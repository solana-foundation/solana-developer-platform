// @vitest-environment jsdom

import { act, cleanup, render, screen } from "@testing-library/react";
import { memo } from "react";
import { afterEach, expect, it, vi } from "vitest";
import { resetDashboardNavigation, setDashboardUrl } from "@/test/dashboard-navigation";
import { SANDBOX_PROJECT } from "@/test/projects";

vi.mock("next/navigation", () => import("@/test/next-navigation"));

import { useDashboardTab, useSyncDashboardUrlStateWithRouter } from "./dashboard-url-state";

const TabReader = memo(function TabReader() {
  return <p>{useDashboardTab() ?? "hub"}</p>;
});

function SyncedShell() {
  useSyncDashboardUrlStateWithRouter();
  return <TabReader />;
}

function navigateWithLink(path: string) {
  window.history.pushState(null, "", path);
  setDashboardUrl(path, {});
}

afterEach(() => {
  cleanup();
  window.history.replaceState(null, "", "/");
  resetDashboardNavigation();
});

it("shows the tab a `?tab=` link opened on the first navigation", () => {
  window.history.replaceState(null, "", `/dashboard/${SANDBOX_PROJECT.id}`);
  const { rerender } = render(<SyncedShell />);
  expect(screen.getByText("hub")).toBeTruthy();

  act(() => {
    navigateWithLink(`/dashboard/${SANDBOX_PROJECT.id}/integrations?tab=rpc`);
    rerender(<SyncedShell />);
  });

  expect(screen.getByText("rpc")).toBeTruthy();
});
