import { mkdtemp, rm, readFile, readdir } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { privateKeyToAccount } from 'viem/accounts'
import { describe, expect, it } from 'vitest'
import { createApiClient } from './client'
import { NETWORK, TREASURY, USDC } from './payment-policy'
import { fileRecoveryStore, memoryRecoveryStore, type RecoveryStore } from './payment-recovery'

const walletKey = `0x${'11'.repeat(32)}` as const
const payer = privateKeyToAccount(walletKey).address
const address = '0x1111111111111111111111111111111111111111'
const tx = `0x${'ab'.repeat(32)}`
const baseUrl = 'https://mock.beamswap.test'
const encode = (value: unknown) => Buffer.from(JSON.stringify(value)).toString('base64')

function harness(
  options: {
    requirement?: Record<string, unknown>
    recoveryStore?: RecoveryStore
    outcome?: 'lost' | '500' | '402' | 'no-receipt' | 'bad-body' | 'wrong-receipt'
    resource?: string
    amount?: string
    barrier?: Promise<void>
  } = {},
) {
  const calls: Request[] = []
  const payloads: Array<{
    payload: { authorization: { from: string; to: string; value: string }; signature: string }
  }> = []
  const api = createApiClient({
    baseUrl,
    walletKey,
    recoveryStore: options.recoveryStore ?? memoryRecoveryStore(),
    fetchImpl: async (input, init) => {
      const req = new Request(input, init)
      calls.push(req)
      const payment = req.headers.get('payment-signature')
      if (!payment) {
        const requirement = {
          scheme: 'exact',
          network: NETWORK,
          asset: USDC,
          payTo: TREASURY,
          amount: options.amount ?? '5000',
          maxTimeoutSeconds: 300,
          extra: { name: 'USD Coin', version: '2' },
          ...options.requirement,
        }
        return Response.json(
          {},
          {
            status: 402,
            headers: {
              'payment-required': encode({
                x402Version: 2,
                resource: { url: options.resource ?? req.url, mimeType: 'application/json' },
                accepts: [requirement],
              }),
            },
          },
        )
      }
      payloads.push(JSON.parse(Buffer.from(payment, 'base64').toString()))
      if (options.barrier) await options.barrier
      if (options.outcome === 'lost') throw new Error('Response lost after submission')
      const receipt = {
        success: true,
        network: NETWORK,
        payer,
        transaction: tx,
        ...(options.outcome === 'wrong-receipt' ? { payer: address } : {}),
      }
      return new Response(
        options.outcome === 'bad-body' ? '<html>bad</html>' : JSON.stringify({ ok: true }),
        {
          status: options.outcome === '500' ? 500 : options.outcome === '402' ? 402 : 200,
          headers: options.outcome === 'no-receipt' ? {} : { 'payment-response': encode(receipt) },
        },
      )
    },
  })
  return { api, calls, payloads }
}

