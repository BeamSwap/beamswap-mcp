import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js'
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { recoverMessageAddress, recoverTypedDataAddress, type Hex } from 'viem'
import { privateKeyToAccount } from 'viem/accounts'
import { describe, expect, it } from 'vitest'
import { readSignerConfig } from './config'
import { localKeySigner, SignerError, type WalletSigner } from './signer'
import { registerVaultTools, VAULT_TOOL_NAMES } from './vault'
import { AGENT_ACTION, agentIntentTypedData } from './vault-intent'
import { createLocalVault, parseVaultAddress } from './vault-local'

const key = `0x${'22'.repeat(32)}` as const
const agent = privateKeyToAccount(key).address
const vault = '0x3333333333333333333333333333333333333333' as const
const WETH = '0x4200000000000000000000000000000000000006'
const USDC = '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913'
const DIGEST = `0x${'ab'.repeat(32)}` as Hex
const UID = `${DIGEST}${vault.slice(2).toLowerCase()}${'00000fff'}` as Hex
const NOW_MS = 1_800_000_000_000
const NOW = NOW_MS / 1000
const baseUrl = 'https://api.beamswap.test'

const view = {
  address: vault,
  agent,
  agentExpiry: NOW + 86_400,
  paused: false,
  nonce: '7',
  policy: {
    maxTradeUsd: '10000000000',
    maxDailyUsd: '50000000000',
    priceGuardBps: 100,
    maxValidity: 7200,
    tokens: [WETH, USDC],
  },
  spentTodayUsd: '12500000000',
  balances: [
    {
      token: WETH,
      symbol: 'WETH',
      decimals: 18,
      balance: '1500000000000000000',
      reserve: '0',
      usd: '300000000000',
    },
    { token: USDC, symbol: 'USDC', decimals: 6, balance: '1234567', reserve: '0', usd: null },
  ],
  openOrders: [{ uid: UID }],
  recentOrders: [
    {
      uid: UID,
      status: 'open',
      sellToken: WETH,
      buyToken: USDC,
      sellAmount: '250000000000000000',
      buyAmount: '600000000',
      reason: 'rebalance',
      createdAt: '2026-10-06T10:00:00.000Z',
    },
  ],
}

interface Call {
  method: string
  path: string
  headers: Record<string, string>
  body: any
}

/** A stand-in for the Beamswap API that records requests and answers like the real vault routes. */
function backend(
  options: {
    respond?: (call: Call) => Response | undefined
    prepared?: (body: any) => any
  } = {},
) {
  const calls: Call[] = []
  const fetchImpl = (async (input: string, init: RequestInit) => {
    const url = new URL(input)
    const call: Call = {
      method: init.method ?? 'GET',
      path: url.pathname,
      headers: init.headers as Record<string, string>,
      body: typeof init.body === 'string' ? JSON.parse(init.body) : undefined,
    }
    calls.push(call)
    const custom = options.respond?.(call)
    if (custom) return custom
    const base = `/v1/vaults/${vault.toLowerCase()}`
    if (call.method === 'GET' && call.path === base) return Response.json(view)
    if (call.path === `${base}/orders/prepare`) {
      const spec = call.body
      const prepared = {
        order: {
          sellToken: spec.sell,
          buyToken: spec.buy,
          receiver: vault,
          sellAmount: spec.sellAmount,
          buyAmount: '600000000',
          validTo: 4095,
          appData: `0x${'11'.repeat(32)}`,
          feeAmount: '0',
          kind: 'sell',
          partiallyFillable: false,
          sellTokenBalance: 'erc20',
          buyTokenBalance: 'erc20',
        },
        appData: { json: '{"appCode":"beamswap"}', hash: `0x${'11'.repeat(32)}` },
        uid: UID,
        digest: DIGEST,
        usdIn: '50000000000',
        intent: {
          typedData: { message: { action: 1, target: DIGEST, nonce: '7', deadline: '1800000300' } },
          nonce: '7',
          deadline: '1800000300',
        },
      }
      return Response.json(options.prepared ? options.prepared(prepared) : prepared)
    }
    if (call.path === `${base}/orders`) {
      return Response.json(
        {
          uid: UID,
          status: 'open',
          txHash: `0x${'cd'.repeat(32)}`,
          explorerUrl: `https://explorer.cow.fi/base/orders/${UID}`,
          reason: call.body.reason ?? null,
        },
        { status: 201 },
      )
    }
    if (call.path === `${base}/cancel`) {
      return Response.json({ uid: call.body.uid, txHash: `0x${'ee'.repeat(32)}`, blockNumber: '1' })
    }
    if (call.path === `${base}/pause`) {
      return Response.json({ paused: true, txHash: `0x${'ff'.repeat(32)}`, blockNumber: '1' })
    }
    return Response.json({ error: 'not found' }, { status: 404 })
  }) as unknown as typeof fetch
  return { calls, fetchImpl }
}

