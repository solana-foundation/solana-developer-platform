import { createHash } from "node:crypto";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { z } from "zod";
import { SANDBOX_PROJECT } from "@/test/projects";
import { resetRequestProject, setApiRequest, setPageRequest } from "@/test/request-project";

const clerk = vi.hoisted(() => ({ auth: vi.fn() }));

vi.mock("next/headers", () => import("@/test/next-headers"));
vi.mock("@clerk/nextjs/server", () => ({ auth: clerk.auth }));

import {
  createRequestScopedSdpApiClients,
  createSdpApiClient,
  proxyToSdpApi,
  requestProjectHref,
  requestProjectId,
  SdpApiResponseError,
  sdpApiAnswer,
} from "./sdp-api";

function requestUrl(input: RequestInfo | URL): string {
  if (typeof input === "string") return input;
  if (input instanceof URL) return input.toString();
  return input.url;
}

function apiFetchMock(respond: () => Response) {
  return vi.fn(async (_input: RequestInfo | URL, _init?: RequestInit) => respond());
}

function okFetchMock() {
  return apiFetchMock(
    () =>
      new Response(JSON.stringify({ data: { ok: true } }), {
        headers: { "Content-Type": "application/json" },
      })
  );
}

function headersOfCall(fetchMock: ReturnType<typeof apiFetchMock>, path: string): Headers {
  const calls = fetchMock.mock.calls.filter(([input]) => requestUrl(input).endsWith(path));
  expect(calls).toHaveLength(1);
  const [call] = calls;
  if (call === undefined) {
    throw new Error(`no upstream call to ${path}`);
  }
  return new Headers(call[1]?.headers);
}

function signedInAuth() {
  return {
    userId: "user_test",
    orgId: "org_test",
    getToken: vi.fn().mockResolvedValue("token_test"),
  };
}

const originalApiBaseUrl = process.env.SDP_API_BASE_URL;

beforeEach(() => {
  process.env.SDP_API_BASE_URL = "https://api.example.test";
  vi.spyOn(console, "info").mockImplementation(() => undefined);
  resetRequestProject();
  setPageRequest(`/dashboard/${SANDBOX_PROJECT.id}/api-keys`);
  clerk.auth.mockResolvedValue(signedInAuth());
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  clerk.auth.mockReset();

  if (originalApiBaseUrl === undefined) {
    delete process.env.SDP_API_BASE_URL;
  } else {
    process.env.SDP_API_BASE_URL = originalApiBaseUrl;
  }
});

describe("requestProjectId", () => {
  it("is the project of the page the request renders", async () => {
    await expect(requestProjectId()).resolves.toBe(SANDBOX_PROJECT.id);
  });

  it("is the project a browser call sent", async () => {
    setApiRequest("prj_test_production");

    await expect(requestProjectId()).resolves.toBe("prj_test_production");
  });

  it("fails loudly for a request outside any project", async () => {
    setPageRequest("/dashboard/payments");

    await expect(requestProjectId()).rejects.toThrow("x-project-id missing");
  });
});

describe("requestProjectHref", () => {
  it("scopes a dashboard path to the request's project", async () => {
    await expect(requestProjectHref("/dashboard/api-keys?created=1")).resolves.toBe(
      `/dashboard/${SANDBOX_PROJECT.id}/api-keys?created=1`
    );
  });
});

