/** Copilot credentials are read on every request so logout/account changes take effect. */
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { AUTH_PATH, COPILOT_HEADERS } from "./config.ts";
import { deriveApiBase, normalizeEnterpriseDomain, tokenExchangeUrl } from "./helpers.ts";
import { StoredCopilotSchema, TokenExchangeSchema } from "./schemas.ts";

const REFRESH_MARGIN_MS = 5 * 60 * 1000;
const REQUEST_TIMEOUT_MS = 15_000;

function readStoredCopilot() {
	let raw: string;
	try { raw = readFileSync(AUTH_PATH, "utf8"); }
	catch {
		resetCopilotAuth();
		throw new Error(`Copilot Auto: cannot read ${AUTH_PATH}. Run /login and pick GitHub Copilot first.`);
	}
	let value: unknown;
	try { value = JSON.parse(raw); }
	catch {
		resetCopilotAuth();
		throw new Error("Copilot Auto: invalid auth file JSON. Run /login and pick GitHub Copilot.");
	}
	const entry = value && typeof value === "object" ? (value as Record<string, unknown>)["github-copilot"] : undefined;
	const parsed = StoredCopilotSchema.safeParse(entry);
	if (!parsed.success || !parsed.data.refresh.trim()) {
		resetCopilotAuth();
		throw new Error("Copilot Auto: no github-copilot login found. Run /login and pick GitHub Copilot.");
	}
	if (parsed.data.enterpriseUrl?.trim() && !normalizeEnterpriseDomain(parsed.data.enterpriseUrl)) {
		resetCopilotAuth();
		throw new Error("Copilot Auto: invalid GitHub Enterprise host in stored login.");
	}
	return parsed.data;
}

export interface StoredCopilotStatus {
	authPath: string;
	hasAccessToken: boolean;
	accessTokenExpiresAtMs: number | null;
	hasRefreshToken: boolean;
	enterpriseDomain: string | null;
}
export function getStoredCopilotStatus(): StoredCopilotStatus {
	const stored = readStoredCopilot();
	return {
		authPath: AUTH_PATH,
		hasAccessToken: Boolean(stored.access),
		accessTokenExpiresAtMs: stored.expires ?? null,
		hasRefreshToken: Boolean(stored.refresh),
		enterpriseDomain: normalizeEnterpriseDomain(stored.enterpriseUrl) ?? null,
	};
}
export interface CopilotAuth { token: string; apiBase: string; }
let cached: (CopilotAuth & { expires: number; identity: string }) | null = null;
let generation = 0;
export function resetCopilotAuth(): void { cached = null; generation++; }
function credentialIdentity(stored: ReturnType<typeof readStoredCopilot>): string {
	return createHash("sha256").update(JSON.stringify(stored)).digest("hex");
}

export async function getCopilotAuth(signal?: AbortSignal): Promise<CopilotAuth> {
	signal?.throwIfAborted();
	const stored = readStoredCopilot();
	const identity = credentialIdentity(stored);
	const now = Date.now();
	if (cached && cached.identity === identity && cached.expires - now > REFRESH_MARGIN_MS)
		return { token: cached.token, apiBase: cached.apiBase };
	cached = null;
	const enterpriseDomain = normalizeEnterpriseDomain(stored.enterpriseUrl);
	if (stored.access?.trim() && stored.expires && stored.expires - now > REFRESH_MARGIN_MS) {
		const apiBase = deriveApiBase(stored.access, enterpriseDomain);
		cached = { token: stored.access, apiBase, expires: stored.expires, identity };
		return { token: stored.access, apiBase };
	}
	const requestGeneration = generation;
	const requestSignal = AbortSignal.any([...(signal ? [signal] : []), AbortSignal.timeout(REQUEST_TIMEOUT_MS)]);
	let response: Response;
	try {
		response = await fetch(tokenExchangeUrl(enterpriseDomain), {
			headers: { Accept: "application/json", Authorization: `Bearer ${stored.refresh}`, ...COPILOT_HEADERS },
			signal: requestSignal,
		});
	} catch {
		requestSignal.throwIfAborted();
		throw new Error("Copilot Auto: token exchange connection failed. Check your network and retry.");
	}
	requestSignal.throwIfAborted();
	if (!response.ok) {
		void response.body?.cancel().catch(() => { });
		throw new Error(`Copilot Auto: token exchange failed ${response.status}. Run /login and pick GitHub Copilot if access has expired.`);
	}
	let value: unknown;
	try { value = await response.json(); }
	catch {
		requestSignal.throwIfAborted();
		throw new Error("Copilot Auto: invalid token exchange response");
	}
	requestSignal.throwIfAborted();
	const parsed = TokenExchangeSchema.safeParse(value);
	if (!parsed.success || !parsed.data.token.trim() || !Number.isFinite(parsed.data.expires_at * 1000) || parsed.data.expires_at * 1000 <= Date.now())
		throw new Error("Copilot Auto: invalid token exchange response (missing token or expired credentials)");
	// Do not return an old account's token if login changed while the request was in flight.
	if (requestGeneration !== generation || credentialIdentity(readStoredCopilot()) !== identity)
		throw new Error("Copilot Auto: login changed during token exchange. Retry the request.");
	const { token, expires_at } = parsed.data;
	const apiBase = deriveApiBase(token, enterpriseDomain);
	cached = { token, apiBase, expires: expires_at * 1000, identity };
	return { token, apiBase };
}
