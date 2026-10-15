/**
 * The intent-router client and the pure routing rules around it.
 *
 * The request/response shape asserted here is the one microsoft/vscode-copilot-chat
 * sends and reads (routerDecisionFetcher.ts); the selection rules are the
 * handoff's: never a model outside the pool, never one Pi cannot stream.
 */
import assert from "node:assert/strict";
import { describe, test } from "node:test";
import type { Api, Model, Message } from "@earendil-works/pi-ai/compat";
import {
	EXPECTED_API_BASE,
	jsonResponse,
	pendingResponse,
	redirectAgentDir,
	SAMPLE_COPILOT_TOKEN,
	SAMPLE_SESSION_TOKEN,
	stubFetch,
	textResponse,
} from "./harness.ts";

// Must precede the imports below: config.ts resolves its paths at module init.
redirectAgentDir();
const {
	AutoRouter,
	describeRouteDecision,
	fetchRouterDecision,
	pickRoutedModel,
	routingPrompt,
} = await import("../src/router.ts");

const user = (content: unknown) =>
	({ role: "user", content, timestamp: 1 }) as Message;
const assistant = (text: string) =>
	({
		role: "assistant",
		content: [{ type: "text", text }],
		api: "anthropic-messages",
		provider: "github-copilot",
		model: "m",
		usage: {},
		stopReason: "stop",
		timestamp: 1,
	}) as unknown as Message;

describe("routingPrompt", () => {
	test("takes the latest user message only and counts user turns", () => {
		const prompt = routingPrompt([
			user("first question"),
			assistant("answer"),
			user("  follow-up  "),
		]);
		assert.deepEqual(prompt, {
			text: "follow-up",
			hasImage: false,
			turnNumber: 2,
		});
	});

	test("joins text parts and flags attached images", () => {
		const prompt = routingPrompt([
			user([
				{ type: "text", text: "look" },
				{ type: "image", data: "AAAA", mimeType: "image/png" },
				{ type: "text", text: "here" },
			]),
		]);
		assert.deepEqual(prompt, {
			text: "look\nhere",
			hasImage: true,
			turnNumber: 1,
		});
	});

	test("is empty when there is no user message or only whitespace", () => {
		assert.deepEqual(routingPrompt([]), {
			text: "",
			hasImage: false,
			turnNumber: 0,
		});
		assert.equal(routingPrompt([user("   ")]).text, "");
	});
});

describe("pickRoutedModel", () => {
	const supported = new Set(["a", "b"]);

	test("returns the first candidate that is pooled and streamable", () => {
		assert.equal(
			pickRoutedModel(
				["x", "unknown", "b", "a"],
				["a", "b", "unknown"],
				supported,
			),
			"b",
		);
	});

	test("never picks a model outside the session pool", () => {
		assert.equal(pickRoutedModel(["a"], ["b"], supported), undefined);
	});

	test("never picks a pooled model Pi cannot stream", () => {
		assert.equal(
			pickRoutedModel(["unknown"], ["unknown"], supported),
			undefined,
		);
		assert.equal(pickRoutedModel([], ["a"], supported), undefined);
	});
});

describe("describeRouteDecision", () => {
	test("names the source so diagnostics never pass a default off as a router pick", () => {
		assert.equal(
			describeRouteDecision({
				source: "router",
				model: "gpt-x",
				label: "needs_reasoning",
				confidence: 0.912,
			}),
			"gpt-x via router (needs_reasoning, confidence 0.91)",
		);
		assert.equal(
			describeRouteDecision({
				source: "default",
				model: "gpt-x",
				reason: "router_error",
				detail: "404: not found",
			}),
			"gpt-x default (router_error 404: not found)",
		);
	});
});

