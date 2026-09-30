import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js'
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { describe, expect, it } from 'vitest'
import { createApiClient } from './client'
import { registerTools } from './tools'

const WETH = '0x4200000000000000000000000000000000000006'
const USDC = '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913'
const HASH = `0x${'ab'.repeat(32)}`
const UID = `0x${'cd'.repeat(56)}`

async function connect(fetchImpl: typeof fetch) {
  const server = new McpServer({ name: 'test', version: '0' })
  registerTools(server, createApiClient({ baseUrl: 'http://api', fetchImpl }))
  const [a, b] = InMemoryTransport.createLinkedPair()
  const client = new Client({ name: 'test-client', version: '0' })
  await Promise.all([client.connect(a), server.connect(b)])
  return client
}

async function call(client: Client, name: string, args: Record<string, unknown>) {
  const res = (await client.callTool({ name, arguments: args })) as {
    isError?: boolean
    content: Array<{ text: string }>
  }
  return { isError: res.isError, body: JSON.parse(res.content[0]!.text) as Record<string, unknown> }
}

describe('free review-link tools', () => {
  it('builds the limit order link without any request', async () => {
    const seen: string[] = []
    const client = await connect(async (url) => {
      seen.push(String(url))
      return Response.json({})
    })
    const { body } = await call(client, 'limit_order_prepare', {
      sell: 'WETH',
      buy: USDC,
      amount: '0.5',
      price: '3000',
      expires: '30d',
    })
    expect(body.reviewUrl).toBe(
      `https://app.beamswap.io/trade?mode=limit&sell=WETH&buy=${USDC}&amount=0.5&price=3000&expires=30d`,
    )
    expect(seen).toEqual([])
  })

  it('previews an automation with a POST and returns the /automate link', async () => {
    let seen: { url: string; body: string } | null = null
    const client = await connect(async (url, init) => {
      seen = { url: String(url), body: String(init?.body) }
      return Response.json({ kind: 'recurring', summary: 'Buy weekly', canCreate: true })
    })
    const { body } = await call(client, 'automation_preview', {
      kind: 'recurring',
      params: { sellToken: USDC, buyToken: WETH, amountPerRun: '10000000' },
      prefill: { amount: '10', runs: '12' },
    })
    expect(seen!.url).toBe('http://api/v1/automations/preview')
    expect(JSON.parse(seen!.body)).not.toHaveProperty('prefill')
    expect(body.reviewUrl).toBe(
      `https://app.beamswap.io/automate?template=recurring&sell=${USDC}&buy=${WETH}&amount=10&runs=12`,
    )
  })

  it('drops transaction data from a cross-chain quote', async () => {
    const client = await connect(async () =>
      Response.json({
        fromChain: 1,
        toChain: 8453,
        fromToken: { address: WETH, symbol: 'WETH', decimals: 18, chainId: 1 },
        toToken: { address: USDC, symbol: 'USDC', decimals: 6, chainId: 8453 },
        fromAmount: '1000000000000000000',
        toAmount: '3000000000',
        approvalAddress: '0x1231DEB6f5749EF6cE6943a275A1D3E7486F4EaE',
        transactionRequest: { to: WETH, data: '0xdeadbeef', value: '0', chainId: 1 },
      }),
    )
    const { body } = await call(client, 'crosschain_quote', {
      fromChain: 1,
      toChain: 8453,
      fromToken: WETH,
      toToken: USDC,
      fromAmount: '1000000000000000000',
      fromAddress: '0x2222222222222222222222222222222222222222',
    })
    expect(JSON.stringify(body)).not.toContain('deadbeef')
    expect(body).not.toHaveProperty('transactionRequest')
    expect(body.reviewUrl).toBe(
      `https://app.beamswap.io/trade?from=1&to=8453&sellToken=${WETH}&buyToken=${USDC}&amount=1`,
    )
  })

  it('escapes the order uid and links status and order', async () => {
    const urls: string[] = []
    const client = await connect(async (url) => {
      urls.push(String(url))
      return Response.json({ status: 'open' })
    })
    const order = await call(client, 'order_status', { uid: UID })
    expect(order.body.explorerUrl).toBe(`https://explorer.cow.fi/base/orders/${UID}`)
    const status = await call(client, 'crosschain_status', { fromChain: 8453, txHash: HASH })
    expect(status.body.explorerUrl).toBe(`https://scan.li.fi/tx/${HASH}`)
    expect(urls).toEqual([
      `http://api/v1/orders/${UID}`,
      `http://api/v1/crosschain/status?fromChain=8453&txHash=${HASH}`,
    ])
  })

  it('reports an API refusal as an error result', async () => {
    const client = await connect(async () => Response.json({ error: 'bad' }, { status: 400 }))
    const { isError, body } = await call(client, 'order_status', { uid: UID })
    expect(isError).toBe(true)
    expect(body.status).toBe(400)
  })
})
