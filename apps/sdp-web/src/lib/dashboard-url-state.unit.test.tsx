// @vitest-environment jsdom

import { act, cleanup, render, screen } from "@testing-library/react";
import { memo } from "react";
import { afterEach, expect, it, vi } from "vitest";

const router = vi.hoisted(() => ({ pathname: "/dashboard", search: "" }));

vi.mock("next/navigation", () => ({
  usePathname: () => router.pathname,
  useSearchParams: () => new URLSearchParams(router.search),
}));

import { useDashboardTab, useSyncDashboardUrlStateWithRouter } from "./dashboard-url-state";

// Memoized so it re-renders only when the URL store notifies it, like a page
// that mounted before App Router wrote the new URL to history.
const TabReader = memo(function TabReader() {
  return <p>{useDashboardTab() ?? "hub"}</p>;
});

function SyncedShell() {
  useSyncDashboardUrlStateWithRouter();
  return <TabReader />;
}

/** What a `<Link>` does: history moves, but no popstate or store event fires. */
function navigateWithLink(path: string) {
  window.history.pushState(null, "", path);
  const url = new URL(path, window.location.origin);
  router.pathname = url.pathname;
  router.search = url.search;
}

afterEach(() => {
  cleanup();
  window.history.replaceState(null, "", "/");
  router.pathname = "/dashboard";
  router.search = "";
});

it("shows the tab a `?tab=` link opened on the first navigation", () => {
  window.history.replaceState(null, "", "/dashboard");
  const { rerender } = render(<SyncedShell />);
  expect(screen.getByText("hub")).toBeTruthy();

  act(() => {
    navigateWithLink("/dashboard/integrations?tab=rpc");
    rerender(<SyncedShell />);
  });

  expect(screen.getByText("rpc")).toBeTruthy();
});
