import { afterEach, describe, expect, it, vi } from "vitest";
import { ComplianceNotEnabledError, screenAddressCompliance } from "./compliance";

const INPUT = { address: "addr1" };

const SCREENING = {
  checkedAt: "2026-09-08T00:00:00.000Z",
  providers: [
    {
      provider: "elliptic",
      status: "ok",
      riskScore: 1.2,
      riskLevel: "low",
      evaluatedAt: "2026-09-08T00:00:00.000Z",
    },
  ],
};

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

describe("screenAddressCompliance", () => {
  it("returns the screening the API reported", async () => {
    mockResponse({ data: { screening: SCREENING } });
    await expect(screenAddressCompliance(INPUT)).resolves.toEqual(SCREENING);
  });

  it("throws on a body it cannot read rather than reporting an empty screening", async () => {
    // The dangerous case: a 200 whose payload never arrived used to surface as
    // "checked just now, nothing flagged".
    mockResponse("<html>gateway</html>", 200);
    await expect(screenAddressCompliance(INPUT)).rejects.toThrow();
  });

  it("throws when the screening is missing from an otherwise valid envelope", async () => {
    mockResponse({ data: {} });
    await expect(screenAddressCompliance(INPUT)).rejects.toThrow();
  });

  it("throws when a provider entry is malformed", async () => {
    mockResponse({
      data: { screening: { ...SCREENING, providers: [{ provider: "elliptic" }] } },
    });
    await expect(screenAddressCompliance(INPUT)).rejects.toThrow();
  });

  it("keeps the disabled-compliance signal distinct", async () => {
    mockResponse({ error: { message: "Compliance is not enabled" } }, 403);
    await expect(screenAddressCompliance(INPUT)).rejects.toBeInstanceOf(ComplianceNotEnabledError);
  });
});
