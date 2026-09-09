/**
 * A `ProbeTransport` over whatever `fetch` the test has stubbed.
 *
 * The probes are handed a transport rather than owning one, so their tests need
 * something to hand them. This is the thinnest possible stand-in: it exercises
 * the probe's own parsing and outcome logic, and deliberately enforces none of
 * the egress policy — that belongs to the API's transport and is covered in
 * `apps/sdp-api/src/services/private-channels/egress.test.ts`.
 */
import type { ProbeTransport } from "./transport";

export const fetchProbeTransport: ProbeTransport = async (request) => {
  const response = await fetch(request.url, {
    method: request.method,
    headers: request.headers,
    body: request.body,
    redirect: "manual",
    signal: AbortSignal.timeout(request.timeoutMs),
  });
  return { status: response.status, ok: response.ok, text: await response.text() };
};
