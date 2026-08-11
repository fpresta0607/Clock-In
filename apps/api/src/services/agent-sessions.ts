import type { AgentSessionEventBatchResponse, AgentSource } from "@clock-in/shared";

import type { AuthenticatedSubject } from "../auth.js";
import type {
  AgentSessionRepository,
  PathMappingRepository,
  SessionRepository,
} from "../repositories.js";
import { resolveProjectForCwd, type PathMappingCandidate } from "./attribution.js";

const futureEventToleranceMs = 30_000;
const defaultStaleThresholdMs = 6 * 60 * 60 * 1_000;

export interface AgentSessionEventInput {
  source: AgentSource;
  externalSessionId: string;
  event: "started" | "ended" | "heartbeat";
  occurredAt: Date;
  cwd: string;
}

export interface AgentSessionServiceDependencies {
  agentSessions: AgentSessionRepository;
  pathMappings: PathMappingRepository;
  sessions: SessionRepository;
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
          const projectId = resolveProjectForCwd(event.cwd, await loadMappings());
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
            cwd: event.cwd,
            projectId,
            linkedSessionId,
            occurredAt: event.occurredAt,
            receivedAt: now,
          });
        } else if (event.event === "ended") {
          const existing = await dependencies.agentSessions.findByExternalKey(subject, event.source, event.externalSessionId);
          if (existing === null) {
            // End-before-start is tolerated: the row is stored directly as ended.
            const projectId = resolveProjectForCwd(event.cwd, await loadMappings());
            await dependencies.agentSessions.insertEnded({
              organizationId: subject.organizationId,
              userId: subject.userId,
              source: event.source,
              externalSessionId: event.externalSessionId,
              cwd: event.cwd,
              projectId,
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
      }
      return { results };
    },
  };
}
