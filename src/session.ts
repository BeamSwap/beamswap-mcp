import { getAddress, type Address } from 'viem'

/** Canonical EIP-712 shape shared by the API verifier and every signing client. */
export const SESSION_DOMAIN = {
  name: 'Beamswap Agent API',
  version: '1',
  chainId: 8453,
} as const

export const SESSION_TYPES = {
  Session: [
    { name: 'address', type: 'address' },
    { name: 'issuedAt', type: 'uint256' },
  ],
} as const

export function buildSessionMessage(address: Address, issuedAt: number) {
  return {
    domain: SESSION_DOMAIN,
    types: SESSION_TYPES,
    primaryType: 'Session' as const,
    message: { address: getAddress(address), issuedAt: BigInt(issuedAt) },
  }
}
