# Beamswap MCP

Give your AI tools for Base wallets, token data, swap preparation, alerts and token distributions.

**Choose how to connect:** [hosted, local, private tunnel or self-hosted](docs/access-methods.md). **Choose your AI:** [Claude, ChatGPT, Gemini, Perplexity, Grok and Codex](docs/connecting.md).

This repository contains the **local stdio server**. The hosted server lives in [beamswap-app-base](https://github.com/BeamSwap/beamswap-app-base). Both use the Beamswap API, with different payment approval flows.

## Run the local server

Install [Node.js](https://nodejs.org/) 22.13 or newer. The npm release runs without cloning:

```sh
npx -y @beamswapio/mcp@0.2.0
```

Set your AI client's command to `npx` and arguments to `["-y", "@beamswapio/mcp@0.2.0"]`. Pinning the version keeps updates deliberate. On Windows, clients that require an executable may need `npx.cmd`; the source-based `node` command below also works.

### Build from source

For source control or local changes, install Git and pnpm 10, then:

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
      "command": "npx",
      "args": ["-y", "@beamswapio/mcp@0.2.0"]
    }
  }
}
```

For a source build, use command `node` and an absolute argument such as `C:/Users/you/beamswap-mcp/dist/index.js`. Merge the `beamswap` entry with your existing servers. After restarting the client, ask it to list the Beamswap tools. Listing tools is free and does not require a wallet.

## Payments in local mode

For paid calls, configure `BEAMSWAP_WALLET_KEY` in your local client's environment settings. Use a **separate wallet with a small USDC balance on Base**. Never paste a private key into a chat, prompt, issue or shared config.

The local server automatically signs API payments when a key is configured. Each tool is capped at its list price below; monitoring is capped at $0.01 per item per day. Only Base USDC EIP-3009 payments to the configured treasury are allowed. Free tools cannot charge. These limits are **per payment**, not a daily or total budget. Your AI client's approval controls are separate. Hosted mode instead asks you to approve requests in your browser.

| Setting | Purpose |
| --- | --- |
| `BEAMSWAP_WALLET_KEY` | Optional for connection/free lookups; required for local paid calls and wallet sign-in, unless you use `BEAMSWAP_SIGNER`. |
| `BEAMSWAP_SIGNER` | Set to `metamask` to sign with [MetaMask Agent Wallet](#metamask-agent-wallet) instead of a private key. Cannot be combined with `BEAMSWAP_WALLET_KEY`. |
| `BEAMSWAP_MM_BIN` | Optional path to the `mm` command (or its JS entry) when it is not on `PATH`. Used with `BEAMSWAP_SIGNER=metamask`. |
| `BEAMSWAP_API_URL` | Defaults to `https://api.beamswap.io`. Change only to an API you trust. |
| `BEAMSWAP_SESSION_TOKEN` | Optional existing wallet session. `session_create` can create one and retain it in process memory. |
| `BEAMSWAP_TASK` | Optional task label (1 to 64 letters, digits, spaces or . _ : -) sent as `x-beamswap-task`, so your task budgets and receipts on beamswap.io can tell this agent's work apart. |
| `BEAMSWAP_VAULT_URL` | Optional private vault link from [app.beamswap.io/agent](https://app.beamswap.io/agent). Adds the six `vault_*` tools. Treat it as a secret. |
| `BEAMSWAP_VAULT_ADDRESS` | Optional `0x` address of an Agent Vault whose agent is your own wallet (`BEAMSWAP_WALLET_KEY` or the MetaMask account). Adds the same six `vault_*` tools. Cannot be combined with `BEAMSWAP_VAULT_URL`. |
| `BEAMSWAP_PAYMENT_TREASURY` | Advanced self-hosting only. Defaults to Beamswap's treasury. Changing the API URL does not change this payment recipient. |

If a signed request times out, returns an error or lacks a valid receipt, the tool returns `paymentOutcomeUnknown`, `doNotRetry` and a recovery ID. Further paid calls for that wallet are blocked across restarts. See [payment recovery](docs/payment-recovery.md) before taking any action. Never ask the AI to create a replacement for an uncertain request.

The API charges USDC. The facilitator pays gas for API settlements. Sending swap, staking, funding or claim transactions separately requires ETH on Base. This server returns transaction instructions and **does not broadcast those transactions**.

## MetaMask Agent Wallet

[MetaMask Agent Wallet](https://www.npmjs.com/package/@metamask/agent-wallet) (the `mm` command) keeps the key in MetaMask's secure enclave or a local mnemonic, so no private key sits in your MCP config. Install it, create or select a wallet with `mm`, then:

```json
{
  "mcpServers": {
    "beamswap": {
      "command": "npx",
      "args": ["-y", "@beamswapio/mcp@0.3.0"],
      "env": { "BEAMSWAP_SIGNER": "metamask" }
    }
  }
}
```

- The server runs `mm wallet address --json` once at startup and asks `mm` to sign each payment, sign-in or vault intent with `--wait`. If your wallet needs 2FA, approve the request in MetaMask; the call waits up to 11 minutes. An unapproved request fails with `Approval pending in MetaMask (2FA)`, and you can retry.
- Payments keep every local safety rule: the per-route price ceiling, the pinned Base USDC treasury, one signature per request and the recovery lock. The wallet needs USDC on Base.
- On Windows the `mm.cmd` launcher cannot be started without a shell, so the server reads the JavaScript entry out of it and runs that with Node. If that fails, set `BEAMSWAP_MM_BIN` to the `mm` executable or its `.js` entry.
- Only ECDSA signatures are accepted, because the Beamswap API and vaults verify ECDSA.

### Vault whose agent is your own wallet

An [Agent Vault](https://app.beamswap.io/agent) can name any address as its agent. If that address is your `mm` wallet (`mm wallet address`) or your `BEAMSWAP_WALLET_KEY` wallet, set `BEAMSWAP_VAULT_ADDRESS` to the vault contract. The six `vault_*` tools then work without a private URL: the server proves it is the agent with a signed challenge (reused for about five minutes, so one 2FA approval covers several reads), signs each trade, cancel or pause as an `AgentIntent`, and Beamswap's relayer submits it and pays the gas. The vault contract enforces your limits on chain; the agent can never withdraw, change rules or resume a paused vault.

An agent skill for this setup is in [`skills/beamswap`](skills/beamswap/SKILL.md).

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
