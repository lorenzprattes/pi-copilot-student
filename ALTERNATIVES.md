# Alternatives considered

Checked October 15, 2026. This is a focused source review, not a complete survey or a claim that every competing package fails in ordinary use.

| Option | Finding | Decision |
| --- | --- | --- |
| [FabriBorgobello/pi-github-copilot-auto](https://github.com/FabriBorgobello/pi-github-copilot-auto) 0.3.0 | Small native Pi integration, source distribution, diagnostic command and mocked tests. We found credential/session cache, cancellation, image-routing, header and error-reporting cases to improve. | Foundation for this attributed fork. |
| [mentalfl0w/copilot-auto](https://github.com/mentalfl0w/copilot-auto) 1.0.1 | Supports Pi and oh-my-pi. Published artifact differs substantially from current source; local Pi 1.2 tests required integration-header and model-filter changes. Its broader compatibility machinery adds maintenance work. | Did not use as the release foundation. |
| [jgrumboe/pi-github-copilot-auto](https://github.com/jgrumboe/pi-github-copilot-auto) | Uses newer `/auto` routing, but inspected source uses older Pi APIs and includes fallback behavior we would not retain. | Worth revisiting as the endpoint becomes available; not our initial base. |
| [GitHub Agentic Workflows with Pi](https://github.github.io/gh-aw/engines/pi/) | Official workflow integration provides `copilot/auto` through its gateway. | Intended for Actions workflows, not this direct student-laptop setup. |

GitHub documents [Auto model selection](https://docs.github.com/en/copilot/concepts/models/auto-model-selection) and [plan differences](https://docs.github.com/en/copilot/get-started/plans). The endpoint protocol itself is not a stable public extension API.

Microsoft’s current [`autoV2Fetcher.ts`](https://github.com/microsoft/vscode/blob/main/extensions/copilot/src/platform/endpoint/node/autoV2Fetcher.ts) confirms the newer `/auto` protocol. A live request using our student account and Pi’s integration headers returned 404. The session/intent route succeeded. We therefore kept the working route; endpoint availability may differ across accounts or integrations.

Students who do not need Pi can use GitHub’s own clients and avoid maintaining this adapter. This project specifically serves the requirement to keep the Pi workflow.
