// @vitest-environment jsdom
import { cleanup, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { dashboardRouter, resetDashboardNavigation } from "@/test/dashboard-navigation";
import { EnglishI18n } from "@/test/i18n";
import { SANDBOX_PROJECT } from "@/test/projects";
import { restoreWindowLocation } from "@/test/window-location";
import { MembersPagination } from "./members-pagination";

vi.mock("next/navigation", () => import("@/test/next-navigation"));

beforeEach(() => {
  resetDashboardNavigation();
});

afterEach(() => {
  cleanup();
  restoreWindowLocation();
});

describe("MembersPagination", () => {
  it("pages from the live URL, so a shallow Members tab stays selected", async () => {
    window.history.replaceState(null, "", `/dashboard/${SANDBOX_PROJECT.id}/settings?tab=members`);
    const user = userEvent.setup();
    render(<MembersPagination meta={{ total: 60, page: 1, pageSize: 25, hasMore: true }} />, {
      wrapper: EnglishI18n,
    });

    await user.click(screen.getByRole("button", { name: "Next page" }));

    expect(dashboardRouter.push).toHaveBeenCalledWith(
      `/dashboard/${SANDBOX_PROJECT.id}/settings?tab=members&membersPage=2`,
      { scroll: false }
    );
  });
});
