# Useful first workflows

Replace every bracketed value. Prompts are examples, not promises that your AI has every required integration.

## Check a wallet

> Show the Base balances of [wallet address]. Separate tokens without a reliable USD value. Show when you checked. Do not trade.

Uses `portfolio`. List API price: $0.02. This is a current balance view, not a historical tax report or a guarantee that every token is safe.

## Prepare a swap

> Compare 0.01 ETH to USDC on Base. Show expected output, minimum output and fees. Prepare a route for [wallet] only after I ask. Never submit it for me.

Uses `swap_quote` ($0.005) and optionally `swap_route` ($0.01), with a separate swap fee. Native ETH routes are simulated and require the source wallet to have funds. ERC-20 route simulation is not supported. Routes expire quickly; prepare a fresh route immediately before wallet review.

## Watch operating funds

> Alert my HTTPS webhook [URL] if the Base USDC balance of [wallet] falls below 100 USDC. Monitor for 7 days. Show the exact cost before creating it.

Uses `watch_create`, where available. One item for seven days costs $0.07 before discounts. Your receiving service verifies the webhook signature and sends any Slack, email or Telegram notification; Beamswap does not send those messages automatically. Treat the watch ID as private because it permits reading and cancellation.

## Prepare a community reward run

> Turn this approved reward list into two columns named address and amount. Keep addresses and decimal amounts exact. Flag duplicate or invalid rows. Show the recipient count and total. Do not invent addresses or change allocations.

No Beamswap API payment is needed to format a file. Review it in [the recipient importer](https://app.beamswap.io/distribute). Creating the distribution costs $50 before discounts, followed by owner approval, funding, opening claims and sharing the link. Default factory funding fee: 0.1%. Funding must cover the full allocation after that fee.

## Help a recipient

> Read distribution [ID]. Explain its deadline and how I can claim through its hosted page. Do not ask for my private key.

Uses `distribution_get`, which is free. Recipients use their own wallet on the hosted claim page. Agent proof retrieval costs $0.001; the hosted page has a free proof route.

## Ideas that need additional development

Recurring reward runs, approval budgets, multi-wallet treasury reports, automatic rebalancing and verified task payouts are product proposals. Today's primitives can help prepare parts of them, but there is no turnkey scheduler, audited task oracle, historical accounting engine or automatic trading service in this package.
