/**
 * Request assembly + streaming for the Auto model. Resolves the token + session,
 * lets the router pick a concrete model from the pool, and delegates to Pi's
 * matching built-in streamer with the Copilot-Session-Token header attached.
 */
import {
	type Api,
	type AssistantMessageEventStream,
	anthropicMessagesApi,
	createAssistantMessageEventStream,
	type Model,
	openAICompletionsApi,
	openAIResponsesApi,
	type SimpleStreamOptions,
	type TranscriptContext,
} from "@earendil-works/pi-ai/compat";
import { randomUUID } from "node:crypto";
import { getCopilotAuth } from "./auth.ts";
import { AUTO_MAX_TOKENS, COPILOT_HEADERS } from "./config.ts";
import {
	supportedCopilotApiList,
	supportedCopilotModels,
} from "./model-support.ts";
import type { AutoRouter, RouteDecision } from "./router.ts";
import { getAutoSession, resetAutoSessions } from "./session.ts";

function streamConcreteModel(
	model: Model<Api>,
	context: TranscriptContext,
	options: SimpleStreamOptions,
): AssistantMessageEventStream {
	switch (model.api) {
		case "anthropic-messages":
			return anthropicMessagesApi().streamSimple(
				model as Model<"anthropic-messages">,
				context,
				options,
			);
		case "openai-completions":
			return openAICompletionsApi().streamSimple(
				model as Model<"openai-completions">,
				context,
				options,
			);
		case "openai-responses":
			return openAIResponsesApi().streamSimple(
				model as Model<"openai-responses">,
				context,
				options,
			);
		default:
			throw new Error(
				`Copilot Auto: model ${model.id} routed to unsupported API ${model.api}. Supported APIs here: ${supportedCopilotApiList()}. Update Pi or this extension if GitHub adds a new API family.`,
			);
	}
}

export interface StreamCopilotAutoDeps {
	/** Per-conversation routing state owned by the extension host. */
	router: AutoRouter;
	/** Called once per request with the route that served it. */
	onRoute?: (decision: RouteDecision) => void;
}

const routerState = new WeakMap<AutoRouter, { key: string; auth: string }>();
export function resetStreamState(router: AutoRouter): void {
    const state = routerState.get(router);
    if (state) resetAutoSessions(state.key);
    routerState.delete(router);
}

/** Never repeat an SDK's raw error response: it can contain a prompt or credential. */
export function safeStreamError(message: string | undefined): string {
  const status = message?.match(/(?:^|HTTP |status[ :]+|error \()(\d{3})\b/i)?.[1];
  return `Copilot Auto: model request failed${status ? ` (HTTP ${status})` : ""}. Run /copilot-student-doctor; check your Copilot access and usage at github.com/settings/copilot.`;
}

export function streamCopilotAuto(
	model: Model<Api>,
	context: TranscriptContext,
	options: SimpleStreamOptions | undefined,
	deps: StreamCopilotAutoDeps,
): AssistantMessageEventStream {
	const stream = createAssistantMessageEventStream();

	(async () => {
		try {
			const signal = options?.signal;
			const { token: copilotToken, apiBase: base } =
				await getCopilotAuth(signal);
			signal?.throwIfAborted();
            let state = routerState.get(deps.router);
            const authIdentity = `${base}\n${copilotToken}`;
            if (!state || state.auth !== authIdentity || (options?.sessionId && state.key !== options.sessionId)) {
                if (state) { deps.router.reset(); resetStreamState(deps.router); }
                state = { key: options?.sessionId ?? randomUUID(), auth: authIdentity };
                routerState.set(deps.router, state);
            }
            const session = await getAutoSession(base, copilotToken, signal, state.key);

			const known = supportedCopilotModels();
			const decision = await deps.router.resolve({
				base,
				copilotToken,
				session,
				messages: context.messages,
				known,
				signal,
			});
			if (!decision) {
				throw new Error(
					`Copilot Auto: no supported model in the Auto pool matched Pi's catalog. Pool: [${session.availableModels.join(", ")}]`,
				);
			}
			// The router only ever returns ids from the pool ∩ Pi's catalog.
			const concrete = known.get(decision.model);
			if (!concrete) {
				throw new Error(
					`Copilot Auto: selected model ${decision.model} is missing from Pi's catalog.`,
				);
			}
			deps.onRoute?.(decision);

			const concreteWithBase = { ...concrete, baseUrl: base };
			const streamOptions: SimpleStreamOptions = {
				...options,
				apiKey: copilotToken,
                maxTokens: Math.min(options?.maxTokens ?? AUTO_MAX_TOKENS, AUTO_MAX_TOKENS, concrete.maxTokens),
				headers: {
                    ...Object.fromEntries(Object.entries(options?.headers ?? {}).filter(([key]) =>
                        !["authorization", "copilot-session-token", "x-api-key", "api-key", ...Object.keys(COPILOT_HEADERS).map(k => k.toLowerCase())].includes(key.toLowerCase())
                    )),
					...COPILOT_HEADERS,
                    Authorization: `Bearer ${copilotToken}`,
					"Copilot-Session-Token": session.sessionToken,
				},
			};

			const inner = streamConcreteModel(
				concreteWithBase,
				context,
				streamOptions,
			);
			for await (const event of inner) {
                if (event.type === "error") {
                    stream.push({ ...event, error: { ...event.error, errorMessage: safeStreamError(event.error.errorMessage) } });
                } else stream.push(event);
            }
			stream.end();
		} catch (error) {
			// Mirror the built-in providers: a cancelled request is an aborted
			// result, not an error. Cancellation during the token exchange or the
			// Auto session open lands here, before a delegated stream exists.
			const stopReason = options?.signal?.aborted ? "aborted" : "error";
			stream.push({
				type: "error",
				reason: stopReason,
				error: {
					role: "assistant",
					content: [],
					api: model.api,
					provider: model.provider,
					model: model.id,
					usage: {
						input: 0,
						output: 0,
						cacheRead: 0,
						cacheWrite: 0,
						totalTokens: 0,
						cost: {
							input: 0,
							output: 0,
							cacheRead: 0,
							cacheWrite: 0,
							total: 0,
						},
					},
					stopReason,
					errorMessage: error instanceof Error && error.message.startsWith("Copilot Auto:") ? error.message : safeStreamError(undefined),
					timestamp: Date.now(),
				},
			});
			stream.end();
		}
	})();

	return stream;
}
