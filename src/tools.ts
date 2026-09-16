/**
 * The `/v1` routes, exposed as MCP tools. Descriptions carry the USDC price so a model can decide
 * whether a call is worth making; the prices mirror `packages/shared/src/agent-pricing.ts` (this
 * package ships to npm on its own, so it cannot import the workspace table). Reading and cancelling
 * a watch are free, and say nothing about price.
 */
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { z } from 'zod'
import type { ApiClient, ApiResponse } from './client'

function json(payload: unknown, isError = false) {
  return { content: [{ type: 'text' as const, text: JSON.stringify(payload) }], isError }
}

/**
 * Turns one API response into a tool result.
 *
 * Anything the API did not answer 2xx to is an `isError` result: a model handed a 400 or a 402 as a
 * normal result would read the error body as data and answer from it. `status` is always included,
 * and a body that was not JSON (an HTML 502 from the proxy, say) is reported as such rather than as
 * the literal `null` it decodes to.
 */
function result(r: ApiResponse, hasWallet: boolean) {
  if (r.status >= 400) {
    const payload: { status: number; error: unknown; hint?: string } = {
      status: r.status,
      error: r.body ?? 'non-JSON response',
    }
    if (r.status === 402) {
      payload.hint = hasWallet
        ? 'The call was not paid for: the BEAMSWAP_WALLET_KEY wallet could not settle. Check its USDC balance on Base.'
        : 'BEAMSWAP_WALLET_KEY is not set, so the call was never paid for. Set it to the 0x private key of a wallet holding USDC on Base.'
    }
    return json(payload, true)
  }
  // Agents read tool output as text, so the settlement receipt rides along inside the JSON. Only an
  // object body can carry it — spreading an array would turn it into `{ "0": … }`.
  const { body, paymentTx } = r
  if (paymentTx && body !== null && typeof body === 'object' && !Array.isArray(body)) {
    return json({ ...body, _payment: { tx: paymentTx } })
  }
  return json(body)
}

/** A token balance against a threshold in the token's own smallest unit. */
const balanceItem = z.object({
  type: z.enum(['balance_below', 'balance_above']),
  address: z.string().describe('Address on Base whose balance is watched'),
  token: z.string().describe('Token address on Base, or "native" for ETH'),
  threshold: z
    .string()
    .describe("Threshold in the token's smallest unit, as a decimal string (never a number)"),
})

/** A USD price crossing, priced by the same feed /v1/portfolio values balances with. */
const priceItem = z.object({
  type: z.literal('price_cross'),
  token: z.string().describe('Token address on Base'),
  usd: z.number().positive().describe('USD price to cross'),
  direction: z.enum(['above', 'below']).describe('Which way the price must cross usd'),
})

const watchItem = z.discriminatedUnion('type', [balanceItem, priceItem])

const distributionEntry = z.object({
  address: z.string().describe('Recipient address on Base'),
  amount: z
    .string()
    .regex(/^\d{1,78}$/)
    .describe("Cumulative allocation in the token's smallest unit, as a decimal string"),
})

