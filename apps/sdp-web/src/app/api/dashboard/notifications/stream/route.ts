import { auth } from "@clerk/nextjs/server";
import { createTimedTrace } from "@/lib/request-tracing";
import { createOrgSdpApiClient, proxyFailure } from "@/lib/sdp-api";

// SSE pass-through for the notification stream. Deliberately NOT proxyNotifications:
// that helper buffers via response.json(), and an event stream must flow through
// unbuffered — the upstream body is handed to the Response as-is.
export const dynamic = "force-dynamic";

export async function GET(request: Request) {
  const trace = createTimedTrace("route.notifications.stream", request);

  const { userId, orgId } = await auth();
  if (!userId) {
    return proxyFailure(trace, 401, "Authentication required");
  }
  if (!orgId) {
    return proxyFailure(trace, 403, "Active organization required");
  }

  try {
    const apiClient = await createOrgSdpApiClient(trace.childContext("api"));
    const upstream = await apiClient.request("/v1/notifications/stream", {
      method: "GET",
      headers: { accept: "text/event-stream" },
      // Browser disconnect (tab close, EventSource.close) cancels the API connection.
      signal: request.signal,
    });
    if (!upstream.ok || !upstream.body) {
      // Release the pooled connection: an unread body keeps the undici socket checked
      // out until GC, and a client in a 401/429 retry loop would strand one per attempt.
      void upstream.body?.cancel().catch(() => undefined);
      const status =
        upstream.status === 401 || upstream.status === 403 || upstream.status === 429
          ? upstream.status
          : 502;
      return proxyFailure(trace, status, "Notification stream unavailable");
    }
    // No Connection header: it's hop-by-hop (Node's http2 rejects it outright under
    // h2c); no-transform + X-Accel-Buffering do the actual anti-buffering work.
    return new Response(upstream.body, {
      status: 200,
      headers: {
        "Content-Type": "text/event-stream; charset=utf-8",
        // `no-transform` stops Next standalone's compression middleware from buffering
        // the stream (it honors the directive); X-Accel-Buffering covers nginx-style
        // proxies in front of the deployment.
        "Cache-Control": "no-cache, no-transform",
        "X-Accel-Buffering": "no",
        "X-SDP-Trace-ID": trace.traceId,
      },
    });
  } catch (error) {
    return proxyFailure(
      trace,
      500,
      error instanceof Error ? error.message : "SDP API proxy request failed"
    );
  }
}
