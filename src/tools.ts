/**
 * The `/v1` routes, exposed as MCP tools. Descriptions carry the USDC price so a model can decide
 * whether a call is worth making; the prices mirror `packages/shared/src/agent-pricing.ts` (this
 * package ships to npm on its own, so it cannot import the workspace table). Reading and cancelling
 * a watch are free, and say nothing about price.
 */
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { z } from 'zod'
import {
  AUTOMATION_PREFILL_KEYS,
  LIMIT_EXPIRY_VALUES,
  automationPreviewReview,
  crosschainQuoteReview,
  crosschainStatusReview,
  limitOrderLink,
  orderStatusReview,
} from './agent-links'
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
  if (r.paymentOutcomeUnknown) return json(r.body, true)
  if (r.status >= 400) {
    const payload: { status: number; error: unknown; hint?: string } = {
      status: r.status,
      error: r.body ?? 'non-JSON response',
    }
    if (r.status === 402) {
      payload.hint = hasWallet
        ? 'No payment was signed for this response. The endpoint requires a supported, policy-approved Base USDC payment.'
        : 'No wallet is configured, so the call was never paid for. Set BEAMSWAP_WALLET_KEY (the 0x private key of a wallet holding USDC on Base) or BEAMSWAP_SIGNER=metamask.'
    }
    return json(payload, true)
  }
  // Agents read tool output as text, so the settlement receipt rides along inside the JSON. Only an
  // object body can carry it - spreading an array would turn it into `{ "0": … }`.
  const { body, paymentTx } = r
  if (paymentTx && body !== null && typeof body === 'object' && !Array.isArray(body)) {
    return json({ ...body, _payment: { tx: paymentTx } })
  }
  return json(body)
}

const decimalText = z.string().regex(/^\d{1,30}(\.\d{1,30})?$/)

