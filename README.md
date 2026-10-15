# Pi Copilot Student

Use your GitHub Copilot student access inside [Pi](https://pi.dev), with one Auto model and a diagnostic command. GitHub chooses the underlying model from the pool your account is allowed to use.

This is an independent community extension, based on [Fabricio Borgobello’s pi-github-copilot-auto](https://github.com/FabriBorgobello/pi-github-copilot-auto). It is not an official GitHub integration. The Auto endpoints it uses can change.

## Install and sign in

You need **Pi 1.2.0**, **Node.js 22.19 or newer**, and active GitHub Copilot access. If you have not activated the student benefit, follow [GitHub’s student setup instructions](https://docs.github.com/en/copilot/how-tos/copilot-on-github/set-up-copilot/enable-copilot/set-up-for-students). Education verification and Copilot activation are separate steps.

In your terminal:

```sh
pi install git:github.com/lorenzprattes/pi-copilot-student@v0.1.1
pi
```

Inside Pi:

1. Run `/login github-copilot`. Choose the browser/device sign-in, leave the Enterprise domain blank for github.com, and authorize your own GitHub account. If you already connected Copilot in Pi, skip this step.
2. Run `/reload` if Pi was already open when you installed the package.
3. Run `/model` and select **Copilot Auto** (`github-copilot-auto/auto`).
4. Ask a coding question as usual.

You can also select it when starting Pi:

```sh
pi --model github-copilot-auto/auto
```

The extension does not change your default model. To make Auto the default, select it in `/model` and press **Ctrl+S**. If you maintain a restricted model-cycling list, add `github-copilot-auto/auto` through `/scoped-models`.

Use only one extension that registers `github-copilot-auto` at a time. Remove an older `pi-github-copilot-auto` installation before installing this fork. The earlier manually adapted `copilot-auto` uses a different provider ID (`github-copilot/auto`); remove that local extension when migrating to avoid confusing duplicate choices.

## Check your setup

Run this inside Pi:

```text
/copilot-student-doctor
```

It checks the stored login, Copilot token exchange, and Auto model pool. It does not send a chat prompt or modify your account. It reports which pool models Pi can use and the last routing outcome. `/copilot-auto-doctor` is an alias.

| Problem | What to do |
| --- | --- |
| No Copilot login | Run `/login github-copilot` using the account with your student benefit. |
| Authentication or access rejected | Sign in again and check [Copilot settings](https://github.com/settings/copilot). |
| A specific model says “not supported” | Select **Copilot Auto**, not a named model under the ordinary Copilot provider. Student plans require Auto. |
| No supported models in the pool | Run the doctor command and check this repository’s releases for compatibility updates. |
| The route says `default` | GitHub’s intent router was unavailable or inapplicable. The extension used a supported model from the authorized Auto pool; the doctor reports why. |
| Usage limit reached | Check your allowance in GitHub. Installing this extension does not increase it. |

Do not paste `auth.json`, tokens, or full network traces into issues. The doctor report excludes credentials, but includes your local auth-file path and API host; review those before sharing.

## What this version changes

Compared with upstream 0.3.0, this fork checks for logout/account changes before reusing authentication, separates Auto sessions by credentials and conversation, rejects expired sessions, preserves cancellation through response reads, and checks image support when reusing a route. It preserves caller headers while protecting Copilot’s authentication headers. Error responses from model APIs are summarized without echoing their contents.

Auto advertises a conservative **64,000-token context** and caps each response at **8,192 tokens**. Pi can compact longer conversations. These limits trade some capacity for compatibility across the changing Auto pool; they do not guarantee that every future pool model will support the same limits.

No global `fetch` patch is installed. Pi’s own streaming implementations handle text, tool calls, and images. The extension reads only the existing `github-copilot` credential; it never writes credentials or requires a copied token.

## Routing and privacy

The extension opens an authorized Auto session, then asks GitHub’s intent router to choose among its available models. Only the latest prompt and routing metadata are sent to that router. The selected chat model receives the conversation and tools through Pi, as with any hosted provider.

The route is retained for tool calls and later turns, and reconsidered after compaction, account changes, or incompatible image input. If the intent router times out or fails, a supported model from the current authorized pool is used and reported as `default`. Authentication/session failures stop the request. The extension never falls back to models outside the authorized pool.

Logging is off by default. Set `PI_COPILOT_LOG` to a writable file path to enable route diagnostics. Logs contain route metadata, not prompts or credentials. `PI_CODING_AGENT_DIR` is respected; `PI_COPILOT_AUTH` can override the auth-file path.

Pi’s dollar estimate is not a reliable measure of Copilot subscription usage. Check your actual allowance in GitHub. This extension does not enable paid overages, alter billing settings, or bypass plan restrictions.

## Compatibility and validation

Version 0.1.1 targets Pi **1.2.0**. Other Pi versions and GitHub Enterprise accounts are not live-validated. GitHub can change its private Auto endpoints independently of Pi or this package.

This release uses `/models/session` and `/models/session/intent`. Microsoft’s newer client also implements `/auto`; that endpoint returned HTTP 404 in our student-account check, so we retained the working session route. This is an observation about that account/integration, not proof that `/auto` is unavailable everywhere.

Automated tests cover authentication, session expiry and isolation, cancellation, allowed model selection, image routing, headers, error privacy, and diagnostics. Live release checks and the alternatives comparison are recorded in [VALIDATION.md](VALIDATION.md) and [ALTERNATIVES.md](ALTERNATIVES.md).

## Update or remove

The installation command pins a release. To move to a later release, install its explicit tag and run `/reload`. Check the release notes first; `pi update` does not move a pinned Git tag.

To uninstall:

```sh
pi remove git:github.com/lorenzprattes/pi-copilot-student@v0.1.1
```

Then restart Pi. Your normal Copilot login remains available to Pi.

## Development

```sh
npm ci
npm test
npm run check
pi -e ./
```

Tests use temporary auth files and mocked HTTP responses; they do not use your account. Pi supplies its own runtime packages to installed extensions. Development dependencies pin Pi 1.2.0; `zod` validates provider responses.

See [NOTICE.md](NOTICE.md) for source provenance and attribution. MIT licensed.
