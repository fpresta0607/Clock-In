import { z } from "zod";

const idSchema = z.string().uuid();
const timestampSchema = z.string().datetime({ offset: true });
const dateSchema = z.string().regex(/^\d{4}-\d{2}-\d{2}$/).refine((value) => {
  const year = Number.parseInt(value.slice(0, 4), 10);
  const month = Number.parseInt(value.slice(5, 7), 10);
  const day = Number.parseInt(value.slice(8, 10), 10);
  const date = new Date(Date.UTC(year, month - 1, day));

  return date.getUTCFullYear() === year && date.getUTCMonth() === month - 1 && date.getUTCDate() === day;
});

export const sessionStatusValues = ["running", "stopped", "needs_review"] as const;
export const sessionStatusSchema = z.enum(sessionStatusValues);

export const userSchema = z
  .object({
    id: idSchema,
    email: z.string().email(),
    name: z.string().min(1),
    organizationId: idSchema,
  })
  .strict();

export const meResponseSchema = z.object({ user: userSchema }).strict();

export const projectListItemSchema = z
  .object({
    id: idSchema,
    name: z.string().min(1),
    color: z.string().regex(/^#[0-9a-fA-F]{6}$/).nullable().optional(),
    isArchived: z.boolean(),
  })
  .strict();

export const projectListResponseSchema = z.object({ projects: z.array(projectListItemSchema) }).strict();

const sessionBaseSchema = z
  .object({
    id: idSchema,
    clientId: idSchema,
    projectId: idSchema,
    description: z.string().max(1_000).nullable(),
    startedAt: timestampSchema,
    idleSeconds: z.number().int().nonnegative(),
  })
  .strict();

const runningSessionSchema = sessionBaseSchema.extend({
  status: z.literal("running"),
  stoppedAt: z.null(),
  durationSeconds: z.null(),
});

const stoppedSessionSchema = sessionBaseSchema.extend({
  status: z.literal("stopped"),
  stoppedAt: timestampSchema,
  durationSeconds: z.number().int().nonnegative(),
});

const needsReviewSessionSchema = sessionBaseSchema.extend({
  status: z.literal("needs_review"),
  stoppedAt: timestampSchema,
  durationSeconds: z.number().int().nonnegative(),
});

export const sessionSchema = z.discriminatedUnion("status", [
  runningSessionSchema,
  stoppedSessionSchema,
  needsReviewSessionSchema,
]);

export const sessionStartRequestSchema = z
  .object({
    clientId: idSchema,
    projectId: idSchema,
    description: z.string().max(1_000).optional(),
    startedAt: timestampSchema.optional(),
  })
  .strict();

export const sessionStartResponseSchema = z.object({ session: sessionSchema }).strict();

export const sessionStopRequestSchema = z
  .object({
    stoppedAt: timestampSchema,
    idleSeconds: z.number().int().nonnegative().default(0),
  })
  .strict();

export const sessionStopResponseSchema = z.object({ session: z.union([stoppedSessionSchema, needsReviewSessionSchema]) }).strict();
export const currentSessionResponseSchema = z.object({ session: runningSessionSchema.nullable() }).strict();

export const reportFiltersSchema = z
  .object({
    from: dateSchema.optional(),
    to: dateSchema.optional(),
    projectId: idSchema.optional(),
    userId: idSchema.optional(),
    page: z.coerce.number().int().min(1).max(10_000).default(1),
    pageSize: z.coerce.number().int().min(1).max(200).default(50),
  })
  .strict();

const completedReportStatusSchema = z.enum(["stopped", "needs_review"]);

export const reportRowSchema = z
  .object({
    id: idSchema,
    user: z.object({ id: idSchema, name: z.string().min(1) }).strict(),
    project: z.object({ id: idSchema, name: z.string().min(1) }).strict(),
    description: z.string().max(1_000).nullable(),
    status: completedReportStatusSchema,
    startedAt: timestampSchema,
    stoppedAt: timestampSchema,
    idleSeconds: z.number().int().nonnegative().safe(),
    durationSeconds: z.number().int().nonnegative().safe(),
  })
  .strict();

export const reportResponseSchema = z
  .object({
    filters: reportFiltersSchema,
    totalDurationSeconds: z.number().int().nonnegative().safe(),
    pagination: z.object({
      page: z.number().int().positive(),
      pageSize: z.number().int().positive().max(200),
      totalRows: z.number().int().nonnegative().safe(),
      totalPages: z.number().int().nonnegative().safe(),
    }).strict(),
    rows: z.array(reportRowSchema),
  })
  .strict();

export const apiErrorCodeValues = [
  "validation_error",
  "invalid_credentials",
  "unauthorized",
  "forbidden",
  "not_found",
  "conflict",
  "session_already_running",
  "project_archived",
  "invalid_session_stop",
  "rate_limited",
  "internal_error",
] as const;

export const apiErrorCodeSchema = z.enum(apiErrorCodeValues);
export const apiErrorSchema = z
  .object({
    error: z
      .object({
        code: apiErrorCodeSchema,
        message: z.string().min(1),
        details: z.record(z.string(), z.unknown()).optional(),
      })
      .strict(),
  })
  .strict();

export type ApiError = z.infer<typeof apiErrorSchema>;
export type ApiErrorCode = z.infer<typeof apiErrorCodeSchema>;
export type CurrentSessionResponse = z.infer<typeof currentSessionResponseSchema>;
export type MeResponse = z.infer<typeof meResponseSchema>;
export type ProjectListItem = z.infer<typeof projectListItemSchema>;
export type ProjectListResponse = z.infer<typeof projectListResponseSchema>;
export type ReportFilters = z.infer<typeof reportFiltersSchema>;
export type ReportRow = z.infer<typeof reportRowSchema>;
export type ReportResponse = z.infer<typeof reportResponseSchema>;
export type Session = z.infer<typeof sessionSchema>;
export type SessionStartRequest = z.infer<typeof sessionStartRequestSchema>;
export type SessionStartResponse = z.infer<typeof sessionStartResponseSchema>;
export type SessionStatus = z.infer<typeof sessionStatusSchema>;
export type SessionStopRequest = z.infer<typeof sessionStopRequestSchema>;
export type SessionStopResponse = z.infer<typeof sessionStopResponseSchema>;
