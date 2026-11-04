import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { nextNavigationMock, resetDashboardNavigation } from "@/test/dashboard-navigation";

vi.mock("next/navigation", () => import("@/test/next-navigation"));
vi.mock("@/i18n/server", () => ({
  getTranslations: async () => (key: string) => key,
  getRequestLocale: async () => "en",
}));

import PayPage from "./page";

function upstreamAnswers(status: number) {
  vi.stubGlobal(
    "fetch",
    vi.fn(async () => Response.json({ error: { message: "upstream" } }, { status }))
  );
}

const renderPage = () => PayPage({ params: Promise.resolve({ token: "tok_test_link" }) });

describe("PayPage", () => {
  beforeEach(() => {
    vi.stubEnv("SDP_API_BASE_URL", "https://api.example.test");
    resetDashboardNavigation();
  });

  afterEach(() => {
    vi.unstubAllEnvs();
    vi.unstubAllGlobals();
  });

  it("renders not-found for a link the API does not know", async () => {
    upstreamAnswers(404);

    await expect(renderPage()).rejects.toThrow("NEXT_NOT_FOUND");
    expect(nextNavigationMock.notFound).toHaveBeenCalledOnce();
  });

  it("throws to the error boundary when the API read fails otherwise", async () => {
    upstreamAnswers(500);

    await expect(renderPage()).rejects.toThrow("Payment request read failed (500)");
    expect(nextNavigationMock.notFound).not.toHaveBeenCalled();
  });
});