/** The real local signer, counting what it was asked to sign. */
function countingSigner(): WalletSigner & { messages: string[]; typed: number } {
  const inner = localKeySigner(key)
  const counting = {
    address: inner.address,
    messages: [] as string[],
    typed: 0,
    signMessage(message: string) {
      counting.messages.push(message)
      return inner.signMessage(message)
    },
    signTypedData: ((data: never, intent?: string) => {
      counting.typed++
      return inner.signTypedData(data, intent)
    }) as WalletSigner['signTypedData'],
  }
  return counting
}

function setup(options: Parameters<typeof backend>[0] = {}, clock = { ms: NOW_MS }) {
  const signer = countingSigner()
  const server = backend(options)
  const local = createLocalVault({
    signer,
    vault,
    baseUrl,
    fetchImpl: server.fetchImpl,
    now: () => clock.ms,
  })
  const call = async (name: string, args: Record<string, unknown> = {}) => {
    const out = await local.call(name, args)
    return { ...out, json: JSON.parse(out.text) }
  }
  return { signer, call, clock, ...server }
}

const signedIntent = (body: { intent: { nonce: string; deadline: string; signature: Hex } }) =>
  body.intent

describe('vault_status and vault_activity', () => {
  it('reads the vault with a signed agent challenge and reports human amounts', async () => {
    const { call, calls, signer } = setup()
    const { json, isError } = await call('vault_status')
    expect(isError).toBe(false)
    expect(json).toMatchObject({
      ok: true,
      vault,
      paused: false,
      agentActive: true,
      rules: {
        perTradeLimit: '100.00 USD',
        dailyLimit: '500.00 USD',
        spentToday: '125.00 USD',
        remainingToday: '375.00 USD',
        priceGuard: '1% worse than the market price at most',
        longestOrder: '120 minutes',
        openOrders: 1,
      },
      balances: [
        { token: 'WETH', amount: '1.5', usd: '3000.00 USD', tradable: true },
        { token: 'USDC', amount: '1.234567', usd: null, tradable: true },
      ],
    })
    const [first] = calls
    expect(first).toMatchObject({ method: 'GET', path: `/v1/vaults/${vault.toLowerCase()}` })
    const [deadline, signature] = first!.headers['x-agent-challenge']!.split('.')
    expect(Number(deadline)).toBe(NOW + 300)
    expect(signer.messages).toEqual([`Beamswap vault prepare ${vault.toLowerCase()} ${deadline}`])
    expect(
      await recoverMessageAddress({ message: signer.messages[0]!, signature: signature as Hex }),
    ).toBe(agent)
  })

  it('lists recent orders with the reason given', async () => {
    const { call } = setup()
    const { json } = await call('vault_activity', { limit: 5 })
    expect(json).toEqual({
      ok: true,
      spentToday: '125.00 USD',
      orders: [
        {
          orderId: UID,
          status: 'open',
          sells: '0.25 WETH',
          forAtLeast: '600 USDC',
          reason: 'rebalance',
          placedAt: '2026-10-06T10:00:00.000Z',
        },
      ],
    })
  })
})

