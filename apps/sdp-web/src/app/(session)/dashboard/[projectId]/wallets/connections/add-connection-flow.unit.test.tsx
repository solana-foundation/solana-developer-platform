// @vitest-environment jsdom

import { cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import * as csrActions from "@/app/(session)/dashboard/[projectId]/wallets/setup/fireblocks-csr-actions";
import {
  DashboardPageTitleContext,
  type DashboardPageTitleOverride,
} from "@/components/dashboard-page-title-context";
import { stubClerkSession } from "@/test/clerk";
import { dashboardDataResponse, stubDashboardFetch } from "@/test/dashboard-fetch";
import { dashboardRouter, resetDashboardNavigation } from "@/test/dashboard-navigation";
import { setPageRequest } from "@/test/request-project";
import { walletsWorkspace } from "@/test/wallets";
import { AddConnectionFlow } from "./add-connection-flow";

vi.mock("next/navigation", () => import("@/test/next-navigation"));
vi.mock("next/headers", () => import("@/test/next-headers"));
vi.mock("next/cache", () => import("@/test/next-cache"));
vi.mock("@clerk/nextjs/server", () => ({
  auth: async () => ({ orgId: "org_test", getToken: async () => "test-token" }),
}));

const PROVIDER_HREF = "/dashboard/prj_test_sandbox/integrations/privy";
const CONNECTION_HREF = "/dashboard/prj_test_sandbox/integrations/privy/connections/cconn_new";

let shownTitle: DashboardPageTitleOverride | null = null;
const showTitle = (override: DashboardPageTitleOverride | null) => {
  shownTitle = override;
};

beforeEach(() => {
  stubClerkSession();
  setPageRequest("/dashboard/prj_test_sandbox/integrations/privy/connections/new");
});

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
  resetDashboardNavigation();
  shownTitle = null;
});

function renderFlow(provider: "privy" | "fireblocks" = "privy") {
  render(
    <DashboardPageTitleContext.Provider value={showTitle}>
      <AddConnectionFlow provider={provider} />
    </DashboardPageTitleContext.Provider>,
    { wrapper: walletsWorkspace("admin") }
  );
}

function mockApi() {
  vi.stubEnv("SDP_API_BASE_URL", "https://api.example.test");
  vi.spyOn(console, "info").mockImplementation(() => undefined);
  const submit = vi
    .fn<() => Promise<Response>>()
    .mockImplementation(async () => Response.json({ data: { connectionId: "cconn_new" } }));
  const complete = vi
    .fn<() => Promise<Response>>()
    .mockImplementation(async () =>
      Response.json({ error: { message: "Completion is unavailable." } }, { status: 403 })
    );
  vi.stubGlobal("fetch", async (url: RequestInfo | URL) => {
    if (String(url).endsWith("/custody/provider-credentials")) return submit();
    if (String(url).endsWith("/custody/connections/cconn_new/complete-installation"))
      return complete();
    throw new Error(`Unexpected API request: ${url}`);
  });
  return { submit, complete };
}

const completed = () =>
  Response.json({
    data: { providerCredential: { provider: "privy" }, completion: { status: "success" } },
  });

function leavePrevented(): boolean {
  const unload = new Event("beforeunload", { cancelable: true });
  window.dispatchEvent(unload);
  return unload.defaultPrevented;
}

async function fillAndSubmit(user: ReturnType<typeof userEvent.setup>) {
  await user.type(screen.getByLabelText("App ID"), "app_test");
  await user.type(screen.getByLabelText("App secret"), "secret_test");
  await user.click(screen.getByRole("button", { name: "Connect and create wallet" }));
}

it("returns to the provider page on Cancel", async () => {
  const user = userEvent.setup();
  renderFlow();

  await user.click(screen.getByRole("button", { name: "Cancel" }));

  expect(dashboardRouter.push).toHaveBeenCalledExactlyOnceWith(PROVIDER_HREF);
});

