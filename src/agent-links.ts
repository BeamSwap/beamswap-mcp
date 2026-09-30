/** Base units to a plain decimal string, full precision, no grouping ("1234.5"). */
function toDecimalString(value: bigint, decimals: number): string {
  const negative = value < 0n
  const abs = negative ? -value : value
  const base = 10n ** BigInt(decimals)
  const int = (abs / base).toString()
  const frac =
    decimals > 0 ? (abs % base).toString().padStart(decimals, '0').replace(/0+$/, '') : ''
  return `${negative ? '-' : ''}${int}${frac ? `.${frac}` : ''}`
}

/**
 * Review links and reply shaping for the agent tools (MCP). The tools only return data plus a link
 * to a Beamswap page where the owner reviews and signs. They never return calldata to sign, and
 * they never accept a signature. The query parameter names are the ones the website reads to
 * prefill its forms (`LimitOrderPanel`, `crosschain/prefill.ts`, `automate/automation-math.ts`).
 */
export const APP_BASE_URL = 'https://app.beamswap.io'

/** Website prefill fields for `/automate?template=<kind>`; values are decimal text as typed. */
export const AUTOMATION_PREFILL_KEYS = [
  'total',
  'parts',
  'interval',
  'amount',
  'runs',
  'trigger',
  'target',
  'max',
  'budget',
  'cooldown',
  'price',
] as const

export const LIMIT_EXPIRY_VALUES = ['1h', '1d', '7d', '30d', '90d'] as const

const PREFILL_VALUE = /^[A-Za-z0-9.]{1,40}$/

function link(path: string, params: Array<[string, string | undefined]>): string {
  const text = params
    .filter((pair): pair is [string, string] => pair[1] !== undefined && pair[1] !== '')
    .map(([key, value]) => `${encodeURIComponent(key)}=${encodeURIComponent(value)}`)
    .join('&')
  return `${APP_BASE_URL}${path}${text ? `?${text}` : ''}`
}

export interface LimitOrderLinkInput {
  /** Curated symbol (WETH, USDC, ...) or a token address on Base. */
  sell: string
  buy: string
  /** Sell amount as decimal text in token units. */
  amount?: string
  /** Limit price as decimal text (buy per sell). */
  price?: string
  expires?: (typeof LIMIT_EXPIRY_VALUES)[number]
}

export function limitOrderLink(input: LimitOrderLinkInput): string {
  return link('/trade', [
    ['mode', 'limit'],
    ['sell', input.sell],
    ['buy', input.buy],
    ['amount', input.amount],
    ['price', input.price],
    ['expires', input.expires],
  ])
}

export interface AutomationLinkInput {
  kind: 'refill' | 'twap' | 'recurring'
  /** The `params` sent to the preview: token addresses are read for the prefill. */
  params: Record<string, unknown>
  /** Optional website fields (decimal text). Unknown keys and odd values are dropped. */
  prefill?: Record<string, string> | undefined
}

export function automationLink(input: AutomationLinkInput): string {
  const text = (key: string) => {
    const value = input.params[key]
    return typeof value === 'string' && /^0x[0-9a-fA-F]{40}$/.test(value) ? value : undefined
  }
  const entries: Array<[string, string | undefined]> = [['template', input.kind]]
  if (input.kind === 'refill') {
    entries.push(['watch', text('watchToken')], ['sell', text('sellToken')])
  } else {
    entries.push(['sell', text('sellToken')], ['buy', text('buyToken')])
  }
  for (const key of AUTOMATION_PREFILL_KEYS) {
    const value = input.prefill?.[key]
    if (typeof value === 'string' && PREFILL_VALUE.test(value)) entries.push([key, value])
  }
  return link('/automate', entries)
}

export interface SwapLinkInput {
  from: number
  to: number
  sellToken: string
  buyToken: string
  /** Decimal text in token units. */
  amount?: string
}

export function swapLink(input: SwapLinkInput): string {
  return link('/trade', [
    ['from', String(input.from)],
    ['to', String(input.to)],
    ['sellToken', input.sellToken],
    ['buyToken', input.buyToken],
    ['amount', input.amount],
  ])
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

const KEEP_QUOTE_KEYS = [
  'id',
  'tool',
  'fromChain',
  'toChain',
  'fromToken',
  'toToken',
  'fromAddress',
  'toAddress',
  'fromAmount',
  'toAmount',
  'toAmountMin',
  'executionDurationSeconds',
  'fees',
  'gasCosts',
  'expiresAt',
] as const

/**
 * Turns a backend cross-chain quote into agent output: the numbers and fees only, with no
 * `transactionRequest` and no `approvalAddress` (nothing to sign or send), plus the page where the
 * owner reviews it and signs in their own wallet.
 */
export function crosschainQuoteReview(body: unknown): unknown {
  if (!isRecord(body)) return body
  const out: Record<string, unknown> = {}
  for (const key of KEEP_QUOTE_KEYS) if (key in body) out[key] = body[key]
  const from = body.fromToken
  const to = body.toToken
  let amount: string | undefined
  if (
    isRecord(from) &&
    typeof body.fromAmount === 'string' &&
    /^\d{1,78}$/.test(body.fromAmount) &&
    typeof from.decimals === 'number' &&
    Number.isInteger(from.decimals) &&
    from.decimals >= 0 &&
    from.decimals <= 36
  ) {
    amount = toDecimalString(BigInt(body.fromAmount), from.decimals)
  }
  if (
    isRecord(from) &&
    isRecord(to) &&
    typeof body.fromChain === 'number' &&
    typeof body.toChain === 'number' &&
    typeof from.address === 'string' &&
    typeof to.address === 'string'
  ) {
    out.reviewUrl = swapLink({
      from: body.fromChain,
      to: body.toChain,
      sellToken: from.address,
      buyToken: to.address,
      ...(amount ? { amount } : {}),
    })
  }
  out.note =
    'Quote only. Open reviewUrl to review a fresh quote and sign in your own wallet. Nothing to sign is returned here.'
  return out
}

const TX_HASH = /^0x[0-9a-fA-F]{64}$/

/** Adds the LI.FI explorer link to a status body. */
export function crosschainStatusReview(body: unknown, txHash: string): unknown {
  if (!isRecord(body) || !TX_HASH.test(txHash)) return body
  return { ...body, explorerUrl: `https://scan.li.fi/tx/${txHash}` }
}

const ORDER_UID = /^0x[0-9a-fA-F]{112}$/

/** Adds the CoW explorer link to an order body. */
export function orderStatusReview(body: unknown, uid: string): unknown {
  if (!isRecord(body) || !ORDER_UID.test(uid)) return body
  return { ...body, explorerUrl: `https://explorer.cow.fi/base/orders/${uid}` }
}

/** Adds the review link to an automation preview body. */
export function automationPreviewReview(body: unknown, input: AutomationLinkInput): unknown {
  if (!isRecord(body)) return body
  return {
    ...body,
    reviewUrl: automationLink(input),
    note: 'Preview only. Nothing is created. Open reviewUrl, connect your wallet and create it there; you sign every order yourself.',
  }
}
