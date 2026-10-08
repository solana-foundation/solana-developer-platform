import { NextResponse } from "next/server";
import { z } from "zod";
import { createTimedTrace, logRouteResult } from "@/lib/request-tracing";
import { createSdpApiClient, getSdpAuth } from "@/lib/sdp-api";

/**
 * Resolves pasted key material to the key it is, so the playground can drop its
 * key picker and still know which key a secret belongs to. The dashboard cannot
 * do this itself: the visible prefix is three characters of entropy and
 * collides, while the API matches on a peppered hash of the whole key.
 *
 * The same shape as the execute proxy: session required, key material stays in
 * the request body, and nothing about the key is echoed back except the row the
 * API matched.
 */
const resolveApiKeySchema = z.object({
  apiKey: z
    .string({ error: "API key is required" })
    .trim()
    .min(1, { error: "API key is required" })
    .max(256, { error: "API key is too long" }),
});

const MAX_REQUEST_BYTES = 4 * 1024;

function failureResponse(
  trace: ReturnType<typeof createTimedTrace>,
  status: number,
  error: string
): NextResponse {
  logRouteResult(trace, status, { error });
  return NextResponse.json(
    { error },
    {
      status,
      headers: {
        "X-SDP-Trace-ID": trace.traceId,
        "Server-Timing": trace.serverTiming(),
      },
    }
  );
}

export async function POST(request: Request) {
  const trace = createTimedTrace("route.playground.api-key", request);

  try {
    const { userId, orgId } = await getSdpAuth();
    if (!userId) {
      return failureResponse(trace, 401, "Authentication required");
    }
    if (!orgId) {
      return failureResponse(trace, 403, "Active organization required");
    }

    const rawBody = await request.text();
    if (rawBody.length > MAX_REQUEST_BYTES) {
      return failureResponse(trace, 413, "Request body too large");
    }

    let json: unknown;
    try {
      json = JSON.parse(rawBody);
    } catch {
      return failureResponse(trace, 400, "Invalid JSON body");
    }

    const parsed = resolveApiKeySchema.safeParse(json);
    if (!parsed.success) {
      return failureResponse(trace, 400, parsed.error.issues[0].message);
    }
    const { apiKey } = parsed.data;

    const client = await createSdpApiClient(trace.childContext("route.playground.api-key.api"));
    const response = await client.request("/internal/playground/api-key/verify", {
      method: "POST",
      body: JSON.stringify({ apiKey }),
    });

    if (!response.ok) {
      // Deliberately one message for every rejection. A key that belongs to
      // another project, an expired key and a key that does not exist must not
      // be distinguishable here, or this route reports on keys the caller does
      // not hold.
      return failureResponse(trace, 403, "API key is not available for the selected project");
    }

    const envelope = (await response.json()) as {
      data?: { id?: unknown; name?: unknown; keyPrefix?: unknown };
    };
    const identity = z
      .object({ id: z.string(), name: z.string(), keyPrefix: z.string() })
      .safeParse(envelope.data);

    if (!identity.success) {
      return failureResponse(trace, 502, "Could not identify the API key");
    }

    logRouteResult(trace, 200, { ok: true });
    return NextResponse.json(identity.data, {
      headers: {
        "X-SDP-Trace-ID": trace.traceId,
        "Server-Timing": trace.serverTiming(),
      },
    });
  } catch {
    return failureResponse(trace, 500, "Could not identify the API key");
  }
}
