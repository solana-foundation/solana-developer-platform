import { createHmac } from "node:crypto";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { WebhookEndpointRow, WorkflowExecutionRow } from "@/db/repositories";
import type { StoredCredentialSecret } from "@/services/credential-secret-store";
import type { Env } from "@/types/env";

// The one credential store both suites below run against — a module can only be mocked
// once, so this has to serve the legacy path and the registry path at the same time.
//
// `read` defaults to "decrypt" by parsing the handle's own payload, which is what the
// registry suite needs so endpoint-secret.ts (grace expiry, per-key readability) runs for
// real against its fixtures. The legacy suite overrides it per test to make a read fail or
// return a specific key on demand.
const secretStore = vi.hoisted(() => ({
  storageBackend: "gcp_secret_manager" as const,
  write: vi.fn(),
  read: vi.fn(
    async ({ stored }: { stored: { encryptedSecretPayload?: string } }) =>
      JSON.parse(stored.encryptedSecretPayload ?? "{}") as Record<string, unknown>
  ),
  destroyVersion: vi.fn(),
}));
vi.mock("@/services/credential-secret-store", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/services/credential-secret-store")>()),
  createCredentialSecretStore: () => secretStore,
}));

// DNS is stubbed so the SSRF guard's behavior is asserted rather than the test host's
// resolver: `example.com` answers public, `rebound.example.com` answers private.
vi.mock("node:dns/promises", () => ({
  lookup: async (hostname: string) =>
    hostname === "rebound.example.com"
      ? [{ address: "10.0.0.5", family: 4 }]
      : [{ address: "93.184.216.34", family: 4 }],
}));

const { getEndpointById, createDelivery } = vi.hoisted(() => ({
  getEndpointById: vi.fn(),
  createDelivery: vi.fn(),
}));

// The registry path resolves its endpoint + logs deliveries through the repo
// factories; everything else in the module stays real.
vi.mock("@/db/repositories", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/db/repositories")>();
  return {
    ...actual,
    createWebhookEndpointsRepository: () => ({ getEndpointById }),
    createWebhookDeliveriesRepository: () => ({ createDelivery }),
  };
});

import { runSendWebhook } from "./webhook";

const env = {} as Env;

function executionFixture(): WorkflowExecutionRow {
  return {
    id: "workflow_execution_test",
    organization_id: "org_test",
    project_id: "prj_test",
    workflow_id: "asset_workflow_test",
    token_id: "tok_test",
    trigger_type: "kyc_approved",
    action_type: "send_webhook",
    status: "processing",
    idempotency_key: "kyc_approved:test",
    trigger_payload: { wallet: "So11111111111111111111111111111111111111112" },
    result: {},
    attempt_count: 1,
    max_attempts: 5,
    next_attempt_at: null,
    locked_at: null,
    error: null,
    decided_by: null,
    decided_at: null,
    created_at: "2026-01-01T00:00:00.000Z",
    updated_at: "2026-01-01T00:00:00.000Z",
  };
}

