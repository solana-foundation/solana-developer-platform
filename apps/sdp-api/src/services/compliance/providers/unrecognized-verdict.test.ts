import { afterEach, describe, expect, it, vi } from "vitest";
import type { ComplianceProvider } from "../types";
import { ChainalysisComplianceProvider } from "./chainalysis";
import { EllipticComplianceProvider } from "./elliptic";
import { RangeComplianceProvider } from "./range";
import { TrmComplianceProvider } from "./trm";

/**
 * Regression for SOLA9-160 (APE-722): a syntactically valid `ok` screening
 * whose verdict (score + level) maps to no recognized risk vocabulary used to
 * normalize as `status: "ok"`, read as clean downstream, and auto-allowlisted
 * the screened address. An `ok` result must carry a recognized verdict;
 * anything else fails closed as `error`.
 */

const INPUT = {
  address: "8dHEsGLpCZHZbXnFVvqWq4kMfM2pVDuNrXvVJVhQWRGZ",
  network: "solana",
  intent: "transfer_destination" as const,
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

/** Each provider fed the successful response shape from SOLA9-160 / drift like it. */
const unrecognizedCases: Array<{
  name: string;
  provider: ComplianceProvider;
  body: unknown;
  recognizedBody: unknown;
}> = [
  {
    name: "elliptic",
    provider: new EllipticComplianceProvider({ apiToken: "token" }),
    body: { risk_score: null, risk_level: "unknown" },
    recognizedBody: { risk_score: 2.5 },
  },
  {
    name: "range",
    provider: new RangeComplianceProvider({ apiKey: "key" }),
    body: { riskScore: null, riskLevel: "unknown" },
    recognizedBody: { riskScore: 2.5 },
  },
  {
    name: "trm",
    provider: new TrmComplianceProvider({ apiKey: "key" }),
    body: [{ addressHighestRiskScoreLevelLabel: "unknown" }],
    recognizedBody: [{ addressHighestRiskScoreLevel: 2.5 }],
  },
  {
    name: "chainalysis",
    provider: new ChainalysisComplianceProvider({ apiKey: "key" }),
    body: { status: "COMPLETE", riskLevel: "unknown" },
    recognizedBody: { status: "COMPLETE", riskScore: 2.5 },
  },
];

describe("successful screening responses with an unrecognized verdict", () => {
  it.each(unrecognizedCases)(
    "$name fails closed instead of reporting ok",
    async ({ provider, body }) => {
      mockResponse(body);
      const result = await provider.screenAddress(INPUT);
      expect(result.status).toBe("error");
      expect(result.riskScore).toBeNull();
      expect(result.message).toContain("unrecognized");
    }
  );

  it.each(unrecognizedCases)(
    "$name still reports a recognized numeric verdict as ok",
    async ({ provider, recognizedBody }) => {
      // Compatibility: each provider's own recognized verdict shapes keep
      // flowing as `ok`, so the fail-closed rule only catches drift.
      mockResponse(recognizedBody);
      const result = await provider.screenAddress(INPUT);
      expect(result).toMatchObject({ status: "ok", riskScore: 2.5 });
    }
  );

  it("keeps the documented no-score completions as ok", async () => {
    // Elliptic: a null canonical score is "no risk rules triggered".
    mockResponse({ risk_score: null });
    const elliptic = await new EllipticComplianceProvider({ apiToken: "token" }).screenAddress(
      INPUT
    );
    expect(elliptic).toMatchObject({ status: "ok", riskScore: null });

    // Elliptic's not-in-blockchain 404 stays a passed check.
    mockResponse({ message: "NotInBlockchain" }, 404);
    const notInBlockchain = await new EllipticComplianceProvider({
      apiToken: "token",
    }).screenAddress(INPUT);
    expect(notInBlockchain.status).toBe("ok");

    // TRM: no score and no label is the documented no-attribution response.
    mockResponse([{ addressHighestRiskScoreLevel: null }]);
    const trm = await new TrmComplianceProvider({ apiKey: "key" }).screenAddress(INPUT);
    expect(trm).toMatchObject({ status: "ok", riskScore: null });
  });

  it("keeps recognized risk-level labels as ok", async () => {
    mockResponse({ riskScore: null, riskLevel: "severe" });
    const range = await new RangeComplianceProvider({ apiKey: "key" }).screenAddress(INPUT);
    expect(range).toMatchObject({ status: "ok", riskLevel: "severe" });
  });
});

describe("malformed successful TRM responses", () => {
  // Each of these carries no readable risk fields, which the adapter used to
  // normalize as TRM's no-attribution completion and pass screening
  // (SOLA9-160). A 200 whose body is not the documented array-of-results
  // shape is contract drift, not a passed check.
  const malformedCases: Array<{ name: string; body: unknown }> = [
    { name: "invalid JSON", body: "<html>gateway error</html>" },
    { name: "a non-array JSON body", body: { error: "contract drift" } },
    { name: "an empty array", body: [] },
    { name: "a null entry", body: [null] },
    { name: "a string entry", body: ["high"] },
  ];

  it.each(malformedCases)("$name fails closed instead of reporting ok", async ({ body }) => {
    mockResponse(body);
    const result = await new TrmComplianceProvider({ apiKey: "key" }).screenAddress(INPUT);
    expect(result.status).toBe("error");
    expect(result.riskScore).toBeNull();
    expect(result.message).toContain("malformed");
  });

  it("still reports the documented no-attribution shape as ok", async () => {
    // An entry that is a real result object without attribution data (plus
    // whatever unrelated fields TRM documents) stays the recognized pass.
    mockResponse([{ address: INPUT.address, chain: "solana" }]);
    const result = await new TrmComplianceProvider({ apiKey: "key" }).screenAddress(INPUT);
    expect(result).toMatchObject({ status: "ok", riskScore: null });
  });
});
