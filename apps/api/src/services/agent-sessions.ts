import { agentRuntimeLabel, type AgentSessionEventBatchResponse, type AgentSource } from "@clock-in/shared";

import type { AuthenticatedSubject } from "../auth.js";
import type {
  AgentRepository,
  AgentSessionRepository,
  PathMappingRepository,
  SessionRepository,
} from "../repositories.js";
import { resolveProjectForCwd, resolveProjectForRule, type PathMappingCandidate } from "./attribution.js";

const futureEventToleranceMs = 30_000;
const defaultStaleThresholdMs = 6 * 60 * 60 * 1_000;

/**
 * Whether a source mints a roster identity. Browser spans are excluded by
 * decision: a browser tab is evidence of attention, not a worker on the
 * payroll.
 */
export const rosterEligibleSource = (source: AgentSource): boolean => source !== "browser";

/**
 * The model a runtime attested, or null when what it sent names none. A CLI
 * marks the entries it writes about itself - Claude Code stamps them
 * `<synthetic>` - and a desktop old enough to read one out of a transcript
 * reports it here, which put "Claude Code · <synthetic>" on the roster. A name
 * in angle brackets is a placeholder, and absence shown as absence is the
 * model's own rule: the shift reads "not recorded" instead.
 *
 * The reader that produced these was fixed in `agent_usage.rs`, but the API
 * deploys before any installer can, so this holds the line for the desktops
 * still sending it.
 */
export const attestedModel = (model: string | null): string | null =>
  model === null || (model.startsWith("<") && model.endsWith(">")) ? null : model;

export interface AgentSessionEventInput {
  source: AgentSource;
  /**
   * The model the runtime was driving, when the hook named one. Kept strictly
   * beside `source`: neither is ever derived from the other, because `pi`
   * running `deepseek-v4-pro` is the `pi` runtime and a model name identifies
   * no runtime at all.
   */
  model: string | null;
  externalSessionId: string;
  event: "started" | "ended" | "heartbeat";
  occurredAt: Date;
  cwd: string | null;
  /**
   * The git repository the working directory sits in, when the hook probed
   * one. Null from a desktop that predates the probe, or from a directory
   * that is not a repository at all; either way the shift mints into its
   * operator's unassigned bucket and graduates when its first commit lands.
   */
  repoRoot: string | null;
  /** The matched url-rule mapping id for browser spans; null for agent events. */
  ruleId: string | null;
}

export interface AgentSessionServiceDependencies {
  agentSessions: AgentSessionRepository;
  pathMappings: PathMappingRepository;
  sessions: SessionRepository;
  /** Optional so older wirings keep working; without it no identity is stamped. */
  agents?: AgentRepository;
  clock?: () => Date;
  staleThresholdMs?: number;
}

export interface AgentSessionReaper {
  /** Closes running sessions with no event for the staleness window, ending them at lastEventAt. */
  reapStale(subject: AuthenticatedSubject): Promise<number>;
}

/**
 * Just the staleness reaper, for read paths (reports, stats) that close stale
 * agent sessions before report aggregation without the full ingestion service.
 */
export function createAgentSessionReaper(
  dependencies: Pick<AgentSessionServiceDependencies, "agentSessions" | "clock" | "staleThresholdMs">,
): AgentSessionReaper {
  const clock = dependencies.clock ?? (() => new Date());
  const staleThresholdMs = dependencies.staleThresholdMs ?? defaultStaleThresholdMs;
  return {
    reapStale(subject: AuthenticatedSubject): Promise<number> {
      const now = clock();
      return dependencies.agentSessions.reapStale(subject, new Date(now.getTime() - staleThresholdMs), now);
    },
  };
}

export interface AgentSessionService {
  ingest(subject: AuthenticatedSubject, events: AgentSessionEventInput[]): Promise<AgentSessionEventBatchResponse>;
  /** Closes running sessions with no event for the staleness window; also runs before every batch. */
  reapStale(subject: AuthenticatedSubject): Promise<number>;
}

