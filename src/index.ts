/**
 * `beamswap-mcp` - stdio MCP server for the Beamswap Agent API.
 *
 * Configuration is entirely environment-driven so the binary can be run straight from npx by a
 * desktop MCP host:
 *   BEAMSWAP_API_URL        base URL of the API (default https://api.beamswap.io)
 *   BEAMSWAP_WALLET_KEY     0x private key of the wallet that pays, USDC on Base
 *   BEAMSWAP_SIGNER         `metamask`: sign with MetaMask Agent Wallet (the `mm` CLI) instead of a key;
 *                           mutually exclusive with BEAMSWAP_WALLET_KEY
 *   BEAMSWAP_MM_BIN         optional path to the `mm` command (needed on Windows if it is not on PATH)
 *   BEAMSWAP_SESSION_TOKEN  optional session JWT, spends the staking-tier free quota first
 *   BEAMSWAP_TASK           optional task label sent as x-beamswap-task (task budgets, receipts)
 *   BEAMSWAP_VAULT_URL      optional private vault URL from the Beamswap dashboard; adds the six vault_* tools
 *   BEAMSWAP_VAULT_ADDRESS  optional 0x address of a vault whose agent is your own wallet (the key or
 *                           MetaMask account above); adds the same six tools. Exclusive with VAULT_URL
 */
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js'
import { fileRecoveryStore } from './payment-recovery'
import { createApiClient } from './client'
import { registerTools } from './tools'
import { localKeySigner, metamaskSigner, type WalletSigner } from './signer'
import { readSignerConfig } from './config'
import { createVaultRemote, registerVaultTools } from './vault'
import { createLocalVault } from './vault-local'

const apiUrl = process.env.BEAMSWAP_API_URL ?? 'https://api.beamswap.io'
const { mode, walletKey, vaultAddress } = readSignerConfig(process.env)
// The address is resolved once, here, so a missing or broken `mm` stops the server with its reason.
const signer: WalletSigner | undefined =
  mode === 'metamask' ? await metamaskSigner() : walletKey ? localKeySigner(walletKey) : undefined

const recoveryStore = fileRecoveryStore()
if (
  process.argv[2] === '--payment-recovery-status' ||
  process.argv[2] === '--clear-payment-recovery'
) {
  if (!signer) {
    throw new Error(
      'Set the wallet key (or BEAMSWAP_SIGNER=metamask) in the local environment before inspecting recovery',
    )
  }
  const wallet = signer.address
  if (process.argv[2] === '--clear-payment-recovery') {
    const id = process.argv[3]
    if (!id || process.argv[4] !== '--checked-payment-and-operation') {
      throw new Error(
        'After checking payment and operation status, pass the recovery ID and --checked-payment-and-operation',
      )
    }
    await recoveryStore.clear(wallet, id)
    console.log('Recovery lock cleared by the wallet owner. No payment or retry was made.')
  } else console.log(JSON.stringify(await recoveryStore.read(wallet)))
  process.exit(0)
}

const api = createApiClient({
  baseUrl: apiUrl,
  ...(signer ? { signer } : {}),
  sessionToken: process.env.BEAMSWAP_SESSION_TOKEN,
  treasury: process.env.BEAMSWAP_PAYMENT_TREASURY,
  recoveryStore,
  task: process.env.BEAMSWAP_TASK,
})

const server = new McpServer({ name: 'beamswap', version: '0.3.0' })
registerTools(server, api)
// The vault tools appear only when the owner configured the private vault URL. It is a secret:
// a malformed value stops the server with a message that does not repeat it.
if (process.env.BEAMSWAP_VAULT_URL) {
  registerVaultTools(server, createVaultRemote(process.env.BEAMSWAP_VAULT_URL))
} else if (vaultAddress && signer) {
  // Own-agent vault: no private URL, so the same tools run locally and sign with the agent wallet.
  registerVaultTools(server, createLocalVault({ signer, vault: vaultAddress, baseUrl: apiUrl }))
}
await server.connect(new StdioServerTransport())
