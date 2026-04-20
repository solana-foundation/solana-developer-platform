/**
 * Standardized API Response Utilities
 */

import type { Context } from "hono";
import type { Env } from "@/types/env";
import { AppError, type ErrorResponse } from "./errors";

export interface SuccessResponse<T> {
  data: T;
  meta?: {
    requestId?: string;
    timestamp?: string;
  };
}

export interface PaginatedResponse<T> {
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

/**
 * Send an error response
 */
export function error(c: Context<{ Bindings: Env }>, err: AppError | Error) {
  if (err instanceof AppError) {
    const response: ErrorResponse = err.toResponse();
    return c.json(response, err.statusCode as 400);
  }

  // Unexpected errors
  console.error("Unexpected error:", err);
  const response: ErrorResponse = {
    error: {
      code: "INTERNAL_ERROR",
      message: "An internal error occurred",
    },
  };
  return c.json(response, 500);
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
 * Send a 202 Accepted response (for async operations)
 */
export function accepted<T>(c: Context<{ Bindings: Env }>, data: T) {
  return success(c, data, 202);
}

/**
 * Send a 204 No Content response
 */
export function noContent(c: Context<{ Bindings: Env }>) {
  return c.body(null, 204);
}
