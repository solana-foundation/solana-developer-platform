import "server-only";

import { z } from "zod";
import type { ApiErrorBody } from "../src/types";
import { SdpApiError } from "./sdp-client";

const NO_STORE_HEADERS = { "Cache-Control": "private, no-store" } as const;

export class ApiRequestError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string
  ) {
    super(message);
    this.name = "ApiRequestError";
  }
}

export function apiSuccessResponse<T>(data: T): Response {
  return Response.json({ data }, { headers: NO_STORE_HEADERS });
}

export function apiErrorResponse(error: unknown): Response {
  console.error(
    error instanceof SdpApiError
      ? `SDP ${error.status} ${error.code ?? ""}: ${error.message}`
      : error
  );

  const status = errorStatus(error);
  const body: ApiErrorBody = {
    error: {
      code:
        error instanceof ApiRequestError
          ? error.code
          : error instanceof SdpApiError
            ? (error.code ?? "SDP_REQUEST_FAILED")
            : status === 400
              ? "INVALID_REQUEST"
              : "DEMO_REQUEST_FAILED",
      message: errorMessage(error),
    },
  };

  const headers = new Headers(NO_STORE_HEADERS);
  if (error instanceof SdpApiError && error.status === 429) {
    // Let the browser back off for exactly as long as SDP asked.
    headers.set("Retry-After", String(error.retryAfterSeconds ?? 10));
  }
  return Response.json(body, { status, headers });
}

function errorStatus(error: unknown): number {
  if (error instanceof ApiRequestError) return error.status;
  if (error instanceof z.ZodError || error instanceof SyntaxError) return 400;
  if (error instanceof SdpApiError) {
    return error.status >= 400 && error.status <= 599 ? error.status : 502;
  }
  return 500;
}

function errorMessage(error: unknown): string {
  if (error instanceof z.ZodError) {
    return error.issues[0]?.message ?? "Invalid request";
  }
  if (error instanceof SyntaxError) return "Request body must be valid JSON";
  return error instanceof Error ? error.message : "Unexpected demo error";
}
