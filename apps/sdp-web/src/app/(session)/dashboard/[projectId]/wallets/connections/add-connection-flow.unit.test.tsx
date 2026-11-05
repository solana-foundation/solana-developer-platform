// @vitest-environment jsdom

import { cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import {
  DashboardPageTitleContext,
  type DashboardPageTitleOverride,
} from "@/components/dashboard-page-title-context";
import { getMessages } from "@/i18n/messages";
import { I18nProvider } from "@/i18n/provider";
import { dashboardRouter, resetDashboardNavigation } from "@/test/dashboard-navigation";
import { setPageRequest } from "@/test/request-project";
import { AddConnectionFlow } from "./add-connection-flow";

vi.mock("next/navigation", () => import("@/test/next-navigation"));
vi.mock("next/headers", () => import("@/test/next-headers"));
vi.mock("next/cache", () => ({ revalidatePath: vi.fn() }));
vi.mock("@clerk/nextjs/server", () => ({
  auth: async () => ({ orgId: "org_test", getToken: async () => "test-token" }),
}));
vi.mock("./use-selected-project-name", () => ({
  useSelectedProjectName: () => "Acme Payments",
}));

const PROVIDER_HREF = "/dashboard/prj_test_sandbox/integrations/privy";
const CONNECTION_HREF = "/dashboard/prj_test_sandbox/integrations/privy/connections/cconn_new";

let shownTitle: DashboardPageTitleOverride | null = null;
const showTitle = (override: DashboardPageTitleOverride | null) => {
  shownTitle = override;
};

beforeEach(() => {
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

function flow(provider: "privy" | "fireblocks") {
  return (
    <I18nProvider locale="en" messages={getMessages("en")}>
      <DashboardPageTitleContext.Provider value={showTitle}>
        <AddConnectionFlow provider={provider} />
      </DashboardPageTitleContext.Provider>
    </I18nProvider>
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
    if (String(url).endsWith("/custody/connections/cconn_new/complete")) return complete();
    throw new Error(`Unexpected API request: ${url}`);
  });
  return { submit, complete };
}

const completed = () =>
  Response.json({
    data: { providerCredential: { provider: "privy" }, completion: { status: "success" } },
  });

async function fillAndSubmit(user: ReturnType<typeof userEvent.setup>) {
  await user.type(screen.getByLabelText("App ID"), "app_test");
  await user.type(screen.getByLabelText("App secret"), "secret_test");
  await user.click(screen.getByRole("button", { name: "Connect and create wallet" }));
}

it.each([
  [
    "privy",
    "Connects this Privy app to Acme Payments and creates the first wallet in it.",
    "Connect and create wallet",
  ],
  ["fireblocks", "Connects this Fireblocks account to Acme Payments.", "Connect and verify"],
] as const)("words the %s footer for what connecting creates", (provider, footer, primary) => {
  const markup = renderToStaticMarkup(flow(provider));

  expect(markup).toContain(footer);
  expect(markup).toContain(primary);
});

it("returns to the provider page on Cancel", async () => {
  const user = userEvent.setup();
  render(flow("privy"));

  await user.click(screen.getByRole("button", { name: "Cancel" }));

  expect(dashboardRouter.push).toHaveBeenCalledWith(PROVIDER_HREF);
});

it("lands on the new connection once it verifies", async () => {
  const { complete } = mockApi();
  complete.mockImplementation(async () => completed());
  const user = userEvent.setup();
  render(flow("privy"));

  await fillAndSubmit(user);

  await waitFor(() => expect(dashboardRouter.push).toHaveBeenCalledWith(CONNECTION_HREF));
});

it("holds the page on an unknown submission until its replay settles", async () => {
  const { submit, complete } = mockApi();
  submit.mockRejectedValueOnce(new TypeError("fetch failed"));
  complete.mockImplementation(async () => completed());
  const user = userEvent.setup();
  render(flow("privy"));

  await fillAndSubmit(user);
  const retry = await screen.findByRole("button", { name: "Retry submission" });

  expect(screen.getByRole("button", { name: "Close" })).toHaveProperty("disabled", true);
  expect(screen.queryByRole("button", { name: /^Connect and create wallet/ })).toBeNull();
  await user.click(screen.getByRole("button", { name: "Close" }));
  expect(dashboardRouter.push).not.toHaveBeenCalled();

  await user.click(retry);
  await waitFor(() => expect(dashboardRouter.push).toHaveBeenCalledWith(CONNECTION_HREF));
  expect(dashboardRouter.push).toHaveBeenCalledTimes(1);
});

it("blocks leaving during a completion retry and releases it after a refusal", async () => {
  const { complete } = mockApi();
  const user = userEvent.setup();
  render(flow("privy"));
  await fillAndSubmit(user);
  await screen.findByText("Completion is unavailable.");
  const retry = Promise.withResolvers<Response>();
  complete.mockReturnValueOnce(retry.promise);

  await user.click(screen.getByRole("button", { name: "Check again" }));
  const close = screen.getByRole("button", { name: "Close" });
  expect(close).toHaveProperty("disabled", true);
  expect(shownTitle).toMatchObject({ backLocked: true });
  await user.click(close);
  expect(dashboardRouter.push).not.toHaveBeenCalled();

  retry.resolve(Response.json({ error: { message: "Try again later." } }, { status: 403 }));
  await screen.findByText("Try again later.");
  await waitFor(() => expect(close).toHaveProperty("disabled", false));
  expect(shownTitle).toHaveProperty("backLocked", undefined);
  await user.click(close);
  expect(dashboardRouter.push).toHaveBeenCalledWith(PROVIDER_HREF);
});
