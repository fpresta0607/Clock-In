import {
  agentSchema,
  clipInterval,
  type AgentPaystubFilters,
  type AgentPaystubResponse,
  type Interval,
} from "@clock-in/shared";

import type { AuthenticatedSubject } from "../auth.js";
import { AppError } from "../errors.js";
import type { AgentRecord, AgentRepository, AgentShiftRecord, ReportQuery } from "../repositories.js";
import type { AgentSessionReaper } from "./agent-sessions.js";
import { normalizedQuery } from "./reports.js";

export interface AgentPatchInput {
  name?: string;
  status?: "registered" | "retired";
  ownerUserId?: string;
}

export interface AgentServiceDependencies {
  agents: AgentRepository;
  /** Paystub reads close stale shifts first, like every other report path. */
  reaper: AgentSessionReaper;
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

export function asAgentView(record: AgentRecord): AgentPaystubResponse["agent"] {
  return {
    id: record.id,
    name: record.name,
    source: record.source,
    status: record.status,
    owner: record.owner,
    project: record.project,
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

function rangeOf(query: ReportQuery): Partial<Interval> {
  return {
    ...(query.from === undefined ? {} : { start: query.from.getTime() }),
    ...(query.toExclusive === undefined ? {} : { end: query.toExclusive.getTime() }),
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
      // The request schema validates fields in isolation; the merged record is
      // re-validated whole, the same rule the path-mapping patch follows.
      const merged = agentSchema.safeParse({
        id: existing.id,
        name: input.name ?? existing.name,
        source: existing.source,
        status: input.status ?? existing.status,
        owner: { id: input.ownerUserId ?? existing.owner.id, name: existing.owner.name },
        project: existing.project,
        createdAt: existing.createdAt.toISOString(),
      });
      if (!merged.success) throw new AppError("validation_error", "The resulting agent is invalid.");
      const updated = await dependencies.agents.update(subject, agentId, { ...input, updatedAt: clock() });
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

      // Commit facts arrive with shift-commit capture; until that data
      // exists the counts are zero and heldRate null - the schema is
      // complete from day one so the web parses a single shape.
      const shiftViews = shifts.map((shift) => ({
        id: shift.id,
        startedAt: shift.startedAt.toISOString(),
        endedAt: shift.endedAt === null ? null : shift.endedAt.toISOString(),
        model: shift.model,
        durationSeconds: clippedSeconds(shift, range),
        commits: [],
      }));

      // Six weekly buckets ending at the range's end (or now, unbounded),
      // oldest first, read from their own window rather than the filter's.
      const anchor = query.toExclusive?.getTime() ?? clock().getTime();
      const trendStart = new Date(anchor - trendWeeks * weekMs);
      const trendShifts = await dependencies.agents.listSessionsForAgent(subject, agentId, {
        from: trendStart,
        toExclusive: new Date(anchor),
      });
      const trend = Array.from({ length: trendWeeks }, (_, index) => {
        const bucket = {
          start: anchor - (trendWeeks - index) * weekMs,
          end: anchor - (trendWeeks - index - 1) * weekMs,
        };
        const seconds = trendShifts.map((shift) => clippedSeconds(shift, bucket));
        return {
          periodStartAt: new Date(bucket.start).toISOString(),
          agentSeconds: seconds.reduce((sum, value) => sum + value, 0),
          shiftCount: seconds.filter((value) => value > 0).length,
          heldRate: null,
        };
      });

      return {
        agent: asAgentView(agent),
        filters,
        totals: {
          agentSeconds: shiftViews.reduce((sum, shift) => sum + shift.durationSeconds, 0),
          shiftCount: shiftViews.length,
          commitsRecorded: 0,
          commitsPending: 0,
          commitsMerged: 0,
          commitsReverted: 0,
          commitsOrphaned: 0,
          heldRate: null,
        },
        shifts: shiftViews,
        trend,
      };
    },
  };
}
