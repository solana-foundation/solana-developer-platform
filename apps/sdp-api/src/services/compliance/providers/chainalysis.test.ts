import { afterEach, describe, expect, it, vi } from "vitest";
import { ChainalysisComplianceProvider } from "./chainalysis";

const INPUT = { address: "addr1", network: "solana", intent: "unknown" as const };

function provider() {
  return new ChainalysisComplianceProvider({ apiKey: "key" });
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

describe("ChainalysisComplianceProvider", () => {
  it("reports a completed screening with a verdict as ok", async () => {
    mockResponse({ status: "COMPLETE", risk: "Low", riskScore: 2 });
    const result = await provider().screenAddress(INPUT);
    expect(result).toMatchObject({
      status: "ok",
      riskScore: 2,
      riskLevel: "Low",
      providerStatus: "COMPLETE",
    });
  });

  it("never reports a non-complete screening as ok", async () => {
    // The reported defect: IN_PROGRESS used to come back status "ok".
    mockResponse({ status: "IN_PROGRESS", riskScore: 5 });
    const result = await provider().screenAddress(INPUT);
    expect(result.status).toBe("pending");
    expect(result.providerStatus).toBe("IN_PROGRESS");
    expect(result.riskScore).toBeNull();
  });

  it("fails closed on a completed response with no verdict at all", async () => {
    mockResponse({ status: "COMPLETE" });
    const result = await provider().screenAddress(INPUT);
    expect(result.status).toBe("error");
  });

  it("fails closed on conflicting risk-score aliases instead of guessing", async () => {
    mockResponse({ status: "COMPLETE", riskScore: 2, risk_score: 9 });
    const result = await provider().screenAddress(INPUT);
    expect(result.status).toBe("error");
    expect(result.message).toContain("conflicting");
  });

  it("fails closed on a body that is not JSON", async () => {
    mockResponse("<html>gateway error</html>");
    const result = await provider().screenAddress(INPUT);
    expect(result.status).toBe("error");
  });

  it("reports an HTTP failure as error with the provider detail", async () => {
    mockResponse({ message: "forbidden" }, 403);
    const result = await provider().screenAddress(INPUT);
    expect(result.status).toBe("error");
    expect(result.message).toContain("403");
  });
});
