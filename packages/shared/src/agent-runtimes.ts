import { z } from "zod";

import registry from "./agent-runtimes.json" with { type: "json" };

/**
 * The agent-runtime roster, loaded from `agent-runtimes.json`.
 *
 * That file is the *only* place a runtime is declared. The API's ingest path,
 * the desktop's labels and process folding, the hook probes and registration
 * snippets, and the quota dials all read it, so adding a runtime is a
 * configuration change rather than a code change. The Rust host reads the same
 * JSON (`agent_runtimes.rs` embeds it), so the two languages cannot drift.
 *
 * The roster is *not* an allowlist. `agentSourceSchema` accepts any id of the
 * canonical shape, so a runtime nobody has declared yet is still recorded under
 * its own name rather than collapsed into `other` or dropped. The roster only
 * decides what Clock-In can say *about* a runtime: its display name, its
 * executables, where its hooks live, and which quota dial it backs.
 */

/** How Clock-In can switch a runtime's hooks on. */
export const agentRuntimeRegistrationValues = ["claude_json", "cursor_json", "manual"] as const;
export type AgentRuntimeRegistration = (typeof agentRuntimeRegistrationValues)[number];

/** Whether a runtime's own hook mechanism names the model it is driving. */
export const agentRuntimeReportsModelValues = ["always", "sometimes", "never"] as const;
export type AgentRuntimeReportsModel = (typeof agentRuntimeReportsModelValues)[number];

const agentRuntimeSchema = z
  .object({
    /** Canonical source id, snake_case; what `agent_sessions.source` stores. */
    id: z.string().max(40).regex(/^[a-z][a-z0-9_]*$/),
    /** Display name, so one tool is never called two different things. */
    label: z.string().min(1),
    /** Executable basenames the runtime surfaces under in foreground-process stats. */
    binaries: z.array(z.string().min(1)).readonly(),
    /** The `quota-axi` provider backing this runtime, when one does. */
    quotaProvider: z.string().min(1).nullable(),
    /** Home-relative path to the config a hook registration lands in. */
    configPath: z.string().min(1),
    registration: z.enum(agentRuntimeRegistrationValues),
    /**
     * Whether the runtime's hook mechanism names the model it is driving:
     * `always` by design on every event, `sometimes` when it depends on the
     * user's wiring or an unconfirmed mechanism, `never` when the mechanism
     * cannot name one. A hook that names no model records none, never a guess.
     */
    reportsModel: z.enum(agentRuntimeReportsModelValues),
    /**
     * Id of a vendored official icon, or `null` when no official asset could be
     * sourced cleanly — those runtimes get the generic agent treatment rather
     * than a lookalike mark.
     */
    icon: z.string().min(1).nullable(),
    /** Paste-it-yourself lines for `manual` runtimes; `{command}` is the hook binary path. */
    manualSnippet: z.array(z.string()).readonly(),
  })
  .strict();

export type AgentRuntime = z.infer<typeof agentRuntimeSchema>;

/** A malformed roster is a build-time mistake, so it fails loudly at import. */
export const agentRuntimes: readonly AgentRuntime[] = z
  .array(agentRuntimeSchema)
  .readonly()
  .parse(registry.runtimes);

/** Canonical ids of the declared runtimes, in roster order. */
export const agentRuntimeIds: readonly string[] = agentRuntimes.map((runtime) => runtime.id);

const byId = new Map(agentRuntimes.map((runtime) => [runtime.id, runtime]));

export const findAgentRuntime = (id: string): AgentRuntime | undefined => byId.get(id);

/**
 * The name to show for a source. An undeclared runtime keeps its own id rather
 * than being relabelled into something the roster does know, because a wrong
 * name is worse than a raw one.
 */
export const agentRuntimeLabel = (id: string): string => byId.get(id)?.label ?? id;

const byBinary = new Map(
  agentRuntimes.flatMap((runtime) => runtime.binaries.map((binary) => [binary, runtime.id] as const)),
);

/**
 * The runtime an executable belongs to, for folding agent CLIs out of the
 * foreground-process rows. Matching is on the lowercased basename without a
 * `.exe` suffix; anything unrecognized is not an agent as far as this says.
 */
export const agentRuntimeForBinary = (processName: string): string | undefined =>
  byBinary.get(processName.replace(/\.exe$/i, "").toLowerCase());

/** The hook snippet for a `manual` runtime, with the hook binary path substituted in. */
export const agentRuntimeManualSnippet = (id: string, command: string): string | undefined => {
  const runtime = byId.get(id);
  if (runtime === undefined || runtime.manualSnippet.length === 0) return undefined;
  return runtime.manualSnippet.join("\n").replaceAll("{command}", command);
};
