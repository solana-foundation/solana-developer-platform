import { type Mock, vi } from "vitest";
import { IDEMPOTENCY_KEY_HEADER, type JsonValue } from "@/lib/idempotency";
import { TAB_DEMO_HEADER_NAME } from "@/lib/payments-demo/demo-cookie";
import { PROJECT_HEADER_NAME } from "@/lib/project-cookie";

/** One request the browser sent to the dashboard backend, as a test asserts on it. */
export interface SentDashboardRequest {
  path: string;
  method: string;
  idempotencyKey: string | null;
  body: unknown;
}

function sentRequest([input, init]: Parameters<typeof fetch>): SentDashboardRequest {
  if (init === undefined) {
    throw new Error("dashboardFetch always sends a RequestInit");
  }
  return {
    path: String(input),
    method: String(init.method),
    idempotencyKey: new Headers(init.headers).get(IDEMPOTENCY_KEY_HEADER),
    body: typeof init.body === "string" ? JSON.parse(init.body) : init.body,
  };
}

/**
 * Stubs the global `fetch` the dashboard calls from the browser, answering each request with
 * `answer`. Undo with `vi.unstubAllGlobals()`.
 */
export function stubDashboardFetch(
  answer: (request: SentDashboardRequest) => Response | Promise<Response>
): Mock<typeof fetch> {
  const fetchMock = vi.fn<typeof fetch>(async (...args) => answer(sentRequest(args)));
  vi.stubGlobal("fetch", fetchMock);
  return fetchMock;
}

/** Every request a {@link stubDashboardFetch} stub has received, in order. */
export function sentDashboardRequests(fetchMock: Mock<typeof fetch>): SentDashboardRequest[] {
  return fetchMock.mock.calls.map(sentRequest);
}

/** One dashboard read the browser sent: its URL and the Project and demo headers it carried. */
export interface SentDashboardRead {
  path: string;
  projectId: string | null;
  demo: string | null;
}

/** Every read a {@link stubDashboardFetch} stub has received, in order. */
export function sentDashboardReads(fetchMock: Mock<typeof fetch>): SentDashboardRead[] {
  return fetchMock.mock.calls.map(([input, init]) => {
    if (init === undefined) {
      throw new Error("dashboardReadRequest always sends a RequestInit");
    }
    const headers = new Headers(init.headers);
    return {
      path: String(input),
      projectId: headers.get(PROJECT_HEADER_NAME),
      demo: headers.get(TAB_DEMO_HEADER_NAME),
    };
  });
}

/** sdp-api's success envelope, as `proxyToSdpApi` streams it back. */
export function dashboardDataResponse(status: number, data: JsonValue): Response {
  return Response.json({ data, meta: { requestId: "req_test" } }, { status });
}

/** The backend's error envelope, as `proxyToSdpApi` streams it back. */
export function dashboardErrorResponse(status: number, message: string): Response {
  return Response.json({ error: { message } }, { status });
}