describe('payment policy through the real x402 signer', () => {
  it('pays exactly the discounted Base USDC price once, to the pinned treasury', async () => {
    const h = harness({ amount: '3000' })
    const result = await h.api.get(`/v1/token/${address}`)
    expect(result).toEqual({ status: 200, body: { ok: true }, paymentTx: tx })
    expect(h.payloads).toHaveLength(1)
    expect(h.payloads[0].payload.authorization).toMatchObject({ from: payer, value: '3000' })
    expect(h.payloads[0].payload.authorization.to.toLowerCase()).toBe(TREASURY)
    expect(h.calls.every((r) => r.redirect === 'error')).toBe(true)
    expect((await h.api.get(`/v1/token/${address}`)).status).toBe(200)
  })

  it.each([
    ['Ethereum instead of Base', { network: 'eip155:1' }],
    ['another asset', { asset: address }],
    ['another recipient', { payTo: address }],
    ['overpriced token info', { amount: '50000000' }],
    ['zero amount', { amount: '0' }],
    ['another scheme', { scheme: 'upto' }],
    ['Permit2', { extra: { name: 'USD Coin', version: '2', assetTransferMethod: 'permit2' } }],
    ['another domain', { extra: { name: 'Attacker', version: '2' } }],
    ['excess validity', { maxTimeoutSeconds: 301 }],
  ])('never signs %s', async (_name, requirement) => {
    const h = harness({ requirement })
    expect((await h.api.get(`/v1/token/${address}`)).status).toBe(502)
    expect(h.payloads).toHaveLength(0)
    expect(h.calls).toHaveLength(1)
  })

  it('refuses payment for free/unknown routes and substituted resources', async () => {
    const h = harness()
    await h.api.get('/v1/distribution/free')
    await h.api.del('/v1/watch/free')
    await h.api.get('/unlisted')
    expect(h.payloads).toHaveLength(0)
    const substituted = harness({ resource: `${baseUrl}/v1/distribution` })
    expect((await substituted.api.get(`/v1/token/${address}`)).status).toBe(502)
    expect(substituted.payloads).toHaveLength(0)
  })

  it('derives watch price from validated days and item count, never a server maximum', async () => {
    const h = harness({ amount: '60000' })
    expect((await h.api.post('/v1/watch', { items: [{}, {}], days: 3 })).status).toBe(200)
    const overpriced = harness({ amount: '60001' })
    expect((await overpriced.api.post('/v1/watch', { items: [{}, {}], days: 3 })).status).toBe(502)
    expect(overpriced.payloads).toHaveLength(0)
    const invalid = harness()
    await invalid.api.post('/v1/watch', { items: [{}], days: 1.5 })
    expect(invalid.payloads).toHaveLength(0)
  })
})

describe('uncertain payments', () => {
  it.each(['lost', '500', '402', 'no-receipt', 'bad-body', 'wrong-receipt'] as const)(
    'blocks fresh payment after %s, including a different operation',
    async (outcome) => {
      const h = harness({ amount: '50000000', outcome })
      const first = await h.api.post('/v1/distribution', { entries: [] })
      expect(first.paymentOutcomeUnknown).toBe(true)
      expect(first.body).toMatchObject({ doNotRetry: true, recoveryId: expect.any(String) })
      const again = await h.api.post('/v1/distribution', { entries: [{ changed: true }] })
      expect(again).toEqual(first)
      expect(h.payloads).toHaveLength(1)
      expect(h.calls).toHaveLength(2)
    },
  )

  it('persists across restart, contains no signature, and requires the matching recovery ID', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'beamswap-recovery-'))
    try {
      const h = harness({ outcome: 'lost', recoveryStore: fileRecoveryStore(directory) })
      const first = await h.api.get(`/v1/token/${address}`)
      const restarted = harness({ recoveryStore: fileRecoveryStore(directory) })
      expect(await restarted.api.get(`/v1/token/${address}`)).toEqual(first)
      expect(restarted.calls).toHaveLength(0)
      const content = await readFile(join(directory, (await readdir(directory))[0]), 'utf8')
      expect(content).not.toContain(walletKey)
      expect(content).not.toContain(h.payloads[0].payload.signature)
      const store = fileRecoveryStore(directory)
      await expect(store.clear(payer, 'wrong')).rejects.toThrow('does not match')
      await store.clear(payer, (first.body as { recoveryId: string }).recoveryId)
      expect((await restarted.api.get(`/v1/token/${address}`)).status).toBe(200)
    } finally {
      await rm(directory, { recursive: true, force: true })
    }
  })

  it('allows only one concurrent wallet payment and never automatically clears a stale lock', async () => {
    let release!: () => void
    const barrier = new Promise<void>((resolve) => {
      release = resolve
    })
    const h = harness({ barrier })
    const first = h.api.get(`/v1/token/${address}`)
    while (h.payloads.length === 0) await new Promise((resolve) => setTimeout(resolve, 1))
    const second = await h.api.get('/v1/quote')
    expect(second.paymentOutcomeUnknown).toBe(true)
    expect(h.payloads).toHaveLength(1)
    release()
    expect((await first).status).toBe(200)
  })
})
