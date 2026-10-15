# Release validation

Version: **0.1.0**. Checked October 15, 2026, on macOS with Pi **1.2.0** and Node.js **24.11.1**.

## Automated checks

- TypeScript: `npm run check`.
- Unit and mocked integration tests: **75 passed**, using `npm test`.
- Package contents: `npm pack`; runtime source, documentation and attribution only, with no credentials or development dependencies bundled.
- Independent source review covered authentication, session caching, cancellation, model selection, installation, attribution and private-data exposure. Review findings on reasoning output limits and home-directory expansion were fixed and regression-tested.

Tests use temporary auth files and mocked responses. They cover account changes/logout, invalid JSON, token exchange, session expiry and isolation, cancellation during response reads, retained image inputs, model-pool membership, custom headers, response caps, error privacy and diagnostics.

## Live account checks

A clean temporary installation from the package archive passed:

1. Model discovery: `github-copilot-auto/auto`, 64k context, 8,192 output limit.
2. Credential refresh: the temporary credential copy was marked expired to exercise a real Copilot token exchange. The user's original auth file was not modified.
3. Tool execution: the model read a disposable text file and returned `orchid`.
4. Conversation continuation: a second prompt returned `ORCHID` from memory, without another file read.

The run exited successfully, with one successful read call and no stderr. GitHub’s intent router selected `mai-code-1.1-flash`. This was a server decision observed in that run, not a promised model for other accounts.

A separate newer-protocol probe to `/auto` returned HTTP 404 for this account/integration. The legacy session/intent route worked. Neither check used private project content.

## Limits of the evidence

Only one GitHub student account was live-tested. We have not verified every plan, a second student's account, Windows, GitHub Enterprise, every model in the pool, or a multi-hour interactive session. Expiry, cancellation and account switching were exercised with automated fixtures; image and cross-provider routing have mocked coverage. Live tests did not test image understanding.

The GitHub Actions workflow runs tests and type checks on Node.js 22 and 24. See the repository's Actions tab for the actual result of a particular commit. Future server or Pi changes may require a new package release.