it("lands on the new connection once it verifies", async () => {
  const { complete } = mockApi();
  complete.mockImplementation(async () => completed());
  const user = userEvent.setup();
  renderFlow();

  await fillAndSubmit(user);

  await waitFor(() =>
    expect(dashboardRouter.push).toHaveBeenCalledExactlyOnceWith(CONNECTION_HREF)
  );
});

it("holds the page on an unknown submission until its replay settles", async () => {
  const { submit, complete } = mockApi();
  submit.mockRejectedValueOnce(new TypeError("fetch failed"));
  complete.mockImplementation(async () => completed());
  const user = userEvent.setup();
  renderFlow();

  await fillAndSubmit(user);
  const retry = await screen.findByRole("button", { name: "Retry submission" });

  expect(screen.getByRole("button", { name: "Close" })).toHaveProperty("disabled", true);
  expect(screen.queryByRole("button", { name: /^Connect and create wallet/ })).toBeNull();
  await user.click(screen.getByRole("button", { name: "Close" }));
  expect(dashboardRouter.push).not.toHaveBeenCalled();

  await user.click(retry);
  await waitFor(() =>
    expect(dashboardRouter.push).toHaveBeenCalledExactlyOnceWith(CONNECTION_HREF)
  );
});

it("blocks leaving during a completion retry and releases it after a refusal", async () => {
  const { complete } = mockApi();
  const user = userEvent.setup();
  renderFlow();
  await fillAndSubmit(user);
  await screen.findByText("Completion is unavailable.");
  const retry = Promise.withResolvers<Response>();
  complete.mockReturnValueOnce(retry.promise);

  await user.click(screen.getByRole("button", { name: "Check again" }));
  const close = screen.getByRole("button", { name: "Close" });
  expect(close).toHaveProperty("disabled", true);
  expect(shownTitle).toMatchObject({ navigationLocked: true });
  expect(leavePrevented()).toBe(true);
  await user.click(close);
  expect(dashboardRouter.push).not.toHaveBeenCalled();

  retry.resolve(Response.json({ error: { message: "Try again later." } }, { status: 403 }));
  await screen.findByText("Try again later.");
  await waitFor(() => expect(close).toHaveProperty("disabled", false));
  expect(shownTitle).toHaveProperty("navigationLocked", undefined);
  expect(leavePrevented()).toBe(false);
  await user.click(close);
  expect(dashboardRouter.push).toHaveBeenCalledExactlyOnceWith(PROVIDER_HREF);
});

it("holds Fireblocks' Connect and verify until a vault is chosen, and names the Project", async () => {
  setPageRequest("/dashboard/prj_test_sandbox/integrations/fireblocks/connections/new");
  stubDashboardFetch((request) => {
    if (request.path !== "/api/dashboard/fireblocks/csr") {
      throw new Error(`Unexpected dashboard request: ${request.path}`);
    }
    return dashboardDataResponse(200, {
      csr: {
        id: "fbcsr_11111111-1111-4111-8111-111111111111",
        csrPem: "public-csr",
        expiresAt: new Date(Date.now() + 86_400_000).toISOString(),
      },
    });
  });
  vi.spyOn(csrActions, "loadFireblocksVaultsAction").mockResolvedValue({
    status: "success",
    vaults: [{ id: "0", name: "Treasury", hasSolanaWallet: true }],
    nextCursor: null,
  });
  const user = userEvent.setup();
  renderFlow("fireblocks");
  const connect = () => screen.getByRole("button", { name: "Connect and verify" });

  expect(screen.getByText("Connects this Fireblocks account to Sandbox.")).toBeTruthy();
  await screen.findByRole("button", { name: "Download CSR" });
  expect(connect()).toHaveProperty("disabled", true);
  await user.type(screen.getByLabelText("API user ID"), "api-user");
  await user.click(screen.getByRole("button", { name: "Load vaults" }));
  const treasury = await screen.findByRole("checkbox", { name: /Treasury/ });
  await waitFor(() => expect(connect()).toHaveProperty("disabled", true));

  await user.click(treasury);

  await waitFor(() => expect(connect()).toHaveProperty("disabled", false));
});
