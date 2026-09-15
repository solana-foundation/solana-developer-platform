import { describe, expect, it } from "vitest";
import { resolveClientIp } from "./client-ip";

describe("resolveClientIp", () => {
  it("uses the verified client appended by the Google load balancer on Cloud Run", () => {
    const headers = new Headers({
      "x-forwarded-for": "198.51.100.99, 203.0.113.10, 192.0.2.20",
    });

    expect(resolveClientIp(headers, { K_SERVICE: "sdp-api" })).toBe("203.0.113.10");
  });

  it("ignores malformed caller-supplied forwarded entries", () => {
    const headers = new Headers({
      "x-forwarded-for": "not-an-ip, 203.0.113.10, 192.0.2.20",
    });

    expect(resolveClientIp(headers, { K_SERVICE: "sdp-api" })).toBe("203.0.113.10");
  });

  it("rejects an unverified single-hop value on Cloud Run", () => {
    const headers = new Headers({ "x-forwarded-for": "198.51.100.99" });

    expect(resolveClientIp(headers, { K_SERVICE: "sdp-api" })).toBeNull();
  });

  it("rejects caller-controlled forwarding headers outside Cloud Run by default", () => {
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
    expect(resolveClientIp(new Headers(), { K_SERVICE: "sdp-api" })).toBeNull();
    expect(
      resolveClientIp(new Headers({ "x-forwarded-for": "unknown" }), {
        K_SERVICE: "sdp-api",
      })
    ).toBeNull();
  });
});