describe('vault_trade and vault_limit_order', () => {
  it('prepares, signs the intent with the agent wallet and submits it', async () => {
    const { call, calls, signer } = setup()
    const { json, isError } = await call('vault_trade', {
      sell: 'ETH',
      buy: 'usdc',
      amount: '0.25',
      maxSlippageBps: 50,
      validForMinutes: 10,
      reason: 'rebalance',
    })
    expect(isError).toBe(false)
    expect(json).toMatchObject({
      ok: true,
      orderId: UID,
      status: 'open',
      txHash: `0x${'cd'.repeat(32)}`,
      explorerUrl: `https://explorer.cow.fi/base/orders/${UID}`,
      reason: 'rebalance',
    })
    const prepare = calls.find((c) => c.path.endsWith('/orders/prepare'))!
    expect(prepare.body).toEqual({
      sell: WETH,
      buy: USDC,
      sellAmount: '250000000000000000',
      maxSlippageBps: 50,
      validFor: 600,
      reason: 'rebalance',
    })
    expect(prepare.headers['x-agent-challenge']).toMatch(/^\d+\.0x[0-9a-f]{130}$/)
    const submit = calls.find((c) => c.path.endsWith('/orders'))!
    expect(submit.body).toMatchObject({
      order: { sellAmount: '250000000000000000', receiver: vault },
      appData: '{"appCode":"beamswap"}',
      reason: 'rebalance',
      intent: { nonce: '7', deadline: '1800000300' },
    })
    expect(submit.headers['x-agent-challenge']).toBeUndefined()
    const intent = signedIntent(submit.body)
    const typed = agentIntentTypedData(vault, {
      action: AGENT_ACTION.place,
      target: DIGEST,
      nonce: 7n,
      deadline: 1800000300n,
    })
    expect(await recoverTypedDataAddress({ ...typed, signature: intent.signature })).toBe(agent)
    expect(signer.typed).toBe(1)
  })

  it('places a limit order with the price and no slippage field', async () => {
    const { call, calls } = setup()
    const { json } = await call('vault_limit_order', {
      sell: 'WETH',
      buy: 'USDC',
      amount: '1',
      limitPrice: '2500',
    })
    expect(json.ok).toBe(true)
    const prepare = calls.find((c) => c.path.endsWith('/orders/prepare'))!
    expect(prepare.body).toEqual({
      sell: WETH,
      buy: USDC,
      sellAmount: '1000000000000000000',
      limitPrice: '2500',
      validFor: 1800,
    })
  })

  it('refuses a token that is not on the vault list and an amount with too many decimals', async () => {
    const { call, calls } = setup()
    const unknown = await call('vault_trade', { sell: 'DOGE', buy: 'USDC', amount: '1' })
    expect(unknown.json).toMatchObject({ ok: false, refused: true, code: 'token_not_allowed' })
    const fine = await call('vault_trade', { sell: 'USDC', buy: 'WETH', amount: '0.0000001' })
    expect(fine.json).toMatchObject({ ok: false, refused: true, code: 'invalid_amount' })
    expect(calls.some((c) => c.path.endsWith('/orders/prepare'))).toBe(false)
  })

  it('signs nothing when the prepared order is not the one asked for', async () => {
    const { call, signer } = setup({
      prepared: (p) => ({ ...p, order: { ...p.order, sellAmount: '999' } }),
    })
    const { json, isError } = await call('vault_trade', { sell: 'WETH', buy: 'USDC', amount: '1' })
    expect(isError).toBe(true)
    expect(json).toMatchObject({ ok: false, refused: false })
    expect(json.message).toMatch(/does not match/)
    expect(signer.typed).toBe(0)
  })

  it('relays the rule that blocked a trade', async () => {
    const { call } = setup({
      respond: (c) =>
        c.path.endsWith('/orders/prepare')
          ? Response.json(
              {
                error: 'That trade is over the per-trade limit.',
                code: 'cap_exceeded',
                rule: 'per_trade',
              },
              { status: 422 },
            )
          : undefined,
    })
    const { json, isError } = await call('vault_trade', { sell: 'WETH', buy: 'USDC', amount: '1' })
    expect(isError).toBe(true)
    expect(json).toEqual({
      ok: false,
      refused: true,
      code: 'cap_exceeded',
      rule: 'per_trade',
      message: 'That trade is over the per-trade limit.',
    })
  })
})

