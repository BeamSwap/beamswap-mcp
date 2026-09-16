import type { ClientEvmSigner } from '@x402/evm'

export const NETWORK = 'eip155:8453'
export const USDC = '0x833589fcd6edb6e08f4c7c32d4f71b54bda02913'
export const TREASURY = '0x1c4ba64ed78cf04e1455226c122474ec82afc1ca'
const address = '0x[0-9a-fA-F]{40}'

/** List-price ceilings in USDC micro-units. Unknown and free routes cannot charge. */
export function priceCeiling(method: string, path: string, body?: string): bigint {
  if (method === 'GET') {
    if (new RegExp(`^/v1/token/${address}$`).test(path)) return 5_000n
    if (new RegExp(`^/v1/portfolio/${address}$`).test(path)) return 20_000n
    if (path === '/v1/quote') return 5_000n
    if (new RegExp(`^/v1/distribution/[^/]+/proof/${address}$`).test(path)) return 1_000n
  }
  if (method === 'POST') {
    if (path === '/v1/execute/route') return 10_000n
    if (path === '/v1/distribution') return 50_000_000n
    if (path === '/v1/watch') {
      try {
        const input = JSON.parse(body ?? '')
        if (
          Array.isArray(input.items) &&
          input.items.length >= 1 &&
          input.items.length <= 50 &&
          Number.isInteger(input.days) &&
          input.days >= 1 &&
          input.days <= 90
        ) {
          return BigInt(input.items.length) * BigInt(input.days) * 10_000n
        }
      } catch {
        /* An invalid request never authorizes spending. */
      }
    }
  }
  return 0n
}

export function permitsRequirement(r: unknown, ceiling: bigint, treasury: string): boolean {
  if (!r || typeof r !== 'object') return false
  const p = r as Record<string, unknown>
  const extra = p.extra as Record<string, unknown> | undefined
  return (
    p.scheme === 'exact' &&
    p.network === NETWORK &&
    typeof p.asset === 'string' &&
    p.asset.toLowerCase() === USDC &&
    typeof p.payTo === 'string' &&
    p.payTo.toLowerCase() === treasury.toLowerCase() &&
    typeof p.amount === 'string' &&
    /^\d{1,20}$/.test(p.amount) &&
    BigInt(p.amount) > 0n &&
    BigInt(p.amount) <= ceiling &&
    typeof p.maxTimeoutSeconds === 'number' &&
    Number.isInteger(p.maxTimeoutSeconds) &&
    p.maxTimeoutSeconds >= 1 &&
    p.maxTimeoutSeconds <= 300 &&
    extra?.name === 'USD Coin' &&
    extra.version === '2' &&
    (extra.assetTransferMethod === undefined || extra.assetTransferMethod === 'eip3009')
  )
}

const fields = [
  { name: 'from', type: 'address' },
  { name: 'to', type: 'address' },
  { name: 'value', type: 'uint256' },
  { name: 'validAfter', type: 'uint256' },
  { name: 'validBefore', type: 'uint256' },
  { name: 'nonce', type: 'bytes32' },
]

/** Defense in depth: the SDK never gets an unrestricted account signer. */
export function assertPaymentData(
  data: Parameters<ClientEvmSigner['signTypedData']>[0],
  payer: string,
  treasury: string,
  amount: bigint,
): void {
  const { domain: d, message: m } = data
  const now = BigInt(Math.floor(Date.now() / 1000))
  const validAfter = BigInt(String(m.validAfter))
  const validBefore = BigInt(String(m.validBefore))
  if (
    data.primaryType !== 'TransferWithAuthorization' ||
    JSON.stringify(data.types.TransferWithAuthorization) !== JSON.stringify(fields) ||
    Object.keys(data.types).some(
      (k) => k !== 'TransferWithAuthorization' && k !== 'EIP712Domain',
    ) ||
    Object.keys(d).some((k) => !['name', 'version', 'chainId', 'verifyingContract'].includes(k)) ||
    d.name !== 'USD Coin' ||
    d.version !== '2' ||
    BigInt(String(d.chainId)) !== 8453n ||
    String(d.verifyingContract).toLowerCase() !== USDC ||
    String(m.from).toLowerCase() !== payer.toLowerCase() ||
    String(m.to).toLowerCase() !== treasury.toLowerCase() ||
    BigInt(String(m.value)) !== amount ||
    amount <= 0n ||
    (validAfter !== 0n && (validAfter > now || validAfter < now - 605n)) ||
    validBefore <= now ||
    validBefore > now + 305n ||
    !/^0x[\da-f]{64}$/i.test(String(m.nonce))
  ) {
    throw new Error('Payment authorization failed the local safety policy')
  }
}
