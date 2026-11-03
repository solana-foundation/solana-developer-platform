import { NextResponse } from "next/server";
import { PROJECT_HEADER_NAME } from "@/lib/project-cookie";

/** The trace a dashboard route answers with: its id and the elapsed time so far. */
interface ResponseTrace {
  traceId: string;
  serverTiming(): string;
}

/**
 * The headers every dashboard API response carries, success or error.
 *
 * The project travels in the `x-project-id` request header, not the URL, so a
 * cache that keyed on the URL alone could hand one project's data to another.
 * `private, no-store` keeps browsers and intermediaries from storing it at all,
 * and `Vary` names the header for any cache that ignores that. Neither relies
 * on Next.js defaulting dynamic handlers to no-store.
 *
 * `headers` are the route's own (Content-Type, Retry-After, ...); the cache and
 * trace headers are set after them, so a route cannot weaken them by accident.
 */
export function dashboardResponseHeaders(trace?: ResponseTrace, headers?: HeadersInit): Headers {
  const result = new Headers(headers);
  result.set("Cache-Control", "private, no-store");
  result.set("Vary", PROJECT_HEADER_NAME);
  if (trace) {
    result.set("X-SDP-Trace-ID", trace.traceId);
    result.set("Server-Timing", trace.serverTiming());
  }
  return result;
}

/** A dashboard API JSON response with `dashboardResponseHeaders`. */
export function dashboardJson<T>(
  body: T,
  init: { status?: number; trace?: ResponseTrace; headers?: HeadersInit } = {}
): NextResponse<T> {
  return NextResponse.json(body, {
    status: init.status,
    headers: dashboardResponseHeaders(init.trace, init.headers),
  });
}
