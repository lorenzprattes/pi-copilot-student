import assert from "node:assert/strict";
import { writeFileSync } from "node:fs";
import { beforeEach, describe, test } from "node:test";
import {
	clearStoredCopilot, jsonResponse, redirectAgentDir, SAMPLE_COPILOT_TOKEN,
	SAMPLE_GITHUB_TOKEN, stubFetch, textResponse, writeStoredCopilot,
} from "./harness.ts";
const authPath = redirectAgentDir();
const { getCopilotAuth, getStoredCopilotStatus, resetCopilotAuth } = await import("../src/auth.ts");
const payload = (token = SAMPLE_COPILOT_TOKEN, seconds = 3600) => ({ token, expires_at: Math.floor(Date.now() / 1000) + seconds });

beforeEach(() => { resetCopilotAuth(); clearStoredCopilot(authPath); });

describe("Copilot authentication", () => {
	test("missing or invalid credentials fail with login guidance", async () => {
		await assert.rejects(getCopilotAuth(), /cannot read.*Run \/login/);
		for (const entry of [{ something: "else" }, { refresh: "" }, { refresh: "  " }]) {
			writeStoredCopilot(authPath, entry);
			await assert.rejects(getCopilotAuth(), /no github-copilot login found/);
		}
	});
	test("malformed JSON never reveals its credential-bearing parser snippet", async () => {
		writeFileSync(authPath, `{"github-copilot":{"refresh":"${SAMPLE_GITHUB_TOKEN}" BROKEN`);
		await assert.rejects(getCopilotAuth(), (error: Error) => {
			assert.match(error.message, /invalid auth file JSON/);
			assert.ok(!error.message.includes(SAMPLE_GITHUB_TOKEN));
			assert.ok(!error.message.includes("BROKEN"));
			return true;
		});
	});
	test("exchanges the refresh token with Copilot headers and reuses the result", async () => {
		writeStoredCopilot(authPath, { refresh: SAMPLE_GITHUB_TOKEN });
		const stub = stubFetch(() => jsonResponse(payload()));
		try {
			const result = await getCopilotAuth();
			assert.equal(result.token, SAMPLE_COPILOT_TOKEN);
			assert.equal(result.apiBase, "https://api.individual.githubcopilot.com");
			assert.deepEqual(await getCopilotAuth(), result);
			assert.equal(stub.calls.length, 1);
			assert.equal(stub.calls[0].url, "https://api.github.com/copilot_internal/v2/token");
			assert.equal(stub.calls[0].headers.authorization, `Bearer ${SAMPLE_GITHUB_TOKEN}`);
			assert.equal(stub.calls[0].headers["copilot-integration-id"], "vscode-chat");
		} finally { stub.restore(); }
	});
	test("logout invalidates a warm token cache", async () => {
		writeStoredCopilot(authPath, { refresh: SAMPLE_GITHUB_TOKEN });
		const stub = stubFetch(() => jsonResponse(payload()));
		try {
			await getCopilotAuth();
			clearStoredCopilot(authPath);
			await assert.rejects(getCopilotAuth(), /cannot read/);
			assert.equal(stub.calls.length, 1);
		} finally { stub.restore(); }
	});
	test("account and Enterprise host changes cannot reuse the previous account token", async () => {
		writeStoredCopilot(authPath, { refresh: SAMPLE_GITHUB_TOKEN });
		const stub = stubFetch(call => jsonResponse(payload(call.url.includes("enterprise.example") ? "enterprise-token" : "first-token")));
		try {
			assert.equal((await getCopilotAuth()).token, "first-token");
			writeStoredCopilot(authPath, { refresh: "second-account-token", enterpriseUrl: "https://enterprise.example/" });
			const changed = await getCopilotAuth();
			assert.equal(changed.token, "enterprise-token");
			assert.equal(changed.apiBase, "https://copilot-api.enterprise.example");
			assert.equal(stub.calls.length, 2);
			assert.equal(stub.calls[1].headers.authorization, "Bearer second-account-token");
		} finally { stub.restore(); }
	});
	test("uses a stored access token only outside the refresh safety margin", async () => {
		writeStoredCopilot(authPath, { refresh: SAMPLE_GITHUB_TOKEN, access: "stored-token", expires: Date.now() + 600_000 });
		const stub = stubFetch(() => jsonResponse(payload()));
		try {
			assert.equal((await getCopilotAuth()).token, "stored-token");
			assert.equal(stub.calls.length, 0);
			writeStoredCopilot(authPath, { refresh: SAMPLE_GITHUB_TOKEN, access: "nearly-expired", expires: Date.now() + 30_000 });
			assert.equal((await getCopilotAuth()).token, SAMPLE_COPILOT_TOKEN);
			assert.equal(stub.calls.length, 1);
		} finally { stub.restore(); }
	});
	test("a failed refresh never returns stale credentials and omits provider response bodies", async () => {
		writeStoredCopilot(authPath, { refresh: SAMPLE_GITHUB_TOKEN, access: "expired-secret", expires: Date.now() - 1 });
		const stub = stubFetch(() => textResponse(`Unknown credential: ${SAMPLE_GITHUB_TOKEN}`, 401));
		try {
			await assert.rejects(getCopilotAuth(), (error: Error) => {
				assert.match(error.message, /token exchange failed 401/);
				assert.ok(!error.message.includes(SAMPLE_GITHUB_TOKEN));
				assert.ok(!error.message.includes("Unknown credential"));
				return true;
			});
		} finally { stub.restore(); }
	});
	test("rejects malformed, empty and already-expired exchange payloads", async () => {
		writeStoredCopilot(authPath, { refresh: SAMPLE_GITHUB_TOKEN });
		for (const body of [{ token: 42 }, payload("", 3600), payload("expired", -1)]) {
			const stub = stubFetch(() => jsonResponse(body));
			try { await assert.rejects(getCopilotAuth(), /invalid token exchange response/); }
			finally { stub.restore(); }
		}
	});
	test("JSON response parsing errors do not expose response text", async () => {
		writeStoredCopilot(authPath, { refresh: SAMPLE_GITHUB_TOKEN });
		const stub = stubFetch(() => textResponse(`{"token":"${SAMPLE_COPILOT_TOKEN}" bad`, 200));
		try {
			await assert.rejects(getCopilotAuth(), { message: "Copilot Auto: invalid token exchange response" });
		} finally { stub.restore(); }
	});
	test("cancellation is respected even when a cached token is available", async () => {
		writeStoredCopilot(authPath, { refresh: SAMPLE_GITHUB_TOKEN });
		const stub = stubFetch(() => jsonResponse(payload()));
		try {
			await getCopilotAuth();
			await assert.rejects(getCopilotAuth(AbortSignal.abort()), { name: "AbortError" });
			assert.equal(stub.calls.length, 1);
		} finally { stub.restore(); }
	});
	test("cancellation while decoding a response is not reported as malformed JSON", async () => {
		writeStoredCopilot(authPath, { refresh: SAMPLE_GITHUB_TOKEN });
		const controller = new AbortController();
		const stub = stubFetch(() => {
			const response = jsonResponse(payload());
			response.json = async () => { controller.abort(); throw new Error("secret parser content"); };
			return response;
		});
		try { await assert.rejects(getCopilotAuth(controller.signal), { name: "AbortError" }); }
		finally { stub.restore(); }
	});
	test("authentication changes during exchange invalidate the in-flight result", async () => {
		writeStoredCopilot(authPath, { refresh: SAMPLE_GITHUB_TOKEN });
		const stub = stubFetch(() => {
			writeStoredCopilot(authPath, { refresh: "replacement-account" });
			return jsonResponse(payload());
		});
		try { await assert.rejects(getCopilotAuth(), /login changed during token exchange/); }
		finally { stub.restore(); }
	});
	test("timeouts abort the exchange and cannot populate the cache", async () => {
		writeStoredCopilot(authPath, { refresh: SAMPLE_GITHUB_TOKEN });
		const original = AbortSignal.timeout;
		AbortSignal.timeout = () => AbortSignal.abort(new DOMException("Timeout", "TimeoutError"));
		const stub = stubFetch(() => jsonResponse(payload()));
		try { await assert.rejects(getCopilotAuth(), { name: "TimeoutError" }); }
		finally { stub.restore(); AbortSignal.timeout = original; }
	});
});

test("doctor status contains no credential values", () => {
	const expires = Date.now() + 600_000;
	writeStoredCopilot(authPath, { refresh: SAMPLE_GITHUB_TOKEN, access: SAMPLE_COPILOT_TOKEN, expires, enterpriseUrl: "https://enterprise.example/" });
	assert.deepEqual(getStoredCopilotStatus(), { authPath, hasAccessToken: true, accessTokenExpiresAtMs: expires, hasRefreshToken: true, enterpriseDomain: "enterprise.example" });
	assert.ok(!JSON.stringify(getStoredCopilotStatus()).includes(SAMPLE_GITHUB_TOKEN));
});
