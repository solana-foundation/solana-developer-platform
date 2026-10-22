import { describe, expect, it } from "vitest";
import type { Env } from "@/types/env";
import { resolveClientIp } from "./client-ip";

describe("resolveClientIp", () => {
  it("uses the verified client appended by the Google load balancer in gclb mode", () => {
    const headers = new Headers({
      "x-forwarded-for": "198.51.100.99, 203.0.113.10, 192.0.2.20",
    });

    expect(resolveClientIp(headers, { TRUST_PROXY_HEADERS: "gclb" })).toBe("203.0.113.10");
  });

  it("ignores malformed caller-supplied forwarded entries", () => {
    const headers = new Headers({
      "x-forwarded-for": "not-an-ip, 203.0.113.10, 192.0.2.20",
    });

    expect(resolveClientIp(headers, { TRUST_PROXY_HEADERS: "gclb" })).toBe("203.0.113.10");
  });

  it("rejects an unverified single-hop value in gclb mode", () => {
    const headers = new Headers({ "x-forwarded-for": "198.51.100.99" });

    expect(resolveClientIp(headers, { TRUST_PROXY_HEADERS: "gclb" })).toBeNull();
  });

  it("does not infer proxy trust from K_SERVICE (APE-810)", () => {
    // Direct run.app traffic reaches Cloud Run with K_SERVICE set and a
    // caller-chosen prefix; only the explicit deployment assertion may trust
    // the chain.
    const headers = new Headers({
      "x-forwarded-for": "198.51.100.99, 203.0.113.10",
    });
    const cloudRunEnv: Partial<Env> = { K_SERVICE: "sdp-prod-api-public" };

    expect(resolveClientIp(headers, cloudRunEnv)).toBeNull();
  });

  it("rejects caller-controlled forwarding headers by default", () => {
    const headers = new Headers({
      "x-forwarded-for": "203.0.113.10, 192.0.2.20",
    });

    expect(resolveClientIp(headers, {})).toBeNull();
  });

  it("uses first-hop proxy behavior only after a self-hosted operator opts in", () => {
    const headers = new Headers({
      "x-forwarded-for": "203.0.113.10, 192.0.2.20",
    });

    expect(resolveClientIp(headers, { TRUST_PROXY_HEADERS: "true" })).toBe("203.0.113.10");
    expect(resolveClientIp(headers, { TRUST_PROXY_HEADERS: "false" })).toBeNull();
  });

  it("returns null when no valid forwarded address is available", () => {
    expect(resolveClientIp(new Headers(), { TRUST_PROXY_HEADERS: "gclb" })).toBeNull();
    expect(
      resolveClientIp(new Headers({ "x-forwarded-for": "unknown" }), {
        TRUST_PROXY_HEADERS: "gclb",
      })
    ).toBeNull();
  });
});
