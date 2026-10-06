/**
 * Signer and vault settings read from the environment, validated before anything is started so a
 * conflicting combination stops the server with one clear sentence.
 */
import type { Address, Hex } from 'viem'
import { parseVaultAddress } from './vault-local'

export interface SignerConfig {
  /** `metamask` signs through the `mm` CLI; `key` uses `BEAMSWAP_WALLET_KEY`; `none` has no wallet. */
  mode: 'metamask' | 'key' | 'none'
  walletKey?: Hex
  vaultAddress?: Address
}

export function readSignerConfig(env: Record<string, string | undefined>): SignerConfig {
  // Blank means unset: MCP hosts often forward every configured variable, empty or not.
  const walletKey = (env.BEAMSWAP_WALLET_KEY || undefined) as Hex | undefined
  const signer = env.BEAMSWAP_SIGNER || undefined
  if (signer !== undefined && signer !== 'metamask') {
    throw new Error('BEAMSWAP_SIGNER must be "metamask" when set')
  }
  if (signer && walletKey) {
    throw new Error('Set either BEAMSWAP_SIGNER or BEAMSWAP_WALLET_KEY, not both')
  }
  if (env.BEAMSWAP_VAULT_URL && env.BEAMSWAP_VAULT_ADDRESS) {
    throw new Error('Set either BEAMSWAP_VAULT_URL or BEAMSWAP_VAULT_ADDRESS, not both')
  }
  const vaultAddress = env.BEAMSWAP_VAULT_ADDRESS
    ? parseVaultAddress(env.BEAMSWAP_VAULT_ADDRESS)
    : undefined
  const mode = signer ? 'metamask' : walletKey ? 'key' : 'none'
  if (vaultAddress && mode === 'none') {
    throw new Error(
      'BEAMSWAP_VAULT_ADDRESS needs the vault agent wallet: set BEAMSWAP_WALLET_KEY or BEAMSWAP_SIGNER=metamask',
    )
  }
  return { mode, ...(walletKey ? { walletKey } : {}), ...(vaultAddress ? { vaultAddress } : {}) }
}
