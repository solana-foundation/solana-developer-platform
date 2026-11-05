// @vitest-environment jsdom
import { cleanup, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { dashboardRequestUrl } from "@/lib/dashboard-request-key";
import { resetIdempotencyKeyStoresForTests } from "@/lib/idempotency-key-store";
import {
  dashboardDataResponse,
  dashboardErrorResponse,
  readsOf,
  sentDashboardRequests,
  stubDashboardFetch,
} from "@/test/dashboard-fetch";
import { resetDashboardNavigation } from "@/test/dashboard-navigation";
import { renderBesideReads } from "@/test/dashboard-reads";
import { SANDBOX_PROJECT } from "@/test/projects";
import { restoreWindowLocation } from "@/test/window-location";
import { InvitationActions } from "./invitation-actions";
import { membersQueryKeys } from "./members-query-key";

vi.mock("next/navigation", () => import("@/test/next-navigation"));

const MEMBERS_TAB_URL = `/dashboard/${SANDBOX_PROJECT.id}/settings?tab=members`;
const MEMBERS_DIRECTORY = membersQueryKeys.directory(
  { projectId: SANDBOX_PROJECT.id, mode: "live" },
  { page: 1 }
);

beforeEach(() => {
  window.sessionStorage.clear();
  resetIdempotencyKeyStoresForTests();
  resetDashboardNavigation();
  window.history.replaceState(null, "", MEMBERS_TAB_URL);
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  restoreWindowLocation();
});

describe("InvitationActions", () => {
  it.each<[() => Response, number]>([
    [() => new Response(null, { status: 204 }), 2],
    [() => dashboardErrorResponse(503, "upstream unavailable"), 1],
  ])(
    "revokes under its key and re-reads the members only once it lands (%#)",
    async (answer, directoryReads) => {
      const fetchMock = stubDashboardFetch(({ method }) =>
        method === "GET" ? dashboardDataResponse(200, {}) : answer()
      );
      const user = userEvent.setup();
      renderBesideReads(
        <InvitationActions invitationId="inv_test_1" email="invitee@example.test" />,
        [MEMBERS_DIRECTORY]
      );
      const trigger = screen.getByRole("button", { name: "Actions for invitee@example.test" });

      await user.click(trigger);
      await user.click(await screen.findByRole("menuitem", { name: "Revoke invite" }));
      const writes = () =>
        sentDashboardRequests(fetchMock).filter(({ method }) => method !== "GET");
      await waitFor(() => expect(writes()).toHaveLength(1));
      await waitFor(() => expect(trigger.hasAttribute("disabled")).toBe(false));

      await waitFor(() =>
        expect(readsOf(fetchMock, dashboardRequestUrl(MEMBERS_DIRECTORY))).toBe(directoryReads)
      );
      expect(writes()).toEqual([
        {
          path: "/api/dashboard/members/invitations/inv_test_1",
          method: "DELETE",
          idempotencyKey: expect.any(String),
          body: undefined,
        },
      ]);
    }
  );
});
