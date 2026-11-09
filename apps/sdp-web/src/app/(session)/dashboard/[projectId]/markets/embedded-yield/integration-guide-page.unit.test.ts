import { type ComponentProps, isValidElement } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { EarnIntegrationGuide } from "@/app/(session)/dashboard/[projectId]/markets/earn/earn-integration-guide";
import * as earnProviderAccess from "@/app/(session)/dashboard/[projectId]/markets/earn/earn-provider-access.server";

import { EarnIntegrationGuidePage } from "./integration-guide-page";

type GuideProps = ComponentProps<typeof EarnIntegrationGuide>;

async function renderGuidePage(strategy?: string): Promise<GuideProps> {
  // The page's own inferred element type, not a widened `ReactNode`.
  const page = await EarnIntegrationGuidePage({
    searchParams: Promise.resolve(strategy === undefined ? {} : { strategy }),
  });
  expect(isValidElement(page)).toBe(true);
  if (!isValidElement(page)) throw new Error("no element");
  expect(page.type).toBe(EarnIntegrationGuide);
  // SAFETY: the page renders exactly one `EarnIntegrationGuide` element, so its
  // props are that component's; `isValidElement` can only type them `unknown`.
  return page.props as GuideProps;
}

describe("EarnIntegrationGuidePage", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    // The loader reads the request's organization over the API; the page's
    // rendering is what's under test here, so it resolves without access.
    vi.spyOn(earnProviderAccess, "loadEarnProviderAccess").mockResolvedValue(null);
  });

  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it("never names the internal-only SDP_API_BASE_URL in the copied snippet's API URL", async () => {
    vi.stubEnv("SDP_API_BASE_URL", "http://sdp-api:8787");
    vi.stubEnv("NEXT_PUBLIC_SDP_API_BASE_URL", undefined);
    vi.stubEnv("NEXT_PUBLIC_API_BASE_URL", undefined);
    const props = await renderGuidePage();
    expect(props.apiBaseUrl).toBeNull();
  });

  it("names a published public base URL so the snippet works outside this deployment", async () => {
    vi.stubEnv("SDP_API_BASE_URL", "http://sdp-api:8787");
    vi.stubEnv("NEXT_PUBLIC_SDP_API_BASE_URL", "https://api.example.com");
    const props = await renderGuidePage();
    expect(props.apiBaseUrl).toBe("https://api.example.com");
  });

  it("falls back to NEXT_PUBLIC_API_BASE_URL and drops a trailing slash", async () => {
    vi.stubEnv("NEXT_PUBLIC_SDP_API_BASE_URL", undefined);
    vi.stubEnv("NEXT_PUBLIC_API_BASE_URL", "https://fallback.example.com/");
    const props = await renderGuidePage();
    expect(props.apiBaseUrl).toBe("https://fallback.example.com");
  });

  it("forwards a strategy query parameter and defaults to no strategy", async () => {
    expect((await renderGuidePage("kamino-usdc")).strategyId).toBe("kamino-usdc");
    expect((await renderGuidePage()).strategyId).toBeUndefined();
  });
});
