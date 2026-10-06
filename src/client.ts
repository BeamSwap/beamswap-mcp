/**
 * Bounded API client: explicit per-route Base USDC payment policy, one signed submission,
 * and persistent wallet-level recovery when a signed outcome is uncertain.
 */
import { ExactEvmScheme, type ClientEvmSigner } from '@x402/evm'
import { decodePaymentResponseHeader, x402HTTPClient, x402Client } from '@x402/fetch'
import { formatUnits, type Hex } from 'viem'
import { buildSessionMessage } from './session'
import {
  assertPaymentData,
  NETWORK,
  permitsRequirement,
  priceCeiling,
  TREASURY,
} from './payment-policy'
import { fileRecoveryStore, recoveryRecord, type RecoveryStore } from './payment-recovery'
import { localKeySigner, type TypedData, type WalletSigner } from './signer'

export interface ApiClientOptions {
  baseUrl: string
  /** Signs payments and sessions: a local key or MetaMask Agent Wallet. Wins over `walletKey`. */
  signer?: WalletSigner
  /** Kept for callers that only have a raw key; wrapped with `localKeySigner`. */
  walletKey?: Hex
  sessionToken?: string
  /** Injected in tests; defaults to the global `fetch`. */
  fetchImpl?: typeof fetch
  /** Explicit local configuration for a trusted self-hosted treasury, never a tool argument. */
  treasury?: string
  recoveryStore?: RecoveryStore
  /**
   * Task label sent as `x-beamswap-task` on every request (`BEAMSWAP_TASK`), so the wallet owner's
   * task budgets and receipts on beamswap.io can tell this agent's work apart.
   */
  task?: string
}

/** Same rule the API applies to `x-beamswap-task`. */
export const TASK_PATTERN = /^[A-Za-z0-9 ._:-]{1,64}$/

export interface ApiResponse {
  status: number
  body: unknown
  /** Settlement tx hash when the call was paid for, `null` when it was free or unpaid. */
  paymentTx: string | null
  paymentOutcomeUnknown?: boolean
}

