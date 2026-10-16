import { describe, expect, it } from "vitest";
import { resolveOnboardingSetup } from "./state";

describe("resolveOnboardingSetup", () => {
  it("starts new organizations at custody", () => {
    expect(
      resolveOnboardingSetup({
        completedAt: null,
        custodyProviders: [],
        canManage: true,
        version: 1,
      })
    ).toEqual({
      status: "not_started",
      currentStep: "custody",
      custodyProviders: [],
      completedAt: null,
      canManage: true,
      version: 1,
    });
  });

  it("does not trust a custody wallet alone to mark onboarding complete", () => {
    expect(
      resolveOnboardingSetup({
        completedAt: null,
        custodyProviders: ["privy"],
        canManage: true,
        version: 1,
      })
    ).toEqual({
      status: "in_progress",
      currentStep: "custody",
      custodyProviders: ["privy"],
      completedAt: null,
      canManage: true,
      version: 1,
    });
  });

  it("keeps backfilled organizations complete even without a custody wallet", () => {
    expect(
      resolveOnboardingSetup({
        completedAt: "2026-07-21 12:00:00",
        custodyProviders: [],
        canManage: false,
        version: 1,
      })
    ).toEqual({
      status: "complete",
      currentStep: "complete",
      custodyProviders: [],
      completedAt: "2026-07-21 12:00:00",
      canManage: false,
      version: 1,
    });
  });
});
