# Choose your connection

Pick the payment model first, then follow the guide for your AI.

| Option | Good for | Advantages | Tradeoffs |
| --- | --- | --- | --- |
| **Hosted MCP** | Most people using a remote MCP client | One server URL; no install or private-key setup; browser wallet approval | You open an approval page for requests that require consent; Beamswap hosts the service |
| **Local MCP over stdio** | Desktop and CLI users | Runs on your computer; works with local clients; can automate paid API calls | Install/build once; keep the process available; configure a separate spending wallet |
| **Private tunnel to local MCP** | ChatGPT users with tunnel access | Your MCP stays on your computer/private network | Advanced setup and account permissions; tunnel must keep running; local auto-payment rules still apply |
| **Self-hosted remote MCP** | Teams operating their own infrastructure | You control hosting, domain and availability | Operate the backend, database and frontend approval flow; configure your own payment service and monitoring |

## Hosted

Server URL: `https://api.beamswap.io/mcp`. Transport: **Streamable HTTP**. Connection authentication: **None**; paid actions are authorized separately with a wallet in the browser.

After a tool prepares an approval request, open its Beamswap approval link, inspect the requested action and price, then approve or decline. Ask your AI to retrieve the result with the returned status capability. Keep these links and capabilities private: they identify your request and its result.

The hosted and local tool lists can differ. Ask your client to list available tools before requesting a workflow. A prepared swap route does not execute a swap; a created distribution does not fund or open claims.

## Local

Use the [source setup](../README.md#run-the-local-server). Stdio means your AI client starts the program and exchanges messages with it locally. `https://api.beamswap.io` is the API the program calls, not a substitute for the remote MCP URL.

Without a wallet key, connection and free tools still work. With a key, the server can automatically pay up to $50 for each API request. This does not impose a session or daily budget. Limit the separate wallet's balance and configure the client's tool confirmations.

## Private tunnel

OpenAI's [Secure MCP Tunnel](https://developers.openai.com/api/docs/guides/secure-mcp-tunnels) can connect ChatGPT to a local stdio program. Configure it to run `node /absolute/path/to/beamswap-mcp/dist/index.js`. You need the appropriate Platform organization and ChatGPT workspace permissions.

This runs the local server's payment model. A tunnel does not add browser payment approval or a spending budget to the local package.

## Self-hosted

The hosted implementation and approval frontend are in [beamswap-app-base](https://github.com/BeamSwap/beamswap-app-base). Deploy both with Postgres and your own HTTPS configuration using its hosted MCP runbook. Self-hosting the stdio package alone does not create an HTTP endpoint.

Do not expose a shared, auto-paying private-key process as an unauthenticated public service. Use the hosted request-approval implementation or an authenticated private deployment.

## Direct API

Developers can use [the REST API](https://app.beamswap.io/docs) with an x402 client instead. This is an alternative to MCP, not another MCP transport. Start with the [OpenAPI schema](https://api.beamswap.io/v1/openapi.json).
