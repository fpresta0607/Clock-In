import { agentRuntimeLabel, type AgentUsageBatchResponse, type AgentUsageUpload } from "@siqshift/shared";

import type { AuthenticatedSubject } from "../auth.js";
import type {
  AgentRepository,
  AgentSessionRecord,
  AgentSessionRepository,
  AgentUsageRepository,
} from "../repositories.js";
import { rosterEligibleSource } from "./agent-sessions.js";
import { unknownSessionReason } from "./shift-commits.js";

export interface AgentUsageServiceDependencies {
  agentUsage: AgentUsageRepository;
  agentSessions: AgentSessionRepository;
  /** Without it, sessions that predate the roster cannot take usage rows. */
  agents?: AgentRepository;
  clock?: () => Date;
}

export interface AgentUsageService {
  ingest(subject: AuthenticatedSubject, usage: AgentUsageUpload[]): Promise<AgentUsageBatchResponse>;
}

export function createAgentUsageService(dependencies: AgentUsageServiceDependencies): AgentUsageService {
  const clock = dependencies.clock ?? (() => new Date());

  return {
    async ingest(subject: AuthenticatedSubject, usage: AgentUsageUpload[]): Promise<AgentUsageBatchResponse> {
      const now = clock();
      let accepted = 0;
      const rejected: AgentUsageBatchResponse["rejected"] = [];

      // One session lookup per (source, externalSessionId) per batch: a
      // shift's usage buckets usually arrive together.
      const sessions = new Map<string, Promise<AgentSessionRecord | null>>();
      const resolveSession = (source: string, externalSessionId: string): Promise<AgentSessionRecord | null> => {
        const key = `${source}|${externalSessionId}`;
        let pending = sessions.get(key);
        if (pending === undefined) {
          pending = dependencies.agentSessions.findByExternalKey(subject, source, externalSessionId);
          sessions.set(key, pending);
        }
        return pending;
      };

      for (const entry of usage) {
        const session = await resolveSession(entry.source, entry.externalSessionId);
        if (session === null) {
          rejected.push({ clientId: entry.clientId, reason: unknownSessionReason });
          continue;
        }

        let agentId = session.agentId;
        if (agentId === null) {
          // A shift that started before the roster existed still takes its
          // usage rows: mint (or find) the identity and stamp the session now.
          if (dependencies.agents === undefined || !rosterEligibleSource(entry.source)) {
            rejected.push({ clientId: entry.clientId, reason: "session has no roster identity" });
            continue;
          }
          // A usage row carries tokens and a model, never a repository, so
          // this mints into the operator's unassigned bucket. The shift
          // graduates onto its codebase when its first commit names one -
          // the same late-discovery path an un-probed session already takes.
          const minted = await dependencies.agents.upsertForKey({
            organizationId: subject.organizationId,
            ownerUserId: session.userId,
            source: entry.source,
            repoRoot: null,
            repoRemote: null,
            projectId: session.projectId,
            name: agentRuntimeLabel(entry.source),
            now,
          });
          agentId = minted.id;
          await dependencies.agentSessions.stampAgent(subject, session.id, agentId, now);
          session.agentId = agentId;
        }

        const existing = await dependencies.agentUsage.findByClientId(subject, entry.clientId);
        if (existing !== null) {
          // A replay restates the same cumulative totals the row already
          // holds, so it is an accepted no-op.
          accepted += 1;
          continue;
        }

        // Counters are cumulative bucket totals: the upsert moves each one to
        // GREATEST(existing, incoming), so a re-read of the same transcript
        // region can only restate a number upward, never add to it.
        await dependencies.agentUsage.upsertBucket({
          organizationId: subject.organizationId,
          userId: session.userId,
          agentId,
          agentSessionId: session.id,
          clientId: entry.clientId,
          bucketStartAt: new Date(entry.bucketStartAt),
          model: entry.model ?? null,
          sidechain: entry.sidechain,
          inputTokens: entry.inputTokens,
          outputTokens: entry.outputTokens,
          cacheCreationInputTokens: entry.cacheCreationInputTokens,
          cacheReadInputTokens: entry.cacheReadInputTokens,
          recordedAt: now,
        });
        accepted += 1;
      }

      return { accepted, rejected };
    },
  };
}
