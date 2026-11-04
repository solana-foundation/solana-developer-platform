import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { nextNavigationMock, resetDashboardNavigation } from "@/test/dashboard-navigation";
import PayPage from "./page";
import { payTokenSchema } from "./pay-token";

vi.mock("next/navigation", () => import("@/test/next-navigation"));
vi.mock("next/headers", () => import("@/test/next-headers"));

const fetchMock = vi.fn<typeof fetch>();

function renderPage(token: string) {
  return PayPage({ params: Promise.resolve({ token }) });
}

beforeEach(() => {
  vi.stubEnv("SDP_API_BASE_URL", "http://sdp-api.test");
  vi.stubGlobal("fetch", fetchMock);
});

afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
  fetchMock.mockReset();
  resetDashboardNavigation();
});

// HOO-2619: the page has no loading boundary, so `notFound()` runs before anything streams and
// the response is a real 404.
describe("PayPage unknown links", () => {
  it.each(["short", "has space here", "../../v1/projects", "a".repeat(65), "tok%2Fen"])(
    "answers 404 for the malformed token %j without reading the API",
    async (token) => {
      await expect(renderPage(token)).rejects.toThrow("NEXT_NOT_FOUND");
      expect(fetchMock).not.toHaveBeenCalled();
    }
  );

  it("answers 404 for a token the API does not know, with one read", async () => {
    fetchMock.mockResolvedValue(new Response("{}", { status: 404 }));

    await expect(renderPage("AbCdEfGh12345-xy")).rejects.toThrow("NEXT_NOT_FOUND");
    expect(fetchMock).toHaveBeenCalledOnce();
    expect(fetchMock.mock.calls[0]?.[0]).toBe("http://sdp-api.test/pay/AbCdEfGh12345-xy");
  });

  it("does not call a refused or failed read a missing link", async () => {
    fetchMock.mockResolvedValue(new Response("{}", { status: 429 }));

    await expect(renderPage("AbCdEfGh12345-xy")).rejects.toThrow("Pay link read failed (429)");
    expect(nextNavigationMock.notFound).not.toHaveBeenCalled();
  });
});

describe("payTokenSchema", () => {
  it("accepts the API's 16-character tokens", () => {
    expect(payTokenSchema.safeParse("0123456789ABCDEF").success).toBe(true);
    expect(payTokenSchema.safeParse("abc-DEF-ghi-JKL-").success).toBe(true);
  });
});
