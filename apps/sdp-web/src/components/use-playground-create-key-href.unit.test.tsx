// @vitest-environment jsdom

import { renderHook } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { resetDashboardNavigation } from "@/test/dashboard-navigation";

const workspace = vi.hoisted(() => ({ canManageApiKeys: true }));

vi.mock("next/navigation", () => import("@/test/next-navigation"));
vi.mock("@/contexts/dashboard-workspace-context", () => ({
  useDashboardWorkspace: () => ({
    dashboardAccess: { capabilities: { canManageApiKeys: workspace.canManageApiKeys } },
  }),
}));

const { usePlaygroundCreateKeyHref } = await import("./use-playground-create-key-href");

beforeEach(() => {
  resetDashboardNavigation();
  workspace.canManageApiKeys = true;
});

describe("usePlaygroundCreateKeyHref", () => {
  it("keeps the new-key page inside the project this tab shows", () => {
    const { result } = renderHook(() => usePlaygroundCreateKeyHref());
    expect(result.current).toBe("/dashboard/prj_test_sandbox/api-keys/new");
  });

  it("offers nothing to someone who may not manage keys", () => {
    workspace.canManageApiKeys = false;
    const { result } = renderHook(() => usePlaygroundCreateKeyHref());
    expect(result.current).toBeUndefined();
  });
});
