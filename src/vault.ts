/**
 * Vault tools for the local stdio server. When `BEAMSWAP_VAULT_URL` (the private URL the vault
 * owner copied from the Beamswap dashboard, `https://api.beamswap.io/mcp/v/<capability>`) is set,
 * the six vault tools appear here and forward to that URL. The vault, its rules and the hosted agent
 * key live on the Beamswap side; this package only carries the request, so nothing here can sign,
 * withdraw, change rules or resume a paused vault. The URL is a secret: it is never logged or
 * echoed in a result. A vault whose agent is your own wallet has no URL: `vault-local.ts` implements
 * the same `VaultRemote` for it, so both register these exact tools through `registerVaultTools`.
 */
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { z } from 'zod'

export const VAULT_TOOL_NAMES = [
  'vault_status',
  'vault_trade',
  'vault_limit_order',
  'vault_cancel',
  'vault_pause',
  'vault_activity',
] as const

export interface VaultRemoteResult {
  text: string
  isError: boolean
}

/** Calls one tool on the private vault URL. */
export interface VaultRemote {
  call(name: string, args: Record<string, unknown>): Promise<VaultRemoteResult>
}

const PRIVATE_URL = /^\/mcp\/v\/bvc_[0-9a-f]{32}$/

/** Accepts the private URL, and http only for a local development backend. */
export function parseVaultUrl(raw: string): URL {
  let url: URL
  try {
    url = new URL(raw)
  } catch {
    throw new Error('BEAMSWAP_VAULT_URL is not a valid URL')
  }
  const local = url.hostname === 'localhost' || url.hostname === '127.0.0.1'
  if (url.protocol !== 'https:' && !(local && url.protocol === 'http:')) {
    throw new Error('BEAMSWAP_VAULT_URL must be an https URL')
  }
  if (!PRIVATE_URL.test(url.pathname) || url.search || url.hash || url.username || url.password) {
    throw new Error('BEAMSWAP_VAULT_URL must be the private URL from your Beamswap vault dashboard')
  }
  return url
}

function failure(message: string): VaultRemoteResult {
  return { text: JSON.stringify({ ok: false, refused: false, message }), isError: true }
}

/** The text of a JSON-RPC answer, from a JSON body or the first `data:` line of an event stream. */
async function readRpc(res: Response): Promise<unknown> {
  const type = res.headers.get('content-type') ?? ''
  const body = await res.text()
  if (type.includes('text/event-stream')) {
    const line = body.split('\n').find((l) => l.startsWith('data:'))
    return line ? JSON.parse(line.slice(5).trim()) : null
  }
  return JSON.parse(body)
}

const TIMEOUT_MS = 60_000

export function createVaultRemote(rawUrl: string, fetchImpl: typeof fetch = fetch): VaultRemote {
  const url = parseVaultUrl(rawUrl)
  let id = 0
  return {
    async call(name, args) {
      let res: Response
      try {
        res = await fetchImpl(url, {
          method: 'POST',
          headers: {
            'content-type': 'application/json',
            accept: 'application/json, text/event-stream',
          },
          body: JSON.stringify({
            jsonrpc: '2.0',
            id: ++id,
            method: 'tools/call',
            params: { name, arguments: args },
          }),
          signal: AbortSignal.timeout(TIMEOUT_MS),
          redirect: 'manual',
        })
      } catch {
        // Never include the error text: it can carry the URL.
        return failure('Could not reach Beamswap. Try again shortly.')
      }
      if (res.status === 404) {
        return failure(
          'This private vault URL is not valid any more. Create a new one on the Beamswap dashboard.',
        )
      }
      if (res.status === 429) return failure('Too many requests. Wait a moment and try again.')
      if (res.status === 503) return failure('Agent vaults are not available right now.')
      if (res.status !== 200) return failure(`Beamswap answered with status ${res.status}.`)
      let rpc: unknown
      try {
        rpc = await readRpc(res)
      } catch {
        return failure('Beamswap sent an answer this tool could not read.')
      }
      const result = (
        rpc as { result?: { content?: Array<{ text?: unknown }>; isError?: boolean } }
      )?.result
      const text = result?.content?.[0]?.text
      if (typeof text !== 'string') return failure('Beamswap sent an unexpected answer.')
      return { text, isError: result?.isError === true }
    },
  }
}

