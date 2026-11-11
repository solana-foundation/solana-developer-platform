// @vitest-environment jsdom
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { resetIdempotencyKeyStoresForTests } from "@/lib/idempotency-key-store";
import {
  dashboardErrorResponse,
  sentDashboardRequests,
  stubDashboardFetch,
} from "@/test/dashboard-fetch";
import { dashboardRouter, resetDashboardNavigation } from "@/test/dashboard-navigation";
import { EnglishI18n } from "@/test/i18n";
import { SANDBOX_PROJECT } from "@/test/projects";
import { restoreWindowLocation } from "@/test/window-location";
import { InvitationActions } from "./invitation-actions";

vi.mock("next/navigation", () => import("@/test/next-navigation"));

const MEMBERS_TAB_URL = `/dashboard/${SANDBOX_PROJECT.id}/settings?tab=members`;

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
  it.each<[() => Response, [string, { scroll: boolean }][]]>([
    [() => new Response(null, { status: 204 }), [[MEMBERS_TAB_URL, { scroll: false }]]],
    [() => dashboardErrorResponse(503, "upstream unavailable"), []],
  ])(
    "revokes under its key and re-reads the page only once it lands (%#)",
    async (answer, replaced) => {
      const fetchMock = stubDashboardFetch(answer);
      const user = userEvent.setup();
      render(<InvitationActions invitationId="inv_test_1" email="invitee@example.test" />, {
        wrapper: EnglishI18n,
      });
      const trigger = screen.getByRole("button", { name: "Actions for invitee@example.test" });

      await user.click(trigger);
      await user.click(await screen.findByRole("menuitem", { name: "Revoke invite" }));
      await waitFor(() => expect(fetchMock).toHaveBeenCalledOnce());
      await waitFor(() => expect(trigger.hasAttribute("disabled")).toBe(false));

      expect(sentDashboardRequests(fetchMock)).toEqual([
        {
          path: "/api/dashboard/members/invitations/inv_test_1",
          method: "DELETE",
          idempotencyKey: expect.any(String),
          body: undefined,
        },
      ]);
      expect(dashboardRouter.replace.mock.calls).toEqual(replaced);
    }
  );
});
