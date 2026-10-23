import { NextResponse } from "next/server";
import { proxyToSdpApi } from "@/lib/sdp-api";

/**
 * The verdict every strict query reader answers with: the forwardable query
 * suffix, or the message for the 400 that replaces the read.
 */
export type ProxyQueryValidation = { ok: true; query: string } | { ok: false; message: string };

/**
 * The 400 every rejected proxy query renders, so the error envelope's shape is
 * spelled once, beside the verdict type that names the rejection.
 */
export function proxyQueryErrorResponse(
  validated: Extract<ProxyQueryValidation, { ok: false }>
): NextResponse {
  return NextResponse.json({ error: { message: validated.message } }, { status: 400 });
}

/**
 * The strict readers' shared GET: validate the query, answer a rejected one
 * with the shared 400, and otherwise hand the request — with the allowlisted
 * query appended — to the proxy. `path` receives the validated suffix (`""` or
 * `"?…"`) so each route keeps spelling its own upstream path.
 */
export async function proxyValidatedGet(
  request: Request,
  options: {
    validate: (request: Request) => ProxyQueryValidation;
    traceSource: string;
    path: (query: string) => string;
  }
): Promise<NextResponse> {
  const validated = options.validate(request);
  if (!validated.ok) return proxyQueryErrorResponse(validated);

  return proxyToSdpApi({
    request,
    traceSource: options.traceSource,
    path: options.path(validated.query),
  });
}
