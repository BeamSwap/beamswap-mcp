/**
 * `beamswap-mcp` — stdio MCP server for the Beamswap Agent API.
 *
 * Configuration is entirely environment-driven so the binary can be run straight from npx by a
 * desktop MCP host:
 *   BEAMSWAP_API_URL        base URL of the API (default https://api.beamswap.io)
 *   BEAMSWAP_WALLET_KEY     0x private key of the wallet that pays, USDC on Base
 *   BEAMSWAP_SESSION_TOKEN  optional session JWT, spends the staking-tier free quota first
 */
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js'
import type { Hex } from 'viem'
import { privateKeyToAccount } from 'viem/accounts'
import { fileRecoveryStore } from './payment-recovery'
import { createApiClient } from './client'
import { registerTools } from './tools'

const recoveryStore = fileRecoveryStore()
if (
  process.argv[2] === '--payment-recovery-status' ||
  process.argv[2] === '--clear-payment-recovery'
) {
  const key = process.env.BEAMSWAP_WALLET_KEY as Hex | undefined
  if (!key)
    throw new Error('Set the wallet key in the local environment before inspecting recovery')
  const wallet = privateKeyToAccount(key).address
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
  baseUrl: process.env.BEAMSWAP_API_URL ?? 'https://api.beamswap.io',
  walletKey: process.env.BEAMSWAP_WALLET_KEY as Hex | undefined,
  sessionToken: process.env.BEAMSWAP_SESSION_TOKEN,
  treasury: process.env.BEAMSWAP_PAYMENT_TREASURY,
  recoveryStore,
})

const server = new McpServer({ name: 'beamswap', version: '0.1.0' })
registerTools(server, api)
await server.connect(new StdioServerTransport())
