// @vitest-environment jsdom
import type { Action } from "@sdp/types/actions";
import { cleanup, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  dashboardDataResponse,
  dashboardErrorResponse,
  readsOf,
  sentDashboardReads,
  stubDashboardFetch,
} from "@/test/dashboard-fetch";
import { resetDashboardNavigation } from "@/test/dashboard-navigation";
import { EnglishDashboardReads } from "@/test/dashboard-reads";
import { SANDBOX_PROJECT } from "@/test/projects";
import { EditApiKeyWorkspace } from "./[keyId]/edit/edit-api-key-workspace";
import { NewApiKeyWorkspace } from "./new/new-api-key-workspace";

vi.mock("next/navigation", () => import("@/test/next-navigation"));
vi.mock("@/contexts/dashboard-workspace-context", () => ({
  useDashboardWorkspace: () => ({
    sdpEnvironment: "sandbox",
    selectedProjectId: "prj_test_sandbox",
  }),
}));
vi.mock("./actions", () => ({ saveApiKeyAuthoringAction: vi.fn() }));

const OFFERED_ACTIONS: Action[] = ["transfers.read", "transfers.execute"];
const KEY_URL = "/api/dashboard/api-keys/key_test%2F1";
const WALLETS_URL = "/api/dashboard/wallets?view=summary";

function stubReads(failingOnce: { path: string; answer: () => Response } | null) {
  const fetchMock = stubDashboardFetch(({ path }) => {
    if (failingOnce !== null && path === failingOnce.path && readsOf(fetchMock, path) === 1) {
      return failingOnce.answer();
    }
    if (path === WALLETS_URL) {
      return dashboardDataResponse(200, {
        wallets: [
          {
            id: "wal_test_1",
            walletId: "wal_test_1",
            publicKey: "So11111111111111111111111111111111111111112",
            label: "Treasury",
            isRuntimeExecutionAllowed: true,
          },
        ],
      });
    }
    return dashboardDataResponse(200, {
      id: "key_test/1",
      name: "Payouts",
      environment: "sandbox",
      grants: ["transfers.execute"],
      expiresAt: null,
      walletScope: "all",
      walletIds: [],
      allowedIps: null,
    });
  });
  return fetchMock;
}

function editPage() {
  return render(<EditApiKeyWorkspace keyId="key_test/1" offeredActions={OFFERED_ACTIONS} />, {
    wrapper: EnglishDashboardReads,
  });
}

function newPage() {
  return render(<NewApiKeyWorkspace offeredActions={OFFERED_ACTIONS} />, {
    wrapper: EnglishDashboardReads,
  });
}

async function nameField(): Promise<HTMLElement> {
  return screen.findByLabelText("Name");
}

beforeEach(() => {
  resetDashboardNavigation();
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe("EditApiKeyWorkspace", () => {
  it("shows a skeleton, then opens the form on the key and wallets it read", async () => {
    const fetchMock = stubReads(null);

    const { container } = editPage();

    expect(container.querySelector('[data-loading-layout="api-key-edit"]')).not.toBeNull();
    expect(await nameField()).toHaveProperty("value", "Payouts");
    expect(sentDashboardReads(fetchMock)).toEqual([
      { path: KEY_URL, projectId: SANDBOX_PROJECT.id, demo: null },
      { path: WALLETS_URL, projectId: SANDBOX_PROJECT.id, demo: null },
    ]);
  });

  it("says a key the API does not find is gone, with a way back to the list", async () => {
    stubReads({ path: KEY_URL, answer: () => dashboardErrorResponse(404, "API key not found") });

    editPage();

    expect(
      await screen.findByText("This API key does not exist in this project, or it was deleted.")
    ).toBeTruthy();
    expect(screen.getByRole("link", { name: "Back to API keys" }).getAttribute("href")).toBe(
      `/dashboard/${SANDBOX_PROJECT.id}/api-keys`
    );
    expect(screen.queryByLabelText("Name")).toBeNull();
  });

  it.each([
    [KEY_URL, "API keys could not be loaded."],
    [WALLETS_URL, "Unable to load wallets"],
  ])("says why when %s fails, and opens the form on retry", async (path, shown) => {
    stubReads({ path, answer: () => dashboardErrorResponse(503, "upstream unavailable") });
    const user = userEvent.setup();
    editPage();

    expect((await screen.findByRole("alert")).textContent).toContain(shown);
    await user.click(screen.getByRole("button", { name: "Try again" }));

    expect(await nameField()).toHaveProperty("value", "Payouts");
  });
});

describe("NewApiKeyWorkspace", () => {
  it("shows a skeleton, then an empty form once the wallets are read", async () => {
    const fetchMock = stubReads(null);

    const { container } = newPage();

    expect(container.querySelector('[data-loading-layout="api-key-new"]')).not.toBeNull();
    expect(await nameField()).toHaveProperty("value", "");
    expect(sentDashboardReads(fetchMock).map(({ path }) => path)).toEqual([WALLETS_URL]);
  });

  it("says the wallets could not be loaded, and opens the form on retry", async () => {
    stubReads({
      path: WALLETS_URL,
      answer: () => dashboardErrorResponse(503, "upstream unavailable"),
    });
    const user = userEvent.setup();
    newPage();

    expect((await screen.findByRole("alert")).textContent).toContain("Unable to load wallets");
    await user.click(screen.getByRole("button", { name: "Try again" }));

    expect(await nameField()).toHaveProperty("value", "");
  });
});
