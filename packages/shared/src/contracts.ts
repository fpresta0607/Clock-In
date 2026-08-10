import { z } from "zod";

import { inviteCodePattern } from "./invite-code.js";

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
    role: z.enum(["admin", "member"]).default("member"),
  })
  .strict();

export const meResponseSchema = z.object({ user: userSchema }).strict();

export const organizationSchema = z
  .object({
    id: idSchema,
    name: z.string().min(1),
    inviteCode: z.string().regex(inviteCodePattern),
  })
  .strict();

export const organizationResponseSchema = z.object({ organization: organizationSchema }).strict();

/** Sent once, right after sign-up, to place the new account in an existing organization. */
export const provisionAccountRequestSchema = z
  .object({
    inviteCode: z.string().min(1).optional(),
    /** Names the workspace this account starts; ignored when an invite code joins one instead. */
    workspaceName: z.string().trim().min(1).max(80).optional(),
  })
  .strict();

/** Sent by an existing account that wants to move into a teammate's workspace. */
export const joinOrganizationRequestSchema = z
  .object({ inviteCode: z.string().min(1), expectedOrganizationId: idSchema.optional() })
  .strict();

function validateCalendarAndInstantBounds(
  value: { from?: string; to?: string; fromAt?: string; toExclusiveAt?: string },
  context: z.RefinementCtx,
): void {
  const hasCalendarBoundary = value.from !== undefined || value.to !== undefined;
  const hasInstantBoundary = value.fromAt !== undefined || value.toExclusiveAt !== undefined;
  if (hasCalendarBoundary && hasInstantBoundary) {
    context.addIssue({ code: z.ZodIssueCode.custom, message: "Calendar and instant bounds cannot be combined." });
  }
  if ((value.fromAt === undefined) !== (value.toExclusiveAt === undefined)) {
    context.addIssue({ code: z.ZodIssueCode.custom, message: "Instant bounds must be supplied together." });
  }
}

export const leaderboardFiltersSchema = z
  .object({
    from: dateSchema.optional(),
    to: dateSchema.optional(),
    fromAt: timestampSchema.optional(),
    toExclusiveAt: timestampSchema.optional(),
  })
  .strict()
  .superRefine(validateCalendarAndInstantBounds);

export const leaderboardEntrySchema = z
  .object({
    rank: z.number().int().positive(),
    user: z.object({ id: idSchema, name: z.string().min(1) }).strict(),
    durationSeconds: z.number().int().nonnegative().safe(),
    sessionCount: z.number().int().nonnegative().safe(),
    corroboratedSeconds: z.number().int().nonnegative().safe(),
  })
  .strict();

export const leaderboardResponseSchema = z
  .object({
    filters: leaderboardFiltersSchema,
    totalDurationSeconds: z.number().int().nonnegative().safe(),
    entries: z.array(leaderboardEntrySchema),
  })
  .strict();

export const projectListItemSchema = z
  .object({
    id: idSchema,
    name: z.string().min(1),
    color: z.string().regex(/^#[0-9a-fA-F]{6}$/).nullable().optional(),
    isArchived: z.boolean(),
    isDefault: z.boolean().default(false),
  })
  .strict();

export const projectListResponseSchema = z.object({
  projects: z.array(projectListItemSchema),
  selectedProjectId: idSchema.nullable().default(null),
}).strict();

/** Desktop "New project…" affordance; the response reuses the list-item shape. */
export const projectCreateRequestSchema = z
  .object({
    name: z.string().trim().min(1).max(80),
  })
  .strict();

export const projectUpdateRequestSchema = z
  .object({
    name: z.string().trim().min(1).max(80).optional(),
    isArchived: z.boolean().optional(),
    replacementProjectId: idSchema.optional(),
  })
  .strict()
  .refine((value) => value.name !== undefined || value.isArchived !== undefined || value.replacementProjectId !== undefined);

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
    projectId: idSchema.optional(),
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
    fromAt: timestampSchema.optional(),
    toExclusiveAt: timestampSchema.optional(),
    projectId: idSchema.optional(),
    userId: idSchema.optional(),
    page: z.coerce.number().int().min(1).max(10_000).default(1),
    pageSize: z.coerce.number().int().min(1).max(200).default(50),
  })
  .strict()
  .superRefine(validateCalendarAndInstantBounds);

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
    corroboratedSeconds: z.number().int().nonnegative().safe(),
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

export const activitySegmentKindValues = ["active", "idle", "locked", "suspended"] as const;
export const activitySegmentKindSchema = z.enum(activitySegmentKindValues);

/** One coarse OS-activity span uploaded by the desktop monitor; `clientId` makes replays idempotent. */
export const activitySegmentUploadSchema = z
  .object({
    clientId: idSchema,
    deviceId: idSchema,
    kind: activitySegmentKindSchema,
    processName: z.string().max(200).optional(),
    startedAt: timestampSchema,
    endedAt: timestampSchema,
  })
  .strict();

export const activitySegmentBatchRequestSchema = z
  .object({
    segments: z.array(activitySegmentUploadSchema).min(1).max(500),
  })
  .strict();