describe("createSdpApiClient", () => {
  it("sends the request's project with the request-bound token", async () => {
    const fetchMock = okFetchMock();
    vi.stubGlobal("fetch", fetchMock);

    const client = await createSdpApiClient();
    await client.fetch("/v1/api-keys");

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const headers = headersOfCall(fetchMock, "/v1/api-keys");
    expect(headers.get("Authorization")).toBe("Bearer token_test");
    expect(headers.get("x-project-id")).toBe(SANDBOX_PROJECT.id);
  });

  it("refuses to build a client for a request outside any project", async () => {
    setApiRequest(null);
    const fetchMock = okFetchMock();
    vi.stubGlobal("fetch", fetchMock);

    await expect(createSdpApiClient()).rejects.toThrow("x-project-id missing");
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

describe("createRequestScopedSdpApiClients", () => {
  it("mints one token for both clients and scopes only the project client", async () => {
    const auth = signedInAuth();
    clerk.auth.mockResolvedValue(auth);
    const fetchMock = okFetchMock();
    vi.stubGlobal("fetch", fetchMock);

    const { organizationClient, projectClient } = await createRequestScopedSdpApiClients({});
    await organizationClient.fetch("/v1/onboarding/status");
    await projectClient.fetch("/v1/wallets");

    expect(auth.getToken).toHaveBeenCalledTimes(1);
    expect(fetchMock).toHaveBeenCalledTimes(2);
    const organizationHeaders = headersOfCall(fetchMock, "/v1/onboarding/status");
    const projectHeaders = headersOfCall(fetchMock, "/v1/wallets");
    expect(organizationHeaders.get("Authorization")).toBe("Bearer token_test");
    expect(organizationHeaders.has("x-project-id")).toBe(false);
    expect(projectHeaders.get("Authorization")).toBe("Bearer token_test");
    expect(projectHeaders.get("x-project-id")).toBe(SANDBOX_PROJECT.id);
  });

  it("logs an API request without caller-supplied path segments or query", async () => {
    const fetchMock = apiFetchMock(
      () => new Response("ok", { headers: { "X-Request-ID": "req_upstream" } })
    );
    vi.stubGlobal("fetch", fetchMock);
    const infoMock = vi.mocked(console.info);

    const { projectClient } = await createRequestScopedSdpApiClients({});
    await projectClient.request(
      "/v1/payments/transfers/sk_pasted_segment?secret=sk_pasted_credential",
      {
        method: "POST",
      }
    );

    expect(fetchMock.mock.calls.map(([input]) => requestUrl(input))).toEqual([
      "https://api.example.test/v1/payments/transfers/sk_pasted_segment?secret=sk_pasted_credential",
    ]);
    const transferEvents = infoMock.mock.calls
      .map(([payload]) => payload)
      .filter((payload): payload is string => typeof payload === "string")
      .map(
        (
          payload
        ): {
          event: string;
          path?: string;
          traceId: string;
          requestId: string;
          upstreamRequestId: string;
        } => JSON.parse(payload)
      )
      .filter((event) => event.event === "sdp_web_api_request");
    expect(transferEvents).toHaveLength(1);
    expect(transferEvents[0]).not.toHaveProperty("path");
    expect(transferEvents[0]?.traceId).toMatch(/^web_[0-9a-f]{32}$/);
    expect(transferEvents[0]?.requestId).toBe(`${transferEvents[0]?.traceId}:01`);
    expect(transferEvents[0]?.upstreamRequestId).toBe("req_upstream");
    expect(infoMock.mock.calls.map(([payload]) => String(payload)).join("\n")).not.toContain(
      "sk_pasted_credential"
    );
    expect(infoMock.mock.calls.map(([payload]) => String(payload)).join("\n")).not.toContain(
      "sk_pasted_segment"
    );
  });

  it("logs a safe join key before a missing upstream response", async () => {
    const fetchMock = vi.fn(async () => {
      throw new TypeError("response lost");
    });
    vi.stubGlobal("fetch", fetchMock);
    const webTraceId = `web_${"c".repeat(32)}`;
    const infoMock = vi.mocked(console.info);
    const client = await createSdpApiClient({
      traceId: webTraceId,
      source: "route.dashboard.test",
    });

    await expect(client.request("/v1/wallets/private-wallet-id?secret=sk_test")).rejects.toThrow(
      "response lost"
    );

    const events = infoMock.mock.calls
      .map(([payload]) => z.record(z.string(), z.unknown()).parse(JSON.parse(String(payload))))
      .filter(
        (event) => event.event === "sdp_web_api_attempt" || event.event === "sdp_web_api_request"
      );
    const expectedHash = createHash("sha256").update(webTraceId).digest("hex");
    expect(events).toHaveLength(2);
    expect(events[0]).toMatchObject({
      event: "sdp_web_api_attempt",
      web_trace_hash: expectedHash,
      traceId: webTraceId,
    });
    expect(events[1]).toMatchObject({
      event: "sdp_web_api_request",
      web_trace_hash: expectedHash,
      outcome: "network_failed",
    });
    expect(JSON.stringify(events)).not.toContain("private-wallet-id");
    expect(JSON.stringify(events)).not.toContain("sk_test");
  });

  it("refuses to build clients when the request has no active organization", async () => {
    clerk.auth.mockResolvedValue({ userId: "user_test", orgId: null, getToken: vi.fn() });

    await expect(createRequestScopedSdpApiClients({})).rejects.toThrow(
      "Active Clerk organization required"
    );
  });

  it("preserves upstream status on API response errors", async () => {
    vi.stubGlobal(
      "fetch",
      apiFetchMock(() => new Response("temporarily unavailable", { status: 503 }))
    );

    const { organizationClient } = await createRequestScopedSdpApiClients({});

    const request = organizationClient.fetch("/v1/projects");
    await expect(request).rejects.toBeInstanceOf(SdpApiResponseError);
    await expect(request).rejects.toMatchObject({ status: 503 });
  });
});

describe("server-side Idempotency-Key (HOO-1918)", () => {
  // The server never mints a key: a server-side key would be new on every
  // retry, so it could not make a retry safe. Callers pass the browser's.
  it("sends only the key the caller passes, and mints none", async () => {
    setApiRequest(SANDBOX_PROJECT.id);
    const fetchMock = okFetchMock();
    vi.stubGlobal("fetch", fetchMock);
    const client = await createSdpApiClient();

    await client.request("/v1/wallets", { method: "POST", body: "{}" });
    await client.request("/v1/wallets/wal_1", {
      method: "PATCH",
      body: "{}",
      headers: { "Idempotency-Key": "browser-key" },
    });

    const keys = fetchMock.mock.calls.map(([, init]) =>
      new Headers(init?.headers).get("Idempotency-Key")
    );
    expect(keys).toEqual([null, "browser-key"]);
  });

  // A server action hides the upstream headers from the browser, so the error
  // carries the replay mark for the action to report.
  it("marks a replayed failure so the action can retire the browser's key", async () => {
    setApiRequest(SANDBOX_PROJECT.id);
    vi.stubGlobal(
      "fetch",
      apiFetchMock(
        () => new Response("{}", { status: 422, headers: { "Idempotent-Replayed": "true" } })
      )
    );
    const client = await createSdpApiClient();

    const failure = await client
      .fetch("/v1/wallets", { method: "POST", body: "{}" })
      .catch((cause: unknown) => cause);

    expect(failure).toMatchObject({ status: 422, replayed: true });
    expect(sdpApiAnswer(failure)).toEqual({ status: 422, replayed: true, code: null });
    expect(sdpApiAnswer(new SdpApiResponseError(400, "{}"))).toEqual({
      status: 400,
      replayed: false,
      code: null,
    });
  });

  it("reports sdp-api's error code, also once the error crossed a server-action boundary", () => {
    const body = JSON.stringify({
      error: { code: "IDEMPOTENCY_KEY_OUTCOME_UNKNOWN", message: "Check with GET" },
    });
    const failure = new SdpApiResponseError(409, body);
    const crossed = new Error(failure.message);

    expect(sdpApiAnswer(failure)).toEqual({
      status: 409,
      replayed: false,
      code: "IDEMPOTENCY_KEY_OUTCOME_UNKNOWN",
    });
    expect(sdpApiAnswer(crossed)).toEqual({
      status: 409,
      replayed: false,
      code: "IDEMPOTENCY_KEY_OUTCOME_UNKNOWN",
    });
  });
});

describe("proxyToSdpApi", () => {
  function browserCall(projectId: string) {
    setApiRequest(projectId);
    return new Request("https://dashboard.example.test/api/deposit", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-Inbound-Only": "must-not-leak",
        "x-project-id": projectId,
      },
      body: JSON.stringify({ amount: "1" }),
    });
  }

  it("relays the tab's project upstream with only the selected endpoint headers", async () => {
    const fetchMock = apiFetchMock(() => new Response(null, { status: 204 }));
    vi.stubGlobal("fetch", fetchMock);

    const response = await proxyToSdpApi({
      request: browserCall(SANDBOX_PROJECT.id),
      traceSource: "test.proxy.headers",
      path: "/v1/earn/vault-deposits",
      upstreamHeaders: { "Idempotency-Key": "deposit-key" },
    });

    expect(response.status).toBe(204);
    expect(response.headers.get("Cache-Control")).toBe("private, no-store");
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const headers = headersOfCall(fetchMock, "/v1/earn/vault-deposits");
    expect(headers.get("x-project-id")).toBe(SANDBOX_PROJECT.id);
    expect(headers.get("Idempotency-Key")).toBe("deposit-key");
    expect(headers.get("Authorization")).toBe("Bearer token_test");
    expect(headers.has("X-Inbound-Only")).toBe(false);
    expect(fetchMock.mock.calls[0]?.[1]?.body).toBe(JSON.stringify({ amount: "1" }));
  });

  // HOO-1918: every mutation forwards the caller's key, and the replay markers
  // come back, without any route opting in.
  it("forwards the caller's Idempotency-Key on a mutation and returns the replay headers", async () => {
    const fetchMock = apiFetchMock(
      () =>
        new Response("{}", {
          status: 201,
          headers: { "Idempotent-Replayed": "true", "Content-Type": "application/json" },
        })
    );
    vi.stubGlobal("fetch", fetchMock);
    const request = browserCall(SANDBOX_PROJECT.id);
    request.headers.set("Idempotency-Key", "recurring-key");

    const response = await proxyToSdpApi({
      request,
      traceSource: "test.proxy.idempotency",
      path: "/v1/payments/recurring-payments",
    });

    expect(response.headers.get("Idempotent-Replayed")).toBe("true");
    const headers = headersOfCall(fetchMock, "/v1/payments/recurring-payments");
    expect(headers.get("Idempotency-Key")).toBe("recurring-key");
    expect(headers.has("X-Inbound-Only")).toBe(false);
  });

  it("keeps a route-selected Idempotency-Key over the inbound one", async () => {
    const fetchMock = apiFetchMock(() => new Response(null, { status: 204 }));
    vi.stubGlobal("fetch", fetchMock);
    const request = browserCall(SANDBOX_PROJECT.id);
    request.headers.set("Idempotency-Key", "inbound-key");

    await proxyToSdpApi({
      request,
      traceSource: "test.proxy.idempotency-route",
      path: "/v1/earn/vault-deposits",
      upstreamHeaders: { "Idempotency-Key": "route-key" },
    });

    expect(headersOfCall(fetchMock, "/v1/earn/vault-deposits").get("Idempotency-Key")).toBe(
      "route-key"
    );
  });

  it("refuses a call without the project header before any upstream call", async () => {
    setApiRequest(null);
    const fetchMock = okFetchMock();
    vi.stubGlobal("fetch", fetchMock);

    const response = await proxyToSdpApi({
      request: new Request("https://dashboard.example.test/api/deposit", {
        method: "POST",
        body: "{}",
      }),
      traceSource: "test.proxy.missing-project",
      path: "/v1/earn/vault-deposits",
    });

    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({
      error: { message: "x-project-id header required" },
    });
    expect(response.headers.get("Cache-Control")).toBe("private, no-store");
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("marks an unauthenticated refusal uncacheable", async () => {
    clerk.auth.mockResolvedValue({ userId: null, orgId: null, getToken: vi.fn() });
    const fetchMock = okFetchMock();
    vi.stubGlobal("fetch", fetchMock);

    const response = await proxyToSdpApi({
      request: browserCall(SANDBOX_PROJECT.id),
      traceSource: "test.proxy.cache",
      path: "/v1/earn/vault-deposits",
    });

    expect(response.status).toBe(401);
    expect(response.headers.get("Cache-Control")).toBe("private, no-store");
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
