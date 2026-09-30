import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js'
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { describe, expect, it } from 'vitest'
import {
  createVaultRemote,
  parseVaultUrl,
  registerVaultTools,
  VAULT_TOOL_NAMES,
  type VaultRemote,
} from './vault'

const CAP = `bvc_${'0123456789abcdef'.repeat(2)}`
const URL_OK = `https://api.beamswap.io/mcp/v/${CAP}`
const UID = `0x${'cd'.repeat(56)}`

async function connect(remote: VaultRemote) {
  const server = new McpServer({ name: 'test', version: '0' })
  registerVaultTools(server, remote)
  const [a, b] = InMemoryTransport.createLinkedPair()
  const client = new Client({ name: 'test-client', version: '0' })
  await Promise.all([client.connect(a), server.connect(b)])
  return client
}

function rpcAnswer(payload: unknown, isError = false) {
  return Response.json({
    jsonrpc: '2.0',
    id: 1,
    result: { content: [{ type: 'text', text: JSON.stringify(payload) }], isError },
  })
}

describe('parseVaultUrl', () => {
  it('accepts the private https URL and a local development one', () => {
    expect(parseVaultUrl(URL_OK).pathname).toBe(`/mcp/v/${CAP}`)
    expect(parseVaultUrl(`http://localhost:4000/mcp/v/${CAP}`).port).toBe('4000')
  })

  it('refuses anything else without echoing it', () => {
    const bad = [
      'nope',
      `http://api.beamswap.io/mcp/v/${CAP}`,
      'https://api.beamswap.io/mcp',
      'https://api.beamswap.io/mcp/v/short',
      `https://api.beamswap.io/mcp/v/${CAP}?x=1`,
      `https://user:pw@api.beamswap.io/mcp/v/${CAP}`,
    ]
    for (const raw of bad) {
      let message = ''
      try {
        parseVaultUrl(raw)
      } catch (e) {
        message = (e as Error).message
      }
      expect(message, raw).toMatch(/BEAMSWAP_VAULT_URL/)
      expect(message).not.toContain(CAP)
    }
  })
})

describe('vault tools', () => {
  it('lists exactly the six vault tools and nothing that withdraws or changes rules', async () => {
    const client = await connect({ call: async () => ({ text: '{}', isError: false }) })
    const names = (await client.listTools()).tools.map((t) => t.name)
    expect(names.sort()).toEqual([...VAULT_TOOL_NAMES].sort())
    for (const forbidden of ['withdraw', 'resume', 'unpause', 'policy', 'limits', 'transfer']) {
      expect(names.some((n) => n.includes(forbidden))).toBe(false)
    }
  })

  it('forwards each tool call with its arguments to the private URL as JSON-RPC', async () => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const seen: Array<{ url: string; body: any }> = []
    const remote = createVaultRemote(URL_OK, (async (url: URL, init: RequestInit) => {
      seen.push({ url: String(url), body: JSON.parse(String(init.body)) })
      return rpcAnswer({ ok: true, message: 'Order placed.' })
    }) as unknown as typeof fetch)
    const client = await connect(remote)
    const res = (await client.callTool({
      name: 'vault_trade',
      arguments: { sell: 'USDC', buy: 'ETH', amount: '25.5', reason: 'dca' },
    })) as { isError?: boolean; content: Array<{ text: string }> }
    expect(res.isError).toBe(false)
    expect(JSON.parse(res.content[0]!.text)).toEqual({ ok: true, message: 'Order placed.' })
    expect(seen).toHaveLength(1)
    expect(seen[0]!.url).toBe(URL_OK)
    expect(seen[0]!.body).toMatchObject({
      jsonrpc: '2.0',
      method: 'tools/call',
      params: {
        name: 'vault_trade',
        arguments: { sell: 'USDC', buy: 'ETH', amount: '25.5', reason: 'dca' },
      },
    })
  })

  it('passes a refusal through unchanged, flagged as an error, naming the rule', async () => {
    const refusal = {
      ok: false,
      refused: true,
      code: 'per_trade_limit',
      rule: 'maxTradeUsd',
      message: 'This trade is 180 USD; your per-trade limit is 100 USD.',
    }
    const client = await connect(
      createVaultRemote(URL_OK, (async () => rpcAnswer(refusal, true)) as unknown as typeof fetch),
    )
    const res = (await client.callTool({
      name: 'vault_trade',
      arguments: { sell: 'USDC', buy: 'ETH', amount: '180' },
    })) as { isError?: boolean; content: Array<{ text: string }> }
    expect(res.isError).toBe(true)
    expect(JSON.parse(res.content[0]!.text)).toEqual(refusal)
  })

  it('validates arguments before anything is sent', async () => {
    let calls = 0
    const client = await connect({
      call: async () => {
        calls++
        return { text: '{}', isError: false }
      },
    })
    for (const [name, args] of [
      ['vault_trade', { sell: 'USDC', buy: 'ETH', amount: '1e3' }],
      ['vault_trade', { sell: 'USDC', buy: 'ETH', amount: '5', maxSlippageBps: 5000 }],
      ['vault_cancel', { orderId: '0x12' }],
      ['vault_limit_order', { sell: 'WETH', buy: 'USDC', amount: '1' }],
    ] as const) {
      const res = (await client
        .callTool({ name, arguments: args })
        .catch((e) => ({ isError: true, e }))) as {
        isError?: boolean
      }
      expect(res.isError, name).toBe(true)
    }
    expect(calls).toBe(0)
    await client.callTool({ name: 'vault_cancel', arguments: { orderId: UID } })
    expect(calls).toBe(1)
  })
})

