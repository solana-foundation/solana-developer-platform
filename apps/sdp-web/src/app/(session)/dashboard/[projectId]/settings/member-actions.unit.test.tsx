// @vitest-environment jsdom
import type { OrganizationRole } from "@sdp/types/roles";
import { cleanup, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { getMessages } from "@/i18n/messages";
import { I18nProvider } from "@/i18n/provider";
import { dashboardRequestUrl } from "@/lib/dashboard-request-key";
import { resetIdempotencyKeyStoresForTests } from "@/lib/idempotency-key-store";
import {
  dashboardDataResponse,
  dashboardErrorResponse,
  readsOf,
  type SentDashboardRequest,
  sentDashboardRequests,
  stubDashboardFetch,
} from "@/test/dashboard-fetch";
import { resetDashboardNavigation } from "@/test/dashboard-navigation";
import { renderBesideReads } from "@/test/dashboard-reads";
import { SANDBOX_PROJECT } from "@/test/projects";
import { restoreWindowLocation } from "@/test/window-location";
import { MemberActions } from "./member-actions";
import { membersQueryKeys } from "./members-query-key";

vi.mock("next/navigation", () => import("@/test/next-navigation"));

function refused(): Response {
  return dashboardErrorResponse(503, "upstream unavailable");
}

function mutations(fetchMock: Parameters<typeof sentDashboardRequests>[0]): SentDashboardRequest[] {
  return sentDashboardRequests(fetchMock).filter((request) => request.method !== "GET");
}

const MEMBERS_DIRECTORY = membersQueryKeys.directory(
  { projectId: SANDBOX_PROJECT.id, mode: "live" },
  { page: 1 }
);

function actions(memberId: string, role: OrganizationRole) {
  return (
    <MemberActions
      memberId={memberId}
      label="Teammate"
      role={role}
      isSelf={false}
      isLastAdmin={false}
    />
  );
}

function row(memberId: string, role: OrganizationRole) {
  return (
    <I18nProvider locale="en" messages={getMessages("en")}>
      {actions(memberId, role)}
    </I18nProvider>
  );
}

beforeEach(() => {
  window.sessionStorage.clear();
  resetIdempotencyKeyStoresForTests();
  resetDashboardNavigation();
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  restoreWindowLocation();
});

describe("MemberActions role change", () => {
  it("keeps a failed change's key for its retry, and gives another role or member a new one", async () => {
    const fetchMock = stubDashboardFetch(refused);
    const user = userEvent.setup();
    const choose = async (item: string, calls: number) => {
      const trigger = screen.getByRole("button", { name: "Actions for Teammate" });
      await waitFor(() => expect(trigger.hasAttribute("disabled")).toBe(false));
      await user.click(trigger);
      await user.click(await screen.findByRole("menuitem", { name: item }));
      await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(calls));
    };
    const { rerender } = render(row("mem_test_1", "member"));

    await choose("Make admin", 1);
    await choose("Make admin", 2);
    rerender(row("mem_test_1", "admin"));
    await choose("Make member", 3);
    rerender(row("mem_test_2", "member"));
    await choose("Make admin", 4);

    const sent = mutations(fetchMock);
    const keys = sent.map((request) => request.idempotencyKey);
    expect(sent.map(({ method, path, body }) => [method, path, body])).toEqual([
      ["PATCH", "/api/dashboard/members/mem_test_1", { role: "admin" }],
      ["PATCH", "/api/dashboard/members/mem_test_1", { role: "admin" }],
      ["PATCH", "/api/dashboard/members/mem_test_1", { role: "member" }],
      ["PATCH", "/api/dashboard/members/mem_test_2", { role: "admin" }],
    ]);
    expect(keys[0]).toEqual(expect.any(String));
    expect(keys[1]).toBe(keys[0]);
    expect(new Set(keys).size).toBe(3);
  });

  it("re-reads the members after a change", async () => {
    const fetchMock = stubDashboardFetch(() => dashboardDataResponse(200, {}));
    const user = userEvent.setup();
    renderBesideReads(actions("mem_test_1", "member"), [MEMBERS_DIRECTORY]);

    await user.click(screen.getByRole("button", { name: "Actions for Teammate" }));
    await user.click(await screen.findByRole("menuitem", { name: "Make admin" }));

    await waitFor(() => expect(readsOf(fetchMock, dashboardRequestUrl(MEMBERS_DIRECTORY))).toBe(2));
  });
});