export function createAgentSessionService(dependencies: AgentSessionServiceDependencies): AgentSessionService {
  const clock = dependencies.clock ?? (() => new Date());
  const staleThresholdMs = dependencies.staleThresholdMs ?? defaultStaleThresholdMs;
  const reaper = createAgentSessionReaper(dependencies);

  return {
    reapStale: (subject) => reaper.reapStale(subject),

    async ingest(subject: AuthenticatedSubject, events: AgentSessionEventInput[]): Promise<AgentSessionEventBatchResponse> {
      const now = clock();
      await dependencies.agentSessions.reapStale(subject, new Date(now.getTime() - staleThresholdMs), now);

      // Mappings rarely change; one lookup per batch attributes every event in it.
      let mappings: Promise<PathMappingCandidate[]> | null = null;
      const loadMappings = (): Promise<PathMappingCandidate[]> => {
        mappings ??= dependencies.pathMappings.listForSubject(subject);
        return mappings;
      };

      // One roster upsert per (source, repo) per batch: five events from the
      // same agent mint or find its identity once. The operator is the
      // authenticated uploader and so is constant across the batch, which is
      // what gives every runtime an operator dimension without asking the
      // runtime for anything.
      const agentIds = new Map<string, Promise<string>>();
      const resolveAgent = (source: AgentSource, repoRoot: string | null, projectId: string | null): Promise<string | null> => {
        const agentsRepository = dependencies.agents;
        if (agentsRepository === undefined || !rosterEligibleSource(source)) return Promise.resolve(null);
        const key = `${source}|${repoRoot ?? ""}`;
        let pending = agentIds.get(key);
        if (pending === undefined) {
          pending = agentsRepository
            .upsertForKey({
              organizationId: subject.organizationId,
              ownerUserId: subject.userId,
              source,
              repoRoot,
              projectId,
              name: agentRuntimeLabel(source),
              now,
            })
            .then((result) => result.id);
          agentIds.set(key, pending);
        }
        return pending;
      };

      const results: AgentSessionEventBatchResponse["results"] = [];
      // The repository is the better evidence of where work happened, so it
      // is matched first and the working directory is the fallback; the
      // mechanism is the same longest-prefix match either way.
      const resolveProject = (event: AgentSessionEventInput, mappings: PathMappingCandidate[]): string | null => {
        if (event.source === "browser") return event.ruleId === null ? null : resolveProjectForRule(event.ruleId, mappings);
        if (event.repoRoot !== null) {
          const fromRepo = resolveProjectForCwd(event.repoRoot, mappings);
          if (fromRepo !== null) return fromRepo;
        }
        return resolveProjectForCwd(event.cwd ?? "", mappings);
      };
      for (const event of events) {
        const occurredAt = event.occurredAt.getTime();
        if (!Number.isFinite(occurredAt)) {
          results.push({ externalSessionId: event.externalSessionId, accepted: false, reason: "occurredAt is invalid" });
          continue;
        }
        if (occurredAt > now.getTime() + futureEventToleranceMs) {
          results.push({ externalSessionId: event.externalSessionId, accepted: false, reason: "occurredAt is too far in the future" });
          continue;
        }

        if (event.event === "started") {
          const projectId = resolveProject(event, await loadMappings());
          let linkedSessionId: string | null = null;
          if (projectId !== null) {
            const running = await dependencies.sessions.findRunning(subject);
            if (running !== null && running.projectId === projectId) linkedSessionId = running.id;
          }
          await dependencies.agentSessions.upsertStarted({
            organizationId: subject.organizationId,
            userId: subject.userId,
            source: event.source,
            model: attestedModel(event.model),
            externalSessionId: event.externalSessionId,
            cwd: event.cwd,
            ruleId: event.ruleId,
            projectId,
            agentId: await resolveAgent(event.source, event.repoRoot, projectId),
            linkedSessionId,
            occurredAt: event.occurredAt,
            receivedAt: now,
          });
        } else if (event.event === "ended") {
          const existing = await dependencies.agentSessions.findByExternalKey(subject, event.source, event.externalSessionId);
          if (existing === null) {
            // End-before-start is tolerated: the row is stored directly as ended.
            const projectId = resolveProject(event, await loadMappings());
            await dependencies.agentSessions.insertEnded({
              organizationId: subject.organizationId,
              userId: subject.userId,
              source: event.source,
              model: attestedModel(event.model),
              externalSessionId: event.externalSessionId,
              cwd: event.cwd,
              ruleId: event.ruleId,
              projectId,
              agentId: await resolveAgent(event.source, event.repoRoot, projectId),
              occurredAt: event.occurredAt,
              receivedAt: now,
            });
          } else if (existing.status === "running") {
            await dependencies.agentSessions.closeRunning(subject, event.source, event.externalSessionId, event.occurredAt, now);
          }
          // An end for an already-ended session is a no-op replay.
        } else {
          // Heartbeats only advance lastEventAt; an unknown session is
          // accepted as a no-op - a heartbeat must never create or resurrect
          // one. A heartbeat naming a model fills a still-null model, on a
          // running or an already-ended row alike (the transcript reader's
          // backfill can land after the end that closed a short session); an
          // existing model is never overwritten (first assignment wins).
          await dependencies.agentSessions.advanceLastEvent(
            subject,
            event.source,
            event.externalSessionId,
            attestedModel(event.model),
            event.occurredAt,
            now,
          );
        }
        results.push({ externalSessionId: event.externalSessionId, accepted: true });
      }
      return { results };
    },
  };
}
