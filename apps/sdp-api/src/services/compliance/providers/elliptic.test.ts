import { afterEach, describe, expect, it, vi } from "vitest";
import { EllipticComplianceProvider } from "./elliptic";

const INPUT = { address: "addr1", network: "solana", intent: "unknown" as const };

function provider() {
  return new EllipticComplianceProvider({ apiToken: "token" });
}

function mockResponse(body: unknown, status = 200) {
  vi.stubGlobal(
    "fetch",
    vi
      .fn()
      .mockResolvedValue(
        new Response(typeof body === "string" ? body : JSON.stringify(body), { status })
      )
  );
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("EllipticComplianceProvider", () => {
  it("reads only the canonical top-level risk_score", async () => {
    // A nested per-rule risk_score must never become the wallet's verdict.
    mockResponse({
      risk_score: 3.5,
      risk_level: "medium",
      evaluation_detail: { source: [{ risk_score: 9.9 }] },
    });
    const result = await provider().screenAddress(INPUT);
    expect(result).toMatchObject({ status: "ok", riskScore: 3.5, riskLevel: "medium" });
  });

  it("treats a null canonical score as a completed no-risk verdict", async () => {
    mockResponse({ risk_score: null });
    const result = await provider().screenAddress(INPUT);
    expect(result).toMatchObject({ status: "ok", riskScore: null });
  });

  it("fails closed when the canonical field is absent, even if nested scores exist", async () => {
    mockResponse({ evaluation_detail: { source: [{ risk_score: 9.9 }] } });
    const result = await provider().screenAddress(INPUT);
    expect(result.status).toBe("error");
    expect(result.message).toContain("risk_score");
  });

  it("fails closed on an ambiguous non-numeric canonical value", async () => {
    mockResponse({ risk_score: "high" });
    const result = await provider().screenAddress(INPUT);
    expect(result.status).toBe("error");
  });

  it("fails closed on a body that is not a JSON object", async () => {
    mockResponse("<html>bad gateway</html>", 200);
    const result = await provider().screenAddress(INPUT);
    expect(result.status).toBe("error");
  });

  it("keeps the not-in-blockchain 404 as a passed check", async () => {
    mockResponse({ message: "NotInBlockchain" }, 404);
    const result = await provider().screenAddress(INPUT);
    expect(result.status).toBe("ok");
    expect(result.riskScore).toBeNull();
  });

  it("reports other HTTP failures as error", async () => {
    mockResponse({ message: "unauthorized" }, 401);
    const result = await provider().screenAddress(INPUT);
    expect(result.status).toBe("error");
    expect(result.message).toContain("401");
  });
});
