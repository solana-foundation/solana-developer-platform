// @vitest-environment jsdom

import { act } from "@testing-library/react";
import { hydrateRoot, type Root } from "react-dom/client";
import { renderToString } from "react-dom/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { getMessages } from "@/i18n/messages";
import { I18nProvider } from "@/i18n/provider";
import { getRequestTimeZone } from "@/i18n/server";
import { TimeZoneProvider } from "@/i18n/time-zone";
import { resetDashboardNavigation } from "@/test/dashboard-navigation";
import { resetRequestProject } from "@/test/request-project";
import PayPage from "./page";

vi.mock("next/navigation", () => import("@/test/next-navigation"));
vi.mock("next/headers", () => import("@/test/next-headers"));

const fetchMock = vi.fn<typeof fetch>();

// 10:14 PM in UTC, the server's zone, and 4:14 PM in Chicago, the payer's.
const EXPIRES_AT = "2026-11-05T22:14:00.000Z";

function payLink(): Response {
  return new Response(
    JSON.stringify({
      amount: "5",
      tokenSymbol: "USDC",
      recipient: "11111111111111111111111111111111",
      status: "awaiting_payment",
      expiresAt: EXPIRES_AT,
      network: "devnet",
      solanaPayUrl: null,
    }),
    { status: 200 }
  );
}

let root: Root | null = null;

/** The page as the root layout serves it, to a payer whose request carries no zone cookie. */
async function servedPage() {
  const page = await PayPage({ params: Promise.resolve({ token: "AbCdEfGh12345-xy" }) });
  const timeZone = await getRequestTimeZone();
  return (
    <I18nProvider locale="en" messages={getMessages("en")}>
      <TimeZoneProvider timeZone={timeZone}>{page}</TimeZoneProvider>
    </I18nProvider>
  );
}

beforeEach(() => {
  resetRequestProject();
  vi.stubEnv("SDP_API_BASE_URL", "http://sdp-api.test");
  vi.stubGlobal("fetch", fetchMock);
  fetchMock.mockImplementation(async () => payLink());
});

afterEach(() => {
  act(() => root?.unmount());
  root = null;
  document.body.replaceChildren();
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
  fetchMock.mockReset();
  resetDashboardNavigation();
});

describe("PayPage on a payer's first visit", () => {
  it("hydrates the server's UTC expiry, then shows it in the payer's zone in a new element", async () => {
    vi.stubEnv("TZ", "UTC");
    const page = await servedPage();
    const html = renderToString(page);
    expect(html).toMatch(/10:14\sPM/);

    vi.stubEnv("TZ", "America/Chicago");
    const container = document.createElement("div");
    container.innerHTML = html;
    document.body.append(container);
    const serverExpiry = [...container.querySelectorAll("span")].find((span) =>
      /10:14\sPM/.test(span.textContent ?? "")
    );
    const recoverableErrors: unknown[] = [];
    await act(async () => {
      root = hydrateRoot(container, page, {
        onRecoverableError: (error) => recoverableErrors.push(error),
      });
    });

    expect(recoverableErrors).toEqual([]);
    expect(container.textContent).toMatch(/Nov 5, 4:14\sPM/);
    expect(container.textContent).not.toMatch(/10:14\sPM/);
    // A replaced element is not a layout shift; the server's text sliding along the row would be.
    expect(serverExpiry?.isConnected).toBe(false);
  });
});
