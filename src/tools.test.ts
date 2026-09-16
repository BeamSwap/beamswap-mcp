import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js'
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { describe, expect, it } from 'vitest'
import { createApiClient, type ApiClient } from './client'
import { registerTools } from './tools'

/**
 * Drives the real `McpServer` through an in-memory transport, so the assertions cover what an
 * agent actually sees (`tools/list`, `tools/call`) rather than the SDK's private registry.
 */
async function connectApi(api: ApiClient) {
  const server = new McpServer({ name: 'test', version: '0' })
  registerTools(server, api)
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair()
  const client = new Client({ name: 'test-client', version: '0' })
  await Promise.all([client.connect(clientTransport), server.connect(serverTransport)])
  return client
}

function connect(fetchImpl: typeof fetch) {
  return connectApi(createApiClient({ baseUrl: 'http://api', fetchImpl }))
}

/** Same encoding the x402 resource server uses for the `PAYMENT-RESPONSE` header. */
function paymentResponseHeader(settle: Record<string, unknown>) {
  return Buffer.from(JSON.stringify(settle), 'utf8').toString('base64')
}

function textOf(result: unknown) {
  return (result as { content: Array<{ type: string; text: string }> }).content[0]!.text
}

/** A quote call whose only variable is the HTTP response the API gives back. */
async function quoteAgainst(res: () => Response) {
  const api = createApiClient({ baseUrl: 'http://api', fetchImpl: async () => res() })
  const client = await connectApi(api)
  return client.callTool({
    name: 'swap_quote',
    arguments: { sell: 'ETH', buy: 'ETH', amount: '1' },
  })
}