function out(r: VaultRemoteResult) {
  return { content: [{ type: 'text' as const, text: r.text }], isError: r.isError }
}

const token = z.string().min(1).max(66)
const amount = z
  .string()
  .regex(/^\d{1,30}(\.\d{1,30})?$/)
  .describe('Amount of the sell token as a decimal, for example "25.5"')
const reason = z
  .string()
  .max(1000)
  .optional()
  .describe('Why you are making this trade, in one sentence. The owner sees it in their feed.')
const minutes = z
  .number()
  .int()
  .min(1)
  .max(60 * 24 * 365)
  .optional()
  .describe('How long the order stays open, in minutes (default 30)')

/** Registers the six vault tools, forwarding to `remote`. */
export function registerVaultTools(server: McpServer, remote: VaultRemote): void {
  const forward = (name: string) => async (args: Record<string, unknown>) =>
    out(await remote.call(name, args))

  server.registerTool(
    'vault_status',
    {
      description:
        "Your vault: balances with USD values, the rules the owner set (per-trade and daily limits, price guard), today's spend and whether it is paused. Read this before trading. Free.",
      inputSchema: {},
      annotations: { readOnlyHint: true, openWorldHint: true },
    },
    forward('vault_status'),
  )
  server.registerTool(
    'vault_trade',
    {
      description:
        'Sell one vault token for another at the current market price (a CoW Protocol order). Refused with the rule that blocked it if it breaks a vault rule. The proceeds always land back in the vault; you cannot withdraw.',
      inputSchema: {
        sell: token.describe(
          'Token to sell: a symbol from vault_status (ETH means WETH) or an address',
        ),
        buy: token.describe('Token to buy: a symbol from vault_status or an address'),
        amount,
        maxSlippageBps: z
          .number()
          .int()
          .min(0)
          .max(2000)
          .optional()
          .describe(
            'Worst accepted price versus the current quote, in basis points (default 100 = 1%)',
          ),
        validForMinutes: minutes,
        reason,
      },
      annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: true },
    },
    forward('vault_trade'),
  )
  server.registerTool(
    'vault_limit_order',
    {
      description:
        'Place a limit order: sell a vault token for another only at or above your price. It rests on CoW Protocol until the market reaches it or it expires. Same vault rules as vault_trade.',
      inputSchema: {
        sell: token,
        buy: token,
        amount,
        limitPrice: z
          .string()
          .regex(/^\d{1,30}(\.\d{1,30})?$/)
          .describe(
            'Buy tokens you want for 1 sell token, for example "2500" for ETH sold for USDC',
          ),
        validForMinutes: minutes,
        reason,
      },
      annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: true },
    },
    forward('vault_limit_order'),
  )
  server.registerTool(
    'vault_cancel',
    {
      description: 'Cancel one open order of this vault by its order id.',
      inputSchema: { orderId: z.string().regex(/^0x[0-9a-fA-F]{112}$/) },
      annotations: {
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: true,
      },
    },
    forward('vault_cancel'),
  )
  server.registerTool(
    'vault_pause',
    {
      description:
        'Pause all trading in this vault right away. Use it if something looks wrong. Only the owner can resume it.',
      inputSchema: {},
      annotations: {
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: true,
      },
    },
    forward('vault_pause'),
  )
  server.registerTool(
    'vault_activity',
    {
      description: 'Recent orders of this vault with status and the reason given for each. Free.',
      inputSchema: { limit: z.number().int().min(1).max(50).optional() },
      annotations: { readOnlyHint: true, openWorldHint: false },
    },
    forward('vault_activity'),
  )
}
