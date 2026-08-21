import type { ShiftCommitBatchResponse, ShiftCommitUpload } from "@siqshift/shared";

import type { AuthenticatedSubject } from "../auth.js";
import type {
  AgentRepository,
  AgentSessionRecord,
  AgentSessionRepository,
  ShiftCommitRepository,
} from "../repositories.js";
import { rosterEligibleSource } from "./agent-sessions.js";
import { graduateAgentForSession } from "./agent-identity.js";

export interface ShiftCommitServiceDependencies {
  shiftCommits: ShiftCommitRepository;
  agentSessions: AgentSessionRepository;
  /** Without it, sessions that predate the roster cannot take commits. */
  agents?: AgentRepository;
  clock?: () => Date;
}

export interface ShiftCommitService {
  ingest(subject: AuthenticatedSubject, commits: ShiftCommitUpload[]): Promise<ShiftCommitBatchResponse>;
}

/** Retryable: the shift has not landed on the server yet; the client keeps the row unsynced. */
export const unknownSessionReason = "unknown_session";

/**
 * How far a client's clock may disagree with the server's before its
 * verification timestamp stops being credible. Payroll timestamps need a
 * sanity bound; skew between two machines needs room.
 */
const clockSkewAllowanceMs = 24 * 60 * 60 * 1_000;

export function createShiftCommitService(dependencies: ShiftCommitServiceDependencies): ShiftCommitService {
  const clock = dependencies.clock ?? (() => new Date());

  return {
    async ingest(subject: AuthenticatedSubject, commits: ShiftCommitUpload[]): Promise<ShiftCommitBatchResponse> {
      const now = clock();
      let accepted = 0;
      const rejected: ShiftCommitBatchResponse["rejected"] = [];

      // One session lookup per (source, externalSessionId) per batch: a
      // shift's commits usually arrive together.
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

      for (const commit of commits) {
        // verifiedAt travels with a decided verification and never with
        // pending; a row that disagrees is wrong on its own, not the batch.
        if ((commit.verification === "pending") !== (commit.verifiedAt === undefined)) {
          rejected.push({ clientId: commit.clientId, reason: "verification and verifiedAt disagree" });
          continue;
        }

        // A verification happens after the commit it judges and no later than
        // now, both within one machine's worth of clock skew. Unbounded, a
        // client could stamp a payroll timestamp in any year it liked.
        if (commit.verifiedAt !== undefined) {
          const verifiedAt = new Date(commit.verifiedAt).getTime();
          const authoredAt = new Date(commit.authoredAt).getTime();
          if (verifiedAt > now.getTime() + clockSkewAllowanceMs || verifiedAt < authoredAt - clockSkewAllowanceMs) {
            rejected.push({ clientId: commit.clientId, reason: "verifiedAt is out of bounds" });
            continue;
          }
        }

        const session = await resolveSession(commit.source, commit.externalSessionId);
        if (session === null) {
          rejected.push({ clientId: commit.clientId, reason: unknownSessionReason });
          continue;
        }

        // The commit's repo root is the evidence that names this shift's
        // codebase. It late-mints an identity for a shift that has none, and
        // it graduates or re-homes one whose codebase was still unknown -
        // which is the designed path for every desktop that cannot probe a
        // repository at session start.
        if (dependencies.agents === undefined || !rosterEligibleSource(commit.source)) {
          if (session.agentId === null) {
            rejected.push({ clientId: commit.clientId, reason: "session has no roster identity" });
            continue;
          }
        } else {
          await graduateAgentForSession(
            { agents: dependencies.agents, agentSessions: dependencies.agentSessions },
            subject,
            session,
            commit.source,
            commit.repoRoot,
            now,
          );
        }
        const agentId = session.agentId;
        if (agentId === null) {
          rejected.push({ clientId: commit.clientId, reason: "session has no roster identity" });
          continue;
        }

        const existing = await dependencies.shiftCommits.findByClientId(subject, commit.clientId);
        if (existing !== null) {
          // A replay is accepted; the only work left is a verification that
          // decided since the row was first uploaded. Terminal states never
          // move again, so a replayed decision is a no-op too.
          if (existing.verification === "pending" && commit.verification !== "pending") {
            await dependencies.shiftCommits.advanceVerification(
              subject,
              existing.id,
              commit.verification,
              new Date(commit.verifiedAt!),
              now,
            );
          }
          accepted += 1;
          continue;
        }

        // "duplicate" means one of the two uniques absorbed the row - a
        // replay racing itself or the same agent recording the same commit
        // from another shift. Both are accepted no-ops. Anything the database
        // refuses outright (a check or a foreign key) is one row's problem:
        // per-row refusals never fail a batch, and a 500 here would wedge the
        // client into replaying the same batch forever.
        try {
          await dependencies.shiftCommits.insert({
            organizationId: subject.organizationId,
            userId: session.userId,
            agentId,
            agentSessionId: session.id,
            clientId: commit.clientId,
            repoRoot: commit.repoRoot,
            branch: commit.branch ?? null,
            sha: commit.sha,
            subject: commit.subject,
            authoredAt: new Date(commit.authoredAt),
            verification: commit.verification,
            verifiedAt: commit.verifiedAt === undefined ? null : new Date(commit.verifiedAt),
            recordedAt: now,
          });
        } catch {
          rejected.push({ clientId: commit.clientId, reason: "the commit could not be recorded" });
          continue;
        }
        accepted += 1;
      }

      return { accepted, rejected };
    },
  };
}
