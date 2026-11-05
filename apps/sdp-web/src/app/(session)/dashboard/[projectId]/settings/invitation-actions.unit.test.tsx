// @vitest-environment jsdom
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as membersActions from "@/app/(session)/members/actions";
import { resetIdempotencyKeyStoresForTests } from "@/lib/idempotency-key-store";
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
  vi.restoreAllMocks();
  restoreWindowLocation();
});

describe("InvitationActions", () => {
  it.each<[membersActions.MemberActionResult, [string, { scroll: boolean }][]]>([
    [{ status: "success" }, [[MEMBERS_TAB_URL, { scroll: false }]]],
    [
      {
        status: "error",
        message: "upstream unavailable",
        answer: { status: 503, replayed: false, code: null },
      },
      [],
    ],
  ])(
    "re-reads the page at the live URL only once a revocation lands: %j",
    async (result, replaced) => {
      const revoke = vi.spyOn(membersActions, "revokeInvitation").mockResolvedValue(result);
      const user = userEvent.setup();
      render(<InvitationActions invitationId="inv_test_1" email="invitee@example.test" />, {
        wrapper: EnglishI18n,
      });
      const trigger = screen.getByRole("button", { name: "Actions for invitee@example.test" });

      await user.click(trigger);
      await user.click(await screen.findByRole("menuitem", { name: "Revoke invite" }));
      await waitFor(() => expect(revoke).toHaveBeenCalledOnce());
      await waitFor(() => expect(trigger.hasAttribute("disabled")).toBe(false));

      expect(dashboardRouter.replace.mock.calls).toEqual(replaced);
    }
  );
});
