/**
 * Thin HTTP client for the Beamswap Agent API.
 *
 * With `walletKey` set, every request goes through `wrapFetchWithPayment`: the first response is a
 * 402 carrying the price, the wrapper signs an EIP-3009 USDC authorisation on Base and replays the
 * request. The settlement tx hash comes back in the `PAYMENT-RESPONSE` header and is handed to the
 * caller so an agent can show what a call cost. Without a key the client still works against free
 * routes (and against a backend where `/v1` pricing is disabled).
 */
import { ExactEvmScheme } from '@x402/evm'
import { decodePaymentResponseHeader, wrapFetchWithPayment, x402Client } from '@x402/fetch'
import type { Hex } from 'viem'
import { privateKeyToAccount } from 'viem/accounts'
import { buildSessionMessage } from './session'

export interface ApiClientOptions {
  baseUrl: string
  walletKey?: Hex
  sessionToken?: string
  /** Injected in tests; defaults to the global `fetch`. */
  fetchImpl?: typeof fetch
}

export interface ApiResponse {
  status: number
  body: unknown
  /** Settlement tx hash when the call was paid for, `null` when it was free or unpaid. */
  paymentTx: string | null
}

export function createApiClient(opts: ApiClientOptions) {
  const base = opts.baseUrl.replace(/\/+$/, '')
  // A missing *or blank* BEAMSWAP_WALLET_KEY means "no wallet": every paid route then answers 402
  // and the caller has to be told why, so the decision is published as `hasWallet`.
  const hasWallet = Boolean(opts.walletKey)
  const account = opts.walletKey ? privateKeyToAccount(opts.walletKey) : undefined
  let sessionToken = opts.sessionToken
  let f: typeof fetch = opts.fetchImpl ?? fetch
  if (account) {
    // The distribution-create route costs $50. Keep an explicit ceiling at that product price;
    // x402's safer $1 default would otherwise make the advertised MCP tool impossible to use.
    const client = new x402Client()
      .setSpendControls({ maxAmountPerPayment: '$50' })
      .register('eip155:*', new ExactEvmScheme(account))
    f = wrapFetchWithPayment(f, client)
  }
  /**
   * One request, however it is shaped. The session token is added here rather than at each call
   * site so a route added later cannot be the one that forgets to spend the free quota, and the
   * payment wrapper sees every request the same way.
   */
  async function send(url: string, init: Init = {}): Promise<ApiResponse> {
    const headers = { ...init.headers }
    if (sessionToken) headers.authorization = `Bearer ${sessionToken}`
    const res = await f(url, { ...init, headers })
    return {
      status: res.status,
      body: await res.json().catch(() => null),
      paymentTx: readPaymentTx(res),
    }
  }

  return {
    hasWallet,
    /** Signs the canonical session message and retains the returned JWT only in this process. */
    async createSession(): Promise<ApiResponse> {
      if (!account) {
        return {
          status: 400,
          body: { error: 'BEAMSWAP_WALLET_KEY is required to create a session' },
          paymentTx: null,
        }
      }
      const issuedAt = Math.floor(Date.now() / 1_000)
      const signature = await account.signTypedData(buildSessionMessage(account.address, issuedAt))
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
    },
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
    /**
     * Same paying wrapper as the rest: a DELETE that is free today would still be paid for if it
     * ever gained a price. A 204 carries no body, which `send` decodes as `null` rather than as a
     * parse failure — there is nothing to report and nothing went wrong.
     */
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
  const receipt = res.headers.get('PAYMENT-RESPONSE')
  if (!receipt) return null
  try {
    return decodePaymentResponseHeader(receipt).transaction ?? null
  } catch {
    return null
  }
}
