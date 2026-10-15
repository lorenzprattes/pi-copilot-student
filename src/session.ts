/** Auto sessions are isolated by conversation, credential and endpoint. */
import { createHash } from "node:crypto";
import { AUTO_MODEL_ID, COPILOT_HEADERS, log } from "./config.ts";
import { AutoSessionSchema } from "./schemas.ts";

const REFRESH_MARGIN_MS = 5 * 60 * 1000;
const MAX_LIFETIME_MS = 25 * 60 * 1000;
const REQUEST_TIMEOUT_MS = 15_000;
const MAX_CACHED_SESSIONS = 128;
export interface AutoSession {
	sessionToken: string;
	availableModels: string[];
	discountedCosts: Record<string, number>;
	expiresAtMs: number;
}
const sessions = new Map<string, { identity: string; session?: AutoSession }>();
/** Call on conversation shutdown/switch; omit the key to clear all cached sessions. */
export function resetAutoSessions(cacheKey?: string): void {
	if (cacheKey === undefined) sessions.clear();
	else sessions.delete(cacheKey);
}

export async function getAutoSession(
	base: string,
	copilotToken: string,
	signal?: AbortSignal,
	cacheKey = "default",
): Promise<AutoSession> {
	signal?.throwIfAborted();
	const now = Date.now();
	const identity = createHash("sha256").update(JSON.stringify([base, copilotToken])).digest("hex");
	const cached = sessions.get(cacheKey);
	if (cached?.identity === identity && cached.session && cached.session.expiresAtMs - now > REFRESH_MARGIN_MS)
		return cached.session;
	// Once refresh begins, the old session is never a fallback for a failed request.
	const entry = cached?.identity === identity ? cached : { identity, session: undefined };
	entry.session = undefined;
	if (!sessions.has(cacheKey) && sessions.size >= MAX_CACHED_SESSIONS) sessions.delete(sessions.keys().next().value as string);
	sessions.set(cacheKey, entry);
	const requestSignal = AbortSignal.any([...(signal ? [signal] : []), AbortSignal.timeout(REQUEST_TIMEOUT_MS)]);
	let response: Response;
	try {
		response = await fetch(`${base}/models/session`, {
			method: "POST",
			headers: { Authorization: `Bearer ${copilotToken}`, "Content-Type": "application/json", ...COPILOT_HEADERS },
			body: JSON.stringify({ auto_mode: { model_hints: [AUTO_MODEL_ID] } }),
			signal: requestSignal,
		});
	} catch {
		requestSignal.throwIfAborted();
		throw new Error("Copilot Auto: session connection failed. Check your network and retry.");
	}
	requestSignal.throwIfAborted();
	if (!response.ok) {
		void response.body?.cancel().catch(() => { });
		throw new Error(`Copilot Auto: /models/session ${response.status}. Check your Copilot access or run /copilot-auto-doctor.`);
	}
	let value: unknown;
	try { value = await response.json(); }
	catch {
		requestSignal.throwIfAborted();
		throw new Error("Copilot Auto: invalid /models/session payload");
	}
	requestSignal.throwIfAborted();
	const parsed = AutoSessionSchema.safeParse(value);
	if (!parsed.success || !parsed.data.session_token.trim() || parsed.data.available_models.length === 0 || parsed.data.available_models.some(id => !id.trim()))
		throw new Error("Copilot Auto: invalid /models/session payload");
	const data = parsed.data;
	const expiresAtMs = Math.min(data.expires_at == null ? now + MAX_LIFETIME_MS : data.expires_at * 1000, now + MAX_LIFETIME_MS);
	if (expiresAtMs <= Date.now()) throw new Error("Copilot Auto: invalid /models/session payload (session already expired)");
	if (sessions.get(cacheKey) !== entry) throw new Error("Copilot Auto: conversation changed while opening a session. Retry the request.");
	const session: AutoSession = {
		sessionToken: data.session_token,
		availableModels: data.available_models,
		discountedCosts: data.discounted_costs,
		expiresAtMs,
	};
	entry.session = session;
	log(`session opened: ${session.availableModels.length} available models`);
	return session;
}
