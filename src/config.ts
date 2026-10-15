/**
 * Static config + opt-in diagnostics for pi-copilot-student.
 */
import { appendFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

export const PROVIDER_ID = "github-copilot-auto";
export const AUTO_MODEL_ID = "auto";
const COPILOT_API_VERSION = "2026-06-01";

// Same client identity the built-in github-copilot provider sends. Copilot-Integration-Id
// is the gate for the /models/session endpoints; reuse the value that already works for chat.
export const COPILOT_HEADERS: Record<string, string> = {
	"User-Agent": "GitHubCopilotChat/0.35.0",
	"Editor-Version": "vscode/1.107.0",
	"Editor-Plugin-Version": "copilot-chat/0.35.0",
	"Copilot-Integration-Id": "vscode-chat",
	"X-GitHub-Api-Version": COPILOT_API_VERSION,
};

export const AGENT_DIR = process.env.PI_CODING_AGENT_DIR || join(homedir(), ".pi", "agent");
export const AUTH_PATH = process.env.PI_COPILOT_AUTH || join(AGENT_DIR, "auth.json");
const LOG_PATH = process.env.PI_COPILOT_LOG;
// Conservative shared limits: Auto may choose a different model after compaction.
export const AUTO_CONTEXT_WINDOW = 64000;
export const AUTO_MAX_TOKENS = 8192;

export function log(msg: string): void {
	if (!LOG_PATH) return;
	try {
		appendFileSync(LOG_PATH, `${new Date().toISOString()} ${msg}\n`, "utf8");
	} catch {
		/* logging is best-effort */
	}
}
