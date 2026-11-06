/**
 * Standardized API Response Utilities
 */

import type { Context } from "hono";
import type { ContentfulStatusCode } from "hono/utils/http-status";
import type { Env } from "@/types/env";
import type { AppError, ErrorResponse } from "./errors";

interface SuccessResponse<T> {
  data: T;
  meta?: {
    requestId?: string;
    timestamp?: string;
  };
}

interface PaginatedResponse<T> {
  data: T[];
  meta: {
    total: number;
    page: number;
    pageSize: number;
    hasMore: boolean;
    requestId?: string;
  };
}

function jsonSafe<T>(value: T): T {
  return JSON.parse(
    JSON.stringify(value, (_key, val) => (typeof val === "bigint" ? val.toString() : val))
  ) as T;
}

/**
 * Send a successful JSON response
 */
export function success<T>(c: Context<{ Bindings: Env }>, data: T, status = 200) {
  const response: SuccessResponse<T> = {
    data,
    meta: {
      requestId: c.get("requestId"),
      timestamp: new Date().toISOString(),
    },
  };
  return c.json(jsonSafe(response), status as 200);
}

/**
 * Send a paginated JSON response
 */
export function paginated<T>(
  c: Context<{ Bindings: Env }>,
  data: T[],
  options: { total: number; page: number; pageSize: number }
) {
  const response: PaginatedResponse<T> = {
    data,
    meta: {
      total: options.total,
      page: options.page,
      pageSize: options.pageSize,
      hasMore: options.page * options.pageSize < options.total,
      requestId: c.get("requestId"),
    },
  };
  return c.json(jsonSafe(response), 200);
}

/** An error status Hono can send with a body; anything else is a 500. */
export function mapErrorStatusCode(statusCode: number): ContentfulStatusCode {
  switch (statusCode) {
    case 202:
    case 400:
    case 401:
    case 403:
    case 404:
    case 409:
    case 413:
    case 422:
    case 429:
    case 500:
    case 501:
    case 502:
    case 503:
    case 504:
      return statusCode;
    default:
      return 500;
  }
}

/**
 * The app's error envelope: the error, the request id and the trace header.
 * `error.code` is an `ErrorCode`, the list the OpenAPI error envelope
 * documents, so every error `app.onError` answers names a documented code.
 *
 * @param c - The request context.
 * @param status - The HTTP status to answer with.
 * @param error - The code, the caller-safe message and any details.
 */
export function errorResponse(
  c: Context<{ Bindings: Env }>,
  status: ContentfulStatusCode,
  error: ErrorResponse["error"]
): Response {
  c.header("X-SDP-Trace-ID", c.get("traceId"));
  return c.json({ error, meta: { requestId: c.get("requestId") } }, status);
}

/**
 * The envelope for an `AppError`. `app.onError` sends every thrown `AppError`
 * through it, and a handler that returns an error instead of throwing it (a
 * replayed failed row) uses it too, so both look the same.
 */
export function appErrorResponse(c: Context<{ Bindings: Env }>, err: AppError): Response {
  return errorResponse(c, mapErrorStatusCode(err.statusCode), err.toResponse().error);
}

/**
 * Send a 201 Created response with location header
 */
export function created<T>(c: Context<{ Bindings: Env }>, data: T, location?: string) {
  if (location) {
    c.header("Location", location);
  }
  return success(c, data, 201);
}

/**
 * Send a 204 No Content response
 */
export function noContent(c: Context<{ Bindings: Env }>) {
  return c.body(null, 204);
}
