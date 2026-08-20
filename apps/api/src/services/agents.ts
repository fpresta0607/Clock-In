import {
  agentSchema,
  clipInterval,
  measureTime,
  type AgentPaystubFilters,
  type AgentPaystubResponse,
  type Interval,
  type TokenTotals,
} from "@clock-in/shared";

import type { AuthenticatedSubject } from "../auth.js";
import { AppError } from "../errors.js";
import type {
  AgentRecord,
  AgentRepository,
  AgentShiftRecord,
  AgentUpdatePatch,
  AgentUsageModelTotalsRecord,
  AgentUsageRepository,
  ReportQuery,
  ReportRepository,
  ShiftCommitRecord,
  ShiftCommitRepository,
} from "../repositories.js";
import type { AgentSessionReaper } from "./agent-sessions.js";
import { agentCodebaseLabel, repoLabel } from "./attribution.js";
import { hourlySeries, maxConcurrentCount, medianDurationSeconds, normalizedQuery, safeInteger } from "./reports.js";

export interface AgentPatchInput {
  name?: string;
  status?: "registered" | "retired";
  ownerUserId?: string;
}

export interface AgentServiceDependencies {
  agents: AgentRepository;
  /** Paystub reads close stale shifts first, like every other report path. */
  reaper: AgentSessionReaper;
  /** Without it, the paystub's commit record stays at zeros and null heldRate. */
  shiftCommits?: ShiftCommitRepository;
  /** Without it, the paystub's token totals stay at zeros under tokensReported false, models at null tokens. */
  agentUsage?: AgentUsageRepository;
  /** Membership lookups for owner changes; ownerUserId must be a member of the org. */
  reports: ReportRepository;
  clock?: () => Date;
}

export interface AgentService {
  list(subject: AuthenticatedSubject): Promise<AgentRecord[]>;
  patch(subject: AuthenticatedSubject, agentId: string, input: AgentPatchInput): Promise<AgentRecord>;
  merge(subject: AuthenticatedSubject, winnerId: string, loserId: string): Promise<void>;
  paystub(subject: AuthenticatedSubject, agentId: string, filters: AgentPaystubFilters): Promise<AgentPaystubResponse>;
}

const weekMs = 7 * 24 * 60 * 60 * 1_000;
const trendWeeks = 6;

/**
 * Whether this caller may see an agent's working directory. The same rule a
 * shift commit's `repoRoot` follows: the agent's owner and workspace admins.
 */
export function mayReadRepoRoot(subject: AuthenticatedSubject, ownerId: string): boolean {
  return subject.role === "admin" || ownerId === subject.userId;
}

/**
 * One agent as every surface renders it. The codebase's folder name reaches
 * every member - it is a name, not a path - while the path behind it is
 * projected only to the owner and workspace admins, and is *omitted* rather
 * than blanked for everyone else, which is what lets both projections parse
 * through the same strict schema.
 */
export function asAgentView(record: AgentRecord, subject: AuthenticatedSubject): AgentPaystubResponse["agent"] {
  // A name either way, never a path; the rule itself lives in attribution.ts
  // so the roster, the minted default name and the repair script cannot drift.
  const name = agentCodebaseLabel(record.repoRoot, record.repoKey);
  return {
    id: record.id,
    name: record.name,
    source: record.source,
    status: record.status,
    owner: record.owner,
    project: record.project,
    ...(name === null ? {} : { repoName: name }),
    ...(record.repoRoot !== null && mayReadRepoRoot(subject, record.owner.id) ? { repoRoot: record.repoRoot } : {}),
    createdAt: record.createdAt.toISOString(),
  };
}

/** A shift's interval: running shifts end at their last event, never at "still open". */
function shiftInterval(shift: AgentShiftRecord): Interval {
  const end = shift.endedAt ?? shift.lastEventAt;
  return { start: shift.startedAt.getTime(), end: end.getTime() };
}

/** Seconds of one shift inside the range, rounded once per shift (reports rounding rule). */
function clippedSeconds(shift: AgentShiftRecord, range: Partial<Interval>): number {
  const clipped = clipInterval(shiftInterval(shift), range);
  return clipped === null ? 0 : Math.round((clipped.end - clipped.start) / 1_000);
}

/**
 * Shifts counted the way the pay-run report counts them: one per shift that
 * actually overlaps the range. `clipInterval` drops a zero-length shift (an
 * `Ended` event with no `Started` records one), so the paystub totals, the
 * paystub trend and the roster row all reconcile on the same number.
 */
function countShifts(shifts: readonly AgentShiftRecord[], range: Partial<Interval>): number {
  return shifts.filter((shift) => clipInterval(shiftInterval(shift), range) !== null).length;
}