describe("fetchRouterDecision", () => {
	const request = {
		base: EXPECTED_API_BASE,
		copilotToken: SAMPLE_COPILOT_TOKEN,
		sessionToken: SAMPLE_SESSION_TOKEN,
		availableModels: ["a", "b"],
		prompt: "why is the build red?",
		signals: { turn_number: 1, prompt_char_count: 21 },
	};

	test("posts the verified body and headers to /models/session/intent", async () => {
		const fetchStub = stubFetch(() =>
			jsonResponse({
				predicted_label: "no_reasoning",
				confidence: 0.6,
				latency_ms: 9,
				candidate_models: ["b"],
				scores: { needs_reasoning: 0.4, no_reasoning: 0.6 },
			}),
		);
		try {
			const result = await fetchRouterDecision(request);
			assert.deepEqual(result, {
				ok: true,
				decision: {
					predicted_label: "no_reasoning",
					confidence: 0.6,
					candidate_models: ["b"],
				},
			});
			const [call] = fetchStub.calls;
			assert.equal(call.url, `${EXPECTED_API_BASE}/models/session/intent`);
			assert.equal(call.init?.method, "POST");
			assert.equal(
				call.headers.authorization,
				`Bearer ${SAMPLE_COPILOT_TOKEN}`,
			);
			assert.equal(call.headers["copilot-session-token"], SAMPLE_SESSION_TOKEN);
			assert.equal(call.headers["content-type"], "application/json");
			assert.equal(call.headers["copilot-integration-id"], "vscode-chat");
			assert.deepEqual(JSON.parse(String(call.init?.body)), {
				prompt: "why is the build red?",
				available_models: ["a", "b"],
				turn_number: 1,
				prompt_char_count: 21,
			});
		} finally {
			fetchStub.restore();
		}
	});

	test("reports only HTTP status, never provider response content", async () => {
		const fetchStub = stubFetch(() =>
			textResponse(
				`{"error":"gone","session_token":"${SAMPLE_SESSION_TOKEN}","token":"${SAMPLE_COPILOT_TOKEN}"}`,
				404,
			),
		);
		try {
			const result = await fetchRouterDecision(request);
			assert.equal(result.ok, false);
			if (!result.ok) {
				assert.equal(result.reason, "router_error");
				assert.equal(result.detail, "HTTP 404");
				assert.ok(!result.detail?.includes(SAMPLE_SESSION_TOKEN));
				assert.ok(!result.detail?.includes(SAMPLE_COPILOT_TOKEN));
				assert.ok(!result.detail?.includes("deadbeefcafe"));
			}
		} finally {
			fetchStub.restore();
		}
	});

	test("reports a payload that does not match the schema", async () => {
		for (const body of [
			jsonResponse({ predicted_label: "needs_reasoning" }),
			jsonResponse({ candidate_models: "a" }),
			textResponse("<html>", 200),
		]) {
			const fetchStub = stubFetch(() => body);
			try {
				assert.deepEqual(await fetchRouterDecision(request), {
					ok: false,
					reason: "router_invalid_payload",
				});
			} finally {
				fetchStub.restore();
			}
		}
	});

	test("reports a timeout instead of waiting on the router", async () => {
		const fetchStub = stubFetch(() => pendingResponse());
		try {
			assert.deepEqual(
				await fetchRouterDecision({ ...request, timeoutMs: 20 }),
				{ ok: false, reason: "router_timeout" },
			);
		} finally {
			fetchStub.restore();
		}
	});

	test("reports a network failure without the credential", async () => {
		const fetchStub = stubFetch(() => {
			throw new TypeError(`fetch failed for Bearer ${SAMPLE_COPILOT_TOKEN}`);
		});
		try {
			const result = await fetchRouterDecision(request);
			assert.equal(result.ok, false);
			if (!result.ok) {
				assert.equal(result.reason, "router_error");
				assert.ok(!result.detail?.includes("deadbeefcafe"));
			}
		} finally {
			fetchStub.restore();
		}
	});

	test("rethrows when the caller cancels, so no fallback request follows", async () => {
		const controller = new AbortController();
		const fetchStub = stubFetch(() => {
			controller.abort();
			return pendingResponse();
		});
		try {
			await assert.rejects(
				fetchRouterDecision({ ...request, signal: controller.signal }),
				{ name: "AbortError" },
			);
		} finally {
			fetchStub.restore();
		}
	});
});