describe('createVaultRemote', () => {
  const call = (fetchImpl: typeof fetch) =>
    createVaultRemote(URL_OK, fetchImpl).call('vault_status', {})

  it('maps transport and status failures to plain sentences that never contain the URL', async () => {
    const cases: Array<[typeof fetch, RegExp]> = [
      [
        (async () => {
          throw new Error(`connect ECONNREFUSED ${URL_OK}`)
        }) as unknown as typeof fetch,
        /Could not reach Beamswap/,
      ],
      [
        (async () => new Response('{}', { status: 404 })) as unknown as typeof fetch,
        /not valid any more/,
      ],
      [
        (async () => new Response('{}', { status: 429 })) as unknown as typeof fetch,
        /Too many requests/,
      ],
      [
        (async () => new Response('{}', { status: 503 })) as unknown as typeof fetch,
        /not available/,
      ],
      [(async () => new Response('x', { status: 500 })) as unknown as typeof fetch, /status 500/],
      [
        (async () => new Response('not json', { status: 200 })) as unknown as typeof fetch,
        /could not read/,
      ],
      [
        (async () =>
          Response.json({
            jsonrpc: '2.0',
            id: 1,
            error: { message: 'x' },
          })) as unknown as typeof fetch,
        /unexpected answer/,
      ],
    ]
    for (const [f, expected] of cases) {
      const r = await call(f)
      expect(r.isError).toBe(true)
      expect(JSON.parse(r.text).message).toMatch(expected)
      expect(r.text).not.toContain(CAP)
    }
  })

  it('reads an event-stream answer too', async () => {
    const payload = {
      jsonrpc: '2.0',
      id: 1,
      result: { content: [{ type: 'text', text: '{"ok":true}' }] },
    }
    const r = await call(
      (async () =>
        new Response(`event: message\ndata: ${JSON.stringify(payload)}\n\n`, {
          headers: { 'content-type': 'text/event-stream' },
        })) as unknown as typeof fetch,
    )
    expect(r).toEqual({ text: '{"ok":true}', isError: false })
  })

  it('does not follow redirects with the capability', async () => {
    let init: RequestInit | undefined
    await call((async (_u: URL, i: RequestInit) => {
      init = i
      return rpcAnswer({ ok: true })
    }) as unknown as typeof fetch)
    expect(init?.redirect).toBe('manual')
  })
})
