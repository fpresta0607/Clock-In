import { describe, expect, it } from "vitest";

import type { AuthenticatedSubject } from "../auth.js";
import {
  SessionRepositoryError,
  type CreateRunningSession,
  type ProjectRecord,
  type ProjectRepository,
  type SessionRecord,
  type SessionRepository,
  type StopRunningSession,
} from "../repositories.js";
import { createSessionService } from "./sessions.js";

const ids = {
  organization: "0e59dfd6-3d1f-4795-9420-3ab65f0df843",
  user: "e1c7e513-b094-4d4c-ae55-21790ae019a4",
  otherUser: "f1c7e513-b094-4d4c-ae55-21790ae019a4",
  project: "a1c7e513-b094-4d4c-ae55-21790ae019a4",
  otherProject: "b1c7e513-b094-4d4c-ae55-21790ae019a4",
  client: "c1c7e513-b094-4d4c-ae55-21790ae019a4",
  session: "d1c7e513-b094-4d4c-ae55-21790ae019a4",
  device: "f1c7e513-b094-4d4c-ae55-21790ae019a4",
};
const subject: AuthenticatedSubject = { organizationId: ids.organization, userId: ids.user };
const now = new Date("2026-08-06T14:00:00.000Z");

function running(overrides: Partial<SessionRecord> = {}): SessionRecord {
  return {
    id: ids.session,
    organizationId: ids.organization,
    userId: ids.user,
    clientId: ids.client,
    projectId: ids.project,
    description: "Investigate timer",
    status: "running",
    startedAt: new Date("2026-08-06T13:00:00.000Z"),
    stoppedAt: null,
    idleSeconds: 0,
    durationSeconds: null,
    ...overrides,
  };
}

class MemoryProjects implements ProjectRepository {
  private readonly selections = new Map<string, string>();

  public constructor(private readonly records: ProjectRecord[]) {}

  public async listForMember(): Promise<ProjectRecord[]> {
    return this.records.filter((record) => !record.archived);
  }

  public async findForMember(_subject: AuthenticatedSubject, projectId: string): Promise<ProjectRecord | null> {
    return this.records.find((record) => record.id === projectId) ?? null;
  }

  public async createForMember(): Promise<ProjectRecord> {
    throw new Error("not implemented");
  }

  public async preferredForMember(current: AuthenticatedSubject): Promise<ProjectRecord | null> {
    const selected = this.selections.get(current.userId);
    return this.records.find((record) => record.id === selected && !record.archived)
      ?? this.records.find((record) => record.isDefault === true && !record.archived)
      ?? null;
  }

  public async rememberSelection(current: AuthenticatedSubject, projectId: string): Promise<void> {
    if (this.records.some((record) => record.id === projectId && !record.archived)) {
      this.selections.set(current.userId, projectId);
    }
  }

  public selectedFor(userId: string): string | undefined {
    return this.selections.get(userId);
  }
}

class MemorySessions implements SessionRepository {
  public readonly records: SessionRecord[];
  public nextCreateError: SessionRepositoryError | null = null;
  public raceRecord: SessionRecord | null = null;
  public createdInput: CreateRunningSession | null = null;

  public constructor(records: SessionRecord[] = []) {
    this.records = records;
  }

  public async findByClientId(current: AuthenticatedSubject, clientId: string): Promise<SessionRecord | null> {
    return this.records.find((record) => record.organizationId === current.organizationId && record.userId === current.userId && record.clientId === clientId) ?? null;
  }

  public async findRunning(current: AuthenticatedSubject): Promise<SessionRecord | null> {
    return this.records.find((record) => record.organizationId === current.organizationId && record.userId === current.userId && record.status === "running") ?? null;
  }

  public async findById(current: AuthenticatedSubject, sessionId: string): Promise<SessionRecord | null> {
    return this.records.find((record) => record.id === sessionId && record.organizationId === current.organizationId && record.userId === current.userId) ?? null;
  }

  public async createRunning(input: CreateRunningSession): Promise<SessionRecord> {
    this.createdInput = input;
    if (this.nextCreateError !== null) {
      if (this.raceRecord !== null) this.records.push(this.raceRecord);
      throw this.nextCreateError;
    }
    const session = running({ ...input, id: crypto.randomUUID() });
    this.records.push(session);
    return session;
  }

