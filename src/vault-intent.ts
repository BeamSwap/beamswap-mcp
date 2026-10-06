/**
 * The EIP-712 `AgentIntent` a vault agent signs to place, cancel or pause. Ported from
 * `agentIntentTypedData` and `AGENT_ACTION` in `packages/shared/src/vault.ts` of the Beamswap app
 * repository, which stays the source of truth: change both together, and the contract
 * (`AgentVault.sol`) with them.
 */
import type { Address, Hex } from 'viem'

/** `AgentVault.ACTION_*`. */
export const AGENT_ACTION = { place: 1, cancel: 2, pause: 3 } as const
export type AgentAction = (typeof AGENT_ACTION)[keyof typeof AGENT_ACTION]

/** `AgentIntent(uint8 action,bytes32 target,uint256 nonce,uint256 deadline)`. */
export const AGENT_INTENT_TYPES = {
  AgentIntent: [
    { name: 'action', type: 'uint8' },
    { name: 'target', type: 'bytes32' },
    { name: 'nonce', type: 'uint256' },
    { name: 'deadline', type: 'uint256' },
  ],
} as const

const ZERO_BYTES32: Hex = `0x${'0'.repeat(64)}`

/** Vaults live on Base only. */
export const VAULT_CHAIN_ID = 8453

export interface AgentIntentInput {
  action: AgentAction
  /** GPv2 order digest for place and cancel (first 32 bytes of the uid), zero for pause. */
  target?: Hex
  /** Must equal `vault.nonce()` when the intent is submitted. */
  nonce: bigint
  /** Unix seconds; the vault rejects the intent after this time. */
  deadline: bigint
}

export function agentIntentTypedData(vault: Address, intent: AgentIntentInput) {
  return {
    domain: {
      name: 'AgentVault',
      version: '1',
      chainId: VAULT_CHAIN_ID,
      verifyingContract: vault,
    },
    types: AGENT_INTENT_TYPES,
    primaryType: 'AgentIntent' as const,
    message: {
      action: intent.action,
      target: intent.target ?? ZERO_BYTES32,
      nonce: intent.nonce,
      deadline: intent.deadline,
    },
  }
}
