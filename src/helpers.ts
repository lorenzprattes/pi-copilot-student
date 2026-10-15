/**
 * Pure helpers for pi-github-copilot-auto — no pi-ai imports, so they unit-test standalone.
 */

/**
 * Pi stores the GitHub Enterprise host as `enterpriseUrl`, either a bare domain
 * or a URL. Reduce it to a hostname the way Pi's own Copilot login does.
 */
export function normalizeEnterpriseDomain(
	input: string | undefined,
): string | undefined {
	const trimmed = input?.trim();
	if (!trimmed) return undefined;
	try {
		return new URL(trimmed.includes("://") ? trimmed : `https://${trimmed}`)
			.hostname;
	} catch {
		return undefined;
	}
}

/** github.com -> https://api.github.com/copilot_internal/v2/token; GHE uses its own api.<domain>. */
export function tokenExchangeUrl(enterpriseDomain?: string): string {
	return `https://api.${enterpriseDomain ?? "github.com"}/copilot_internal/v2/token`;
}

/**
 * Token format: ...;proxy-ep=proxy.business.githubcopilot.com;... -> https://api.business.githubcopilot.com
 * Without a proxy-ep, GHE falls back to copilot-api.<domain>, as Pi's built-in provider does.
 */
export function deriveApiBase(
	copilotToken: string,
	enterpriseDomain?: string,
): string {
	const match = copilotToken.match(/proxy-ep=([^;]+)/);
	if (match) return `https://${match[1].replace(/^proxy\./, "api.")}`;
	if (enterpriseDomain) return `https://copilot-api.${enterpriseDomain}`;
	return "https://api.individual.githubcopilot.com";
}

/**
 * Default route: the first Auto-pool model, in GitHub's pool order, that Pi
 * knows and can stream here. Used when the intent router is skipped or fails.
 */
export function pickAutoModel(
	availableModels: string[],
	supportedModelIds: Set<string>,
): string | undefined {
	return availableModels.find((id) => supportedModelIds.has(id));
}

