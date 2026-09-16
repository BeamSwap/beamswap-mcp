# Maintainer release checklist

The standalone repository is the public source of truth. The app repository retains a private compatibility copy for its existing tests; it must not publish a second package under the same name.

## Provenance

Initial source was extracted from `BeamSwap/beamswap-app-base` commit `4b6af23`, `packages/mcp`, with `packages/shared/src/agent-session.ts` copied to `src/session.ts`. The standalone review then added strict per-tool payment policy and persistent uncertain-payment recovery. Keep the session domain, fields and Base chain ID compatible with the API verifier.

Runtime dependencies are pinned to the versions used by the launch implementation. Update them in a separately reviewed change. The lockfile records the full dependency graph.

## Before publishing

1. Confirm the intended npm account owns the `@beamswap` scope and the version is unused.
2. Run `pnpm install --frozen-lockfile`, `pnpm check` and `npm pack --dry-run`.
3. Inspect the tarball: bundle, license, README and public guides only. No credentials, tests, ledger, node_modules or environment files.
4. Test the installed tarball through MCP initialization, tools/list and a free mocked call. Do not require a funded wallet in CI.
5. Review the source diff and provider docs. Verify the hosted endpoint before describing it as live.
6. Confirm every new commit is authored and committed as `flisko`, with no co-author trailer.
7. Obtain the owner's explicit npm-release authorization. Then publish the exact checked package with public access and provenance where supported.
8. Verify the public registry version and executable before changing guides to an `npx @beamswap/mcp` command.

There is deliberately no automatic npm-publish workflow. CI on Windows and Linux builds and checks the package without release credentials.
