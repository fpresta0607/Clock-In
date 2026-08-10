import type { SessionAttribution } from "@clock-in/shared";

import type { AuthenticatedSubject } from "../auth.js";
import { AppError } from "../errors.js";
import {
  SessionRepositoryError,
  type ObservedSessionInsert,
  type ProjectRepository,
  type SessionRecord,
  type SessionRepository,
} from "../repositories.js";

const futureStopToleranceMs = 30_000;
const maxStartBackdateMs = 7 * 24 * 60 * 60 * 1_000;
const reviewThresholdSeconds = 12 * 60 * 60;

export interface StartSessionInput {
  clientId: string;
  projectId?: string;
  deviceId: string;
  description?: string;
  startedAt?: Date;
}

export interface StopSessionInput {
  stoppedAt: Date;
  idleSeconds: number;
}

/** One finished session as the desktop observed it, before validation. */
export interface ObservedSessionInput {
  clientId: string;
  projectId: string;
  attribution: Exclude<SessionAttribution, "manual">;
  startedAt: Date;
  stoppedAt: Date;
  idleSeconds: number;
}

export interface ObservedSessionBatchResult {
  accepted: number;
  rejected: { clientId: string; reason: string }[];
}

interface NormalizedStartInput {
  clientId: string;
  projectId: string;
  deviceId: string;
  description: string | null;
  startedAt: Date;
  requestedStartedAt?: Date;
}

export interface SessionServiceDependencies {
  projects: ProjectRepository;
  sessions: SessionRepository;
  clock?: () => Date;
}

export interface SessionService {
  /** @deprecated The manual timer is retired; kept so older installed builds keep their data. */
  start(subject: AuthenticatedSubject, input: StartSessionInput): Promise<SessionRecord>;
  /** @deprecated See `start`. */
  stop(subject: AuthenticatedSubject, sessionId: string, input: StopSessionInput): Promise<SessionRecord>;
  /** @deprecated See `start`. Observed sessions arrive finished, so nothing runs server-side. */
  current(subject: AuthenticatedSubject): Promise<SessionRecord | null>;
  /** Stores finished sessions the desktop observed. Per-row rejections never fail the batch. */
  recordObserved(subject: AuthenticatedSubject, inputs: ObservedSessionInput[]): Promise<ObservedSessionBatchResult>;
}

function sameStartIdentity(existing: SessionRecord, input: NormalizedStartInput): boolean {
  return existing.projectId === input.projectId
    && existing.description === input.description
    && (input.requestedStartedAt === undefined || existing.startedAt.getTime() === input.requestedStartedAt.getTime());
}

function invalidStop(message: string): AppError {
  return new AppError("invalid_session_stop", message);
}

