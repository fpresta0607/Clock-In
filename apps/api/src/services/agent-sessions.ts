import type { AgentSessionEventBatchResponse, AgentSource } from "@clock-in/shared";

import type { AuthenticatedSubject } from "../auth.js";
import type {
  AgentSessionRepository,
  AgentSessionStaleExclusion,
  PathMappingRecord,
  PathMappingRepository,
  SessionRepository,
} from "../repositories.js";
import { resolveProjectForCwd, resolveProjectForRuleId } from "./attribution.js";

const futureEventToleranceMs = 30_000;
const defaultStaleThresholdMs = 6 * 60 * 60 * 1_000;
// Browser spans heart beat every 60 seconds, so ten minutes of silence means the tab is gone.
const defaultBrowserStaleThresholdMs = 10 * 60 * 1_000;

export interface AgentSessionEventInput {
  source: AgentSource;
  externalSessionId: string;
  event: "started" | "ended" | "heartbeat";
  occurredAt: Date;
  /** Agent sources carry a cwd; browser spans carry a ruleId instead. */
  cwd?: string;
  ruleId?: string;
}

export interface AgentSessionServiceDependencies {
  agentSessions: AgentSessionRepository;
  pathMappings: PathMappingRepository;
  sessions: SessionRepository;
  clock?: () => Date;
  /** Staleness window for non-browser sources. */
  staleThresholdMs?: number;
  /** Staleness window for browser spans, much shorter than the agent window. */
  browserStaleThresholdMs?: number;
}

export interface AgentSessionReaper {
  /** Closes running sessions with no event for their source's staleness window, ending them at lastEventAt. */
  reapStale(subject: AuthenticatedSubject): Promise<number>;
}

function createReapStale(
  dependencies: Pick<AgentSessionServiceDependencies, "agentSessions" | "clock" | "staleThresholdMs" | "browserStaleThresholdMs">,
): (subject: AuthenticatedSubject, excluded?: readonly AgentSessionStaleExclusion[]) => Promise<number> {
  const clock = dependencies.clock ?? (() => new Date());
  const staleThresholdMs = dependencies.staleThresholdMs ?? defaultStaleThresholdMs;
  const browserStaleThresholdMs = dependencies.browserStaleThresholdMs ?? defaultBrowserStaleThresholdMs;
  return (subject, excluded = []) => {
    const now = clock();
    return dependencies.agentSessions.reapStale(subject, {
      default: new Date(now.getTime() - staleThresholdMs),
      browser: new Date(now.getTime() - browserStaleThresholdMs),
    }, now, excluded);
  };
}

/**
 * Just the staleness reaper, for read paths (reports, stats) that close stale
 * agent sessions before corroboration math without the full ingestion service.
 */
export function createAgentSessionReaper(
  dependencies: Pick<AgentSessionServiceDependencies, "agentSessions" | "clock" | "staleThresholdMs" | "browserStaleThresholdMs">,
): AgentSessionReaper {
  const reapStale = createReapStale(dependencies);
  return {
    reapStale: (subject) => reapStale(subject),
  };
}

export interface AgentSessionService {
  ingest(subject: AuthenticatedSubject, events: AgentSessionEventInput[]): Promise<AgentSessionEventBatchResponse>;
  /** Closes running sessions with no event for the staleness window; also runs after every batch. */
  reapStale(subject: AuthenticatedSubject): Promise<number>;
}

export function createAgentSessionService(dependencies: AgentSessionServiceDependencies): AgentSessionService {
  const clock = dependencies.clock ?? (() => new Date());
  const reapStale = createReapStale(dependencies);

  return {
    reapStale: (subject) => reapStale(subject),

    async ingest(subject: AuthenticatedSubject, events: AgentSessionEventInput[]): Promise<AgentSessionEventBatchResponse> {
      const now = clock();
      const batchKeys = new Map<string, AgentSessionStaleExclusion>();

      // Mappings rarely change; one lookup per batch attributes every event in it.
      let mappings: Promise<PathMappingRecord[]> | null = null;
      const loadMappings = (): Promise<PathMappingRecord[]> => {
        mappings ??= dependencies.pathMappings.listForSubject(subject);
        return mappings;
      };
      // The extension proposes a rule id; the stored mapping row decides. A deleted
      // or foreign rule leaves the span unattributed rather than erroring.
      const resolveProject = async (event: AgentSessionEventInput): Promise<string | null> => {
        const candidates = await loadMappings();
        if (event.source === "browser") {
          return event.ruleId === undefined ? null : resolveProjectForRuleId(event.ruleId, candidates);
        }
        const prefixes = candidates.filter((mapping) => mapping.kind === "path_prefix");
        return event.cwd === undefined ? null : resolveProjectForCwd(event.cwd, prefixes);
      };

      const results: AgentSessionEventBatchResponse["results"] = [];
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
          const projectId = await resolveProject(event);
          let linkedSessionId: string | null = null;
          if (projectId !== null) {
            const running = await dependencies.sessions.findRunning(subject);
            if (running !== null && running.projectId === projectId) linkedSessionId = running.id;
          }
          await dependencies.agentSessions.upsertStarted({
            organizationId: subject.organizationId,
            userId: subject.userId,
            source: event.source,
            externalSessionId: event.externalSessionId,
            cwd: event.cwd ?? null,
            ruleId: event.ruleId ?? null,
            projectId,
            linkedSessionId,
            occurredAt: event.occurredAt,
            receivedAt: now,
          });
        } else if (event.event === "ended") {
          const existing = await dependencies.agentSessions.findByExternalKey(subject, event.source, event.externalSessionId);
          if (existing === null) {
            // End-before-start is tolerated: the row is stored directly as ended.
            await dependencies.agentSessions.insertEnded({
              organizationId: subject.organizationId,
              userId: subject.userId,
              source: event.source,
              externalSessionId: event.externalSessionId,
              cwd: event.cwd ?? null,
              ruleId: event.ruleId ?? null,
              projectId: await resolveProject(event),
              occurredAt: event.occurredAt,
              receivedAt: now,
            });
          } else if (existing.status === "running") {
            await dependencies.agentSessions.closeRunning(subject, event.source, event.externalSessionId, event.occurredAt, now);
          }
          // An end for an already-ended session is a no-op replay.
        } else {
          // Heartbeats only advance lastEventAt; an unknown or ended session is
          // accepted as a no-op — a heartbeat must never create or resurrect one.
          await dependencies.agentSessions.advanceLastEvent(subject, event.source, event.externalSessionId, event.occurredAt, now);
        }
        results.push({ externalSessionId: event.externalSessionId, accepted: true });
        batchKeys.set(`${event.source}\u0000${event.externalSessionId}`, {
          source: event.source,
          externalSessionId: event.externalSessionId,
        });
      }
      await reapStale(subject, [...batchKeys.values()]);
      return { results };
    },
  };
}
