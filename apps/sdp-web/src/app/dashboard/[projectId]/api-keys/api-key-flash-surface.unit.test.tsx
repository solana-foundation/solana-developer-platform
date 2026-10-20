// @vitest-environment jsdom
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { getMessages } from "@/i18n/messages";
import { I18nProvider } from "@/i18n/provider";
import { resetDashboardNavigation, setDashboardUrl } from "@/test/dashboard-navigation";
import { PRODUCTION_PROJECT, SANDBOX_PROJECT } from "@/test/projects";
import type { ApiKeyFlash } from "./api-key-flash";
import { ApiKeyFlashSurface } from "./api-key-flash-surface";

interface ClerkAuthFixture {
  isLoaded: boolean;
  sessionId: string | null;
  userId: string | null;
  orgId: string | null;
}

const clerk = vi.hoisted((): { auth: ClerkAuthFixture } => ({
  auth: { isLoaded: true, sessionId: "sess_a", userId: "user_a", orgId: "org_a" },
}));

vi.mock("@clerk/nextjs", () => ({ useAuth: () => clerk.auth }));
vi.mock("next/navigation", () => import("@/test/next-navigation"));

const fetchMock = vi.fn<typeof fetch>();

function flashResponse(flash: ApiKeyFlash | null): Response {
  return new Response(JSON.stringify({ flash }), { status: 200 });
}

const ui = () => (
  <I18nProvider locale="en" messages={getMessages("en")}>
    <ApiKeyFlashSurface />
    <ApiKeyFlashSurface />
  </I18nProvider>
);

const accountAKey: ApiKeyFlash = {
  level: "success",
  message: "API key created",
  key: "sk_test_account_a_bearer",
  keyPrefix: "sk_test_acc",
};

beforeEach(() => {
  vi.stubGlobal("fetch", fetchMock);
  fetchMock.mockReset();
  resetDashboardNavigation();
  setDashboardUrl(`/dashboard/${SANDBOX_PROJECT.id}/api-keys`, {});
  clerk.auth = { isLoaded: true, sessionId: "sess_a", userId: "user_a", orgId: "org_a" };
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

  it("never hands one account's pending new key to the next account in the tab", async () => {
    const accountARead = Promise.withResolvers<Response>();
    const accountBRead = Promise.withResolvers<Response>();
    fetchMock.mockReturnValueOnce(accountARead.promise).mockReturnValueOnce(accountBRead.promise);

    // A starts the one-time read, then signs out before it answers; B signs in on this tab.
    const accountA = render(ui());
    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));
    accountA.unmount();
    clerk.auth = { isLoaded: true, sessionId: "sess_b", userId: "user_b", orgId: "org_a" };
    render(ui());

    // B issues its own read instead of joining A's.
    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(2));

    accountARead.resolve(flashResponse(accountAKey));
    accountBRead.resolve(flashResponse(null));

    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(2));
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(screen.queryByDisplayValue(accountAKey.key ?? "")).toBeNull();
    expect(screen.queryByText("API key created")).toBeNull();
  });

  it("drops a shown key the moment the auth scope changes", async () => {
    fetchMock
      .mockResolvedValueOnce(flashResponse(accountAKey))
      .mockResolvedValue(flashResponse(null));

    const view = render(
      <I18nProvider locale="en" messages={getMessages("en")}>
        <ApiKeyFlashSurface />
      </I18nProvider>
    );
    expect(await screen.findByText("API key created")).toBeTruthy();

    clerk.auth = { isLoaded: true, sessionId: "sess_a", userId: "user_a", orgId: "org_b" };
    view.rerender(
      <I18nProvider locale="en" messages={getMessages("en")}>
        <ApiKeyFlashSurface />
      </I18nProvider>
    );

    expect(screen.queryByText("API key created")).toBeNull();
  });

  it("does not read the flash before Clerk has a signed-in session", () => {
    clerk.auth = { isLoaded: true, sessionId: null, userId: null, orgId: null };

    render(ui());

    expect(fetchMock).not.toHaveBeenCalled();
  });
});
