# Repository rules

- Never read or commit `.env` / `.env.*`, private keys, session tokens or npm credentials.
- New commits use only the owner's configured `flisko` Git identity. No co-author trailers.
- Preserve bigint/string token amounts and the canonical Base EIP-712 session message.
- Run `pnpm check` before a PR. Its protocol smoke uses a local mock API and no wallet.
- This is the standalone public source of `@beamswap/mcp`. Do not publish npm versions, tags or paid smoke calls without explicit authorization.
- Keep transport and payment claims accurate: this release uses stdio, automatically pays approved API requests when a wallet is configured, and never broadcasts swap/funding transactions.