function rangeOf(query: ReportQuery): Partial<Interval> {
  return {
    ...(query.from === undefined ? {} : { start: query.from.getTime() }),
    ...(query.toExclusive === undefined ? {} : { end: query.toExclusive.getTime() }),
  };
}

/**
 * A repo root is a working directory, and a working directory can carry a
 * user name, so it follows the same rule as every other one: the owning user
 * and workspace admins see it, everyone else gets the commit without it. The
 * server still stores it - the (agent, repo, sha) unique needs it - this is a
 * projection, not a schema change.
 */
function asCommitView(record: ShiftCommitRecord, showRepoRoot: boolean): AgentPaystubResponse["shifts"][number]["commits"][number] {
  return {
    id: record.id,
    ...(showRepoRoot ? { repoRoot: record.repoRoot } : {}),
    branch: record.branch,
    sha: record.sha,
    subject: record.subject,
    authoredAt: record.authoredAt.toISOString(),
    verification: record.verification,
    verifiedAt: record.verifiedAt === null ? null : record.verifiedAt.toISOString(),
  };
}

/** merged / decided; null while nothing has been decided - "pending", not 0%. */
function heldRateOf(commits: readonly ShiftCommitRecord[]): number | null {
  const merged = commits.filter((commit) => commit.verification === "merged").length;
  const decided = commits.filter((commit) => commit.verification !== "pending").length;
  return decided === 0 ? null : merged / decided;
}

const ZERO_TOKENS: TokenTotals = { inputTokens: 0, outputTokens: 0, cacheCreationInputTokens: 0, cacheReadInputTokens: 0 };

/**
 * The codebase a shift worked: its own commit's repo root when it recorded
 * one - the actual repository - and otherwise its working directory, which may
 * sit inside the repo. Either way a label, never a path.
 */
function shiftRepoLabel(cwd: string | null, commits: readonly ShiftCommitRecord[]): string | null {
  const root = commits[0]?.repoRoot ?? cwd;
  return root === null || root === undefined ? null : repoLabel(root);
}

/** One model's token split, converted from its sql-sum record. */
function usageTokens(record: AgentUsageModelTotalsRecord): TokenTotals {
  return {
    inputTokens: safeInteger(record.inputTokens, "paystub input tokens"),
    outputTokens: safeInteger(record.outputTokens, "paystub output tokens"),
    cacheCreationInputTokens: safeInteger(record.cacheCreationInputTokens, "paystub cache creation tokens"),
    cacheReadInputTokens: safeInteger(record.cacheReadInputTokens, "paystub cache read tokens"),
  };
}

