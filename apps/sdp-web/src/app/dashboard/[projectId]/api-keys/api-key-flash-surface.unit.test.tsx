// @vitest-environment jsdom
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { getMessages } from "@/i18n/messages";
import { I18nProvider } from "@/i18n/provider";
import { resetDashboardNavigation, setDashboardUrl } from "@/test/dashboard-navigation";
import { PRODUCTION_PROJECT, SANDBOX_PROJECT } from "@/test/projects";
import type { ApiKeyFlash } from "./api-key-flash";
import { ApiKeyFlashSurface } from "./api-key-flash-surface";

vi.mock("next/navigation", () => import("@/test/next-navigation"));

const fetchMock = vi.fn<typeof fetch>();

function flashResponse(flash: ApiKeyFlash): Response {
  return new Response(JSON.stringify({ flash }), { status: 200 });
}

const ui = () => (
  <I18nProvider locale="en" messages={getMessages("en")}>
    <ApiKeyFlashSurface />
    <ApiKeyFlashSurface />
  </I18nProvider>
);

beforeEach(() => {
  vi.stubGlobal("fetch", fetchMock);
  fetchMock.mockReset();
  resetDashboardNavigation();
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe("ApiKeyFlashSurface", () => {
  it("shares one pending read per Project flash path and never reuses another Project's", async () => {
    const sandboxRead = Promise.withResolvers<Response>();
    const productionRead = Promise.withResolvers<Response>();
    fetchMock.mockReturnValueOnce(sandboxRead.promise).mockReturnValueOnce(productionRead.promise);

    setDashboardUrl(`/dashboard/${SANDBOX_PROJECT.id}/api-keys`, {});
    const view = render(ui());
    setDashboardUrl(`/dashboard/${PRODUCTION_PROJECT.id}/api-keys`, {});
    view.rerender(ui());

    expect(fetchMock.mock.calls.map(([flashPath]) => flashPath)).toEqual([
      `/dashboard/${SANDBOX_PROJECT.id}/api-keys/flash`,
      `/dashboard/${PRODUCTION_PROJECT.id}/api-keys/flash`,
    ]);

    sandboxRead.resolve(flashResponse({ level: "success", message: "Sandbox key revoked" }));
    productionRead.resolve(flashResponse({ level: "success", message: "Production key revoked" }));

    expect(await screen.findAllByText("Production key revoked")).toHaveLength(2);
    expect(screen.queryByText("Sandbox key revoked")).toBeNull();
  });
});
