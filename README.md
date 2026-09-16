# Beamswap MCP

Give your AI tools for Base wallets, token data, swap preparation, alerts and token distributions.

**Choose how to connect:** [hosted, local, private tunnel or self-hosted](docs/access-methods.md). **Choose your AI:** [Claude, ChatGPT, Gemini, Perplexity, Grok and Codex](docs/connecting.md).

This repository contains the **local stdio server**. The hosted server lives in [beamswap-app-base](https://github.com/BeamSwap/beamswap-app-base). Both use the Beamswap API, with different payment approval flows.

## Run the local server

Use the source setup below. The npm release is pending registry publishing access; `@beamswap/mcp` is not available on npm yet.

### Build from source

Install [Node.js](https://nodejs.org/) 22.13 or newer, Git and pnpm 10, then:

```sh
git clone https://github.com/BeamSwap/beamswap-mcp.git
cd beamswap-mcp
pnpm install --frozen-lockfile
pnpm build
```

Set your AI client's server command to `node`, with the **absolute path** to `dist/index.js` as its argument. The client starts the server. Running it directly leaves it waiting for MCP messages on stdin, which is normal.

### Connect before adding a wallet

```json
{
  "mcpServers": {
    "beamswap": {
      "command": "node",
      "args": ["/absolute/path/to/beamswap-mcp/dist/index.js"]
    }
  }
}
```

Replace the example path with your built file, such as `C:/Users/you/beamswap-mcp/dist/index.js` on Windows. Merge the `beamswap` entry with your existing servers. After restarting the client, ask it to list the Beamswap tools. Listing tools is free and does not require a wallet.

## Payments in local mode

For paid calls, configure `BEAMSWAP_WALLET_KEY` in your local client's environment settings. Use a **separate wallet with a small USDC balance on Base**. Never paste a private key into a chat, prompt, issue or shared config.

The local server automatically signs API payments when a key is configured. Each tool is capped at its list price below; monitoring is capped at $0.01 per item per day. Only Base USDC EIP-3009 payments to the configured treasury are allowed. Free tools cannot charge. These limits are **per payment**, not a daily or total budget. Your AI client's approval controls are separate. Hosted mode instead asks you to approve requests in your browser.

| Setting | Purpose |
| --- | --- |
| `BEAMSWAP_WALLET_KEY` | Optional for connection/free lookups; required for local paid calls and wallet sign-in. |
| `BEAMSWAP_API_URL` | Defaults to `https://api.beamswap.io`. Change only to an API you trust. |
| `BEAMSWAP_SESSION_TOKEN` | Optional existing wallet session. `session_create` can create one and retain it in process memory. |
| `BEAMSWAP_PAYMENT_TREASURY` | Advanced self-hosting only. Defaults to Beamswap's treasury. Changing the API URL does not change this payment recipient. |

If a signed request times out, returns an error or lacks a valid receipt, the tool returns `paymentOutcomeUnknown`, `doNotRetry` and a recovery ID. Further paid calls for that wallet are blocked across restarts. See [payment recovery](docs/payment-recovery.md) before taking any action. Never ask the AI to create a replacement for an uncertain request.

The API charges USDC. The facilitator pays gas for API settlements. Sending swap, staking, funding or claim transactions separately requires ETH on Base. This server returns transaction instructions and **does not broadcast those transactions**.

## Try a prompt

Start with: **“List your Beamswap tools without making any paid requests.”**

Then use an exact wallet or token address:

- “Check the Base balances of [wallet]. Show tokens with missing prices separately. Do not trade.”
- “Compare a quote for 0.01 ETH to USDC on Base. Show the fee and expected output. Do not execute.”
- “Validate this rewards list, show duplicate wallets and the total, then stop for my review.”

See [workflow examples](docs/examples.md) for costs, prerequisites and where approval belongs.

## Local tools and list prices

| Tool | What it does | API price |
| --- | --- | --- |
| `session_create` | Activate wallet-based quota and discounts | Free signature |
| `token_info` | Token metadata, price and quote-based liquidity check | $0.005 |
| `portfolio` | Base token and native ETH balances with available USD values | $0.02 |
| `swap_quote` | Compare supported swap aggregators | $0.005 |
| `swap_route` | Prepare transaction data for your wallet | $0.01 |
| `watch_create` | Balance/price threshold alerts to your HTTPS webhook | $0.01 per item per day |
| `watch_get` | Read a watch by its private ID | Free |
| `watch_delete` | Stop a watch by its private ID | Free, no refund |
| `distribution_create` | Create a paused recipient claim contract | $50 |
| `distribution_get` | Read distribution metadata | Free |
| `distribution_proof` | Retrieve one recipient's proof | $0.001 |

Active GLINT tiers can reduce paid prices by 10%, 25% or 40% and grant quota on eligible routes. Create a session to use your tier. Swap execution preparation and distributions are not free-quota routes. Swap and distribution funding fees are separate from API prices. Successful paid calls include `_payment.tx` when a settlement receipt is available.

Tool amounts are **decimal strings in the token's smallest unit**, not JavaScript numbers. The website's recipient importer instead accepts readable token amounts and converts them using verified token decimals.

## Development and releases

```sh
pnpm check
npm pack --dry-run
```

Checks cover type safety, MCP protocol tool tests, the bundle and a real stdio connection to a local mock API. They use no funded wallet and send no mainnet payment. [Release checklist](docs/releasing.md).

MIT license. Maintained by [BeamSwap](https://github.com/BeamSwap).
