import { describe, expect, it } from "vitest";

import {
  agentRuntimeForBinary,
  agentRuntimeIds,
  agentRuntimeLabel,
  agentRuntimeManualSnippet,
  agentRuntimes,
  findAgentRuntime,
} from "./agent-runtimes.js";
import { agentSourceSchema } from "./contracts.js";

describe("the agent runtime roster", () => {
  it("declares the runtimes SIQshift is expected to recognize", () => {
    for (const id of ["claude_code", "codex", "cursor", "kimi_code", "pi", "opencode"]) {
      expect(agentRuntimeIds).toContain(id);
    }
  });

  it("declares runtimes that are installed nowhere, so absence is never hard-coded", () => {
    for (const id of ["pi_signed", "grok", "muse", "copilot"]) {
      expect(findAgentRuntime(id)).toBeDefined();
    }
  });

  it("uses ids the wire contract already accepts", () => {
    for (const runtime of agentRuntimes) {
      expect(agentSourceSchema.parse(runtime.id)).toBe(runtime.id);
    }
  });

  it("gives every runtime a distinct id and claims no executable twice", () => {
    expect(new Set(agentRuntimeIds).size).toBe(agentRuntimeIds.length);
    const binaries = agentRuntimes.flatMap((runtime) => runtime.binaries);
    expect(new Set(binaries).size).toBe(binaries.length);
  });

  it("names a runtime by its label and an undeclared one by its own id", () => {
    expect(agentRuntimeLabel("claude_code")).toBe("Claude Code");
    expect(agentRuntimeLabel("pi")).toBe("Pi");
    // A wrong name would be worse than a raw one.
    expect(agentRuntimeLabel("agent_9")).toBe("agent_9");
  });

  it("folds an agent executable into its runtime, whatever the case or suffix", () => {
    expect(agentRuntimeForBinary("claude")).toBe("claude_code");
    expect(agentRuntimeForBinary("claude.exe")).toBe("claude_code");
    expect(agentRuntimeForBinary("PI")).toBe("pi");
    expect(agentRuntimeForBinary("opencode")).toBe("opencode");
    // A runtime is never read off a model name, nor a model off a process.
    expect(agentRuntimeForBinary("deepseek-v4-pro")).toBeUndefined();
    expect(agentRuntimeForBinary("chrome")).toBeUndefined();
  });

  it("gives every unmergeable runtime a snippet that names the hook binary", () => {
    for (const runtime of agentRuntimes) {
      const snippet = agentRuntimeManualSnippet(runtime.id, "/opt/siqshift-hook");
      if (runtime.registration !== "manual") {
        expect(snippet).toBeUndefined();
        continue;
      }
      expect(snippet).toContain("/opt/siqshift-hook");
      expect(snippet).not.toContain("{command}");
      // Each snippet takes whatever form that CLI actually needs — a shell
      // line, or JavaScript for the ones whose hooks are code — but every one
      // names its own runtime so two CLIs never report as each other.
      expect(snippet).toContain("--source");
      expect(snippet).toContain(runtime.id);
    }
  });

  it("declares per runtime whether its hook mechanism can name the model", () => {
    // Claude Code's SessionStart/SessionEnd payloads carry no model key
    // (verified live), Codex pipes that exact payload, and Cursor's
    // registration passes only --source/--event with a payload mined for a
    // session id and cwd: none of the merged mechanisms can name one.
    expect(findAgentRuntime("claude_code")?.reportsModel).toBe("never");
    expect(findAgentRuntime("codex")?.reportsModel).toBe("never");
    expect(findAgentRuntime("cursor")?.reportsModel).toBe("never");
    // Pi's extension passes ctx.model?.id on every event by design.
    expect(findAgentRuntime("pi")?.reportsModel).toBe("always");
    expect(findAgentRuntime("pi_signed")?.reportsModel).toBe("always");
    // The rest are manual snippets whose mechanism is unconfirmed or whose
    // events carry no model: reporting one depends on the user's wiring.
    for (const id of ["kimi_code", "opencode", "grok", "muse", "copilot"]) {
      expect(findAgentRuntime(id)?.reportsModel).toBe("sometimes");
    }
  });

  it("keeps the unconfirmed mechanisms saying so while showing the --model flag", () => {
    for (const id of ["kimi_code", "grok", "muse", "copilot"]) {
      const snippet = agentRuntimeManualSnippet(id, "/opt/siqshift-hook");
      expect(snippet).toContain("unconfirmed");
      expect(snippet).toContain("--model");
    }
    // opencode's events genuinely carry no model, so its snippet shows none
    // and says why instead of inventing a source for one.
    const opencode = agentRuntimeManualSnippet("opencode", "/opt/siqshift-hook");
    expect(opencode).toContain("unconfirmed");
    expect(opencode).not.toContain("--model");
    // Pi's extensions name the model through ctx.model?.id on every event.
    for (const id of ["pi", "pi_signed"]) {
      expect(agentRuntimeManualSnippet(id, "/opt/siqshift-hook")).toContain("--model");
    }
  });

  it("ships a mark for every declared runtime, sourced from original monochrome glyphs", () => {
    for (const runtime of agentRuntimes) {
      expect(runtime.icon).toBe(runtime.id);
    }
  });
});
