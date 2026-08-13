import { describe, expect, it } from "vitest";

import type { AuthenticatedSubject } from "../auth.js";
import type { ActivitySegmentInsert, ActivitySegmentRepository } from "../repositories.js";
import { createActivityService, type ActivitySegmentInput } from "./activity.js";

const ids = {
  organization: "0e59dfd6-3d1f-4795-9420-3ab65f0df843",
  user: "e1c7e513-b094-4d4c-ae55-21790ae019a4",
  otherUser: "f1c7e513-b094-4d4c-ae55-21790ae019a4",
  device: "9b1c7e51-3b09-44d4-ae55-21790ae019a4",
};
const subject: AuthenticatedSubject = { organizationId: ids.organization, userId: ids.user, role: "member" };
const now = new Date("2026-08-06T14:00:00.000Z");

class MemorySegments implements ActivitySegmentRepository {
  public readonly records: ActivitySegmentInsert[] = [];

  /** Mirrors the ON CONFLICT DO NOTHING idempotency key. */
  public async insertBatch(segments: ActivitySegmentInsert[]): Promise<void> {
    for (const segment of segments) {
      const duplicate = this.records.some((record) => record.organizationId === segment.organizationId
        && record.userId === segment.userId
        && record.clientId === segment.clientId);
      if (!duplicate) this.records.push(segment);
    }
  }
}

function segment(overrides: Partial<ActivitySegmentInput> = {}): ActivitySegmentInput {
  return {
    clientId: crypto.randomUUID(),
    deviceId: ids.device,
    kind: "active",
    startedAt: new Date("2026-08-06T13:00:00.000Z"),
    endedAt: new Date("2026-08-06T13:30:00.000Z"),
    ...overrides,
  };
}

function createService() {
  const segments = new MemorySegments();
  return { segments, service: createActivityService({ segments, clock: () => now }) };
}

describe("activity service", () => {
  it("inserts valid segments with a server-stamped receivedAt", async () => {
    const { segments, service } = createService();
    const input = segment({ processName: "Code.exe" });

    await expect(service.upload(subject, [input])).resolves.toEqual({ accepted: 1, rejected: [] });
    expect(segments.records).toHaveLength(1);
    expect(segments.records[0]).toMatchObject({
      organizationId: ids.organization,
      userId: ids.user,
      clientId: input.clientId,
      processName: "Code.exe",
      receivedAt: now,
    });
  });

  it("counts a replayed batch as accepted without duplicating rows", async () => {
    const { segments, service } = createService();
    const input = segment();

    await service.upload(subject, [input]);
    await expect(service.upload(subject, [input])).resolves.toEqual({ accepted: 1, rejected: [] });
    expect(segments.records).toHaveLength(1);
  });

  it("rejects invalid rows individually without failing the batch", async () => {
    const { segments, service } = createService();
    const inverted = segment({ endedAt: new Date("2026-08-06T12:00:00.000Z") });
    const equal = segment({ startedAt: new Date("2026-08-06T13:00:00.000Z"), endedAt: new Date("2026-08-06T13:00:00.000Z") });
    const future = segment({ endedAt: new Date("2026-08-06T14:00:30.001Z") });
    const tolerated = segment({ startedAt: new Date("2026-08-06T13:59:00.000Z"), endedAt: new Date("2026-08-06T14:00:30.000Z") });
    const tooLong = segment({ startedAt: new Date("2026-08-05T13:00:00.000Z"), endedAt: new Date("2026-08-06T13:00:00.001Z") });
    const broken = segment({ startedAt: new Date("not-a-date") });
    const good = segment();

    const result = await service.upload(subject, [inverted, equal, future, tolerated, tooLong, broken, good]);

    expect(result.accepted).toBe(2);
    expect(result.rejected).toEqual([
      { clientId: inverted.clientId, reason: "endedAt must be after startedAt" },
      { clientId: equal.clientId, reason: "endedAt must be after startedAt" },
      { clientId: future.clientId, reason: "endedAt is too far in the future" },
      { clientId: tooLong.clientId, reason: "segment spans more than 24 hours" },
      { clientId: broken.clientId, reason: "timestamps are invalid" },
    ]);
    expect(segments.records.map((record) => record.clientId).sort()).toEqual([good.clientId, tolerated.clientId].sort());
  });

  it("scopes rows to the uploading subject", async () => {
    const { segments, service } = createService();
    const other: AuthenticatedSubject = { organizationId: ids.organization, userId: ids.otherUser, role: "member" };
    await service.upload(subject, [segment()]);
    await service.upload(other, [segment()]);

    expect(segments.records[0]).toMatchObject({ userId: ids.user });
    expect(segments.records[1]).toMatchObject({ userId: ids.otherUser });
  });
});
