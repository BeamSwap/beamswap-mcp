import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { fileURLToPath } from 'node:url'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js'

// Exercise the packaged entry point without inheriting wallet/session secrets or calling mainnet.
const requests = []
const api = createServer((request, response) => {
  requests.push({ method: request.method, path: request.url })
  response.writeHead(404, { 'content-type': 'application/json' })
  response.end(JSON.stringify({ error: 'distribution not found' }))
})
await new Promise((resolve) => api.listen(0, '127.0.0.1', resolve))
const port = api.address().port
const transport = new StdioClientTransport({
  command: process.execPath,
  args: [process.argv[2] ?? fileURLToPath(new URL('../dist/index.js', import.meta.url))],
  env: {
    BEAMSWAP_API_URL: `http://127.0.0.1:${port}`,
    BEAMSWAP_WALLET_KEY: '',
    BEAMSWAP_SESSION_TOKEN: '',
  },
  stderr: 'pipe',
})
const client = new Client({ name: 'beamswap-package-check', version: '1.0.0' })
try {
  await client.connect(transport)
  const { tools } = await client.listTools()
  assert.equal(tools.length, 11)
  assert(tools.some((tool) => tool.name === 'session_create'))
  assert(tools.some((tool) => tool.name === 'distribution_create'))
  const result = await client.callTool({
    name: 'distribution_get', arguments: { id: 'protocol-smoke' },
  })
  assert.equal(result.isError, true)
  assert.deepEqual(requests, [{ method: 'GET', path: '/v1/distribution/protocol-smoke' }])
  console.log('Protocol smoke passed: 11 tools and one free mock request. No wallet or mainnet call.')
} finally {
  await client.close()
  await new Promise((resolve) => api.close(resolve))
}