describe("runSendWebhook", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("fails permanently when the url param is missing", async () => {
    const outcome = await runSendWebhook(env, executionFixture(), { params: {} });
    expect(outcome).toMatchObject({
      status: "failed",
      retryable: false,
      error: "MISSING_PARAM:url",
    });
  });

  it("fails permanently on a malformed url", async () => {
    const outcome = await runSendWebhook(env, executionFixture(), {
      params: { url: "not-a-url" },
    });
    expect(outcome).toMatchObject({
      status: "failed",
      retryable: false,
      error: "BLOCKED_URL:INVALID_URL",
    });
  });

  it.each([
    ["http://example.com/hook", "INSECURE_SCHEME"],
    ["https://127.0.0.1/hook", "PRIVATE_HOST"],
    ["https://169.254.169.254/computeMetadata/v1/", "PRIVATE_HOST"],
    ["https://10.1.2.3/hook", "PRIVATE_HOST"],
    ["https://metadata.google.internal/token", "PRIVATE_HOST"],
    ["https://localhost:8787/v1/tokens", "PRIVATE_HOST"],
  ])("refuses to fetch %s and never opens a connection", async (url, reason) => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);

    const outcome = await runSendWebhook(env, executionFixture(), { params: { url } });

    expect(outcome).toMatchObject({
      status: "failed",
      retryable: false,
      error: `BLOCKED_URL:${reason}`,
    });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("blocks a public hostname that resolves into private space", async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);

    const outcome = await runSendWebhook(env, executionFixture(), {
      params: { url: "https://rebound.example.com/hook" },
    });

    expect(outcome).toMatchObject({ status: "failed", error: "BLOCKED_URL:PRIVATE_HOST" });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("re-validates the target of a redirect instead of following it blindly", async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      new Response(null, {
        status: 302,
        headers: { location: "http://169.254.169.254/latest/meta-data/" },
      })
    );
    vi.stubGlobal("fetch", fetchMock);

    const outcome = await runSendWebhook(env, executionFixture(), {
      params: { url: "https://example.com/hook" },
    });

    // The first hop happened; the redirect target is rejected before a second fetch.
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(outcome).toMatchObject({ status: "failed", retryable: false });
    expect(String((outcome as { error: string }).error)).toContain("BLOCKED_URL");
  });

  it("POSTs the trigger event and signs the body when a secret is set", async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response(null, { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);

    const outcome = await runSendWebhook(env, executionFixture(), {
      params: { url: "https://example.com/hook", secret: "shhh" },
    });

    expect(outcome.status).toBe("succeeded");
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0] as [URL, RequestInit];
    expect(String(url)).toBe("https://example.com/hook");
    expect(init.method).toBe("POST");
    const headers = init.headers as Record<string, string>;
    expect(headers["content-type"]).toBe("application/json");
    expect(headers["x-sdp-signature-256"]).toMatch(/^sha256=[0-9a-f]{64}$/);
    const body = JSON.parse(String(init.body)) as Record<string, unknown>;
    expect(body).toMatchObject({
      type: "kyc_approved",
      tokenId: "tok_test",
      executionId: "workflow_execution_test",
    });
  });

  it("does not sign when no secret is set", async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response(null, { status: 204 }));
    vi.stubGlobal("fetch", fetchMock);

    const outcome = await runSendWebhook(env, executionFixture(), {
      params: { url: "https://example.com/hook" },
    });

    expect(outcome.status).toBe("succeeded");
    const [, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect((init.headers as Record<string, string>)["x-sdp-signature-256"]).toBeUndefined();
  });

  it.each([
    [500, true],
    [503, true],
    [429, true],
    [408, true],
  ])("treats HTTP %s as retryable", async (status, retryable) => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response(null, { status })));
    const outcome = await runSendWebhook(env, executionFixture(), {
      params: { url: "https://example.com/hook" },
    });
    expect(outcome).toMatchObject({ status: "failed", retryable, error: `HTTP_${status}` });
  });

  it.each([
    [400, false],
    [401, false],
    [404, false],
    [410, false],
  ])("treats HTTP %s as a permanent endpoint config error", async (status, retryable) => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response(null, { status })));
    const outcome = await runSendWebhook(env, executionFixture(), {
      params: { url: "https://example.com/hook" },
    });
    expect(outcome).toMatchObject({ status: "failed", retryable, error: `HTTP_${status}` });
  });

  it("treats a network error as retryable", async () => {
    vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new Error("socket hang up")));
    const outcome = await runSendWebhook(env, executionFixture(), {
      params: { url: "https://example.com/hook" },
    });
    expect(outcome).toMatchObject({ status: "failed", retryable: true, error: "socket hang up" });
  });

  // A rule carrying a signing key must never deliver without one. "Could not read the
  // key" and "there is no key" are different answers, and treating the first as the
  // second stripped the receiver's only way to authenticate the payload — while the
  // engine recorded the execution as succeeded, so nothing retried and nothing surfaced.
  describe("when the rule has a signing secret the store cannot return", () => {
    const storedRef = {
      storageBackend: "gcp_secret_manager",
      secretRef: "projects/p/secrets/sdp-workflow-action-1",
      secretVersionRef: "projects/p/secrets/sdp-workflow-action-1/versions/1",
    } as never;

    it("does not deliver, and asks the engine to retry", async () => {
      secretStore.read.mockRejectedValue(new Error("secret manager unavailable"));
      const fetchMock = vi.fn();
      vi.stubGlobal("fetch", fetchMock);

      const outcome = await runSendWebhook(env, executionFixture(), {
        params: { url: "https://example.com/hook" },
        actionSecret: storedRef,
      });

      expect(fetchMock).not.toHaveBeenCalled();
      expect(outcome).toMatchObject({
        status: "failed",
        retryable: true,
        error: "SECRET_UNREADABLE",
      });
    });

    // Same answer when the reference resolves to nothing usable: the key is configured,
    // so an empty read is a failed read, not an unsigned rule.
    it("does not deliver when the stored reference yields no value", async () => {
      secretStore.read.mockResolvedValue({});
      const fetchMock = vi.fn();
      vi.stubGlobal("fetch", fetchMock);

      const outcome = await runSendWebhook(env, executionFixture(), {
        params: { url: "https://example.com/hook" },
        actionSecret: storedRef,
      });

      expect(fetchMock).not.toHaveBeenCalled();
      expect(outcome).toMatchObject({ retryable: true, error: "SECRET_UNREADABLE" });
    });

    // The counterpart that must keep working: a readable key still signs, so the fix
    // did not turn every stored secret into a failure.
    it("signs with the stored key when the store returns it", async () => {
      secretStore.read.mockResolvedValue({ secret: "from-the-store" });
      const fetchMock = vi.fn().mockResolvedValue(new Response(null, { status: 200 }));
      vi.stubGlobal("fetch", fetchMock);

      const outcome = await runSendWebhook(env, executionFixture(), {
        params: { url: "https://example.com/hook" },
        actionSecret: storedRef,
      });

      expect(outcome).toMatchObject({ status: "succeeded" });
      const headers = fetchMock.mock.calls[0][1].headers as Record<string, string>;
      expect(headers["x-sdp-signature-256"]).toMatch(/^sha256=[0-9a-f]{64}$/);
    });
  });
});

