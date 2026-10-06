/**
 * Vault tools for a vault whose agent is your own wallet (a local key or MetaMask Agent Wallet),
 * not a Beamswap-hosted key. Such a vault has no private URL, so when `BEAMSWAP_VAULT_ADDRESS` is
 * set this module answers the same six tools by calling the vault REST API directly: the agent
 * proves who it is with a signed challenge to read and prepare, signs an `AgentIntent` for every
 * trade, cancel and pause, and Beamswap's relayer submits it and pays the gas. The vault contract
 * checks the signature and its own rules; nothing here can withdraw, change rules or resume.
 */
import { getAddress, isAddress, parseUnits, type Address, type Hex } from 'viem'
import { SignerError, type WalletSigner } from './signer'
import type { VaultRemote, VaultRemoteResult } from './vault'
import { AGENT_ACTION, agentIntentTypedData, type AgentIntentInput } from './vault-intent'

export interface LocalVaultOptions {
  signer: WalletSigner
  /** The vault contract the signer is the agent of. */
  vault: string
  baseUrl: string
  /** Injected in tests; defaults to the global `fetch`. */
  fetchImpl?: typeof fetch
  /** Injected in tests; milliseconds since the epoch. */
  now?: () => number
}

/** Same lifetime the backend gives its own intents. */
const INTENT_TTL_SECONDS = 300
/** A challenge is reused until this close to its deadline, so a trade does not trigger a 2FA prompt each time. */
const CHALLENGE_REFRESH_SECONDS = 60
const DEFAULT_VALID_MINUTES = 30
const TIMEOUT_MS = 60_000

/** Parses `BEAMSWAP_VAULT_ADDRESS`. The error does not echo the value. */
export function parseVaultAddress(raw: string): Address {
  if (!isAddress(raw.trim(), { strict: false })) {
    throw new Error('BEAMSWAP_VAULT_ADDRESS is not a valid address')
  }
  return getAddress(raw.trim())
}

interface VaultToken {
  token: Address
  symbol: string
  decimals: number
  balance: string
  reserve: string
  usd: string | null
}

interface VaultOrder {
  uid: Hex | null
  status: string
  sellToken: Address
  buyToken: Address
  sellAmount: string
  buyAmount: string
  reason: string | null
  createdAt: string
}

/** The fields of `VaultViewJson` (`GET /v1/vaults/:address`) this module reads. */
interface VaultView {
  address: Address
  agent: Address | null
  agentExpiry: number
  paused: boolean
  nonce: string
  policy: {
    maxTradeUsd: string
    maxDailyUsd: string
    priceGuardBps: number
    maxValidity: number
    tokens: Address[]
  }
  spentTodayUsd: string
  balances: VaultToken[]
  openOrders: VaultOrder[]
  recentOrders: VaultOrder[]
}

interface Prepared {
  order: Record<string, unknown> & {
    sellToken: string
    buyToken: string
    receiver: string
    sellAmount: string
  }
  appData: unknown
  digest: Hex
  intent: { nonce: string; deadline: string; typedData: { message: { target: string } } }
}

/** A refusal or failure reported to the agent as `{ ok: false, refused, ... }`. */
class ToolFailure extends Error {
  constructor(
    readonly refused: boolean,
    message: string,
    readonly extra: { code?: string; rule?: string; uid?: string } = {},
  ) {
    super(message)
  }
}

const WRONG_AGENT =
  "The signing wallet is not this vault's agent. Check `mm wallet address` (or BEAMSWAP_WALLET_KEY) matches the agent set on beamswap.io/agent."

/** 1e8 USD units as `12.34 USD`, rounded down. */
function humanUsd(units: bigint): string {
  const whole = units / 100_000_000n
  const cents = (units % 100_000_000n).toString().padStart(8, '0').slice(0, 2)
  return `${whole}.${cents} USD`
}

/** Token units as a plain decimal with up to six fraction digits, rounded down. */
function humanAmount(value: bigint, decimals: number): string {
  const base = 10n ** BigInt(decimals)
  const shown = Math.min(6, decimals)
  const frac = (value % base).toString().padStart(decimals, '0').slice(0, shown).replace(/0+$/, '')
  if (value > 0n && value < base && frac === '') return `<0.${'0'.repeat(Math.max(0, shown - 1))}1`
  return `${value / base}${frac ? `.${frac}` : ''}`
}

