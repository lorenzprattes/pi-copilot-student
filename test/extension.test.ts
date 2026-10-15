import assert from "node:assert/strict";
import { test } from "node:test";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { redirectAgentDir } from "./harness.ts";
redirectAgentDir();
const { default: extension } = await import("../src/index.ts");

test("registers an independent Auto provider without network calls or setting changes", () => {
  const commands = new Set<string>();
  let registration: any;
  const originalFetch = globalThis.fetch;
  globalThis.fetch = () => { throw new Error("startup must not contact GitHub"); };
  try {
    extension({
      on() {},
      registerCommand(name: string) { commands.add(name); },
      registerProvider(id: string, config: unknown) { registration = { id, config }; },
    } as unknown as ExtensionAPI);
    assert.equal(registration.id, "github-copilot-auto");
    assert.equal(registration.config.models[0].contextWindow, 64000);
    assert.equal(registration.config.models[0].maxTokens, 8192);
    assert.ok(commands.has("copilot-student-doctor"));
    assert.ok(commands.has("copilot-auto-doctor"));
  } finally { globalThis.fetch = originalFetch; }
});