  public async stopRunning(current: AuthenticatedSubject, sessionId: string, input: StopRunningSession): Promise<SessionRecord | null> {
    const session = await this.findById(current, sessionId);
    if (session === null || session.status !== "running") return null;
    const completed: SessionRecord = { ...session, ...input };
    const index = this.records.indexOf(session);
    this.records[index] = completed;
    return completed;
  }
}

function createService(records: SessionRecord[] = [], projects: ProjectRecord[] = [{
  id: ids.project, organizationId: ids.organization, name: "General Work", archived: false, isDefault: true,
}]) {
  const sessions = new MemorySessions(records);
  const projectRepository = new MemoryProjects(projects);
  return {
    sessions,
    projects: projectRepository,
    service: createSessionService({ projects: projectRepository, sessions, clock: () => now }),
  };
}

describe("session service", () => {
  it("uses the member-visible default when a start omits a project", async () => {
    const { service, sessions, projects } = createService();

    await service.start(subject, { clientId: ids.client, deviceId: ids.device, description: "General work" });

    expect(sessions.records[0]).toMatchObject({ projectId: ids.project, organizationId: ids.organization, userId: ids.user });
    expect(projects.selectedFor(ids.user)).toBe(ids.project);
  });

  it("persists the trusted recording device with a timer start", async () => {
    const { service, sessions } = createService();

    await service.start(subject, { clientId: ids.client, projectId: ids.project, deviceId: ids.device });

    expect(sessions.createdInput).toMatchObject({ deviceId: ids.device });
  });

  it("returns the persisted session for a compatible idempotent start before authorization checks", async () => {
    const persisted = running();
    const { service } = createService([persisted], []);

    await expect(service.start(subject, {
      clientId: ids.client, projectId: ids.project, deviceId: ids.device, description: "Investigate timer", startedAt: persisted.startedAt,
    })).resolves.toEqual(persisted);
  });

  it("treats an omitted start timestamp as compatible on an idempotent retry", async () => {
    const persisted = running();
    const { service } = createService([persisted], []);

    await expect(service.start(subject, {
      clientId: ids.client, projectId: ids.project, deviceId: ids.device, description: "Investigate timer",
    })).resolves.toEqual(persisted);
  });

  it("returns an old persisted session for an explicit compatible idempotent retry", async () => {
    const persisted = running({ startedAt: new Date("2026-07-30T13:59:59.999Z") });
    const { service } = createService([persisted], []);

    await expect(service.start(subject, {
      clientId: ids.client,
      projectId: ids.project,
      deviceId: ids.device,
      description: "Investigate timer",
      startedAt: persisted.startedAt,
    })).resolves.toEqual(persisted);
  });

  it("rejects a client id reused with a different start identity", async () => {
    const { service } = createService([running()]);

    await expect(service.start(subject, {
      clientId: ids.client, projectId: ids.otherProject, deviceId: ids.device, description: "Investigate timer", startedAt: new Date("2026-08-06T13:00:00.000Z"),
    })).rejects.toMatchObject({ code: "conflict", status: 409 });
  });

  it("validates explicit start times against the injected clock", async () => {
    const { service } = createService();
    const input = { clientId: ids.client, projectId: ids.project, deviceId: ids.device };

    await expect(service.start(subject, { ...input, startedAt: new Date("not-a-date") })).rejects.toMatchObject({ code: "validation_error", status: 400 });
    await expect(service.start(subject, { ...input, startedAt: new Date("2026-08-06T14:00:30.001Z") })).rejects.toMatchObject({ code: "validation_error", status: 400 });
    await expect(service.start(subject, { ...input, startedAt: new Date("2026-07-30T13:59:59.999Z") })).rejects.toMatchObject({ code: "validation_error", status: 400 });
    await expect(service.start(subject, { ...input, startedAt: new Date("2026-07-30T14:00:00.000Z") })).resolves.toMatchObject({ startedAt: new Date("2026-07-30T14:00:00.000Z") });
  });

  it("does not leak inaccessible projects and rejects archived projects", async () => {
    const inaccessible = createService([], []);
    const archived = createService([], [{ id: ids.project, organizationId: ids.organization, name: "Old", archived: true }]);
    const input = { clientId: ids.client, projectId: ids.project, deviceId: ids.device };

    await expect(inaccessible.service.start(subject, input)).rejects.toMatchObject({ code: "not_found", status: 404 });
    await expect(archived.service.start(subject, input)).rejects.toMatchObject({ code: "project_archived", status: 409 });
  });

  it("rejects another running session and resolves a client-id unique race by re-reading", async () => {
    const active = createService([running({ clientId: ids.otherProject })]);
    await expect(active.service.start(subject, { clientId: ids.client, projectId: ids.project, deviceId: ids.device })).rejects.toMatchObject({ code: "session_already_running" });

    const raced = createService();
    raced.sessions.nextCreateError = new SessionRepositoryError("client_id");
    raced.sessions.raceRecord = running();
    await expect(raced.service.start(subject, {
      clientId: ids.client, projectId: ids.project, deviceId: ids.device, description: "Investigate timer", startedAt: new Date("2026-08-06T13:00:00.000Z"),
    })).resolves.toEqual(running());

    const oneRunningRace = createService();
    oneRunningRace.sessions.nextCreateError = new SessionRepositoryError("session_already_running");
    oneRunningRace.sessions.raceRecord = running();
    await expect(oneRunningRace.service.start(subject, {
      clientId: ids.client, projectId: ids.project, deviceId: ids.device, description: "Investigate timer", startedAt: new Date("2026-08-06T13:00:00.000Z"),
    })).resolves.toEqual(running());
  });

  it("validates stop times and idle seconds, computes duration, and marks long sessions for review", async () => {
    const { service } = createService([running()]);
    await expect(service.stop(subject, ids.session, { stoppedAt: new Date("2026-08-06T12:59:59.000Z"), idleSeconds: 0 })).rejects.toMatchObject({ code: "invalid_session_stop" });
    await expect(service.stop(subject, ids.session, { stoppedAt: new Date("2026-08-06T14:00:31.000Z"), idleSeconds: 0 })).rejects.toMatchObject({ code: "invalid_session_stop" });
    await expect(service.stop(subject, ids.session, { stoppedAt: new Date("2026-08-06T13:10:00.000Z"), idleSeconds: 0.5 })).rejects.toMatchObject({ code: "invalid_session_stop" });
    await expect(service.stop(subject, ids.session, { stoppedAt: new Date("2026-08-06T13:10:00.000Z"), idleSeconds: 601 })).rejects.toMatchObject({ code: "invalid_session_stop" });
    await expect(service.stop(subject, ids.session, { stoppedAt: new Date("2026-08-06T13:10:00.999Z"), idleSeconds: 60 })).resolves.toMatchObject({ status: "stopped", durationSeconds: 540, description: "Investigate timer" });

    const long = createService([running({ startedAt: new Date("2026-08-05T23:00:00.000Z") })]);
    await expect(long.service.stop(subject, ids.session, { stoppedAt: new Date("2026-08-06T13:00:00.000Z"), idleSeconds: 0 })).resolves.toMatchObject({ status: "needs_review", durationSeconds: 50_400 });
  });

  it("returns a completed stop idempotently and exposes only the caller's running current session", async () => {
    const completed = running({ status: "stopped", stoppedAt: new Date("2026-08-06T13:10:00.000Z"), idleSeconds: 0, durationSeconds: 600 });
    const { service } = createService([completed]);

    await expect(service.stop(subject, ids.session, { stoppedAt: new Date("2026-08-06T13:20:00.000Z"), idleSeconds: 5 })).resolves.toEqual(completed);
    await expect(service.start(subject, {
      clientId: ids.client,
      projectId: ids.project,
      deviceId: ids.device,
      description: "Investigate timer",
      startedAt: new Date("2026-08-06T13:00:00.000Z"),
    })).resolves.toEqual(completed);
    await expect(service.current(subject)).resolves.toBeNull();
    await expect(service.stop({ ...subject, userId: ids.otherUser }, ids.session, { stoppedAt: now, idleSeconds: 0 })).rejects.toMatchObject({ code: "not_found" });
  });
});