export function registerTools(server: McpServer, api: ApiClient): void {
  server.registerTool(
    'session_create',
    {
      description:
        'Create a 24-hour session for the configured wallet. Free. The session unlocks GLINT tier quota, discounts and execution fees and remains only in this MCP process.',
      inputSchema: {},
    },
    async () => result(await api.createSession(), api.hasWallet),
  )

  server.registerTool(
    'token_info',
    {
      description:
        'Base ERC-20 facts: metadata, supply, deployer, USD price, round-trip liquidity check. Costs $0.005 USDC via x402.',
      inputSchema: { address: z.string().describe('ERC-20 contract address on Base') },
    },
    async ({ address }) => {
      const r = await api.get(`/v1/token/${address}`)
      return result(r, api.hasWallet)
    },
  )

  server.registerTool(
    'portfolio',
    {
      description:
        'ETH + ERC-20 balances of a Base address with USD values. Costs $0.02 USDC via x402.',
      inputSchema: { address: z.string().describe('Wallet address on Base') },
    },
    async ({ address }) => {
      const r = await api.get(`/v1/portfolio/${address}`)
      return result(r, api.hasWallet)
    },
  )

  server.registerTool(
    'swap_quote',
    {
      description:
        'Best swap output across Base aggregators (quote only, no calldata). Costs $0.005 USDC via x402.',
      inputSchema: {
        sell: z.string().describe('Token address or ETH'),
        buy: z.string().describe('Token address or ETH'),
        amount: z
          .string()
          .describe("Sell amount in the sell token's smallest unit, as a decimal string"),
        slippageBps: z.number().int().min(1).max(5000).default(50).describe('1..5000, default 50'),
      },
    },
    async ({ sell, buy, amount, slippageBps }) => {
      // `amount` stays the string the caller gave us: a wei value never survives a round trip
      // through a JS number.
      const r = await api.get('/v1/quote', {
        sell,
        buy,
        amount,
        slippageBps: String(slippageBps),
      })
      return result(r, api.hasWallet)
    },
  )

  server.registerTool(
    'swap_route',
    {
      description:
        'Best swap route across Base aggregators as ready-to-sign calldata. Costs $0.01 USDC via x402 plus a 10 bps fee inside the route (less for GLINT tiers). Returns to/data/value; you sign and send it.',
      inputSchema: {
        sell: z.string().describe('Token address or ETH'),
        buy: z.string().describe('Token address or ETH'),
        amount: z
          .string()
          .describe("Sell amount in the sell token's smallest unit, as a decimal string"),
        from: z.string().describe('Address that will sign and send the transaction'),
        recipient: z.string().optional().describe('Receiver of the output token; defaults to from'),
        // Capped at 2000 like the route itself: this one returns signable calldata, and a 50 %
        // floor is a loss rather than a slippage setting.
        slippageBps: z.number().int().min(1).max(2000).default(50).describe('1..2000, default 50'),
      },
    },
    async ({ sell, buy, amount, from, recipient, slippageBps }) => {
      // `amount` is passed through untouched, as above. An omitted `recipient` is `undefined` and
      // `JSON.stringify` drops the key, which is exactly what the API's optional field expects.
      const r = await api.post('/v1/execute/route', {
        sell,
        buy,
        amount,
        from,
        recipient,
        slippageBps,
      })
      return result(r, api.hasWallet)
    },
  )

  server.registerTool(
    'watch_create',
    {
      description:
        'Watch Base balances or USD prices; signed webhook on trip. $0.01 per item per day via x402.',
      inputSchema: {
        items: z
          .array(watchItem)
          .min(1)
          .max(50)
          .describe('1..50 conditions, each billed separately'),
        days: z.number().int().min(1).max(90).describe('How long to watch, 1..90 days'),
        webhookUrl: z
          .string()
          .describe(
            'Public https URL that receives the signed POST; private addresses are refused',
          ),
      },
    },
    async ({ items, days, webhookUrl }) => {
      // The whole window is charged at creation, so the result carries the only copy of the
      // signing secret there will ever be: the API keeps it encrypted and never reads it back.
      const r = await api.post('/v1/watch', { items, days, webhookUrl })
      return result(r, api.hasWallet)
    },
  )

  server.registerTool(
    'watch_get',
    {
      description:
        'Read one watch: its condition, status, last observed value and recent webhook deliveries. Free.',
      inputSchema: { id: z.string().describe('Watch id returned by watch_create') },
    },
    async ({ id }) => {
      // Escaped, not interpolated raw: the id comes from the agent, and one carrying a slash or a
      // `?` would otherwise reshape the path it is pasted into.
      const r = await api.get(`/v1/watch/${encodeURIComponent(id)}`)
      return result(r, api.hasWallet)
    },
  )

  server.registerTool(
    'watch_delete',
    {
      description:
        'Stop one watch. Free, idempotent, and never refunded: the days were bought up front.',
      inputSchema: { id: z.string().describe('Watch id returned by watch_create') },
    },
    async ({ id }) => {
      const r = await api.del(`/v1/watch/${encodeURIComponent(id)}`)
      return result(r, api.hasWallet)
    },
  )

  server.registerTool(
    'distribution_create',
    {
      description:
        'Deploy a cumulative Merkle token distributor on Base and return approval, gross funding and unpause transactions for the owner to send. Costs $50 USDC via x402; the API deploys the clone and settles payment, while owner transactions remain unsent.',
      inputSchema: {
        token: z.string().describe('ERC-20 token address on Base'),
        entries: z
          .array(distributionEntry)
          .min(1)
          .max(100_000)
          .describe('1..100000 unique recipient allocations'),
        deadline: z
          .number()
          .int()
          .positive()
          .optional()
          .describe('Optional claim deadline as Unix seconds; defaults to 90 days'),
        name: z.string().trim().min(1).max(80).optional().describe('Optional public name'),
      },
    },
    async ({ token, entries, deadline, name }) => {
      const r = await api.post('/v1/distribution', { token, entries, deadline, name })
      return result(r, api.hasWallet)
    },
  )

  server.registerTool(
    'distribution_get',
    {
      description:
        'Read a token distribution, including its root, contract, promised total, funded balance and claim URL. Free.',
      inputSchema: { id: z.string().describe('Distribution id returned by distribution_create') },
    },
    async ({ id }) => {
      const r = await api.get(`/v1/distribution/${encodeURIComponent(id)}`)
      return result(r, api.hasWallet)
    },
  )

  server.registerTool(
    'distribution_proof',
    {
      description:
        'Get one recipient cumulative amount and Merkle proof for a distribution. Costs $0.001 USDC via x402; a missing recipient is a free 404.',
      inputSchema: {
        id: z.string().describe('Distribution id returned by distribution_create'),
        address: z.string().describe('Recipient address on Base'),
      },
    },
    async ({ id, address }) => {
      const r = await api.get(
        `/v1/distribution/${encodeURIComponent(id)}/proof/${encodeURIComponent(address)}`,
      )
      return result(r, api.hasWallet)
    },
  )
}