/** Applies `shape` to a successful object or array body; errors pass through untouched. */
function shaped(r: ApiResponse, shape: (body: unknown) => unknown): ApiResponse {
  return r.status >= 200 && r.status < 300 && r.body !== null && typeof r.body === 'object'
    ? { ...r, body: shape(r.body) }
    : r
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

  server.registerTool(
    'spending_status',
    {
      description:
        "Read the wallet owner's spending controls on Beamswap: whether paid calls are paused, the daily, weekly and monthly caps, what was spent in each window and the task budgets. Amounts are USDC units (6 decimals) as strings. Free. Uses a session signed with the configured wallet.",
      inputSchema: {},
    },
    async () => result(await api.sessionCall('GET', '/v1/account/spending'), api.hasWallet),
  )

  server.registerTool(
    'spending_pause',
    {
      description:
        'Pause every paid Beamswap call for the configured wallet, for example when a task is going wrong. Free. Only the wallet owner can resume, from the Spending controls page on beamswap.io; there is no tool to resume.',
      inputSchema: {},
    },
    async () => result(await api.sessionCall('POST', '/v1/account/spending/pause'), api.hasWallet),
  )

  // Free tools below return data plus a review link on app.beamswap.io. They never return calldata
  // to sign and never accept a signature; the owner signs in their own wallet on the website.
  server.registerTool(
    'limit_order_prepare',
    {
      description:
        'Build a review link that opens the Beamswap limit order form on Base (CoW Protocol) prefilled with your sell token, buy token, amount, price and expiry. Returns only the link; you review and sign in your own wallet. Free.',
      inputSchema: {
        sell: z
          .string()
          .min(1)
          .max(42)
          .describe('Sell token: a symbol such as WETH or a Base address'),
        buy: z
          .string()
          .min(1)
          .max(42)
          .describe('Buy token: a symbol such as USDC or a Base address'),
        amount: decimalText.optional().describe('Sell amount in token units, for example 0.5'),
        price: decimalText.optional().describe('Limit price as buy tokens per sell token'),
        expires: z.enum(LIMIT_EXPIRY_VALUES).optional(),
      },
    },
    async (args) =>
      json({
        reviewUrl: limitOrderLink(args),
        note: 'Open reviewUrl to see the live CoW price, review the order and sign it in your own wallet. Nothing to sign is returned here.',
      }),
  )

  server.registerTool(
    'order_status',
    {
      description:
        'Read one limit order by its CoW order uid: status, filled amounts and validity. Free.',
      inputSchema: {
        uid: z.string().describe('CoW order uid (0x followed by 112 hex characters)'),
      },
    },
    async ({ uid }) => {
      const r = await api.get(`/v1/orders/${encodeURIComponent(uid)}`)
      return result(
        shaped(r, (body) => orderStatusReview(body, uid)),
        api.hasWallet,
      )
    },
  )

  server.registerTool(
    'automation_preview',
    {
      description:
        'Preview a reserve refill, TWAP or recurring buy without creating it: the summary, maximum exposure, schedule and warnings, plus a review link to create it on Beamswap. Amounts are base units. Free.',
      inputSchema: {
        kind: z.enum(['refill', 'twap', 'recurring']),
        params: z
          .record(z.string(), z.unknown())
          .describe('Parameters for the kind, in base units'),
        budgetTotal: z
          .string()
          .optional()
          .describe('Total budget in base units (required for a refill)'),
        expiresAt: z.number().int().positive().optional(),
        prefill: z
          .partialRecord(z.enum(AUTOMATION_PREFILL_KEYS), z.string().max(40))
          .optional()
          .describe('Optional website form values in token units, for the review link'),
      },
    },
    async ({ kind, params, budgetTotal, expiresAt, prefill }) => {
      const r = await api.post('/v1/automations/preview', { kind, params, budgetTotal, expiresAt })
      return result(
        shaped(r, (body) => automationPreviewReview(body, { kind, params, prefill })),
        api.hasWallet,
      )
    },
  )

  server.registerTool(
    'crosschain_quote',
    {
      description:
        'Quote a swap on Base or across Base, Arbitrum, Optimism and Ethereum through LI.FI: expected and minimum output, fees and duration, plus a review link. Returns no transaction data; you sign in your own wallet on Beamswap. Free.',
      inputSchema: {
        fromChain: z.number().int().describe('Source chain id: 8453, 42161, 10 or 1'),
        toChain: z.number().int().describe('Destination chain id'),
        fromToken: z.string().describe('Sell token address, 0xEeee...EEeE for native ETH'),
        toToken: z.string().describe('Buy token address'),
        fromAmount: z.string().describe('Sell amount in base units'),
        fromAddress: z.string().describe('The wallet that will sign'),
        toAddress: z.string().optional(),
        slippageBps: z.number().int().min(1).max(300).optional(),
      },
    },
    async (a) => {
      const query: Record<string, string> = {
        fromChain: String(a.fromChain),
        toChain: String(a.toChain),
        fromToken: a.fromToken,
        toToken: a.toToken,
        fromAmount: a.fromAmount,
        fromAddress: a.fromAddress,
      }
      if (a.toAddress) query.toAddress = a.toAddress
      if (a.slippageBps !== undefined) query.slippageBps = String(a.slippageBps)
      const r = await api.get('/v1/crosschain/quote', query)
      return result(shaped(r, crosschainQuoteReview), api.hasWallet)
    },
  )

  server.registerTool(
    'crosschain_status',
    {
      description:
        'Read the status of a swap or transfer by its source chain transaction hash. Free.',
      inputSchema: {
        fromChain: z.number().int().describe('Source chain id: 8453, 42161, 10 or 1'),
        txHash: z.string().describe('Transaction hash on the source chain'),
        toChain: z.number().int().optional(),
      },
    },
    async ({ fromChain, txHash, toChain }) => {
      const query: Record<string, string> = { fromChain: String(fromChain), txHash }
      if (toChain !== undefined) query.toChain = String(toChain)
      const r = await api.get('/v1/crosschain/status', query)
      return result(
        shaped(r, (body) => crosschainStatusReview(body, txHash)),
        api.hasWallet,
      )
    },
  )
}
