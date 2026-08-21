import { createHmac } from "node:crypto";
import { afterEach, describe, expect, it, vi } from "vitest";

// DNS is stubbed so the SSRF guard's behavior is asserted rather than the test host's
// resolver (same fixture as actions/webhook.test.ts).
vi.mock("node:dns/promises", () => ({
  lookup: async (hostname: string) =>
    hostname === "rebound.example.com"
      ? [{ address: "10.0.0.5", family: 4 }]
      : [{ address: "93.184.216.34", family: 4 }],
}));

import { RESPONSE_BODY_MAX_CHARS, sendWebhook, signLegacy, signV2 } from "./webhook-delivery";

// Independent HMAC so the tests catch a scheme change instead of mirroring one.
function hmacHex(secret: string, payload: string): string {
  return createHmac("sha256", secret).update(payload).digest("hex");
}

describe("signLegacy", () => {
  it("is a plain HMAC-SHA256 hex over the body (the pinned MVP scheme)", async () => {
    const body = JSON.stringify({ type: "kyc_approved", executionId: "x" });
    expect(await signLegacy("shhh", body)).toBe(hmacHex("shhh", body));
  });
});

describe("signV2", () => {
  it("signs timestamp-dot-body and formats as t=<ts>,v1=<hex>", async () => {
    const body = JSON.stringify({ type: "kyc_approved" });
    const header = await signV2(["whsec_current"], 1_700_000_000, body);
    expect(header).toBe(`t=1700000000,v1=${hmacHex("whsec_current", `1700000000.${body}`)}`);
  });

  it("carries one v1 entry per live key, current first, during rotation grace", async () => {
    const body = "{}";
    const header = await signV2(["whsec_new", "whsec_old"], 42, body);
    expect(header).toBe(
      `t=42,v1=${hmacHex("whsec_new", `42.${body}`)},v1=${hmacHex("whsec_old", `42.${body}`)}`
    );
  });
});

describe("sendWebhook", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("returns the status, duration and response body on a non-redirect response", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response("ok!", { status: 200 })));
    const outcome = await sendWebhook({ url: "https://example.com/hook", body: "{}", headers: {} });
    expect(outcome).toMatchObject({ ok: true, status: 200, responseBody: "ok!" });
  });

  it("truncates the captured response body", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(new Response("x".repeat(RESPONSE_BODY_MAX_CHARS + 100)))
    );
    const outcome = await sendWebhook({ url: "https://example.com/hook", body: "{}", headers: {} });
    if (!outcome.ok) {
      throw new Error("expected ok outcome");
    }
    expect(outcome.responseBody).toHaveLength(RESPONSE_BODY_MAX_CHARS);
  });

  it("blocks a private target without opening a connection", async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    const outcome = await sendWebhook({ url: "https://10.1.2.3/hook", body: "{}", headers: {} });
    expect(outcome).toMatchObject({
      ok: false,
      kind: "blocked",
      reason: "BLOCKED_URL:PRIVATE_HOST",
    });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("blocks a hostname that resolves into private space", async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    const outcome = await sendWebhook({
      url: "https://rebound.example.com/hook",
      body: "{}",
      headers: {},
    });
    expect(outcome).toMatchObject({
      ok: false,
      kind: "blocked",
      reason: "BLOCKED_URL:PRIVATE_HOST",
    });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("re-validates a redirect target instead of following it blindly", async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      new Response(null, {
        status: 302,
        headers: { location: "http://169.254.169.254/latest/meta-data/" },
      })
    );
    vi.stubGlobal("fetch", fetchMock);
    const outcome = await sendWebhook({ url: "https://example.com/hook", body: "{}", headers: {} });
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(outcome).toMatchObject({ ok: false, kind: "blocked" });
  });

  it("maps a thrown fetch to a network outcome", async () => {
    vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new Error("socket hang up")));
    const outcome = await sendWebhook({ url: "https://example.com/hook", body: "{}", headers: {} });
    expect(outcome).toMatchObject({ ok: false, kind: "network", error: "socket hang up" });
  });
});
