import { afterEach, describe, expect, it, vi } from "vitest";
import type { WorkflowExecutionRow } from "@/db/repositories";
import type { Env } from "@/types/env";
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
    created_at: "2026-01-01T00:00:00.000Z",
    updated_at: "2026-01-01T00:00:00.000Z",
  };
}

describe("runSendWebhook", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("fails permanently when the url param is missing", async () => {
    const outcome = await runSendWebhook(env, executionFixture(), { params: {} });
    expect(outcome).toMatchObject({ status: "failed", retryable: false, error: "MISSING_PARAM:url" });
  });

  it("fails permanently on a malformed url", async () => {
    const outcome = await runSendWebhook(env, executionFixture(), {
      params: { url: "not-a-url" },
    });
    expect(outcome).toMatchObject({
      status: "failed",
      retryable: false,
      error: "INVALID_PARAM:url",
    });
  });

  it("POSTs the trigger event and signs the body when a secret is set", async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response(null, { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);

    const outcome = await runSendWebhook(env, executionFixture(), {
      params: { url: "https://example.com/hook", secret: "shhh" },
    });

    expect(outcome.status).toBe("succeeded");
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe("https://example.com/hook");
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
});
