// @vitest-environment jsdom

import type { Project } from "@sdp/types/projects";
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import * as workspaceContext from "@/contexts/dashboard-workspace-context";
import { EnglishI18n } from "@/test/i18n";
import { PRODUCTION_PROJECT } from "@/test/projects";
import { PlanSection } from "./plan-section";

function renderPlan(productionProject: Project | null) {
  vi.mocked(vi.spyOn(workspaceContext, "useDashboardWorkspace"), {
    partial: true,
  }).mockReturnValue({ productionProject });
  render(<PlanSection />, { wrapper: EnglishI18n });
}

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

describe("PlanSection", () => {
  it("shows the Free plan with its key limit and seats, and mainnet as pending review", () => {
    renderPlan(null);

    expect(screen.getByText("Free")).toBeDefined();
    expect(screen.getByText("Devnet. Mainnet after review.")).toBeDefined();
    expect(screen.getByText("100 requests per minute per key")).toBeDefined();
    expect(screen.getByText("Up to 20")).toBeDefined();
  });

  it("names both networks once mainnet access is approved", () => {
    renderPlan(PRODUCTION_PROJECT);

    expect(screen.getByText("Devnet and mainnet")).toBeDefined();
  });
});