describe('vault_cancel and vault_pause', () => {
  it('signs a cancel intent for the order digest with the vault nonce', async () => {
    const { call, calls } = setup()
    const { json } = await call('vault_cancel', { orderId: UID.toUpperCase().replace('0X', '0x') })
    expect(json).toMatchObject({ ok: true, message: 'Order cancelled.', orderId: UID })
    const body = calls.find((c) => c.path.endsWith('/cancel'))!.body
    expect(body.uid).toBe(UID)
    const deadline = BigInt(body.intent.deadline)
    expect(deadline).toBe(BigInt(NOW + 300))
    const typed = agentIntentTypedData(vault, {
      action: AGENT_ACTION.cancel,
      target: DIGEST,
      nonce: 7n,
      deadline,
    })
    expect(await recoverTypedDataAddress({ ...typed, signature: body.intent.signature })).toBe(
      agent,
    )
  })

  it('refuses an order of another vault before signing anything', async () => {
    const { call, calls, signer } = setup()
    const other = `${DIGEST}${'44'.repeat(20)}00000fff`
    const { json } = await call('vault_cancel', { orderId: other })
    expect(json).toMatchObject({ ok: false, refused: true, code: 'order_not_found' })
    expect(calls).toHaveLength(0)
    expect(signer.typed).toBe(0)
  })

  it('signs a pause intent with a zero target', async () => {
    const { call, calls } = setup()
    const { json } = await call('vault_pause')
    expect(json).toMatchObject({ ok: true, paused: true, txHash: `0x${'ff'.repeat(32)}` })
    const body = calls.find((c) => c.path.endsWith('/pause'))!.body
    const typed = agentIntentTypedData(vault, {
      action: AGENT_ACTION.pause,
      nonce: 7n,
      deadline: BigInt(body.intent.deadline),
    })
    expect(typed.message.target).toBe(`0x${'0'.repeat(64)}`)
    expect(await recoverTypedDataAddress({ ...typed, signature: body.intent.signature })).toBe(
      agent,
    )
  })
})

describe('agent challenge', () => {
  it('is signed once and reused across calls, then renewed near its deadline', async () => {
    const clock = { ms: NOW_MS }
    const { call, signer } = setup({}, clock)
    await call('vault_status')
    await call('vault_activity')
    await call('vault_trade', { sell: 'WETH', buy: 'USDC', amount: '0.1' })
    expect(signer.messages).toHaveLength(1)
    clock.ms += 239_000
    await call('vault_status')
    expect(signer.messages).toHaveLength(1)
    clock.ms += 2_000
    await call('vault_status')
    expect(signer.messages).toHaveLength(2)
  })

  it('shares one signing between concurrent calls', async () => {
    const { call, signer } = setup()
    await Promise.all([call('vault_status'), call('vault_activity')])
    expect(signer.messages).toHaveLength(1)
  })
})

