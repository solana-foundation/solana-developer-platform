// @vitest-environment jsdom

import { act } from "@testing-library/react";
import { createRoot, hydrateRoot, type Root } from "react-dom/client";
import { renderToString } from "react-dom/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { formatDateTime } from "@/app/(session)/dashboard/[projectId]/payments/payments-presentation";
import { getRequestTimeZone } from "@/i18n/server";
import { TimeZoneProvider, useTimeZone } from "@/i18n/time-zone";
import { requestCookies, resetRequestProject } from "@/test/request-project";

vi.mock("next/headers", () => import("@/test/next-headers"));

// 10:14 PM in UTC and 4:14 PM in Chicago.
const CREATED_AT = "2026-11-04T22:14:00.000Z";

let root: Root | null = null;

function CreatedAt({ onRender }: { onRender?: (timeZone: string) => void }) {
  const timeZone = useTimeZone();
  onRender?.(timeZone);
  return <span>{formatDateTime(CREATED_AT, "en-US", timeZone)}</span>;
}

function page(servedTimeZone: string, onRender?: (timeZone: string) => void) {
  return (
    <TimeZoneProvider timeZone={servedTimeZone}>
      <CreatedAt onRender={onRender} />
    </TimeZoneProvider>
  );
}

/** The server renders in UTC; the page then hydrates in a Chicago browser. */
async function loadPage(servedTimeZone: string) {
  vi.stubEnv("TZ", "UTC");
  const html = renderToString(page(servedTimeZone));
  vi.stubEnv("TZ", "America/Chicago");
  const container = document.createElement("div");
  container.innerHTML = html;
  document.body.append(container);
  const recoverableErrors: unknown[] = [];
  await act(async () => {
    root = hydrateRoot(container, page(servedTimeZone), {
      onRecoverableError: (error) => recoverableErrors.push(error),
    });
  });
  return { html, container, recoverableErrors };
}

beforeEach(() => {
  resetRequestProject();
});

afterEach(() => {
  act(() => root?.unmount());
  root = null;
  document.body.replaceChildren();
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});

describe("TimeZoneProvider and useTimeZone", () => {
  it("renders on the server in the zone the request named, not the server's own", () => {
    vi.stubEnv("TZ", "UTC");
    expect(renderToString(page("America/Chicago"))).toMatch(/4:14\sPM/);
  });

  it("hydrates in the served zone, then shows the browser's and stores it for the server", async () => {
    const writeCookie = vi.spyOn(Document.prototype, "cookie", "set");
    const { html, container, recoverableErrors } = await loadPage("UTC");

    expect(html).toMatch(/10:14\sPM/);
    expect(recoverableErrors).toEqual([]);
    expect(container.textContent).toMatch(/^Nov 4, 2026, 4:14\sPM$/);
    expect(writeCookie).toHaveBeenCalledExactlyOnceWith(
      "sdp-time-zone=America%2FChicago; Path=/; Max-Age=31536000; SameSite=Lax; Secure"
    );
  });

  it("stores nothing when the request already named the browser's zone", async () => {
    const writeCookie = vi.spyOn(Document.prototype, "cookie", "set");
    const { recoverableErrors, container } = await loadPage("America/Chicago");

    expect(recoverableErrors).toEqual([]);
    expect(container.textContent).toMatch(/^Nov 4, 2026, 4:14\sPM$/);
    expect(writeCookie).not.toHaveBeenCalled();
  });

  it("starts a page the browser renders itself in the browser's zone", () => {
    vi.stubEnv("TZ", "America/Chicago");
    const rendered: string[] = [];
    const container = document.createElement("div");
    document.body.append(container);
    act(() => {
      root = createRoot(container);
      root.render(page("UTC", (timeZone) => rendered.push(timeZone)));
    });

    expect(new Set(rendered)).toEqual(new Set(["America/Chicago"]));
  });
});

describe("getRequestTimeZone", () => {
  it("reads the zone the browser stored", async () => {
    requestCookies.set("sdp-time-zone", "America/Chicago");
    await expect(getRequestTimeZone()).resolves.toBe("America/Chicago");
  });

  it.each([
    ["no cookie", undefined],
    ["a zone Intl does not know", "Mars/Olympus_Mons"],
    ["characters no zone has", "UTC; Path=/"],
    ["an overlong value", `America/${"x".repeat(80)}`],
  ])("falls back to UTC for %s", async (_case, value) => {
    if (value !== undefined) requestCookies.set("sdp-time-zone", value);
    await expect(getRequestTimeZone()).resolves.toBe("UTC");
  });
});
