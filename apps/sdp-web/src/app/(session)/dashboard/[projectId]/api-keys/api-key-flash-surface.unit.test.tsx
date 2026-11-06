// @vitest-environment jsdom
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { resetDashboardNavigation, setDashboardUrl } from "@/test/dashboard-navigation";
import { PRODUCTION_PROJECT, SANDBOX_PROJECT } from "@/test/projects";
import type { ApiKeyFlash } from "./api-key-flash";
import { useApiKeyFlashSecret } from "./api-key-flash-surface";

interface ClerkAuthFixture {
  sessionId: string | null;
  userId: string | null;
  orgId: string | null;
}

const clerk = vi.hoisted((): { auth: ClerkAuthFixture } => ({
  auth: { sessionId: "sess_a", userId: "user_a", orgId: "org_a" },
}));

vi.mock("@clerk/nextjs", () => ({ useAuth: () => clerk.auth }));
vi.mock("next/navigation", () => import("@/test/next-navigation"));

const fetchMock = vi.fn<typeof fetch>();

function flashResponse(flash: ApiKeyFlash | null): Response {
  return new Response(JSON.stringify({ flash }), { status: 200 });
}

function SecretProbe({ keyId }: { keyId: string }) {
  const secret = useApiKeyFlashSecret(keyId);
  return secret === null ? null : <p data-key-id={keyId}>{secret}</p>;
}

const ui = () => (
  <>
    <SecretProbe keyId="key_test_1" />
    <SecretProbe keyId="key_test_2" />
  </>
);

const accountAKey: ApiKeyFlash = { keyId: "key_test_1", key: "sf_test_account_a_secret" };

beforeEach(() => {
  vi.stubGlobal("fetch", fetchMock);
  fetchMock.mockReset();
  resetDashboardNavigation();
  setDashboardUrl(`/dashboard/${SANDBOX_PROJECT.id}/api-keys/key_test_1`, {});
  clerk.auth = { sessionId: "sess_a", userId: "user_a", orgId: "org_a" };
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe("useApiKeyFlashSecret", () => {
  it("hands the secret only to the key it was generated for, from one shared read", async () => {
    fetchMock.mockResolvedValue(flashResponse(accountAKey));

    render(ui());

    const shown = await screen.findAllByText(accountAKey.key);
    expect(shown.map((element) => element.getAttribute("data-key-id"))).toEqual(["key_test_1"]);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("shares one pending read per Project flash path and never reuses another Project's", async () => {
    const sandboxRead = Promise.withResolvers<Response>();
    const productionRead = Promise.withResolvers<Response>();
    fetchMock.mockReturnValueOnce(sandboxRead.promise).mockReturnValueOnce(productionRead.promise);

    const view = render(ui());
    setDashboardUrl(`/dashboard/${PRODUCTION_PROJECT.id}/api-keys/key_test_2`, {});
    view.rerender(ui());

    expect(fetchMock.mock.calls.map(([flashPath]) => flashPath)).toEqual([
      `/dashboard/${SANDBOX_PROJECT.id}/api-keys/flash`,
      `/dashboard/${PRODUCTION_PROJECT.id}/api-keys/flash`,
    ]);

    sandboxRead.resolve(flashResponse({ keyId: "key_test_1", key: "sf_test_sandbox_secret" }));
    productionRead.resolve(
      flashResponse({ keyId: "key_test_2", key: "sf_test_production_secret" })
    );

    expect(await screen.findByText("sf_test_production_secret")).toBeTruthy();
    expect(screen.queryByText("sf_test_sandbox_secret")).toBeNull();
  });

  it("never hands one account's pending new key to the next account in the tab", async () => {
    const accountARead = Promise.withResolvers<Response>();
    const accountBRead = Promise.withResolvers<Response>();
    fetchMock.mockReturnValueOnce(accountARead.promise).mockReturnValueOnce(accountBRead.promise);

    const accountA = render(ui());
    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));
    accountA.unmount();
    clerk.auth = { sessionId: "sess_b", userId: "user_b", orgId: "org_a" };
    render(ui());

    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(2));

    accountARead.resolve(flashResponse(accountAKey));
    accountBRead.resolve(flashResponse(null));

    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(screen.queryByText(accountAKey.key)).toBeNull();
  });

  it("drops a shown key the moment the auth scope changes", async () => {
    fetchMock
      .mockResolvedValueOnce(flashResponse(accountAKey))
      .mockResolvedValue(flashResponse(null));

    const view = render(<SecretProbe keyId="key_test_1" />);
    expect(await screen.findByText(accountAKey.key)).toBeTruthy();

    clerk.auth = { sessionId: "sess_a", userId: "user_a", orgId: "org_b" };
    view.rerender(<SecretProbe keyId="key_test_1" />);

    expect(screen.queryByText(accountAKey.key)).toBeNull();
  });

  it("does not read the flash before Clerk has a signed-in session", () => {
    clerk.auth = { sessionId: null, userId: null, orgId: null };

    render(ui());

    expect(fetchMock).not.toHaveBeenCalled();
  });
});
