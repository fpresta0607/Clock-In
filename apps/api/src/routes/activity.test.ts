import { beforeAll, describe, expect, it } from "vitest";

import { createApp } from "../app.js";
import { parseEnv } from "../env.js";
import type { ActivitySegmentInsert, ActivitySegmentRepository } from "../repositories.js";
import { createTestAuth } from "../test-tokens.js";

const ids = {
  organization: "0e59dfd6-3d1f-4795-9420-3ab65f0df843",
  otherOrganization: "1e59dfd6-3d1f-4795-9420-3ab65f0df843",
  user: "e1c7e513-b094-4d4c-ae55-21790ae019a4",
  otherUser: "f1c7e513-b094-4d4c-ae55-21790ae019a4",
  device: "9b1c7e51-3b09-44d4-ae55-21790ae019a4",
};
const config = parseEnv({
  DATABASE_URL: "postgres://clock_in:password@localhost:5432/clock_in",
  AUTH_BASE_URL: "https://auth.clock-in.test/neondb/auth",
  NODE_ENV: "test",
});
const users = {
  [ids.user]: { id: ids.user, email: "alex@example.com", name: "Alex", organizationId: ids.organization, role: "member" as const },
  [ids.otherUser]: { id: ids.otherUser, email: "blair@example.com", name: "Blair", organizationId: ids.otherOrganization, role: "member" as const },
};

let keys: Awaited<ReturnType<typeof createTestAuth>>["keys"];
let bearerHeader: string;
let otherBearerHeader: string;

beforeAll(async () => {
  const auth = await createTestAuth(config, new Date("2026-08-06T14:00:00.000Z"));
  keys = auth.keys;
  bearerHeader = await auth.bearer(ids.user);
  otherBearerHeader = await auth.bearer(ids.otherUser);
});

class MemorySegments implements ActivitySegmentRepository {
  public readonly records: ActivitySegmentInsert[] = [];

  public async insertBatch(segments: ActivitySegmentInsert[]): Promise<void> {
    for (const segment of segments) {
      const duplicate = this.records.some((record) => record.organizationId === segment.organizationId
        && record.userId === segment.userId
        && record.clientId === segment.clientId);
      if (!duplicate) this.records.push(segment);
    }
  }
}

function createTestApp(segments = new MemorySegments()) {
  return createApp({
    config,
    keys,
    accounts: { resolve: async (identity) => users[identity.authUserId as keyof typeof users] },
    clock: () => new Date("2026-08-06T14:00:00.000Z"),
    activitySegmentRepository: segments,
  });
}

function segment(overrides: Record<string, unknown> = {}) {
  return {
    clientId: crypto.randomUUID(),
    deviceId: ids.device,
    kind: "active",
    startedAt: "2026-08-06T13:00:00.000Z",
    endedAt: "2026-08-06T13:30:00.000Z",
    ...overrides,
  };
}

describe("activity segment routes", () => {
  it("requires a bearer token", async () => {
    const response = await createTestApp().request("http://api.test/activity/segments", { method: "POST" });
    expect(response.status).toBe(401);
  });

  it("rejects malformed and schema-invalid bodies", async () => {
    const headers = { authorization: bearerHeader, "content-type": "application/json" };
    const app = createTestApp();

    const malformed = await app.request("http://api.test/activity/segments", { method: "POST", headers, body: "{bad" });
    expect(malformed.status).toBe(400);
    await expect(malformed.json()).resolves.toEqual({ error: { code: "validation_error", message: "Invalid request body." } });

    const empty = await app.request("http://api.test/activity/segments", { method: "POST", headers, body: JSON.stringify({ segments: [] }) });
    expect(empty.status).toBe(400);

    const badKind = await app.request("http://api.test/activity/segments", { method: "POST", headers, body: JSON.stringify({ segments: [segment({ kind: "busy" })] }) });
    expect(badKind.status).toBe(400);
  });

  it("accepts valid segments, reports per-row rejections, and replays idempotently", async () => {
    const headers = { authorization: bearerHeader, "content-type": "application/json" };
    const segments = new MemorySegments();
    const app = createTestApp(segments);
    const good = segment({ processName: "Code.exe" });
    const inverted = segment({ endedAt: "2026-08-06T12:00:00.000Z" });

    const uploaded = await app.request("http://api.test/activity/segments", {
      method: "POST", headers, body: JSON.stringify({ segments: [good, inverted] }),
    });
    expect(uploaded.status).toBe(200);
    await expect(uploaded.json()).resolves.toEqual({
      accepted: 1,
      rejected: [{ clientId: inverted.clientId, reason: "endedAt must be after startedAt" }],
    });
    expect(segments.records).toHaveLength(1);
    expect(segments.records[0]).toMatchObject({ clientId: good.clientId, organizationId: ids.organization, userId: ids.user });

    const replay = await app.request("http://api.test/activity/segments", {
      method: "POST", headers, body: JSON.stringify({ segments: [good] }),
    });
    expect(replay.status).toBe(200);
    await expect(replay.json()).resolves.toEqual({ accepted: 1, rejected: [] });
    expect(segments.records).toHaveLength(1);
  });

  it("scopes the idempotency key to the uploading organization and user", async () => {
    const headers = { authorization: otherBearerHeader, "content-type": "application/json" };
    const segments = new MemorySegments();
    const app = createTestApp(segments);
    const shared = segment();

    await app.request("http://api.test/activity/segments", {
      method: "POST", headers: { ...headers, authorization: bearerHeader }, body: JSON.stringify({ segments: [shared] }),
    });
    const other = await app.request("http://api.test/activity/segments", {
      method: "POST", headers, body: JSON.stringify({ segments: [shared] }),
    });

    expect(other.status).toBe(200);
    await expect(other.json()).resolves.toEqual({ accepted: 1, rejected: [] });
    expect(segments.records).toHaveLength(2);
    expect(segments.records[1]).toMatchObject({ organizationId: ids.otherOrganization, userId: ids.otherUser });
  });
});