export const activitySegmentBatchResponseSchema = z
  .object({
    accepted: z.number().int().nonnegative(),
    rejected: z.array(z.object({ clientId: idSchema, reason: z.string().min(1) }).strict()),
  })
  .strict();

export const agentSourceValues = ["claude_code", "codex", "kimi_code", "cursor", "browser", "other"] as const;
export const agentSourceSchema = z.enum(agentSourceValues);

export const agentEventKindValues = ["started", "ended", "heartbeat"] as const;
export const agentEventKindSchema = z.enum(agentEventKindValues);

/**
 * One lifecycle event drained from an agent-hook or browser spool; keyed server-side by
 * (source, externalSessionId). Browser spans carry the matched `ruleId` instead of a `cwd`:
 * exactly one of the two must be present, `ruleId` iff the source is `browser`.
 */
export const agentSessionEventSchema = z
  .object({
    source: agentSourceSchema,
    externalSessionId: z.string().min(1).max(200),
    event: agentEventKindSchema,
    occurredAt: timestampSchema,
    cwd: z.string().min(1).max(1_000).optional(),
    ruleId: idSchema.optional(),
  })
  .strict()
  .superRefine((event, ctx) => {
    const expectsRule = event.source === "browser";
    if ((event.ruleId !== undefined) !== expectsRule || (event.cwd !== undefined) === expectsRule) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: expectsRule
          ? "Browser events carry a ruleId and no cwd."
          : "Agent events carry a cwd and no ruleId.",
      });
    }
  });

export const agentSessionEventBatchRequestSchema = z
  .object({
    events: z.array(agentSessionEventSchema).min(1).max(500),
  })
  .strict();

export const agentSessionEventBatchResponseSchema = z
  .object({
    results: z.array(z
      .object({
        externalSessionId: z.string().min(1).max(200),
        accepted: z.boolean(),
        reason: z.string().min(1).optional(),
      })
      .strict()),
  })
  .strict();

export const pathMappingKindValues = ["path_prefix", "url_rule"] as const;
export const pathMappingKindSchema = z.enum(pathMappingKindValues);

// Lowercase DNS labels, hyphens allowed, with an optional "*." wildcard prefix.
const urlRuleHostPattern = /^(?:\*\.)?[a-z0-9](?:[a-z0-9-]*[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]*[a-z0-9])?)*$/;

/**
 * A URL rule is a scheme-less, lowercase-host pattern over host + path whose only glob is
 * a single trailing `/*` (e.g. `github.com/acme/*`, `*.figma.com/files/*`, `quickbooks.com`).
 */
function isUrlRulePattern(pattern: string): boolean {
  if (pattern.includes("://") || /\s/.test(pattern)) return false;
  const body = pattern.endsWith("/*") ? pattern.slice(0, -2) : pattern;
  if (body.includes("?") || body.includes("#")) return false;
  const slashIndex = body.indexOf("/");
  const host = slashIndex === -1 ? body : body.slice(0, slashIndex);
  const path = slashIndex === -1 ? "" : body.slice(slashIndex + 1);
  return urlRuleHostPattern.test(host) && !path.includes("*");
}

/** URL-rule patterns share the pathPrefix column, so the rule only binds when kind says so. */
function validateMappingPattern(
  value: { kind?: "path_prefix" | "url_rule" | undefined; pathPrefix?: string | undefined },
  ctx: z.RefinementCtx,
): void {
  if (value.kind === "url_rule" && value.pathPrefix !== undefined && !isUrlRulePattern(value.pathPrefix)) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["pathPrefix"],
      message: "URL rules are scheme-less lowercase host patterns with a single trailing glob.",
    });
  }
}

export const projectPathMappingSchema = z
  .object({
    id: idSchema,
    kind: pathMappingKindSchema,
    pathPrefix: z.string().min(1).max(500),
    repoUrl: z.string().nullable().optional(),
    projectId: idSchema,
  })
  .strict()
  .superRefine(validateMappingPattern);

export const pathMappingCreateRequestSchema = z
  .object({
    kind: pathMappingKindSchema.default("path_prefix"),
    pathPrefix: z.string().min(1).max(500),
    repoUrl: z.string().nullable().optional(),
    projectId: idSchema,
  })
  .strict()
  .superRefine(validateMappingPattern);

export const pathMappingUpdateRequestSchema = z
  .object({
    kind: pathMappingKindSchema.optional(),
    pathPrefix: z.string().min(1).max(500).optional(),
    repoUrl: z.string().nullable().optional(),
    projectId: idSchema.optional(),
  })
  .strict()
  .superRefine(validateMappingPattern);

export const pathMappingListResponseSchema = z
  .object({ mappings: z.array(projectPathMappingSchema) })
  .strict();

export const meStatsFiltersSchema = z
  .object({
    from: dateSchema.optional(),
    to: dateSchema.optional(),
    fromAt: timestampSchema.optional(),
    toExclusiveAt: timestampSchema.optional(),
  })
  .strict()
  .superRefine(validateCalendarAndInstantBounds);