const ENDPOINT_ID = "webhook_endpoint_5e60b7b0-9ff1-4f4c-a56b-6db5f9e0c001";

// A handle the mocked store "decrypts" back into `{secret}` by parsing the payload.
function storedSecret(secret: string): StoredCredentialSecret {
  return { storageBackend: "encrypted_db", encryptedSecretPayload: JSON.stringify({ secret }) };
}

function endpointFixture(overrides: Partial<WebhookEndpointRow> = {}): WebhookEndpointRow {
  return {
    id: ENDPOINT_ID,
    organization_id: "org_test",
    project_id: "prj_test",
    url: "https://example.com/hook",
    label: "Test endpoint",
    description: null,
    status: "active",
    secret_storage: storedSecret("whsec_current"),
    previous_secret_storage: null,
    previous_secret_expires_at: null,
    secret_version: 1,
    created_by: null,
    deleted_at: null,
    created_at: "2026-01-01T00:00:00.000Z",
    updated_at: "2026-01-01T00:00:00.000Z",
    ...overrides,
  };
}

// Independent HMAC so the tests catch a scheme change instead of mirroring one.
function hmacHex(secret: string, payload: string): string {
  return createHmac("sha256", secret).update(payload).digest("hex");
}

describe("runSendWebhook (registry endpoint)", () => {
  beforeEach(() => {
    // The legacy suite above stubs `read` per test on the shared store; reset restores the
    // payload-parsing default these fixtures rely on.
    secretStore.read.mockReset();
    getEndpointById.mockReset();
    createDelivery.mockReset();
    createDelivery.mockImplementation(async (input: Record<string, unknown>) => input);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  const run = () =>
    runSendWebhook(env, executionFixture(), { params: { endpointId: ENDPOINT_ID } });

  it("sends v2 headers, signs timestamp-dot-body, and records a succeeded delivery", async () => {
    getEndpointById.mockResolvedValue(endpointFixture());
    const fetchMock = vi.fn().mockResolvedValue(new Response("ok", { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);

    const outcome = await run();

    expect(outcome.status).toBe("succeeded");
    expect(outcome.result).toMatchObject({ status: 200, endpointId: ENDPOINT_ID });
    expect(String(outcome.result.deliveryId)).toMatch(/^webhook_delivery_/);

    const [, init] = fetchMock.mock.calls[0] as [URL, RequestInit];
    const headers = init.headers as Record<string, string>;
    expect(headers["x-sdp-signature-256"]).toBeUndefined();
    expect(headers["x-sdp-event"]).toBe("kyc_approved");
    expect(headers["x-sdp-delivery"]).toBe(outcome.result.deliveryId);
    const body = String(init.body);
    const expected = hmacHex("whsec_current", `${headers["x-sdp-timestamp"]}.${body}`);
    expect(headers["x-sdp-signature"]).toBe(`t=${headers["x-sdp-timestamp"]},v1=${expected}`);

    expect(createDelivery).toHaveBeenCalledTimes(1);
    expect(createDelivery.mock.calls[0][0]).toMatchObject({
      id: outcome.result.deliveryId,
      endpointId: ENDPOINT_ID,
      executionId: "workflow_execution_test",
      triggerType: "kyc_approved",
      attempt: 1,
      status: "succeeded",
      responseStatus: 200,
      responseBody: "ok",
      requestBody: body,
      requestBodyTruncated: false,
    });
  });

  it("signs with both keys while the rotation grace window is open, current first", async () => {
    getEndpointById.mockResolvedValue(
      endpointFixture({
        previous_secret_storage: storedSecret("whsec_old"),
        previous_secret_expires_at: new Date(Date.now() + 3_600_000).toISOString(),
      })
    );
    const fetchMock = vi.fn().mockResolvedValue(new Response(null, { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);

    await run();

    const [, init] = fetchMock.mock.calls[0] as [URL, RequestInit];
    const headers = init.headers as Record<string, string>;
    const signed = `${headers["x-sdp-timestamp"]}.${String(init.body)}`;
    expect(headers["x-sdp-signature"]).toBe(
      `t=${headers["x-sdp-timestamp"]},v1=${hmacHex("whsec_current", signed)},v1=${hmacHex("whsec_old", signed)}`
    );
  });

  it("drops the previous key once its grace expiry has passed", async () => {
    getEndpointById.mockResolvedValue(
      endpointFixture({
        previous_secret_storage: storedSecret("whsec_old"),
        previous_secret_expires_at: new Date(Date.now() - 1_000).toISOString(),
      })
    );
    const fetchMock = vi.fn().mockResolvedValue(new Response(null, { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);

    await run();

    const headers = (fetchMock.mock.calls[0] as [URL, RequestInit])[1].headers as Record<
      string,
      string
    >;
    expect(headers["x-sdp-signature"].match(/v1=/g)).toHaveLength(1);
  });

  it("fails permanently when the endpoint does not exist (and logs nothing)", async () => {
    getEndpointById.mockResolvedValue(null);
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);

    const outcome = await run();

    expect(outcome).toMatchObject({
      status: "failed",
      retryable: false,
      error: "ENDPOINT_NOT_FOUND",
    });
    expect(fetchMock).not.toHaveBeenCalled();
    expect(createDelivery).not.toHaveBeenCalled();
  });

  it.each([
    ["deleted", { deleted_at: "2026-01-02T00:00:00.000Z" }, "ENDPOINT_DELETED"],
    ["disabled", { status: "disabled" as const }, "ENDPOINT_DISABLED"],
  ])(
    "fails permanently on a %s endpoint and records the misfire",
    async (_label, overrides, error) => {
      getEndpointById.mockResolvedValue(endpointFixture(overrides));
      const fetchMock = vi.fn();
      vi.stubGlobal("fetch", fetchMock);

      const outcome = await run();

      expect(outcome).toMatchObject({ status: "failed", retryable: false, error });
      expect(fetchMock).not.toHaveBeenCalled();
      expect(createDelivery.mock.calls[0][0]).toMatchObject({ status: "failed", error });
    }
  );

  it("fails transiently (never unsigned) when the signing secret cannot be read", async () => {
    getEndpointById.mockResolvedValue(
      endpointFixture({ secret_storage: { storageBackend: "encrypted_db" } })
    );
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);

    const outcome = await run();

    expect(outcome).toMatchObject({
      status: "failed",
      retryable: true,
      error: "SECRET_UNAVAILABLE",
    });
    expect(fetchMock).not.toHaveBeenCalled();
    expect(createDelivery.mock.calls[0][0]).toMatchObject({
      status: "failed",
      error: "SECRET_UNAVAILABLE",
    });
  });

  // Mid-rotation both keys are live, so a receiver still on the old one verifies against
  // it. Sending only the current signature is indistinguishable from unsigned to that
  // receiver — and its rejection would be a permanent 4xx that never retries.
  it("fails transiently rather than dropping an unreadable previous key during grace", async () => {
    getEndpointById.mockResolvedValue(
      endpointFixture({
        previous_secret_storage: { storageBackend: "encrypted_db" },
        previous_secret_expires_at: new Date(Date.now() + 3_600_000).toISOString(),
      })
    );
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);

    const outcome = await run();

    expect(outcome).toMatchObject({
      status: "failed",
      retryable: true,
      error: "PREVIOUS_SECRET_UNAVAILABLE",
    });
    expect(fetchMock).not.toHaveBeenCalled();
    expect(createDelivery.mock.calls[0][0]).toMatchObject({
      status: "failed",
      error: "PREVIOUS_SECRET_UNAVAILABLE",
    });
  });

  // The same unreadable handle past its expiry is simply not a live key any more.
  it("still delivers when an unreadable previous key's grace has already expired", async () => {
    getEndpointById.mockResolvedValue(
      endpointFixture({
        previous_secret_storage: { storageBackend: "encrypted_db" },
        previous_secret_expires_at: new Date(Date.now() - 1_000).toISOString(),
      })
    );
    const fetchMock = vi.fn().mockResolvedValue(new Response(null, { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);

    const outcome = await run();

    expect(outcome).toMatchObject({ status: "succeeded" });
    const headers = (fetchMock.mock.calls[0] as [URL, RequestInit])[1].headers as Record<
      string,
      string
    >;
    expect(headers["x-sdp-signature"].match(/v1=/g)).toHaveLength(1);
  });

  it.each([
    [500, true],
    [404, false],
  ])(
    "records the delivery and maps HTTP %s retryability like the legacy path",
    async (status, retryable) => {
      getEndpointById.mockResolvedValue(endpointFixture());
      vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response("nope", { status })));

      const outcome = await run();

      expect(outcome).toMatchObject({ status: "failed", retryable, error: `HTTP_${status}` });
      expect(createDelivery.mock.calls[0][0]).toMatchObject({
        status: "failed",
        responseStatus: status,
        responseBody: "nope",
        error: `HTTP_${status}`,
      });
    }
  );

  it("records a blocked delivery when the endpoint URL is rejected by the SSRF guard", async () => {
    getEndpointById.mockResolvedValue(endpointFixture({ url: "https://rebound.example.com/hook" }));
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);

    const outcome = await run();

    expect(outcome).toMatchObject({
      status: "failed",
      retryable: false,
      error: "BLOCKED_URL:PRIVATE_HOST",
    });
    expect(fetchMock).not.toHaveBeenCalled();
    expect(createDelivery.mock.calls[0][0]).toMatchObject({ error: "BLOCKED_URL:PRIVATE_HOST" });
  });

  it("never flips the action outcome when the delivery log insert fails", async () => {
    getEndpointById.mockResolvedValue(endpointFixture());
    createDelivery.mockRejectedValue(new Error("db down"));
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response(null, { status: 200 })));

    const outcome = await run();

    expect(outcome.status).toBe("succeeded");
  });
});