function resolveToken(view: VaultView, input: string): VaultToken {
  const text = input.trim().toLowerCase()
  const byAddress = /^0x[0-9a-f]{40}$/.test(text)
  const found = view.balances.find((t) =>
    byAddress
      ? t.token.toLowerCase() === text
      : t.symbol.toLowerCase() === text || (text === 'eth' && t.symbol.toLowerCase() === 'weth'),
  )
  const allowed = new Set(view.policy.tokens.map((a) => a.toLowerCase()))
  if (!found || !allowed.has(found.token.toLowerCase())) {
    const list = view.balances.map((t) => t.symbol).join(', ') || 'none'
    throw new ToolFailure(
      true,
      `${input.trim()} is not on this vault's list of allowed tokens (${list}).`,
      { code: 'token_not_allowed', rule: 'tokens' },
    )
  }
  return found
}

/** Exact decimal to token units. `parseUnits` would round extra digits, so refuse them instead. */
function parseAmount(human: string, decimals: number): bigint {
  const frac = human.split('.')[1] ?? ''
  const amount = /^\d{1,30}(\.\d{1,30})?$/.test(human) && frac.length <= decimals
  const units = amount ? parseUnits(human, decimals) : 0n
  if (units <= 0n) {
    throw new ToolFailure(
      true,
      `Amount must be a plain positive number with at most ${decimals} decimals, for example "25.5".`,
      { code: 'invalid_amount' },
    )
  }
  return units
}

