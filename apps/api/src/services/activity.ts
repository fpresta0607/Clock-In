import type { ActivitySegmentBatchResponse, ActivitySegmentKind } from "@clock-in/shared";

import type { AuthenticatedSubject } from "../auth.js";
import type { ActivitySegmentInsert, ActivitySegmentRepository } from "../repositories.js";

const futureEndToleranceMs = 30_000;
const maxSegmentSpanMs = 24 * 60 * 60 * 1_000;

export interface ActivitySegmentInput {
  clientId: string;
  deviceId: string;
  kind: ActivitySegmentKind;
  processName?: string;
  startedAt: Date;
  endedAt: Date;
}

export interface ActivityServiceDependencies {
  segments: ActivitySegmentRepository;
  clock?: () => Date;
}

export interface ActivityService {
  upload(subject: AuthenticatedSubject, segments: ActivitySegmentInput[]): Promise<ActivitySegmentBatchResponse>;
}

function rejectionReason(segment: ActivitySegmentInput, now: Date): string | null {
  const start = segment.startedAt.getTime();
  const end = segment.endedAt.getTime();
  if (!Number.isFinite(start) || !Number.isFinite(end)) return "timestamps are invalid";
  if (end <= start) return "endedAt must be after startedAt";
  if (end > now.getTime() + futureEndToleranceMs) return "endedAt is too far in the future";
  if (end - start > maxSegmentSpanMs) return "segment spans more than 24 hours";
  return null;
}

export function createActivityService(dependencies: ActivityServiceDependencies): ActivityService {
  const clock = dependencies.clock ?? (() => new Date());

  return {
    async upload(subject: AuthenticatedSubject, segments: ActivitySegmentInput[]): Promise<ActivitySegmentBatchResponse> {
      const now = clock();
      const valid: ActivitySegmentInsert[] = [];
      const rejected: ActivitySegmentBatchResponse["rejected"] = [];
      for (const segment of segments) {
        const reason = rejectionReason(segment, now);
        if (reason !== null) {
          rejected.push({ clientId: segment.clientId, reason });
          continue;
        }
        valid.push({
          organizationId: subject.organizationId,
          userId: subject.userId,
          clientId: segment.clientId,
          deviceId: segment.deviceId,
          kind: segment.kind,
          processName: segment.processName ?? null,
          startedAt: segment.startedAt,
          endedAt: segment.endedAt,
          receivedAt: now,
        });
      }
      // Replayed client ids are ignored by the repository, so a replay counts as accepted.
      await dependencies.segments.insertBatch(valid);
      return { accepted: valid.length, rejected };
    },
  };
}