describe("MemberActions role choices", () => {
  it("offers every other role, read-only included", async () => {
    const fetchMock = stubDashboardFetch(refused);
    const user = userEvent.setup();
    render(row("mem_test_viewer", "member"));

    await user.click(screen.getByRole("button", { name: "Actions for Teammate" }));
    const items = (await screen.findAllByRole("menuitem")).map((item) => item.textContent);
    expect(items).toEqual(["Make admin", "Make read-only", "Remove member"]);

    await user.click(screen.getByRole("menuitem", { name: "Make read-only" }));
    await waitFor(() => expect(fetchMock).toHaveBeenCalledOnce());
    expect(mutations(fetchMock).map((request) => request.body)).toEqual([{ role: "viewer" }]);
  });
});

describe("MemberActions removal", () => {
  const openRemoval = async (user: ReturnType<typeof userEvent.setup>) => {
    await user.click(screen.getByRole("button", { name: "Actions for Teammate" }));
    await user.click(await screen.findByRole("menuitem", { name: "Remove member" }));
    return within(await screen.findByRole("dialog", { name: "Remove member" }));
  };

  it("holds the removal until the member's keys load", async () => {
    stubDashboardFetch(() => new Promise<Response>(() => {}));
    const user = userEvent.setup();
    render(row("mem_test_keys_pending", "member"));

    const dialog = await openRemoval(user);
    expect(dialog.getByText("Checking the API keys this member created…")).toBeTruthy();
    expect(dialog.getByRole("button", { name: "Remove member" }).hasAttribute("disabled")).toBe(
      true
    );
  });

  it("removes anyway after the keys fail to load", async () => {
    const fetchMock = stubDashboardFetch(refused);
    const user = userEvent.setup();
    render(row("mem_test_keys_failed", "member"));

    const dialog = await openRemoval(user);
    await user.click(await dialog.findByRole("button", { name: "Remove anyway" }));
    expect(
      dialog.getByText(
        "Could not load the API keys this member created. Removing them does not revoke their keys."
      )
    ).toBeTruthy();
    await waitFor(() =>
      expect(mutations(fetchMock)).toEqual([
        {
          path: "/api/dashboard/members/mem_test_keys_failed",
          method: "DELETE",
          idempotencyKey: expect.any(String),
          body: undefined,
        },
      ])
    );
  });

  it("lists the member's keys once they load, then removes and re-reads the members", async () => {
    const keysAnswer = Promise.withResolvers<Response>();
    const fetchMock = stubDashboardFetch(({ method, path }) =>
      path === dashboardRequestUrl(MEMBERS_DIRECTORY)
        ? dashboardDataResponse(200, {})
        : method === "GET"
          ? keysAnswer.promise.then((response) => response.clone())
          : new Response(null, { status: 204 })
    );
    const user = userEvent.setup();
    renderBesideReads(actions("mem_test_removed", "member"), [MEMBERS_DIRECTORY]);

    const dialog = await openRemoval(user);
    expect(dialog.getByText("Checking the API keys this member created…")).toBeTruthy();
    keysAnswer.resolve(
      dashboardDataResponse(200, {
        apiKeys: [
          {
            id: "key_test_1",
            name: "Deploy bot",
            keyPrefix: "sdp_test",
            projectId: "prj_test_sandbox",
            projectName: "Sandbox",
            environment: "sandbox",
            createdAt: "2026-10-01T00:00:00.000Z",
          },
        ],
      })
    );
    expect(await dialog.findByText("Deploy bot")).toBeTruthy();
    expect(dialog.queryByText("Checking the API keys this member created…")).toBeNull();
    await user.click(dialog.getByRole("button", { name: "Remove member" }));

    await waitFor(() => expect(readsOf(fetchMock, dashboardRequestUrl(MEMBERS_DIRECTORY))).toBe(2));
    expect(mutations(fetchMock).map(({ method, path }) => [method, path])).toEqual([
      ["DELETE", "/api/dashboard/members/mem_test_removed"],
    ]);
  });
});
