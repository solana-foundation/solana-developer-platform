// @vitest-environment jsdom

import { cleanup, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { toast } from "sonner";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { getMessages } from "@/i18n/messages";
import { I18nProvider } from "@/i18n/provider";
import { dashboardRouter, resetDashboardNavigation } from "@/test/dashboard-navigation";
import { setPageRequest } from "@/test/request-project";

vi.mock("next/navigation", () => import("@/test/next-navigation"));
vi.mock("next/headers", () => import("@/test/next-headers"));
vi.mock("next/cache", () => import("@/test/next-cache"));
vi.mock("@clerk/nextjs/server", () => ({
  auth: async () => ({ orgId: "org_test", getToken: async () => "test-token" }),
}));

import type { CustodyCredentialLifecycle } from "./connection-detail.data";
import { DeactivateCredentialsDialog } from "./deactivate-credentials-dialog";

const UNUSED: CustodyCredentialLifecycle = {
  providerCredential: {
    id: "pcred_current",
    provider: "privy",
    label: "Privy production app",
    scope: "project",
    projectId: "prj_1",
    status: "active",
    createdAt: "2026-09-09T14:20:00.000Z",
    displayMetadata: { appIdSuffix: "9f2a" },
    source: "stored",
  },
  rotationCandidate: null,
  impact: { connections: [], projects: [] },
  rollback: null,
};

beforeEach(() => {
  setPageRequest("/dashboard/prj_test_sandbox/integrations/privy/connections/cconn_1");
  vi.stubEnv("SDP_API_BASE_URL", "https://api.example.test");
  vi.spyOn(console, "info").mockImplementation(() => undefined);
});

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
  resetDashboardNavigation();
});

function mockApi(status: number) {
  const api = vi.fn(async (url: RequestInfo | URL, _init?: RequestInit) => {
    if (String(url).endsWith("/provider-credentials/pcred_current/deactivate")) {
      return Response.json(
        status === 200
          ? {
              data: { providerCredential: { ...UNUSED.providerCredential, status: "deactivated" } },
            }
          : { error: { message: "Deactivation could not be confirmed." } },
        { status }
      );
    }
    throw new Error(`Unexpected API request: ${url}`);
  });
  vi.stubGlobal("fetch", api);
  return api;
}

async function mount(lifecycle: CustodyCredentialLifecycle, onClose: () => void) {
  render(
    <I18nProvider locale="en" messages={getMessages("en")}>
      <DeactivateCredentialsDialog
        isOpen
        onClose={onClose}
        lifecycle={lifecycle}
        provider="privy"
        connectionId="cconn_1"
      />
    </I18nProvider>
  );
  return screen.findByRole("dialog", { name: "Deactivate “Privy production app” credentials?" });
}

it("deactivates unused credentials without claiming deletion at the provider", async () => {
  const api = mockApi(200);
  const success = vi.spyOn(toast, "success").mockImplementation(() => "test-toast");
  const onClose = vi.fn();
  const dialog = await mount(UNUSED, onClose);

  expect(within(dialog).getByText(/does not revoke credentials at the provider/)).toBeTruthy();
  await userEvent.click(within(dialog).getByRole("button", { name: "Deactivate credentials" }));

  await waitFor(() => expect(onClose).toHaveBeenCalled());
  expect(api).toHaveBeenCalledWith(
    "https://api.example.test/internal/dashboard/custody/provider-credentials/pcred_current/deactivate",
    expect.objectContaining({ method: "POST" })
  );
  expect(success).toHaveBeenCalledWith("Credentials deactivated", {
    description: "These credentials can no longer be used for signing through SDP.",
  });
  expect(dashboardRouter.refresh).toHaveBeenCalled();
});

it("refuses to deactivate credentials another connection still uses", async () => {
  const api = mockApi(200);
  const dialog = await mount(
    {
      ...UNUSED,
      impact: {
        projects: [{ id: "prj_other", name: "Treasury" }],
        connections: [{ id: "cconn_other", projectId: "prj_other", status: "active" }],
      },
    },
    vi.fn()
  );

  expect(
    within(dialog).getByText(/1 connections reference these credentials, in Treasury/)
  ).toBeTruthy();
  const confirm = within(dialog).getByRole("button", { name: "Deactivate credentials" });
  expect(confirm).toHaveProperty("disabled", true);
  await userEvent.click(confirm);
  expect(api).not.toHaveBeenCalled();
});

it.each([
  [403, "error", "Credentials not deactivated"],
  [409, "warning", "This connection changed while you were working."],
  [503, "warning", "Result unknown"],
] as const)(
  "stays open on HTTP %s without claiming success",
  async (status, notification, title) => {
    mockApi(status);
    const success = vi.spyOn(toast, "success").mockImplementation(() => "test-toast");
    const notice = vi.spyOn(toast, notification).mockImplementation(() => "test-toast");
    const onClose = vi.fn();
    const dialog = await mount(UNUSED, onClose);

    await userEvent.click(within(dialog).getByRole("button", { name: "Deactivate credentials" }));

    await waitFor(() => expect(dashboardRouter.refresh).toHaveBeenCalled());
    expect(onClose).not.toHaveBeenCalled();
    expect(success).not.toHaveBeenCalled();
    expect(notice).toHaveBeenCalledWith(title, {
      description: "Deactivation could not be confirmed.",
    });
  }
);
