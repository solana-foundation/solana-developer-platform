import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { PRODUCTION_PROJECT } from "@/test/projects";
import { restoreWindowLocation, setWindowPathname } from "@/test/window-location";
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

function mockResponse(body: unknown, status: number) {
  const fetchMock = vi.fn(
    async (_input: RequestInfo | URL, _init: RequestInit) =>
      new Response(typeof body === "string" ? body : JSON.stringify(body), { status })
  );
  vi.stubGlobal("fetch", fetchMock);
  return fetchMock;
}

beforeEach(() => {
  setWindowPathname(`/dashboard/${PRODUCTION_PROJECT.id}/payments`);
});

afterEach(() => {
  restoreWindowLocation();
  vi.unstubAllGlobals();
});

describe("screenAddressCompliance", () => {
  it("returns the screening the API reported for the Project in the tab's URL", async () => {
    const fetchMock = mockResponse({ data: { screening: SCREENING } }, 200);

    await expect(screenAddressCompliance(INPUT)).resolves.toEqual(SCREENING);
    const [screeningPath, screeningInit] = fetchMock.mock.calls[0];
    expect(screeningPath).toBe("/api/dashboard/compliance/address-screenings");
    expect(new Headers(screeningInit.headers).get("x-project-id")).toBe(PRODUCTION_PROJECT.id);
  });

  it.each([
    ["an unreadable body", "<html>gateway</html>"],
    ["a missing screening", { data: {} }],
    [
      "a malformed provider",
      { data: { screening: { ...SCREENING, providers: [{ provider: "elliptic" }] } } },
    ],
  ])("throws on %s", async (_case, body) => {
    mockResponse(body, 200);
    await expect(screenAddressCompliance(INPUT)).rejects.toThrow();
  });

  it("keeps the disabled-compliance signal distinct", async () => {
    mockResponse({ error: { message: "Compliance is not enabled" } }, 403);
    await expect(screenAddressCompliance(INPUT)).rejects.toBeInstanceOf(ComplianceNotEnabledError);
  });
});
