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
import { createApiClient } from './client'
import { registerTools } from './tools'

const api = createApiClient({
  baseUrl: process.env.BEAMSWAP_API_URL ?? 'https://api.beamswap.io',
  walletKey: process.env.BEAMSWAP_WALLET_KEY as Hex | undefined,
  sessionToken: process.env.BEAMSWAP_SESSION_TOKEN,
})

const server = new McpServer({ name: 'beamswap', version: '0.1.0' })
registerTools(server, api)
await server.connect(new StdioServerTransport())