export function createSessionService(dependencies: SessionServiceDependencies): SessionService {
  const clock = dependencies.clock ?? (() => new Date());

  return {
    async start(subject: AuthenticatedSubject, input: StartSessionInput): Promise<SessionRecord> {
      if (typeof input.deviceId !== "string" || input.deviceId.trim().length === 0) {
        throw new AppError("validation_error", "A recording device is required to start a timer.");
      }
      const now = clock();
      const startedAt = input.startedAt ?? now;
      const preferred = input.projectId === undefined
        ? await dependencies.projects.preferredForMember?.(subject) ?? null
        : null;
      if (input.projectId === undefined && preferred === null) {
        throw new AppError("not_found", "Project not found.");
      }
      const normalized: NormalizedStartInput = {
        clientId: input.clientId,
        projectId: input.projectId ?? preferred!.id,
        deviceId: input.deviceId,
        description: input.description ?? null,
        startedAt,
        ...(input.startedAt === undefined ? {} : { requestedStartedAt: input.startedAt }),
      };
      const existing = await dependencies.sessions.findByClientId(subject, normalized.clientId);
      if (existing !== null) {
        if (sameStartIdentity(existing, normalized)) return existing;
        throw new AppError("conflict", "The client id is already associated with a different session.");
      }

      const startTime = startedAt.getTime();
      if (!Number.isFinite(startTime)
        || startTime > now.getTime() + futureStopToleranceMs
        || startTime < now.getTime() - maxStartBackdateMs) {
        throw new AppError("validation_error", "Invalid session start time.");
      }

      const project = await dependencies.projects.findForMember(subject, normalized.projectId);
      if (project === null) {
        throw new AppError("not_found", "Project not found.");
      }
      if (project.archived) {
        throw new AppError("project_archived", "Archived projects cannot be used for time sessions.");
      }
      await dependencies.projects.rememberSelection?.(subject, project.id);
      if (await dependencies.sessions.findRunning(subject) !== null) {
        throw new AppError("session_already_running", "A time session is already running.");
      }

      try {
        return await dependencies.sessions.createRunning({
          organizationId: subject.organizationId,
          userId: subject.userId,
          clientId: normalized.clientId,
          projectId: normalized.projectId,
          deviceId: normalized.deviceId,
          description: normalized.description,
          startedAt: normalized.startedAt,
        });
      } catch (error) {
        if (!(error instanceof SessionRepositoryError)) throw error;
        const raced = await dependencies.sessions.findByClientId(subject, normalized.clientId);
        if (raced !== null && sameStartIdentity(raced, normalized)) return raced;
        if (error.conflict === "session_already_running") {
          throw new AppError("session_already_running", "A time session is already running.");
        }
        throw new AppError("conflict", "The client id is already associated with a different session.");
      }
    },

    async stop(subject: AuthenticatedSubject, sessionId: string, input: StopSessionInput): Promise<SessionRecord> {
      const existing = await dependencies.sessions.findById(subject, sessionId);
      if (existing === null) {
        throw new AppError("not_found", "Session not found.");
      }
      if (existing.status !== "running") return existing;

      const now = clock();
      const elapsedMs = input.stoppedAt.getTime() - existing.startedAt.getTime();
      if (elapsedMs < 0) throw invalidStop("The stop time must not be before the start time.");
      if (input.stoppedAt.getTime() > now.getTime() + futureStopToleranceMs) {
        throw invalidStop("The stop time is too far in the future.");
      }
      const elapsedSeconds = Math.floor(elapsedMs / 1_000);
      if (!Number.isInteger(input.idleSeconds) || input.idleSeconds < 0 || input.idleSeconds > elapsedSeconds) {
        throw invalidStop("Idle seconds must not exceed elapsed time.");
      }

      const completed = await dependencies.sessions.stopRunning(subject, sessionId, {
        stoppedAt: input.stoppedAt,
        idleSeconds: input.idleSeconds,
        durationSeconds: elapsedSeconds - input.idleSeconds,
        status: elapsedSeconds > reviewThresholdSeconds ? "needs_review" : "stopped",
        updatedAt: now,
      });
      if (completed !== null) return completed;

      const raced = await dependencies.sessions.findById(subject, sessionId);
      if (raced !== null && raced.status !== "running") return raced;
      throw new AppError("not_found", "Session not found.");
    },

    current(subject: AuthenticatedSubject): Promise<SessionRecord | null> {
      return dependencies.sessions.findRunning(subject);
    },

    async recordObserved(
      subject: AuthenticatedSubject,
      inputs: ObservedSessionInput[],
    ): Promise<ObservedSessionBatchResult> {
      const now = clock();
      const rejected: { clientId: string; reason: string }[] = [];
      const inserts: ObservedSessionInsert[] = [];
      // One membership lookup per distinct project, not per session: a day of
      // observed sessions is mostly the same one or two projects.
      const projects = new Map<string, string | null>();

      for (const input of inputs) {
        const elapsedMs = input.stoppedAt.getTime() - input.startedAt.getTime();
        const problem = await (async (): Promise<string | null> => {
          if (!Number.isFinite(elapsedMs) || elapsedMs <= 0) return "The session must end after it started.";
          if (input.stoppedAt.getTime() > now.getTime() + futureStopToleranceMs) {
            return "The session ends too far in the future.";
          }
          if (input.startedAt.getTime() < now.getTime() - maxStartBackdateMs) {
            return "The session is older than the seven-day evidence window.";
          }
          const elapsedSeconds = Math.floor(elapsedMs / 1_000);
          if (input.idleSeconds > elapsedSeconds) return "Idle seconds must not exceed elapsed time.";
          if (!projects.has(input.projectId)) {
            const project = await dependencies.projects.findForMember(subject, input.projectId);
            projects.set(
              input.projectId,
              project === null ? "Project not found." : project.archived ? "Archived projects cannot record time." : null,
            );
          }
          return projects.get(input.projectId) ?? null;
        })();

        if (problem !== null) {
          rejected.push({ clientId: input.clientId, reason: problem });
          continue;
        }

        const elapsedSeconds = Math.floor(elapsedMs / 1_000);
        inserts.push({
          organizationId: subject.organizationId,
          userId: subject.userId,
          clientId: input.clientId,
          projectId: input.projectId,
          attribution: input.attribution,
          startedAt: input.startedAt,
          stoppedAt: input.stoppedAt,
          idleSeconds: input.idleSeconds,
          durationSeconds: elapsedSeconds - input.idleSeconds,
          status: elapsedSeconds > reviewThresholdSeconds ? "needs_review" : "stopped",
        });
      }

      // Replays are ignored on the client id, so a retried batch is a no-op.
      await dependencies.sessions.insertObservedBatch(inserts);
      return { accepted: inserts.length, rejected };
    },
  };
}