describe("routing safety", () => {
	const model = (id: string, vision = false, api = "openai-responses") =>
		({ id, api, input: vision ? ["text", "image"] : ["text"] }) as Model<Api>;
	const session = {
		sessionToken: SAMPLE_SESSION_TOKEN, availableModels: ["text", "vision", "unsupported"],
		discountedCosts: {}, expiresAtMs: Date.now() + 60000,
	};
	const input = {
		base: EXPECTED_API_BASE, copilotToken: SAMPLE_COPILOT_TOKEN, session,
		known: new Map([
			["text", model("text")], ["vision", model("vision", true)],
			["unsupported", model("unsupported", true, "unknown-api")],
		]),
		messages: [user("first question")],
	};

	test("new and retained image content invalidates text-only sticky routing", async () => {
		const fetchStub = stubFetch(() => jsonResponse({ candidate_models: ["text"], predicted_label: "simple" }));
		try {
			const router = new AutoRouter();
			assert.equal((await router.resolve(input))?.model, "text");
			const messages = [...input.messages, user([{ type: "image", data: "AAAA", mimeType: "image/png" }])];
			assert.equal((await router.resolve({ ...input, messages }))?.model, "vision");
			assert.equal((await router.resolve({ ...input, messages: [...messages, user("what next?")] }))?.model, "vision");
			assert.equal(fetchStub.calls.length, 1);
		} finally { fetchStub.restore(); }
	});

	test("fails closed when an image has no streamable vision model in the pool", async () => {
		const router = new AutoRouter();
		assert.equal(await router.resolve({ ...input, session: { ...session, availableModels: ["text", "unsupported"] },
			messages: [user([{ type: "image", data: "AAAA", mimeType: "image/png" }])] }), undefined);
	});

	test("tool-result images also require a vision model", async () => {
		const messages = [...input.messages, { role: "toolResult", toolCallId: "x", toolName: "read", isError: false,
			timestamp: 1, content: [{ type: "image", data: "AAAA", mimeType: "image/png" }] } as Message];
		assert.equal((await new AutoRouter().resolve({ ...input, messages }))?.model, "vision");
	});

	test("cancellation while reading success or error bodies never falls back", async () => {
		for (const status of [200, 500]) {
			const controller = new AbortController();
			const response = jsonResponse({ candidate_models: ["text"], predicted_label: "simple" }, status);
			const read = async () => { controller.abort(); throw new DOMException("cancelled", "AbortError"); };
			Object.defineProperty(response, status === 200 ? "json" : "text", { value: read });
			const fetchStub = stubFetch(() => response);
			try {
				await assert.rejects(new AutoRouter().resolve({ ...input, signal: controller.signal }), { name: "AbortError" });
				assert.equal(fetchStub.calls.length, 1);
			} finally { fetchStub.restore(); }
		}
	});

	test("already-cancelled calls do not return a cached route", async () => {
		const router = new AutoRouter();
		await router.resolve({ ...input, messages: [] });
		const controller = new AbortController(); controller.abort();
		await assert.rejects(router.resolve({ ...input, signal: controller.signal }), { name: "AbortError" });
	});

	test("a routing result from a reset conversation is discarded", async () => {
		const router = new AutoRouter();
		const fetchStub = stubFetch(() => {
			router.reset();
			return jsonResponse({ candidate_models: ["text"], predicted_label: "simple" });
		});
		try {
			await assert.rejects(router.resolve(input), /conversation changed/);
			assert.equal(router.lastDecision, undefined);
		} finally { fetchStub.restore(); }
	});
});
