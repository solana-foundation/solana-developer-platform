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

  it("keeps first-hop proxy behavior outside Cloud Run", () => {
    const headers = new Headers({
      "x-forwarded-for": "203.0.113.10, 192.0.2.20",
    });

    expect(resolveClientIp(headers, {})).toBe("203.0.113.10");
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
