// @vitest-environment jsdom

import type { PrivateChannelInstance } from "@sdp/types/private-channels";
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import type { ReactNode } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { dashboardErrorResponse, stubDashboardFetch } from "@/test/dashboard-fetch";
import { dashboardRouter, resetDashboardNavigation } from "@/test/dashboard-navigation";
import { DashboardReadsProvider } from "@/test/dashboard-reads";
import { EnglishI18n } from "@/test/i18n";
import { privateChannelInstanceFixture } from "@/test/private-channels";
import { PrivateChannelsInstanceGate } from "./private-channels-instance-gate";

vi.mock("next/navigation", () => import("@/test/next-navigation"));

type GateMatch = "active" | { instanceId: string; requireActive: boolean };

const ACTIVE = privateChannelInstanceFixture({ id: "pci_test_a", isActive: true });
const INACTIVE = privateChannelInstanceFixture({ id: "pci_test_a", isActive: false });
const OTHER = privateChannelInstanceFixture({ id: "pci_test_b", isActive: true });

function instanceAnswer(instance: PrivateChannelInstance | null): () => Response {
  return () => Response.json({ data: { instance } });
}

function Reads({ children }: { children: ReactNode }) {
  return (
    <DashboardReadsProvider>
      <EnglishI18n>{children}</EnglishI18n>
    </DashboardReadsProvider>
  );
}

function renderGate(match: GateMatch, answer: () => Response) {
  stubDashboardFetch(answer);
  render(
    <PrivateChannelsInstanceGate match={match} skeleton={<p>Loading instance</p>}>
      {(gated) => <p>{`Instance ${gated.id}`}</p>}
    </PrivateChannelsInstanceGate>,
    { wrapper: Reads }
  );
}

beforeEach(() => {
  resetDashboardNavigation();
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe("PrivateChannelsInstanceGate", () => {
  it.each<[string, GateMatch, PrivateChannelInstance | null]>([
    ["no instance", { instanceId: "pci_test_a", requireActive: false }, null],
    ["another instance", { instanceId: "pci_test_a", requireActive: false }, OTHER],
    ["a disconnected instance", { instanceId: "pci_test_a", requireActive: true }, INACTIVE],
  ])("renders the Project's not-found view for %s", async (_case, match, instance) => {
    renderGate(match, instanceAnswer(instance));

    expect(
      await screen.findByText("The page you're looking for doesn't exist or may have moved.")
    ).toBeTruthy();
    expect(screen.queryByText(/^Instance /)).toBeNull();
    expect(dashboardRouter.replace).not.toHaveBeenCalled();
  });

  it.each<[string, PrivateChannelInstance | null]>([
    ["no instance", null],
    ["a disconnected instance", INACTIVE],
  ])("replaces the address with setup for %s", async (_case, instance) => {
    renderGate("active", instanceAnswer(instance));

    await waitFor(() =>
      expect(dashboardRouter.replace).toHaveBeenCalledWith(
        "/dashboard/prj_test_sandbox/integrations/private-channels/setup"
      )
    );
    expect(screen.getByText("Loading instance")).toBeTruthy();
    expect(screen.queryByText(/^Instance /)).toBeNull();
  });

  it.each<[string, GateMatch, PrivateChannelInstance]>([
    ["any active instance", "active", ACTIVE],
    ["the named active instance", { instanceId: "pci_test_a", requireActive: true }, ACTIVE],
    [
      "the named disconnected instance",
      { instanceId: "pci_test_a", requireActive: false },
      INACTIVE,
    ],
  ])("renders its children for %s", async (_case, match, instance) => {
    renderGate(match, instanceAnswer(instance));

    expect(await screen.findByText("Instance pci_test_a")).toBeTruthy();
    expect(dashboardRouter.replace).not.toHaveBeenCalled();
  });

  it("shows the read's error with a retry when the instance cannot be read", async () => {
    renderGate("active", () => dashboardErrorResponse(503, "Gateway unavailable"));

    expect(await screen.findByText("Gateway unavailable")).toBeTruthy();
    expect(screen.getByRole("button", { name: "Try again" })).toBeTruthy();
    expect(dashboardRouter.replace).not.toHaveBeenCalled();
  });
});
