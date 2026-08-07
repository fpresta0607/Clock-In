import { describe, expect, it } from "vitest";

import {
  apiErrorSchema,
  currentSessionResponseSchema,
  loginRequestSchema,
  loginResponseSchema,
  projectListItemSchema,
  reportFiltersSchema,
  sessionStartRequestSchema,
  sessionStartResponseSchema,
  sessionSchema,
  sessionStatusValues,
  sessionStopRequestSchema,
  sessionStopResponseSchema,
} from "./contracts.js";

const ids = {
  client: "84c996f1-3a07-452c-a476-4ca320488c22",
  organization: "0e59dfd6-3d1f-4795-9420-3ab65f0df843",
  project: "4952827b-1d8f-4c37-8c84-9d7db2c960b6",
  session: "77f941cf-f4bb-4b03-9170-2e82fd8187e9",
  user: "e1c7e513-b094-4d4c-ae55-21790ae019a4",
};

const startedAt = "2026-08-06T14:00:00.000Z";
const stoppedAt = "2026-08-06T15:03:04.000Z";

describe("authentication contracts", () => {
  it("accepts a login request with an email and password", () => {
    expect(loginRequestSchema.parse({ email: "alex@example.com", password: "correct horse battery staple" })).toEqual({
      email: "alex@example.com",
      password: "correct horse battery staple",
    });
  });

  it("rejects a login request without valid credentials", () => {
    expect(() => loginRequestSchema.parse({ email: "not-an-email", password: "" })).toThrow();
  });

  it("accepts a login response with the signed-in user", () => {
    expect(
      loginResponseSchema.parse({
        accessToken: "signed.jwt.token",
        user: { id: ids.user, email: "alex@example.com", name: "Alex Morgan", organizationId: ids.organization },
      }),
    ).toMatchObject({ accessToken: "signed.jwt.token", user: { id: ids.user } });
  });
});

describe("project contracts", () => {
  it("accepts a project list item with its active state", () => {
    expect(
      projectListItemSchema.parse({
        id: ids.project,
        name: "Website redesign",
        color: "#2563eb",
        isArchived: false,
      }),
    ).toMatchObject({ id: ids.project, isArchived: false });
  });
});

describe("session contracts", () => {
  it("covers every supported session status", () => {
    expect(sessionStatusValues).toEqual(["running", "stopped", "needs_review"]);
  });

  it("accepts a start request with a client-generated id", () => {
    expect(
      sessionStartRequestSchema.parse({
        clientId: ids.client,
        projectId: ids.project,
        description: "Prepare the landing page",
        startedAt,
      }),
    ).toMatchObject({ clientId: ids.client, projectId: ids.project });
  });

  it("accepts the persisted running session returned after a start", () => {
    expect(
      sessionStartResponseSchema.parse({
        session: {
          id: ids.session,
          clientId: ids.client,
          projectId: ids.project,
          status: "running",
          description: "Prepare the landing page",
          startedAt,
          stoppedAt: null,
          idleSeconds: 0,
          durationSeconds: null,
        },
      }),
    ).toMatchObject({ session: { id: ids.session, status: "running" } });
  });

  it("rejects completed sessions from a start response", () => {
    const completedSession = {
      id: ids.session,
      clientId: ids.client,
      projectId: ids.project,
      description: null,
      startedAt,
      stoppedAt,
      idleSeconds: 0,
      durationSeconds: 3_784,
    };

    expect(() => sessionStartResponseSchema.parse({ session: { ...completedSession, status: "stopped" } })).toThrow();
    expect(() => sessionStartResponseSchema.parse({ session: { ...completedSession, status: "needs_review" } })).toThrow();
  });

  it("accepts a stop request and the stopped session response", () => {
    expect(sessionStopRequestSchema.parse({ stoppedAt, idleSeconds: 120 })).toEqual({ stoppedAt, idleSeconds: 120 });
    expect(
      sessionStopResponseSchema.parse({
        session: {
          id: ids.session,
          clientId: ids.client,
          projectId: ids.project,
          status: "stopped",
          description: null,
          startedAt,
          stoppedAt,
          idleSeconds: 120,
          durationSeconds: 3664,
        },
      }),
    ).toMatchObject({ session: { status: "stopped", durationSeconds: 3664 } });
  });

  it("rejects a running session from a stop response", () => {
    expect(() => sessionStopResponseSchema.parse({
      session: {
        id: ids.session,
        clientId: ids.client,
        projectId: ids.project,
        status: "running",
        description: null,
        startedAt,
        stoppedAt: null,
        idleSeconds: 0,
        durationSeconds: null,
      },
    })).toThrow();
  });

  it("represents an absent or running current session", () => {
    expect(currentSessionResponseSchema.parse({ session: null })).toEqual({ session: null });
    expect(
      currentSessionResponseSchema.parse({
        session: {
          id: ids.session,
          clientId: ids.client,
          projectId: ids.project,
          status: "running",
          description: null,
          startedAt,
          stoppedAt: null,
          idleSeconds: 0,
          durationSeconds: null,
        },
      }),
    ).toMatchObject({ session: { status: "running" } });
  });

  it("rejects session timestamps and durations that contradict the status", () => {
    const runningSession = {
      id: ids.session,
      clientId: ids.client,
      projectId: ids.project,
      status: "running",
      description: null,
      startedAt,
      stoppedAt: null,
      idleSeconds: 0,
      durationSeconds: null,
    };

    expect(() => sessionSchema.parse({ ...runningSession, stoppedAt })).toThrow();
    expect(() => sessionSchema.parse({ ...runningSession, durationSeconds: 1 })).toThrow();
    expect(() => sessionSchema.parse({ ...runningSession, status: "stopped", stoppedAt: null, durationSeconds: 1 })).toThrow();
    expect(() => sessionSchema.parse({ ...runningSession, status: "needs_review", stoppedAt, durationSeconds: null })).toThrow();
  });

  it("rejects a completed session as the current session", () => {
    const completedSession = {
      id: ids.session,
      clientId: ids.client,
      projectId: ids.project,
      description: null,
      startedAt,
      stoppedAt,
      idleSeconds: 0,
      durationSeconds: 3_784,
    };

    expect(() => currentSessionResponseSchema.parse({ session: { ...completedSession, status: "stopped" } })).toThrow();
    expect(() => currentSessionResponseSchema.parse({ session: { ...completedSession, status: "needs_review" } })).toThrow();
  });
});

describe("report and error contracts", () => {
  it("accepts inclusive report filters", () => {
    expect(
      reportFiltersSchema.parse({
        from: "2026-08-01",
        to: "2026-08-06",
        projectId: ids.project,
        userId: ids.user,
      }),
    ).toMatchObject({ from: "2026-08-01", to: "2026-08-06" });
  });

  it("rejects impossible calendar dates", () => {
    expect(() => reportFiltersSchema.parse({ from: "2026-99-99" })).toThrow();
    expect(() => reportFiltersSchema.parse({ to: "2026-02-29" })).toThrow();
  });

  it("uses stable API error codes and actionable messages", () => {
    expect(apiErrorSchema.parse({ error: { code: "session_already_running", message: "Stop the active session first." } })).toEqual({
      error: { code: "session_already_running", message: "Stop the active session first." },
    });
    expect(() => apiErrorSchema.parse({ error: { code: "unrecognized", message: "Nope" } })).toThrow();
  });
});