export function createLocalVault(opts: LocalVaultOptions): VaultRemote {
  const { signer } = opts
  const vault = parseVaultAddress(opts.vault)
  const baseUrl = new URL(opts.baseUrl.replace(/\/+$/, ''))
  if (
    baseUrl.username ||
    baseUrl.password ||
    baseUrl.search ||
    baseUrl.hash ||
    baseUrl.pathname !== '/' ||
    (!opts.fetchImpl &&
      baseUrl.protocol !== 'https:' &&
      !(
        baseUrl.protocol === 'http:' &&
        ['localhost', '127.0.0.1', '[::1]'].includes(baseUrl.hostname)
      ))
  ) {
    throw new Error('BEAMSWAP_API_URL must be an HTTPS origin (HTTP allowed only on loopback)')
  }
  const f = opts.fetchImpl ?? fetch
  const now = opts.now ?? Date.now
  const nowSeconds = () => Math.floor(now() / 1_000)
  const path = `/v1/vaults/${vault.toLowerCase()}`

  // One signed challenge serves every read and prepare call until it nears its deadline.
  let challenge: { header: string; deadline: number } | undefined
  let signing: Promise<string> | undefined
  function challengeHeader(): Promise<string> {
    if (challenge && challenge.deadline - nowSeconds() > CHALLENGE_REFRESH_SECONDS) {
      return Promise.resolve(challenge.header)
    }
    signing ??= (async () => {
      const deadline = nowSeconds() + INTENT_TTL_SECONDS
      const signature = await signer.signMessage(
        `Beamswap vault prepare ${vault.toLowerCase()} ${deadline}`,
      )
      challenge = { header: `${deadline}.${signature}`, deadline }
      return challenge.header
    })().finally(() => {
      signing = undefined
    })
    return signing
  }

  async function request(
    method: 'GET' | 'POST',
    url: string,
    init: { body?: unknown; challenge?: boolean } = {},
  ): Promise<unknown> {
    const headers: Record<string, string> = {}
    if (init.body !== undefined) headers['content-type'] = 'application/json'
    if (init.challenge) headers['x-agent-challenge'] = await challengeHeader()
    let res: Response
    try {
      res = await f(`${baseUrl.origin}${url}`, {
        method,
        headers,
        body: init.body === undefined ? undefined : JSON.stringify(init.body),
        redirect: 'error',
        signal: AbortSignal.timeout(TIMEOUT_MS),
      })
    } catch {
      throw new ToolFailure(false, 'Could not reach Beamswap. Try again shortly.')
    }
    const body = (await res.json().catch(() => null)) as {
      error?: unknown
      code?: unknown
      rule?: unknown
      uid?: unknown
    } | null
    if (res.ok) return body
    if (res.status === 401 || body?.code === 'bad_signature') {
      challenge = undefined
      throw new ToolFailure(true, WRONG_AGENT, { code: 'bad_signature' })
    }
    if (res.status === 429) {
      throw new ToolFailure(true, 'Too many requests. Wait a moment and try again.', {
        code: 'rate_limited',
      })
    }
    const message =
      typeof body?.error === 'string' && body.error
        ? body.error
        : `Beamswap answered with status ${res.status}.`
    throw new ToolFailure(res.status < 500, message, {
      ...(typeof body?.code === 'string' ? { code: body.code } : {}),
      ...(typeof body?.rule === 'string' ? { rule: body.rule } : {}),
      ...(typeof body?.uid === 'string' ? { uid: body.uid } : {}),
    })
  }

  const readView = () => request('GET', path, { challenge: true }) as Promise<VaultView>

  async function signIntent(intent: AgentIntentInput, why: string) {
    const signature = await signer.signTypedData(agentIntentTypedData(vault, intent), why)
    return {
      nonce: intent.nonce.toString(),
      deadline: intent.deadline.toString(),
      signature,
    }
  }

  async function place(
    args: Record<string, unknown>,
    limit: boolean,
  ): Promise<Record<string, unknown>> {
    const view = await readView()
    const sell = resolveToken(view, String(args.sell))
    const buy = resolveToken(view, String(args.buy))
    const sellAmount = parseAmount(String(args.amount), sell.decimals)
    const reason = typeof args.reason === 'string' ? args.reason : undefined
    const prepared = (await request('POST', `${path}/orders/prepare`, {
      challenge: true,
      body: {
        sell: sell.token,
        buy: buy.token,
        sellAmount: sellAmount.toString(),
        ...(limit
          ? { limitPrice: args.limitPrice }
          : args.maxSlippageBps !== undefined
            ? { maxSlippageBps: args.maxSlippageBps }
            : {}),
        validFor:
          (Number(args.validForMinutes ?? DEFAULT_VALID_MINUTES) || DEFAULT_VALID_MINUTES) * 60,
        ...(reason !== undefined ? { reason } : {}),
      },
    })) as Prepared
    // The agent signs a digest it cannot read, so check the prepared order is the one it asked for
    // (the vault contract still enforces the rules, this only catches a wrong or tampered answer).
    const o = prepared.order
    if (
      o.sellToken.toLowerCase() !== sell.token.toLowerCase() ||
      o.buyToken.toLowerCase() !== buy.token.toLowerCase() ||
      o.receiver.toLowerCase() !== vault.toLowerCase() ||
      o.sellAmount !== sellAmount.toString() ||
      prepared.intent.typedData.message.target.toLowerCase() !== prepared.digest.toLowerCase()
    ) {
      throw new ToolFailure(
        false,
        'Beamswap prepared an order that does not match the request. Nothing was signed.',
      )
    }
    const intent = await signIntent(
      {
        action: AGENT_ACTION.place,
        target: prepared.digest,
        nonce: BigInt(prepared.intent.nonce),
        deadline: BigInt(prepared.intent.deadline),
      },
      'Beamswap vault trade',
    )
    const placed = (await request('POST', `${path}/orders`, {
      body: {
        order: prepared.order,
        appData: (prepared.appData as { json?: unknown })?.json,
        intent,
        ...(reason !== undefined ? { reason } : {}),
      },
    })) as {
      uid: string
      status: string
      txHash: string
      explorerUrl?: string
      reason: string | null
    }
    return {
      message: 'Order placed. It rests on CoW Protocol until it fills or expires.',
      orderId: placed.uid,
      status: placed.status,
      txHash: placed.txHash,
      explorerUrl: placed.explorerUrl,
      reason: placed.reason,
    }
  }

  const tools: Record<string, (args: Record<string, unknown>) => Promise<Record<string, unknown>>> =
    {
      async vault_status() {
        const view = await readView()
        const maxDaily = BigInt(view.policy.maxDailyUsd)
        const spent = BigInt(view.spentTodayUsd)
        const allowed = new Set(view.policy.tokens.map((a) => a.toLowerCase()))
        return {
          vault: view.address,
          paused: view.paused,
          agentActive: view.agent !== null && nowSeconds() < view.agentExpiry,
          agentExpiresAt: view.agent ? new Date(view.agentExpiry * 1000).toISOString() : null,
          rules: {
            perTradeLimit: humanUsd(BigInt(view.policy.maxTradeUsd)),
            dailyLimit: humanUsd(maxDaily),
            spentToday: humanUsd(spent),
            remainingToday: humanUsd(maxDaily > spent ? maxDaily - spent : 0n),
            priceGuard: `${view.policy.priceGuardBps / 100}% worse than the market price at most`,
            longestOrder: `${Math.floor(view.policy.maxValidity / 60)} minutes`,
            openOrders: view.openOrders.length,
          },
          balances: view.balances.map((t) => ({
            token: t.symbol,
            address: t.token,
            amount: humanAmount(BigInt(t.balance), t.decimals),
            reserve: humanAmount(BigInt(t.reserve), t.decimals),
            usd: t.usd === null ? null : humanUsd(BigInt(t.usd)),
            tradable: allowed.has(t.token.toLowerCase()),
          })),
          note: 'You can trade, cancel and pause. Only the owner can withdraw, change rules or resume.',
        }
      },
      vault_trade: (args) => place(args, false),
      vault_limit_order: (args) => place(args, true),
      async vault_cancel(args) {
        const uid = String(args.orderId).toLowerCase() as Hex
        // Order uid: 32 bytes digest, 20 bytes owner (the vault), 4 bytes validTo.
        if (`0x${uid.slice(66, 106)}` !== vault.toLowerCase()) {
          throw new ToolFailure(true, 'That order does not belong to this vault.', {
            code: 'order_not_found',
          })
        }
        const view = await readView()
        const intent = await signIntent(
          {
            action: AGENT_ACTION.cancel,
            target: uid.slice(0, 66) as Hex,
            nonce: BigInt(view.nonce),
            deadline: BigInt(nowSeconds() + INTENT_TTL_SECONDS),
          },
          'Beamswap vault cancel order',
        )
        const done = (await request('POST', `${path}/cancel`, { body: { uid, intent } })) as {
          uid: string
          txHash: string
        }
        return { message: 'Order cancelled.', orderId: done.uid, txHash: done.txHash }
      },
      async vault_pause() {
        const view = await readView()
        const intent = await signIntent(
          {
            action: AGENT_ACTION.pause,
            nonce: BigInt(view.nonce),
            deadline: BigInt(nowSeconds() + INTENT_TTL_SECONDS),
          },
          'Beamswap vault pause',
        )
        const done = (await request('POST', `${path}/pause`, { body: { intent } })) as {
          txHash: string | null
        }
        return {
          message: done.txHash
            ? 'The vault is paused. Only the owner can resume trading.'
            : 'The vault was already paused. Only the owner can resume trading.',
          paused: true,
          txHash: done.txHash,
        }
      },
      async vault_activity(args) {
        const view = await readView()
        const limit = Math.min(50, Math.max(1, Number(args.limit ?? 10) || 10))
        const token = new Map(view.balances.map((t) => [t.token.toLowerCase(), t] as const))
        const label = (address: string, amount: string) => {
          const t = token.get(address.toLowerCase())
          return t
            ? `${humanAmount(BigInt(amount), t.decimals)} ${t.symbol}`
            : `${amount} of ${address}`
        }
        return {
          spentToday: humanUsd(BigInt(view.spentTodayUsd)),
          orders: view.recentOrders.slice(0, limit).map((o) => ({
            orderId: o.uid,
            status: o.status,
            sells: label(o.sellToken, o.sellAmount),
            forAtLeast: label(o.buyToken, o.buyAmount),
            reason: o.reason,
            placedAt: o.createdAt,
          })),
        }
      },
    }

  return {
    async call(name, args): Promise<VaultRemoteResult> {
      const tool = tools[name]
      const answer = (payload: Record<string, unknown>, isError: boolean) => ({
        text: JSON.stringify(payload),
        isError,
      })
      if (!tool) return answer({ ok: false, refused: false, message: 'Unknown vault tool.' }, true)
      try {
        return answer({ ok: true, ...(await tool(args)) }, false)
      } catch (error) {
        if (error instanceof ToolFailure) {
          return answer(
            {
              ok: false,
              refused: error.refused,
              ...error.extra,
              message: error.message,
            },
            true,
          )
        }
        // A signer message is written to be shown; anything else is not.
        const message =
          error instanceof SignerError
            ? error.message
            : 'The vault request failed. Try again shortly.'
        return answer({ ok: false, refused: false, message }, true)
      }
    },
  }
}
