# Recover an uncertain payment

If a signed request loses its response or returns an error, payment may already have settled. Distribution creation or watch creation may also have completed. Do not retry or ask the AI to create a replacement.

The MCP returns `paymentOutcomeUnknown: true`, `doNotRetry: true` and a `recoveryId`. It saves a wallet-level lock in your home directory under `.beamswap/mcp-payments`. This survives process restarts and blocks further paid calls from that wallet, even with different arguments. Known free lookups remain available.

The record contains a random ID, timestamp, API origin and hashed request fingerprint. It stores no private key, session token, authorization signature or recipient list. Keep this directory on persistent storage when running in a container. Do not delete it to bypass an unresolved payment.

## Owner recovery

1. Stop the MCP clients using that wallet so no request remains in progress.
2. Check the wallet's Base USDC transfers and the API operation's status. For distributions, check the factory creation events and recover the distribution ID with the API operator. For watches, ask the API operator to reconcile the paid request. A missing response does not establish failure.
3. If the operation completed, recover its result. If payment settled but no result can be recovered, resolve it with the API operator before buying the operation again. Authorization expiry alone does not prove non-settlement.
4. After reconciling both payment and operation, inspect and clear the matching lock manually in a terminal. Use the same locally configured wallet environment, never a key on the command line.

```sh
npx -y @beamswapio/mcp@0.1.0 --payment-recovery-status
npx -y @beamswapio/mcp@0.1.0 --clear-payment-recovery RECOVERY_ID --checked-payment-and-operation
```

For source builds, replace `npx -y @beamswapio/mcp@0.1.0` with `node /absolute/path/to/dist/index.js`.

Clearing a lock does not refund, cancel or retry anything. It enables future paid requests. This command is deliberately not an MCP tool the AI can call automatically.

Separate computers do not share this local state. Use one MCP host for a spending wallet, or share persistent recovery storage when running multiple processes on that host. The server does not impose a cumulative spending budget; limit the dedicated wallet balance.
