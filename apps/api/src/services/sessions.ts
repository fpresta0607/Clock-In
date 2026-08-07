import type { AuthenticatedSubject } from "../auth.js";
import { AppError } from "../errors.js";
import {
  SessionRepositoryError,
  type ProjectRepository,
  type SessionRecord,
  type SessionRepository,
} from "../repositories.js";

const futureStopToleranceMs = 30_000;
const maxStartBackdateMs = 7 * 24 * 60 * 60 * 1_000;
const reviewThresholdSeconds = 12 * 60 * 60;

export interface StartSessionInput {
  clientId: string;
  projectId: string;
  description?: string;
  startedAt?: Date;
}

export interface StopSessionInput {
  stoppedAt: Date;
  idleSeconds: number;
}

interface NormalizedStartInput {
  clientId: string;
  projectId: string;
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
  start(subject: AuthenticatedSubject, input: StartSessionInput): Promise<SessionRecord>;
  stop(subject: AuthenticatedSubject, sessionId: string, input: StopSessionInput): Promise<SessionRecord>;
  current(subject: AuthenticatedSubject): Promise<SessionRecord | null>;
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
      const now = clock();
      const startedAt = input.startedAt ?? now;
      const startTime = startedAt.getTime();
      if (!Number.isFinite(startTime)
        || startTime > now.getTime() + futureStopToleranceMs
        || startTime < now.getTime() - maxStartBackdateMs) {
        throw new AppError("validation_error", "Invalid session start time.");
      }
      const normalized: NormalizedStartInput = {
        clientId: input.clientId,
        projectId: input.projectId,
        description: input.description ?? null,
        startedAt,
        ...(input.startedAt === undefined ? {} : { requestedStartedAt: input.startedAt }),
      };
      const existing = await dependencies.sessions.findByClientId(subject, normalized.clientId);
      if (existing !== null) {
        if (sameStartIdentity(existing, normalized)) return existing;
        throw new AppError("conflict", "The client id is already associated with a different session.");
      }

      const project = await dependencies.projects.findForMember(subject, normalized.projectId);
      if (project === null) {
        throw new AppError("not_found", "Project not found.");
      }
      if (project.archived) {
        throw new AppError("project_archived", "Archived projects cannot be used for time sessions.");
      }
      if (await dependencies.sessions.findRunning(subject) !== null) {
        throw new AppError("session_already_running", "A time session is already running.");
      }

      try {
        return await dependencies.sessions.createRunning({
          organizationId: subject.organizationId,
          userId: subject.userId,
          clientId: normalized.clientId,
          projectId: normalized.projectId,
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
  };
}
