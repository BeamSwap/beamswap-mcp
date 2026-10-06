# Changelog

## 0.3.0

- Add MetaMask Agent Wallet support: `BEAMSWAP_SIGNER=metamask` signs API payments, sign-in and vault intents through the `mm` CLI instead of a private key. `BEAMSWAP_MM_BIN` points at the CLI when it is not on `PATH`.
- Add `BEAMSWAP_VAULT_ADDRESS`: the six `vault_*` tools for an Agent Vault whose agent is your own wallet, signed locally and relayed by Beamswap.
- `BEAMSWAP_SIGNER` and `BEAMSWAP_WALLET_KEY` are mutually exclusive, as are `BEAMSWAP_VAULT_URL` and `BEAMSWAP_VAULT_ADDRESS`.
- Add the `beamswap` agent skill under `skills/`.

## 0.2.0

- Add `spending_status` and `spending_pause` for the wallet's spending controls.
- Add `BEAMSWAP_TASK`, sent as `x-beamswap-task` so task budgets and receipts can tell agents apart.
- Add free `limit_order_prepare`, `order_status`, `automation_preview`, `crosschain_quote` and `crosschain_status`. They return data and a review link on app.beamswap.io, never calldata to sign.
- Add the Agent Vault tools `vault_status`, `vault_trade`, `vault_limit_order`, `vault_cancel`, `vault_pause` and `vault_activity`, enabled when `BEAMSWAP_VAULT_URL` is set. They trade inside on-chain limits and never withdraw.
- The vault link is treated as a secret and is never logged or echoed.

## 0.1.0

- First public release.
