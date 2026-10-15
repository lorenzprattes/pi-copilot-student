import assert from "node:assert/strict";
import { beforeEach, describe, test } from "node:test";
import { EXPECTED_API_BASE, jsonResponse, redirectAgentDir, SAMPLE_COPILOT_TOKEN, SAMPLE_SESSION_TOKEN, stubFetch, textResponse } from "./harness.ts";
redirectAgentDir();
const { getAutoSession, resetAutoSessions } = await import("../src/session.ts");
const payload = (seconds = 3600) => ({ session_token: SAMPLE_SESSION_TOKEN, available_models: ["gpt-5.4"], expires_at: Math.floor(Date.now() / 1000) + seconds });
beforeEach(() => resetAutoSessions());

describe("Auto session lifecycle", () => {
	test("opens an Auto pool with client identity and preserves pool metadata", async () => {
		const stub = stubFetch(() => jsonResponse({ ...payload(), discounted_costs: { "gpt-5.4": 0.5 } }));
		try {
			const session = await getAutoSession(EXPECTED_API_BASE, SAMPLE_COPILOT_TOKEN);
			assert.equal(session.sessionToken, SAMPLE_SESSION_TOKEN);
			assert.deepEqual(session.availableModels, ["gpt-5.4"]);
			assert.deepEqual(session.discountedCosts, { "gpt-5.4": 0.5 });
			assert.equal(stub.calls[0].url, `${EXPECTED_API_BASE}/models/session`);
			assert.equal(stub.calls[0].headers.authorization, `Bearer ${SAMPLE_COPILOT_TOKEN}`);
			assert.equal(stub.calls[0].headers["copilot-integration-id"], "vscode-chat");
			assert.deepEqual(JSON.parse(String(stub.calls[0].init?.body)), { auto_mode: { model_hints: ["auto"] } });
			assert.deepEqual(await getAutoSession(EXPECTED_API_BASE, SAMPLE_COPILOT_TOKEN), session);
			assert.equal(stub.calls.length, 1);
		} finally { stub.restore(); }
	});
	test("scopes sessions to conversation, credentials and API endpoint", async () => {
		const stub = stubFetch(() => jsonResponse(payload()));
		try {
			await getAutoSession(EXPECTED_API_BASE, "first", undefined, "conversation-a");
			await getAutoSession(EXPECTED_API_BASE, "first", undefined, "conversation-b");
			await getAutoSession(EXPECTED_API_BASE, "second", undefined, "conversation-a");
			await getAutoSession("https://copilot-api.enterprise.example", "second", undefined, "conversation-a");
			assert.equal(stub.calls.length, 4);
			await getAutoSession(EXPECTED_API_BASE, "first", undefined, "conversation-b");
			assert.equal(stub.calls.length, 4);
		} finally { stub.restore(); }
	});
	test("reset invalidates only the requested conversation", async () => {
		const stub = stubFetch(() => jsonResponse(payload()));
		try {
			await getAutoSession(EXPECTED_API_BASE, "token", undefined, "a");
			await getAutoSession(EXPECTED_API_BASE, "token", undefined, "b");
			resetAutoSessions("a");
			await getAutoSession(EXPECTED_API_BASE, "token", undefined, "b");
			assert.equal(stub.calls.length, 2);
			await getAutoSession(EXPECTED_API_BASE, "token", undefined, "a");
			assert.equal(stub.calls.length, 3);
		} finally { stub.restore(); }
	});
	test("bounds absent or excessive expiry to 25 minutes", async () => {
		for (const expires_at of [undefined, Math.floor(Date.now() / 1000) + 86400]) {
			resetAutoSessions();
			const before = Date.now();
			const stub = stubFetch(() => jsonResponse({ ...payload(), expires_at }));
			try {
				const result = await getAutoSession(EXPECTED_API_BASE, SAMPLE_COPILOT_TOKEN);
				assert.ok(result.expiresAtMs >= before + 25 * 60 * 1000);
				assert.ok(result.expiresAtMs <= Date.now() + 25 * 60 * 1000);
				assert.deepEqual(result.discountedCosts, {});
			} finally { stub.restore(); }
		}
	});
	test("rejects empty tokens, empty pools, expired sessions and malformed JSON", async () => {
		for (const body of [{ ...payload(), session_token: "" }, { ...payload(), available_models: [] }, payload(-1), { session_token: SAMPLE_SESSION_TOKEN }]) {
			const stub = stubFetch(() => jsonResponse(body));
			try { await assert.rejects(getAutoSession(EXPECTED_API_BASE, SAMPLE_COPILOT_TOKEN), /invalid \/models\/session payload/); }
			finally { stub.restore(); }
		}
		const stub = stubFetch(() => textResponse(`{"session_token":"${SAMPLE_SESSION_TOKEN}" broken`, 200));
		try { await assert.rejects(getAutoSession(EXPECTED_API_BASE, SAMPLE_COPILOT_TOKEN), { message: "Copilot Auto: invalid /models/session payload" }); }
		finally { stub.restore(); }
	});
	test("failed refresh never returns the previous session or provider response text", async () => {
		let count = 0;
		const stub = stubFetch(() => ++count === 1 ? jsonResponse(payload(30)) : textResponse(`Private arbitrary value: ${SAMPLE_SESSION_TOKEN}`, 403));
		try {
			await getAutoSession(EXPECTED_API_BASE, SAMPLE_COPILOT_TOKEN);
			for (let i = 0; i < 2; i++) {
				await assert.rejects(getAutoSession(EXPECTED_API_BASE, SAMPLE_COPILOT_TOKEN), (error: Error) => {
					assert.match(error.message, /\/models\/session 403/);
					assert.ok(!error.message.includes("Private arbitrary value"));
					assert.ok(!error.message.includes(SAMPLE_SESSION_TOKEN));
					return true;
				});
			}
			assert.equal(stub.calls.length, 3);
		} finally { stub.restore(); }
	});
	test("cancellation is honored even for a warm cache", async () => {
		const stub = stubFetch(() => jsonResponse(payload()));
		try {
			await getAutoSession(EXPECTED_API_BASE, SAMPLE_COPILOT_TOKEN);
			await assert.rejects(getAutoSession(EXPECTED_API_BASE, SAMPLE_COPILOT_TOKEN, AbortSignal.abort()), { name: "AbortError" });
			assert.equal(stub.calls.length, 1);
		} finally { stub.restore(); }
	});
	test("response-body cancellation is propagated without caching its result", async () => {
		const controller = new AbortController();
		const stub = stubFetch(() => {
			const response = jsonResponse(payload());
			response.json = async () => { controller.abort(); throw new Error("secret body"); };
			return response;
		});
		try { await assert.rejects(getAutoSession(EXPECTED_API_BASE, SAMPLE_COPILOT_TOKEN, controller.signal), { name: "AbortError" }); }
		finally { stub.restore(); }
	});
	test("a reset during the request invalidates its eventual result", async () => {
		const stub = stubFetch(() => { resetAutoSessions("a"); return jsonResponse(payload()); });
		try { await assert.rejects(getAutoSession(EXPECTED_API_BASE, SAMPLE_COPILOT_TOKEN, undefined, "a"), /conversation changed/); }
		finally { stub.restore(); }
	});
	test("timeouts remain timeouts instead of successful stale sessions", async () => {
		const original = AbortSignal.timeout;
		AbortSignal.timeout = () => AbortSignal.abort(new DOMException("Timeout", "TimeoutError"));
		const stub = stubFetch(() => jsonResponse(payload()));
		try { await assert.rejects(getAutoSession(EXPECTED_API_BASE, SAMPLE_COPILOT_TOKEN), { name: "TimeoutError" }); }
		finally { stub.restore(); AbortSignal.timeout = original; }
	});
});
