import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { WorkflowExecutionRow } from "@/db/repositories";
import type { Env } from "@/types/env";

// The credential store backing a rule's stored signing key. Faked so a read can be made
// to fail on demand — the point of the fail-open tests below.
const secretStore = vi.hoisted(() => ({
  storageBackend: "gcp_secret_manager" as const,
  write: vi.fn(),
  read: vi.fn(),
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