describe('errors', () => {
  it('maps a bad signature to the wrong-wallet message and drops the cached challenge', async () => {
    let denied = true
    const { call, signer } = setup({
      respond: (c) =>
        denied && c.method === 'GET'
          ? Response.json({ error: 'nope', code: 'unauthorized' }, { status: 401 })
          : undefined,
    })
    const first = await call('vault_status')
    expect(first.isError).toBe(true)
    expect(first.json).toMatchObject({ ok: false, refused: true, code: 'bad_signature' })
    expect(first.json.message).toContain("The signing wallet is not this vault's agent.")
    expect(first.json.message).toContain('`mm wallet address`')
    denied = false
    expect((await call('vault_status')).json.ok).toBe(true)
    expect(signer.messages).toHaveLength(2)
  })

  it('maps a bad_signature on submit the same way', async () => {
    const { call } = setup({
      respond: (c) =>
        c.path.endsWith('/orders')
          ? Response.json({ error: 'x', code: 'bad_signature' }, { status: 401 })
          : undefined,
    })
    const { json } = await call('vault_trade', { sell: 'WETH', buy: 'USDC', amount: '0.1' })
    expect(json).toMatchObject({ ok: false, refused: true, code: 'bad_signature' })
  })

  it('shows a signer problem as is, and hides anything unexpected', async () => {
    const pending = createLocalVault({
      signer: {
        address: agent,
        signMessage: async () => {
          throw new SignerError('Approval pending in MetaMask (2FA). Approve it, then retry.')
        },
        signTypedData: async () => '0x',
      },
      vault,
      baseUrl,
      fetchImpl: backend().fetchImpl,
    })
    expect(JSON.parse((await pending.call('vault_status', {})).text).message).toBe(
      'Approval pending in MetaMask (2FA). Approve it, then retry.',
    )
    const broken = createLocalVault({
      signer: localKeySigner(key),
      vault,
      baseUrl,
      fetchImpl: (async () => {
        throw new Error(`secret ${key}`)
      }) as unknown as typeof fetch,
    })
    const out = await broken.call('vault_status', {})
    expect(out.isError).toBe(true)
    expect(out.text).not.toContain(key)
    expect(JSON.parse(out.text)).toMatchObject({ ok: false, refused: false })
  })
})

describe('registration', () => {
  it('registers the same six tools as the hosted vault', async () => {
    const server = new McpServer({ name: 'test', version: '0' })
    registerVaultTools(
      server,
      createLocalVault({
        signer: localKeySigner(key),
        vault,
        baseUrl,
        fetchImpl: backend().fetchImpl,
      }),
    )
    const [a, b] = InMemoryTransport.createLinkedPair()
    const client = new Client({ name: 'test-client', version: '0' })
    await Promise.all([client.connect(a), server.connect(b)])
    const { tools } = await client.listTools()
    expect(tools.map((t) => t.name).sort()).toEqual([...VAULT_TOOL_NAMES].sort())
    const out = await client.callTool({ name: 'vault_pause', arguments: {} })
    expect(out.isError).toBe(false)
  })
})

describe('configuration', () => {
  const k = `0x${'22'.repeat(32)}`
  it('accepts the signer on its own, a key on its own, and a vault with either', () => {
    expect(readSignerConfig({ BEAMSWAP_SIGNER: 'metamask' }).mode).toBe('metamask')
    expect(readSignerConfig({ BEAMSWAP_WALLET_KEY: k }).mode).toBe('key')
    expect(readSignerConfig({ BEAMSWAP_WALLET_KEY: '', BEAMSWAP_SIGNER: '' }).mode).toBe('none')
    expect(
      readSignerConfig({ BEAMSWAP_SIGNER: 'metamask', BEAMSWAP_VAULT_ADDRESS: vault.toLowerCase() })
        .vaultAddress,
    ).toBe(vault)
  })

  it('refuses conflicting or incomplete settings', () => {
    expect(() => readSignerConfig({ BEAMSWAP_SIGNER: 'metamask', BEAMSWAP_WALLET_KEY: k })).toThrow(
      /not both/,
    )
    expect(() => readSignerConfig({ BEAMSWAP_SIGNER: 'ledger' })).toThrow(/must be "metamask"/)
    expect(() =>
      readSignerConfig({
        BEAMSWAP_WALLET_KEY: k,
        BEAMSWAP_VAULT_URL: 'https://x',
        BEAMSWAP_VAULT_ADDRESS: vault,
      }),
    ).toThrow(/BEAMSWAP_VAULT_URL or BEAMSWAP_VAULT_ADDRESS/)
    expect(() => readSignerConfig({ BEAMSWAP_VAULT_ADDRESS: vault })).toThrow(
      /needs the vault agent/,
    )
    expect(() =>
      readSignerConfig({ BEAMSWAP_WALLET_KEY: k, BEAMSWAP_VAULT_ADDRESS: '0x12' }),
    ).toThrow('BEAMSWAP_VAULT_ADDRESS is not a valid address')
    expect(parseVaultAddress(vault)).toBe(vault)
  })
})