export const meStatsProjectSchema = z
  .object({
    project: z.object({ id: idSchema, name: z.string().min(1) }).strict(),
    durationSeconds: z.number().int().nonnegative().safe(),
    corroboratedSeconds: z.number().int().nonnegative().safe(),
    sessionCount: z.number().int().nonnegative().safe(),
  })
  .strict();

export const meStatsAppSchema = z
  .object({
    processName: z.string(),
    durationSeconds: z.number().int().nonnegative().safe(),
  })
  .strict();

/** Per-rule browser-span focus totals; `projectId` is null while the rule is unattributed. */
export const meStatsSiteSchema = z
  .object({
    mapping: z
      .object({
        id: idSchema,
        pattern: z.string().min(1).max(500),
        projectId: idSchema.nullable(),
      })
      .strict(),
    durationSeconds: z.number().int().nonnegative().safe(),
  })
  .strict();

export const meStatsResponseSchema = z
  .object({
    filters: meStatsFiltersSchema,
    totalDurationSeconds: z.number().int().nonnegative().safe(),
    corroboratedSeconds: z.number().int().nonnegative().safe(),
    projects: z.array(meStatsProjectSchema),
    /** Per-foreground-process totals, heaviest first; the producer sorts, the schema only validates. */
    apps: z.array(meStatsAppSchema),
    /** Per-URL-rule browser focus totals, heaviest first; the producer sorts, the schema only validates. */
    sites: z.array(meStatsSiteSchema),
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

export type ActivitySegmentBatchRequest = z.infer<typeof activitySegmentBatchRequestSchema>;
export type ActivitySegmentBatchResponse = z.infer<typeof activitySegmentBatchResponseSchema>;
export type ActivitySegmentKind = z.infer<typeof activitySegmentKindSchema>;
export type ActivitySegmentUpload = z.infer<typeof activitySegmentUploadSchema>;
export type AgentEventKind = z.infer<typeof agentEventKindSchema>;
export type AgentSessionEvent = z.infer<typeof agentSessionEventSchema>;
export type AgentSessionEventBatchRequest = z.infer<typeof agentSessionEventBatchRequestSchema>;
export type AgentSessionEventBatchResponse = z.infer<typeof agentSessionEventBatchResponseSchema>;
export type AgentSource = z.infer<typeof agentSourceSchema>;
export type ApiError = z.infer<typeof apiErrorSchema>;
export type ApiErrorCode = z.infer<typeof apiErrorCodeSchema>;
export type CurrentSessionResponse = z.infer<typeof currentSessionResponseSchema>;
export type JoinOrganizationRequest = z.infer<typeof joinOrganizationRequestSchema>;
export type LeaderboardEntry = z.infer<typeof leaderboardEntrySchema>;
export type LeaderboardFilters = z.infer<typeof leaderboardFiltersSchema>;
export type LeaderboardResponse = z.infer<typeof leaderboardResponseSchema>;
export type MeResponse = z.infer<typeof meResponseSchema>;
export type MeStatsApp = z.infer<typeof meStatsAppSchema>;
export type MeStatsFilters = z.infer<typeof meStatsFiltersSchema>;
export type MeStatsProject = z.infer<typeof meStatsProjectSchema>;
export type MeStatsResponse = z.infer<typeof meStatsResponseSchema>;
export type MeStatsSite = z.infer<typeof meStatsSiteSchema>;
export type Organization = z.infer<typeof organizationSchema>;
export type OrganizationResponse = z.infer<typeof organizationResponseSchema>;
export type PathMappingCreateRequest = z.infer<typeof pathMappingCreateRequestSchema>;
export type PathMappingKind = z.infer<typeof pathMappingKindSchema>;
export type PathMappingListResponse = z.infer<typeof pathMappingListResponseSchema>;
export type PathMappingUpdateRequest = z.infer<typeof pathMappingUpdateRequestSchema>;
export type ProjectCreateRequest = z.infer<typeof projectCreateRequestSchema>;
export type ProjectListItem = z.infer<typeof projectListItemSchema>;
export type ProjectListResponse = z.infer<typeof projectListResponseSchema>;
export type ProjectUpdateRequest = z.infer<typeof projectUpdateRequestSchema>;
export type ProjectPathMapping = z.infer<typeof projectPathMappingSchema>;
export type ProvisionAccountRequest = z.infer<typeof provisionAccountRequestSchema>;
export type ReportFilters = z.infer<typeof reportFiltersSchema>;
export type ReportRow = z.infer<typeof reportRowSchema>;
export type ReportResponse = z.infer<typeof reportResponseSchema>;
export type Session = z.infer<typeof sessionSchema>;
export type SessionStartRequest = z.infer<typeof sessionStartRequestSchema>;
export type SessionStartResponse = z.infer<typeof sessionStartResponseSchema>;
export type SessionStatus = z.infer<typeof sessionStatusSchema>;
export type SessionStopRequest = z.infer<typeof sessionStopRequestSchema>;
export type SessionStopResponse = z.infer<typeof sessionStopResponseSchema>;
