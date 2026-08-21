import { apiErrorSchema, type ApiError, type ApiErrorCode } from "@siqshift/shared";
import type { Context } from "hono";
import type { ContentfulStatusCode } from "hono/utils/http-status";

const statusByCode: Record<ApiErrorCode, ContentfulStatusCode> = {
  validation_error: 400,
  invalid_credentials: 401,
  unauthorized: 401,
  forbidden: 403,
  not_found: 404,
  conflict: 409,
  session_already_running: 409,
  project_archived: 409,
  invalid_session_stop: 400,
  rate_limited: 429,
  internal_error: 500,
};

export class AppError extends Error {
  public readonly code: ApiErrorCode;
  public readonly status: ContentfulStatusCode;
  public readonly details: Record<string, unknown> | undefined;

  public constructor(code: ApiErrorCode, message: string, details?: Record<string, unknown>) {
    super(message);
    this.name = "AppError";
    this.code = code;
    this.status = statusByCode[code];
    this.details = details;
  }
}

export function errorBody(error: AppError): ApiError {
  const candidate = error.details === undefined
    ? { error: { code: error.code, message: error.message } }
    : { error: { code: error.code, message: error.message, details: error.details } };
  return apiErrorSchema.parse(candidate);
}

export function jsonError(context: Context, error: AppError, status: ContentfulStatusCode = error.status): Response {
  return context.json(errorBody(error), status);
}

export function handleAppError(error: Error, context: Context): Response {
  if (error instanceof AppError) {
    return jsonError(context, error);
  }
  // The response stays generic; the log keeps the real failure diagnosable.
  console.error("siqshift-api: unexpected error", error);
  return jsonError(context, new AppError("internal_error", "An unexpected error occurred."));
}
