import type { CounterpartyRequirements } from "@sdp/types/ramp-requirements";
import { describe, expect, it } from "vitest";
import { isOnboardingPanelStatus, onboardingCopy } from "./index";

const translate = (key: string) => key;

function bvnk(status: "collect" | "provisioning" | "ready"): CounterpartyRequirements {
  switch (status) {
    case "collect":
      return {
        provider: "bvnk",
        direction: "onramp",
        status: "collect",
        fields: [{ kind: "text", key: "firstName", label: "First name", required: true }],
      };
    case "provisioning":
      return { provider: "bvnk", direction: "onramp", status: "provisioning" };
    case "ready":
      return { provider: "bvnk", direction: "onramp", status: "ready" };
  }
}

describe("BVNK onboarding panel statuses", () => {
  it("renders a waiting state for the provisioning status while it keeps polling", () => {
    const requirements = bvnk("provisioning");
    if (isOnboardingPanelStatus(requirements)) {
      expect(onboardingCopy(requirements, translate).title).toBe(
        "DashboardPayments.bvnk.provisioningTitle"
      );
    } else {
      throw new Error(`expected ${requirements.status} to be a panel status`);
    }
  });

  it("renders the ready status once provisioning completes", () => {
    const requirements = bvnk("ready");
    expect(isOnboardingPanelStatus(requirements)).toBe(true);
  });

  it("keeps the collect status out of the panel so fields render instead", () => {
    const requirements = bvnk("collect");
    expect(isOnboardingPanelStatus(requirements)).toBe(false);
  });
});
