---
name: beamswap
description: Use when an agent with a MetaMask Agent Wallet (the `mm` CLI) needs Base token data, portfolio balances, swap quotes or routes, or wants to trade inside a Beamswap Agent Vault. Covers configuring @beamswapio/mcp with BEAMSWAP_SIGNER=metamask, sending a returned swap transaction with `mm`, vault trading, and paying the Beamswap x402 API directly.
---

# Beamswap with MetaMask Agent Wallet

Beamswap's MCP server (`@beamswapio/mcp`) gives an agent Base token data, swap routes and Agent Vault trading. With `BEAMSWAP_SIGNER=metamask` it signs through your `mm` wallet, so no private key is ever in the MCP config.

## Set up

1. Install and unlock MetaMask Agent Wallet, and check the active account: `mm wallet address --json`. Fund it with a little USDC on Base for paid API calls (cents per call), and ETH on Base only if it will send transactions.
2. Add the server (version 0.3.0 or newer):

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

Do not also set `BEAMSWAP_WALLET_KEY`; the server refuses both. On Windows, if `mm` is not found, set `BEAMSWAP_MM_BIN` to the `mm` executable or its `.js` entry.

3. If a signature needs 2FA, the call waits for approval in MetaMask. If it reports `Approval pending in MetaMask (2FA)`, approve and retry.

## Swap on Base

1. `swap_quote` compares routes (about $0.005). Show the user the expected output and fee.
2. `swap_route` returns transaction instructions: `to`, `data`, `value`. The server never broadcasts them.
3. Inspect, then send with the wallet. Decode first so the user can see what it does:

```sh
mm decode --help   # decode the returned calldata with the options your version lists
mm wallet send-transaction --chain-id 8453 --payload '<to/data/value JSON from swap_route>' --wait --json
```

Check the decoded recipient, token and amount against the quote before sending. Run `mm wallet send-transaction --help` for the exact payload fields your version expects.

## Trade inside an Agent Vault

A vault holds the owner's funds and trades only inside rules the owner set on chain (per-trade and daily limits, allowed tokens, price guard, maximum order lifetime). The vault contract is the guard, not the agent or this server; the agent cannot withdraw, change rules or resume a paused vault.

1. In the vault setup on [app.beamswap.io/agent](https://app.beamswap.io/agent), set the vault's agent to the `mm` wallet address (`mm wallet address`).
2. Add `"BEAMSWAP_VAULT_ADDRESS": "0x<vault contract>"` to the server's `env`.
3. Use the tools: `vault_status` first (balances, rules, spend today), then `vault_trade`, `vault_limit_order`, `vault_cancel`, `vault_pause`, `vault_activity`. A refusal names the rule that blocked the trade; do not retry around it.

Each trade is signed by the `mm` wallet as an intent (shown as "Beamswap vault trade") and submitted by Beamswap's relayer, which pays the gas, so the agent wallet needs no ETH. Reads reuse one signed challenge for about five minutes, so approvals are not repeated for every call.

If a vault has a private Beamswap URL instead (a Beamswap-hosted agent key), use `BEAMSWAP_VAULT_URL`, not `BEAMSWAP_VAULT_ADDRESS`; they are mutually exclusive.

## Pay the Beamswap API directly

The REST API (`https://api.beamswap.io`, schema at `/v1/openapi.json`) uses x402: a request answers `402` with a Base USDC price, and the client retries with a signed payment. To call it without MCP, use MetaMask Agent Wallet's x402 support to sign that payment instead of writing your own signer. Pay only Base USDC to the treasury named in the 402 response and only for the price you expect; the MCP server enforces a per-route ceiling for you.
