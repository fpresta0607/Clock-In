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
  it("declares the runtimes Clock-In is expected to recognize", () => {
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
      const snippet = agentRuntimeManualSnippet(runtime.id, "/opt/clock-in-hook");
      if (runtime.registration !== "manual") {
        expect(snippet).toBeUndefined();
        continue;
      }
      expect(snippet).toContain("/opt/clock-in-hook");
      expect(snippet).not.toContain("{command}");
      // Each snippet takes whatever form that CLI actually needs — a shell
      // line, or JavaScript for the ones whose hooks are code — but every one
      // names its own runtime so two CLIs never report as each other.
      expect(snippet).toContain("--source");
      expect(snippet).toContain(runtime.id);
    }
  });

  it("ships a mark only where an official asset was sourced cleanly", () => {
    // opencode's mark ships in its own MIT-licensed repository. Nothing
    // comparable exists for the rest, and Clock-In will not draw a lookalike,
    // so they use the generic agent badge instead.
    expect(findAgentRuntime("opencode")?.icon).toBe("opencode");
    for (const runtime of agentRuntimes) {
      if (runtime.id !== "opencode") {
        expect(runtime.icon).toBeNull();
      }
    }
  });
});