export function createAgentService(dependencies: AgentServiceDependencies): AgentService {
  const clock = dependencies.clock ?? (() => new Date());

  async function requireAgent(subject: AuthenticatedSubject, agentId: string): Promise<AgentRecord> {
    const agent = await dependencies.agents.findById(subject, agentId);
    if (agent === null) throw new AppError("not_found", "Agent not found.");
    return agent;
  }

  return {
    list(subject: AuthenticatedSubject): Promise<AgentRecord[]> {
      return dependencies.agents.listForOrganization(subject);
    },

    async patch(subject: AuthenticatedSubject, agentId: string, input: AgentPatchInput): Promise<AgentRecord> {
      const existing = await requireAgent(subject, agentId);
      // Renaming and retiring are open to any member, but ownership is what
      // the pay run attributes hours to, so it moves under the same gate as a
      // merge - or by the owner handing it on themselves.
      if (input.ownerUserId !== undefined && subject.role !== "admin" && existing.owner.id !== subject.userId) {
        throw new AppError("forbidden", "Only a workspace administrator or the current owner can reassign an agent.");
      }
      // A member naming an anonymous agent is the registration ceremony: the
      // rename and the status land in one write. An explicit status always wins.
      const autoRegister = input.name !== undefined && input.status === undefined && existing.status === "anonymous";
      const status = input.status ?? (autoRegister ? "registered" : existing.status);
      // The request schema validates fields in isolation; the merged record is
      // re-validated whole, the same rule the path-mapping patch follows. The
      // identity columns ride along so the check keeps checking the real
      // record - a field left out here would be validated as absent, which is
      // how a rename starts failing on a field the request never mentions.
      const merged = agentSchema.safeParse({
        ...asAgentView(existing, subject),
        name: input.name ?? existing.name,
        status,
        owner: { id: input.ownerUserId ?? existing.owner.id, name: existing.owner.name },
      });
      if (!merged.success) throw new AppError("validation_error", "The resulting agent is invalid.");
      if (input.ownerUserId !== undefined) {
        const owner = await dependencies.reports.findUserForOrganization(subject, input.ownerUserId);
        if (owner === null) throw new AppError("not_found", "User not found.");
      }
      const patch: AgentUpdatePatch = {
        ...input,
        ...(autoRegister ? { status: "registered" as const } : {}),
        updatedAt: clock(),
      };
      const updated = await dependencies.agents.update(subject, agentId, patch);
      if (updated === null) throw new AppError("not_found", "Agent not found.");
      return updated;
    },

    async merge(subject: AuthenticatedSubject, winnerId: string, loserId: string): Promise<void> {
      // Admin gate first: a merge re-points other members' shifts.
      if (subject.role !== "admin") {
        throw new AppError("forbidden", "Only a workspace administrator can merge agents.");
      }
      if (winnerId === loserId) {
        throw new AppError("validation_error", "An agent cannot absorb itself.");
      }
      await requireAgent(subject, winnerId);
      await requireAgent(subject, loserId);
      await dependencies.agents.merge(subject, winnerId, loserId);
    },

    async paystub(subject: AuthenticatedSubject, agentId: string, filters: AgentPaystubFilters): Promise<AgentPaystubResponse> {
      await dependencies.reaper.reapStale(subject);
      const agent = await requireAgent(subject, agentId);
      const query = normalizedQuery(filters);
      const range = rangeOf(query);
      const shifts = await dependencies.agents.listSessionsForAgent(subject, agentId, query);
      const commits = dependencies.shiftCommits === undefined
        ? []
        : await dependencies.shiftCommits.listForAgent(subject, agentId, query);
      const usageByModel = dependencies.agentUsage === undefined
        ? []
        : await dependencies.agentUsage.sumByAgentAndModel(subject, agentId, query);
      const usageBuckets = dependencies.agentUsage === undefined
        ? []
        : await dependencies.agentUsage.sumByBucketForAgent(subject, agentId, query);
      // The owner's presence is what "while they were there" and leverage are
      // measured against; the paystub carries no project scope, so their
      // working intervals are presence itself.
      const ownerPresence = await dependencies.reports.readPresenceIntervals(subject, { ...query, userId: agent.owner.id });
      const commitsBySession = new Map<string, ShiftCommitRecord[]>();
      for (const commit of commits) {
        const existing = commitsBySession.get(commit.agentSessionId) ?? [];
        existing.push(commit);
        commitsBySession.set(commit.agentSessionId, existing);
      }

      const showRepoRoot = mayReadRepoRoot(subject, agent.owner.id);
      const shiftViews = shifts.map((shift) => {
        const shiftCommits = commitsBySession.get(shift.id) ?? [];
        return {
          id: shift.id,
          startedAt: shift.startedAt.toISOString(),
          endedAt: shift.endedAt === null ? null : shift.endedAt.toISOString(),
          model: shift.model,
          durationSeconds: clippedSeconds(shift, range),
          repo: shiftRepoLabel(shift.cwd, shiftCommits),
          commits: shiftCommits.map((commit) => asCommitView(commit, showRepoRoot)),
        };
      });
      // The in-range slice of each shift, keyed by shift id, so the session
      // facts (max at once, median) measure exactly the time the totals count.
      const clippedById = new Map<string, Interval>();
      for (const shift of shifts) {
        const clipped = clipInterval(shiftInterval(shift), range);
        if (clipped !== null) clippedById.set(shift.id, clipped);
      }

      // The model mix: per-shift seconds (already rounded once per shift)
      // summed under each distinct model, unnamed shifts under null. Each
      // entry carries its own token split; a model with no usage rows keeps
      // null, so absence stays absence. Max-at-once and median come from the
      // clipped shift intervals, the same measurement the member breakdown's
      // Agent-sessions table makes.
      const usageByModelKey = new Map(usageByModel.map((row) => [row.model, row]));
      const modelMix = new Map<string | null, {
        model: string | null;
        agentSeconds: number;
        shiftCount: number;
        intervals: Interval[];
        tokens: TokenTotals | null;
      }>();
      for (const shift of shiftViews) {
        const usage = usageByModelKey.get(shift.model);
        const entry = modelMix.get(shift.model) ?? {
          model: shift.model,
          agentSeconds: 0,
          shiftCount: 0,
          intervals: [],
          tokens: usage === undefined || safeInteger(usage.rowCount, "paystub usage row count") === 0 ? null : usageTokens(usage),
        };
        entry.agentSeconds += shift.durationSeconds;
        entry.shiftCount += 1;
        const clipped = clippedById.get(shift.id);
        if (clipped !== undefined) entry.intervals.push(clipped);
        modelMix.set(shift.model, entry);
      }

      // The codebase mix, folded the same way: which repositories this agent
      // worked, heaviest first, so a member can see where its hours went.
      const codebaseMix = new Map<string | null, { repo: string | null; agentSeconds: number; shiftCount: number }>();
      for (const shift of shiftViews) {
        const entry = codebaseMix.get(shift.repo) ?? { repo: shift.repo, agentSeconds: 0, shiftCount: 0 };
        entry.agentSeconds += shift.durationSeconds;
        entry.shiftCount += 1;
        codebaseMix.set(shift.repo, entry);
      }

      // The owner's active time and the runtime that fell outside it, measured
      // by the one time model every other surface measures through.
      const shiftIntervals = [...clippedById.values()];
      const measurement = measureTime(
        ownerPresence.map((row) => ({ start: row.startedAt.getTime(), end: row.endedAt.getTime() })),
        shiftIntervals,
        range,
      );
      const agentSeconds = shiftViews.reduce((sum, shift) => sum + shift.durationSeconds, 0);

      // Six weekly buckets ending at the range's end (or now, unbounded),
      // oldest first, read from their own window rather than the filter's.
      const anchor = query.toExclusive?.getTime() ?? clock().getTime();
      const trendQuery: ReportQuery = {
        from: new Date(anchor - trendWeeks * weekMs),
        toExclusive: new Date(anchor),
      };
      const trendShifts = await dependencies.agents.listSessionsForAgent(subject, agentId, trendQuery);
      const trendCommits = dependencies.shiftCommits === undefined
        ? []
        : await dependencies.shiftCommits.listForAgent(subject, agentId, trendQuery);
      const trend = Array.from({ length: trendWeeks }, (_, index) => {
        const bucket = {
          start: anchor - (trendWeeks - index) * weekMs,
          end: anchor - (trendWeeks - index - 1) * weekMs,
        };
        const seconds = trendShifts.map((shift) => clippedSeconds(shift, bucket));
        const bucketCommits = trendCommits.filter((commit) => {
          const authored = commit.authoredAt.getTime();
          return authored >= bucket.start && authored < bucket.end;
        });
        return {
          periodStartAt: new Date(bucket.start).toISOString(),
          agentSeconds: seconds.reduce((sum, value) => sum + value, 0),
          shiftCount: countShifts(trendShifts, bucket),
          heldRate: heldRateOf(bucketCommits),
        };
      });

      return {
        agent: asAgentView(agent, subject),
        filters,
        totals: {
          agentSeconds,
          shiftCount: countShifts(shifts, range),
          commitsRecorded: commits.length,
          commitsPending: commits.filter((commit) => commit.verification === "pending").length,
          commitsMerged: commits.filter((commit) => commit.verification === "merged").length,
          commitsReverted: commits.filter((commit) => commit.verification === "reverted").length,
          commitsOrphaned: commits.filter((commit) => commit.verification === "orphaned").length,
          heldRate: heldRateOf(commits),
          // The per-model rows partition the agent's usage (the null-model
          // bucket included), so their sum is the range total. tokensReported
          // counts rows, never whether the sum is nonzero.
          tokens: usageByModel.reduce((totals, row) => {
            const tokens = usageTokens(row);
            totals.inputTokens += tokens.inputTokens;
            totals.outputTokens += tokens.outputTokens;
            totals.cacheCreationInputTokens += tokens.cacheCreationInputTokens;
            totals.cacheReadInputTokens += tokens.cacheReadInputTokens;
            return totals;
          }, { ...ZERO_TOKENS }),
          tokensReported: usageByModel.some((row) => safeInteger(row.rowCount, "paystub usage row count") > 0),
          ownerActiveSeconds: measurement.activeSeconds,
          // The totals round once per shift and the sweep rounds once overall,
          // so away is held inside agentSeconds - "while they were there"
          // can never come out negative over a rounding remainder.
          awaySeconds: Math.min(agentSeconds, measurement.concurrency.awaySeconds),
        },
        models: [...modelMix.values()].map(({ intervals, ...entry }) => ({
          ...entry,
          maxConcurrent: maxConcurrentCount(intervals),
          medianSeconds: medianDurationSeconds(intervals),
        })),
        codebases: [...codebaseMix.values()]
          .sort((a, b) => b.agentSeconds - a.agentSeconds || (a.repo ?? "").localeCompare(b.repo ?? "")),
        shifts: shiftViews,
        trend,
        hourly: hourlySeries(
          ownerPresence.map((row) => ({ start: row.startedAt.getTime(), end: row.endedAt.getTime() })),
          shiftIntervals,
          usageBuckets,
          range,
        ),
      };
    },
  };
}