describe('mcp tools', () => {
  it('exposes the API routes and session creation as tools', async () => {
    const client = await connect(async () => Response.json({}))
    const { tools } = await client.listTools()
    expect(tools.map((t) => t.name).sort()).toEqual([
      'distribution_create',
      'distribution_get',
      'distribution_proof',
      'portfolio',
      'session_create',
      'swap_quote',
      'swap_route',
      'token_info',
      'watch_create',
      'watch_delete',
      'watch_get',
    ])
    // Only the five that cost something quote a price; `watch_get` and `watch_delete` say "Free."
    const priced = tools.filter((t) => (t.description ?? '').includes('via x402'))
    expect(priced.map((t) => t.name).sort()).toEqual([
      'distribution_create',
      'distribution_proof',
      'portfolio',
      'swap_quote',
      'swap_route',
      'token_info',
      'watch_create',
    ])
    expect(priced.every((t) => (t.description ?? '').includes('$'))).toBe(true)
    expect(tools.find((t) => t.name === 'watch_create')?.description).toBe(
      'Watch Base balances or USD prices; signed webhook on trip. $0.01 per item per day via x402.',
    )
  })

  it('creates a signed session, retains its token, and sends it on later calls', async () => {
    const calls: Array<{ url: string; init: RequestInit | undefined }> = []
    const walletKey = `0x${'11'.repeat(32)}` as `0x${string}`
    const api = createApiClient({
      baseUrl: 'http://api',
      walletKey,
      fetchImpl: async (input, init) => {
        const url = input instanceof Request ? input.url : String(input)
        const requestInit =
          input instanceof Request
            ? {
                method: input.method,
                headers: Object.fromEntries(input.headers),
                body: await input.clone().text(),
              }
            : init
        calls.push({ url, init: requestInit })
        if (url.endsWith('/v1/session')) {
          return Response.json({ token: 'memory-only-jwt', expiresAt: 2_000_000_000 })
        }
        return Response.json({ ok: true })
      },
    })
    const client = await connectApi(api)
    const created = await client.callTool({ name: 'session_create', arguments: {} })
    expect(JSON.parse(textOf(created))).toMatchObject({ active: true, expiresAt: 2_000_000_000 })
    expect(textOf(created)).not.toContain('memory-only-jwt')
    const posted = JSON.parse(String(calls[0]?.init?.body))
    expect(posted).toMatchObject({
      address: '0x19E7E376E7C213B7E7e7e46cc70A5dD086DAff2A',
    })
    expect(typeof posted.issuedAt).toBe('number')
    expect(posted.signature).toMatch(/^0x[0-9a-f]+$/)

    await client.callTool({
      name: 'swap_quote',
      arguments: { sell: 'ETH', buy: 'ETH', amount: '1' },
    })
    expect(calls[1]?.init?.headers).toMatchObject({ authorization: 'Bearer memory-only-jwt' })
  })

  it('forwards distribution create, get and proof calls without changing wei strings', async () => {
    const calls: Array<{ url: string; init: RequestInit | undefined }> = []
    const client = await connect(async (input, init) => {
      calls.push({ url: String(input), init })
      return Response.json({ id: 'dist-1' }, { status: init?.method === 'POST' ? 201 : 200 })
    })
    const amount = '123456789012345678901234567890'
    await client.callTool({
      name: 'distribution_create',
      arguments: {
        token: '0x1111111111111111111111111111111111111111',
        entries: [{ address: '0x2222222222222222222222222222222222222222', amount }],
        deadline: 2_000_000_000,
        name: 'Community round',
      },
    })
    expect(calls[0]!.url).toBe('http://api/v1/distribution')
    expect(calls[0]!.init?.method).toBe('POST')
    expect(JSON.parse(String(calls[0]!.init?.body))).toEqual({
      token: '0x1111111111111111111111111111111111111111',
      entries: [{ address: '0x2222222222222222222222222222222222222222', amount }],
      deadline: 2_000_000_000,
      name: 'Community round',
    })

    await client.callTool({ name: 'distribution_get', arguments: { id: 'dist/one' } })
    await client.callTool({
      name: 'distribution_proof',
      arguments: { id: 'dist/one', address: '0x22?proof=other' },
    })
    expect(calls[1]!.url).toBe('http://api/v1/distribution/dist%2Fone')
    expect(calls[2]!.url).toBe('http://api/v1/distribution/dist%2Fone/proof/0x22%3Fproof%3Dother')
  })

  it('swap_quote forwards query params and returns the body as JSON text', async () => {
    const calls: string[] = []
    const client = await connect(async (input) => {
      calls.push(String(input))
      return Response.json({ best: { source: 'kyberswap', amountOut: '1', minOut: '1' } })
    })
    const out = await client.callTool({
      name: 'swap_quote',
      arguments: {
        sell: 'ETH',
        buy: '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913',
        amount: '1000',
        slippageBps: 50,
      },
    })
    expect(calls[0]).toBe(
      'http://api/v1/quote?sell=ETH&buy=0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913&amount=1000&slippageBps=50',
    )
    expect(JSON.parse(textOf(out))).toMatchObject({ best: { source: 'kyberswap' } })
    expect(out.isError).toBeFalsy()
  })

  it('keeps a big sell amount exact and defaults slippageBps to 50', async () => {
    const calls: string[] = []
    const client = await connect(async (input) => {
      calls.push(String(input))
      return Response.json({})
    })
    await client.callTool({
      name: 'swap_quote',
      arguments: { sell: 'ETH', buy: 'ETH', amount: '123456789012345678901234567890' },
    })
    expect(calls[0]).toBe(
      'http://api/v1/quote?sell=ETH&buy=ETH&amount=123456789012345678901234567890&slippageBps=50',
    )
  })

  it('swap_route posts the intent as a JSON body and defaults slippageBps to 50', async () => {
    const calls: Array<{ url: string; init: RequestInit | undefined }> = []
    const client = await connect(async (input, init) => {
      calls.push({ url: String(input), init })
      return Response.json({ best: { source: '0x', to: '0x22', data: '0xaa', value: '1000' } })
    })
    const out = await client.callTool({
      name: 'swap_route',
      arguments: {
        sell: 'ETH',
        buy: '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913',
        // Above 2^53: the whole point of keeping the amount a string end to end.
        amount: '123456789012345678901234567890',
        from: '0xe598c65f960a8c39b539f31cabf2c28f1567fd54',
      },
    })
    expect(calls[0]!.url).toBe('http://api/v1/execute/route')
    expect(calls[0]!.init?.method).toBe('POST')
    expect(calls[0]!.init?.headers).toMatchObject({ 'content-type': 'application/json' })
    expect(JSON.parse(String(calls[0]!.init?.body))).toEqual({
      sell: 'ETH',
      buy: '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913',
      amount: '123456789012345678901234567890',
      from: '0xe598c65f960a8c39b539f31cabf2c28f1567fd54',
      slippageBps: 50,
    })
    expect(JSON.parse(textOf(out))).toMatchObject({ best: { source: '0x' } })
    expect(out.isError).toBeFalsy()
  })

  it('swap_route sends recipient only when the caller named one', async () => {
    const bodies: string[] = []
    const client = await connect(async (_input, init) => {
      bodies.push(String(init?.body))
      return Response.json({})
    })
    await client.callTool({
      name: 'swap_route',
      arguments: {
        sell: 'ETH',
        buy: '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913',
        amount: '1000',
        from: '0xe598c65f960a8c39b539f31cabf2c28f1567fd54',
        recipient: '0x1111111111111111111111111111111111111111',
        slippageBps: 100,
      },
    })
    expect(JSON.parse(bodies[0]!)).toMatchObject({
      recipient: '0x1111111111111111111111111111111111111111',
      slippageBps: 100,
    })
  })

  it('token_info and portfolio hit the path routes and surface the settlement tx', async () => {
    const calls: string[] = []
    const client = await connect(async (input) => {
      calls.push(String(input))
      return Response.json(
        { symbol: 'GLINT' },
        {
          headers: {
            'PAYMENT-RESPONSE': paymentResponseHeader({ success: true, transaction: '0xabc' }),
          },
        },
      )
    })
    const token = await client.callTool({
      name: 'token_info',
      arguments: { address: '0x55B423D0189F2315073DFb49845ea9eFFD9815A4' },
    })
    expect(calls[0]).toBe('http://api/v1/token/0x55B423D0189F2315073DFb49845ea9eFFD9815A4')
    expect(JSON.parse(textOf(token))).toEqual({ symbol: 'GLINT', _payment: { tx: '0xabc' } })

    await client.callTool({
      name: 'portfolio',
      arguments: { address: '0xe598c65f960a8c39b539f31cabf2c28f1567fd54' },
    })
    expect(calls[1]).toBe('http://api/v1/portfolio/0xe598c65f960a8c39b539f31cabf2c28f1567fd54')
  })

  it('passes the session token as a bearer header when one is configured', async () => {
    const seen: Array<Record<string, string>> = []
    const fetchImpl: typeof fetch = async (_input, init) => {
      seen.push((init?.headers ?? {}) as Record<string, string>)
      return Response.json({})
    }
    const api = createApiClient({ baseUrl: 'http://api/', fetchImpl, sessionToken: 'jwt-123' })
    const res = await api.get('/v1/quote')
    expect(seen[0]).toEqual({ authorization: 'Bearer jwt-123' })
    expect(res).toEqual({ status: 200, body: {}, paymentTx: null })
    // A POST spends the same quota, so it carries the same token next to its content type.
    await api.post('/v1/execute/route', { sell: 'ETH' })
    expect(seen[1]).toEqual({
      'content-type': 'application/json',
      authorization: 'Bearer jwt-123',
    })
  })

  it('reports a 4xx as a tool error carrying the status and the body', async () => {
    const out = await quoteAgainst(() =>
      Response.json({ error: 'amount must be a positive integer' }, { status: 400 }),
    )
    expect(out.isError).toBe(true)
    expect(JSON.parse(textOf(out))).toEqual({
      status: 400,
      error: { error: 'amount must be a positive integer' },
    })
  })

  it('tells the operator when a 402 arrived because no wallet key is set', async () => {
    const out = await quoteAgainst(() =>
      Response.json({ accepts: [{ scheme: 'exact', price: '$0.005' }] }, { status: 402 }),
    )
    expect(out.isError).toBe(true)
    const payload = JSON.parse(textOf(out))
    expect(payload.status).toBe(402)
    expect(payload.hint).toContain('BEAMSWAP_WALLET_KEY is not set')
    expect(payload.error).toEqual({ accepts: [{ scheme: 'exact', price: '$0.005' }] })
  })

  it('says the configured wallet could not pay when a 402 survives a funded client', async () => {
    // `createApiClient` would send this through the x402 payment wrapper, so the branch is driven
    // through a stand-in client instead of a real key.
    const api: ApiClient = {
      hasWallet: true,
      createSession: async () => ({ status: 200, body: {}, paymentTx: null }),
      get: async () => ({ status: 402, body: { accepts: [] }, paymentTx: null }),
      post: async () => ({ status: 402, body: { accepts: [] }, paymentTx: null }),
      del: async () => ({ status: 402, body: { accepts: [] }, paymentTx: null }),
    }
    const client = await connectApi(api)
    const out = await client.callTool({
      name: 'portfolio',
      arguments: { address: '0xe598c65f960a8c39b539f31cabf2c28f1567fd54' },
    })
    expect(out.isError).toBe(true)
    expect(JSON.parse(textOf(out)).hint).toContain('could not settle')
  })

  it('watch_create posts items, days and the webhook URL and returns the body as text', async () => {
    const calls: Array<{ url: string; init: RequestInit | undefined }> = []
    const client = await connect(async (input, init) => {
      calls.push({ url: String(input), init })
      return Response.json(
        { ids: ['w1'], secret: 'abc', expiresAt: '2026-10-01T00:00:00.000Z', price: '$0.60' },
        { status: 201 },
      )
    })
    const out = await client.callTool({
      name: 'watch_create',
      arguments: {
        items: [
          {
            type: 'balance_below',
            address: '0xe598c65f960a8c39b539f31cabf2c28f1567fd54',
            token: 'native',
            // A wei threshold above 2^53: a string end to end, exactly like a sell amount.
            threshold: '123456789012345678901234567890',
          },
          {
            type: 'price_cross',
            token: '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913',
            usd: 1.01,
            direction: 'above',
          },
        ],
        days: 30,
        webhookUrl: 'https://hooks.example.com/beamswap',
      },
    })
    expect(calls[0]!.url).toBe('http://api/v1/watch')
    expect(calls[0]!.init?.method).toBe('POST')
    expect(calls[0]!.init?.headers).toMatchObject({ 'content-type': 'application/json' })
    expect(JSON.parse(String(calls[0]!.init?.body))).toEqual({
      items: [
        {
          type: 'balance_below',
          address: '0xe598c65f960a8c39b539f31cabf2c28f1567fd54',
          token: 'native',
          threshold: '123456789012345678901234567890',
        },
        {
          type: 'price_cross',
          token: '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913',
          usd: 1.01,
          direction: 'above',
        },
      ],
      days: 30,
      webhookUrl: 'https://hooks.example.com/beamswap',
    })
    expect(JSON.parse(textOf(out))).toMatchObject({ ids: ['w1'], secret: 'abc' })
    expect(out.isError).toBeFalsy()
  })

  it('watch_get reads the watch and watch_delete cancels it with a DELETE', async () => {
    const calls: Array<{ url: string; method: string | undefined }> = []
    const client = await connect(async (input, init) => {
      calls.push({ url: String(input), method: init?.method })
      // 204 has no body at all; the client decodes that as `null` rather than throwing.
      return init?.method === 'DELETE'
        ? new Response(null, { status: 204 })
        : Response.json({ id: 'w1', status: 'active' })
    })
    const got = await client.callTool({ name: 'watch_get', arguments: { id: 'w1' } })
    expect(calls[0]).toEqual({ url: 'http://api/v1/watch/w1', method: undefined })
    expect(JSON.parse(textOf(got))).toMatchObject({ id: 'w1', status: 'active' })

    const deleted = await client.callTool({ name: 'watch_delete', arguments: { id: 'w1' } })
    expect(calls[1]).toEqual({ url: 'http://api/v1/watch/w1', method: 'DELETE' })
    expect(textOf(deleted)).toBe('null')
    expect(deleted.isError).toBeFalsy()
  })

  // The id is a string an agent hands us, not something we minted: one with a slash or a query
  // character in it would otherwise reshape the path it is pasted into.
  it('escapes a watch id that is not a plain uuid', async () => {
    const calls: string[] = []
    const client = await connect(async (input) => {
      calls.push(String(input))
      return Response.json({ error: 'watch not found' }, { status: 404 })
    })
    await client.callTool({ name: 'watch_get', arguments: { id: '../openapi.json?x=1' } })
    expect(calls[0]).toBe('http://api/v1/watch/..%2Fopenapi.json%3Fx%3D1')
  })

  it('reports a non-JSON 5xx body as such instead of as a null result', async () => {
    const out = await quoteAgainst(
      () =>
        new Response('<html><body>502 Bad Gateway</body></html>', {
          status: 502,
          headers: { 'content-type': 'text/html' },
        }),
    )
    expect(out.isError).toBe(true)
    expect(JSON.parse(textOf(out))).toEqual({ status: 502, error: 'non-JSON response' })
  })
})