export function createApiClient(opts: ApiClientOptions) {
  const base = opts.baseUrl.replace(/\/+$/, '')
  const baseUrl = new URL(base)
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
  // A missing *or blank* BEAMSWAP_WALLET_KEY with no signer means "no wallet": every paid route
  // then answers 402 and the caller has to be told why, so the decision is published as `hasWallet`.
  const account: WalletSigner | undefined =
    opts.signer ?? (opts.walletKey ? localKeySigner(opts.walletKey) : undefined)
  const hasWallet = Boolean(account)
  let sessionToken = opts.sessionToken
  const f = opts.fetchImpl ?? fetch
  const treasury = opts.treasury ?? TREASURY
  if (!/^0x[\da-f]{40}$/i.test(treasury)) throw new Error('Invalid payment treasury')
  const recovery = opts.recoveryStore ?? fileRecoveryStore()
  const task = opts.task?.trim() || undefined
  if (task && !TASK_PATTERN.test(task)) {
    throw new Error('BEAMSWAP_TASK must be 1 to 64 characters: letters, digits, spaces, . _ : or -')
  }
  /**
   * One request, however it is shaped. The session token is added here rather than at each call
   * site so a route added later cannot be the one that forgets to spend the free quota, and the
   * payment wrapper sees every request the same way.
   */
  async function send(url: string, init: Init = {}): Promise<ApiResponse> {
    const target = new URL(url)
    if (target.origin !== baseUrl.origin) throw new Error('Unexpected API origin')
    const headers = { ...init.headers }
    if (sessionToken) headers.authorization = `Bearer ${sessionToken}`
    if (task) headers['x-beamswap-task'] = task
    const method = init.method ?? 'GET'
    const ceiling = priceCeiling(
      method,
      target.pathname,
      typeof init.body === 'string' ? init.body : undefined,
    )
    const request: Init = {
      ...init,
      headers,
      redirect: 'error',
      signal: AbortSignal.timeout(60_000),
    }
    let lockedId: string | undefined
    let signed = false
    function unknown(id: string): ApiResponse {
      return {
        status: 409,
        paymentTx: null,
        paymentOutcomeUnknown: true,
        body: {
          error: 'A payment may have settled. Do not retry or create a replacement.',
          doNotRetry: true,
          paymentOutcomeUnknown: true,
          recoveryId: id,
          recovery:
            'Ask the wallet owner to check payment and operation status, then use the manual recovery CLI. Restarting will not clear this lock.',
        },
      }
    }
    try {
      // Block at wallet level, including differently worded requests after an uncertain outcome.
      if (account && ceiling > 0n) {
        const pending = await recovery.read(account.address)
        if (pending) return unknown(pending.id)
      }
      let res = await f(url, request)
      let body = await boundedJson(res)
      if (res.status !== 402 || !account || ceiling === 0n) {
        return { status: res.status, body, paymentTx: readPaymentTx(res) }
      }
      let exactAmount = 0n
      const signer: ClientEvmSigner = {
        address: account.address,
        async signTypedData(data) {
          assertPaymentData(data, account!.address, treasury, exactAmount)
          if (signed) throw new Error('A second payment signature is forbidden')
          const record = recoveryRecord(baseUrl.origin, method, url, String(init.body ?? ''))
          if (!(await recovery.acquire(account!.address, record)))
            throw new Error('Wallet has a pending payment')
          lockedId = record.id
          // Persist before signing. A crash at any point must fail closed.
          signed = true
          return account!.signTypedData(
            data as TypedData,
            `Beamswap API payment of ${formatUnits(exactAmount, 6)} USDC`,
          )
        },
      }
      const client = new x402Client()
        .setSpendControls({ maxAmountPerPayment: '$50' })
        .register(NETWORK, new ExactEvmScheme(signer))
        .registerPolicy((version, requirements) => {
          const allowed =
            version === 2
              ? requirements.filter((r) => permitsRequirement(r, ceiling, treasury))
              : []
          // Select one exact requirement, then verify the generated typed data against it.
          const chosen = allowed[0]
          if (chosen) exactAmount = BigInt(chosen.amount)
          return chosen ? [chosen] : []
        })
      const http = new x402HTTPClient(client)
      const challenge = http.getPaymentRequiredResponse((name) => res.headers.get(name), body)
      if (challenge.x402Version !== 2 || challenge.resource?.url !== url)
        throw new Error('Unexpected payment resource')
      const payload = await client.createPaymentPayload(challenge)
      // Exactly one signed submission, with no wrapper retry/recovery hooks.
      res = await f(url, {
        ...request,
        headers: { ...headers, ...http.encodePaymentSignatureHeader(payload) },
      })
      body = await boundedJson(res)
      const receipt = readReceipt(res)
      if (
        !res.ok ||
        !body ||
        typeof body !== 'object' ||
        !receipt?.success ||
        receipt.network !== NETWORK ||
        receipt.payer?.toLowerCase() !== account.address.toLowerCase() ||
        !/^0x[\da-f]{64}$/i.test(receipt.transaction ?? '')
      )
        return unknown(lockedId!)
      await recovery.clear(account.address, lockedId!)
      return { status: res.status, body, paymentTx: receipt.transaction }
    } catch {
      if (signed) return unknown(lockedId!)
      if (account) {
        const pending = await recovery.read(account.address).catch(() => null)
        if (pending) return unknown(pending.id)
      }
      return {
        status: 502,
        paymentTx: null,
        body: {
          error:
            'Request failed or payment policy rejected the challenge. No payment was signed by this request.',
        },
      }
    }
  }

  /** Signs the canonical session message and retains the returned JWT only in this process. */
  async function createSession(): Promise<ApiResponse> {
    if (!account) {
      return {
        status: 400,
        body: {
          error: 'BEAMSWAP_WALLET_KEY or BEAMSWAP_SIGNER=metamask is required to create a session',
        },
        paymentTx: null,
      }
    }
    const issuedAt = Math.floor(Date.now() / 1_000)
    const signature = await account.signTypedData(
      buildSessionMessage(account.address, issuedAt),
      'Beamswap API sign-in',
    )
    const response = await send(`${base}/v1/session`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ address: account.address, issuedAt, signature }),
    })
    if (response.status >= 200 && response.status < 300) {
      const body = response.body as { token?: unknown; expiresAt?: unknown } | null
      if (!body || typeof body.token !== 'string' || typeof body.expiresAt !== 'number') {
        return {
          status: 502,
          body: { error: 'Session endpoint returned an invalid response' },
          paymentTx: null,
        }
      }
      sessionToken = body.token
      return {
        status: response.status,
        body: { active: true, address: account.address, expiresAt: body.expiresAt },
        paymentTx: null,
      }
    }
    return response
  }

  /**
   * A free, wallet-scoped call (spending controls). Signs a session from the configured key when
   * none is held, and once more when the held one has expired. These routes never ask for payment.
   */
  async function sessionCall(method: 'GET' | 'POST', path: string): Promise<ApiResponse> {
    if (!sessionToken) {
      if (!account) {
        return {
          status: 400,
          body: {
            error:
              'Set BEAMSWAP_WALLET_KEY, BEAMSWAP_SIGNER=metamask or BEAMSWAP_SESSION_TOKEN to use spending controls',
          },
          paymentTx: null,
        }
      }
      const created = await createSession()
      if (created.status < 200 || created.status >= 300) return created
    }
    const call = () =>
      method === 'GET'
        ? send(`${base}${path}`)
        : send(`${base}${path}`, {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: '{}',
          })
    const first = await call()
    if (first.status !== 401 || !account) return first
    const renewed = await createSession()
    if (renewed.status < 200 || renewed.status >= 300) return renewed
    return call()
  }

  return {
    hasWallet,
    /** The configured signer, for tools that sign something other than an API payment. */
    signer: account,
    createSession,
    sessionCall,
    async get(path: string, query: Record<string, string> = {}): Promise<ApiResponse> {
      const qs = new URLSearchParams(query).toString()
      return send(`${base}${path}${qs ? `?${qs}` : ''}`)
    },
    /** `body` is serialised here, so a wei amount reaches the API as the string it was given as. */
    async post(path: string, body: unknown): Promise<ApiResponse> {
      return send(`${base}${path}`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body),
      })
    },
    /** Watch deletion is free and can never sign a payment. */
    async del(path: string): Promise<ApiResponse> {
      return send(`${base}${path}`, { method: 'DELETE' })
    },
  }
}

/** `RequestInit` with its headers narrowed to the plain object form the client always builds. */
type Init = Omit<RequestInit, 'headers'> & { headers?: Record<string, string> }

export type ApiClient = ReturnType<typeof createApiClient>

/** A receipt we cannot decode must not cost the caller the response they already paid for. */
function readPaymentTx(res: Response): string | null {
  return readReceipt(res)?.transaction ?? null
}

function readReceipt(res: Response) {
  const receipt = res.headers.get('PAYMENT-RESPONSE')
  if (!receipt) return null
  try {
    return decodePaymentResponseHeader(receipt)
  } catch {
    return null
  }
}

async function boundedJson(res: Response): Promise<unknown> {
  if (!res.body) return null
  const reader = res.body.getReader()
  const chunks: Uint8Array[] = []
  let length = 0
  try {
    while (true) {
      const next = await reader.read()
      if (next.done) break
      length += next.value.byteLength
      if (length > 1_048_576) throw new Error('API response exceeded 1 MiB')
      chunks.push(next.value)
    }
    try {
      return JSON.parse(Buffer.concat(chunks).toString('utf8'))
    } catch {
      return null
    }
  } finally {
    await reader.cancel().catch(() => {})
    reader.releaseLock()
  }
}
