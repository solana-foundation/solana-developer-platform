import { describe, expect, it } from "vitest";
import { resolveOnboardingSetup } from "./state";

describe("resolveOnboardingSetup", () => {
  it("starts new organizations at RPC selection", () => {
    expect(
      resolveOnboardingSetup({
        completedAt: null,
        rpcProvider: null,
        custodyProvider: null,
        canManage: true,
        version: 1,
      })
    ).toEqual({
      status: "not_started",
      currentStep: "rpc",
      rpcProvider: null,
      custodyProvider: null,
      completedAt: null,
      canManage: true,
      version: 1,
    });
  });

  it("resumes at custody once the RPC choice is persisted", () => {
    expect(
      resolveOnboardingSetup({
        completedAt: null,
        rpcProvider: "helius",
        custodyProvider: null,
        canManage: true,
        version: 1,
      })
    ).toMatchObject({ status: "in_progress", currentStep: "custody" });
  });

  it("does not trust prerequisites alone to mark onboarding complete", () => {
    expect(
      resolveOnboardingSetup({
        completedAt: null,
        rpcProvider: "default",
        custodyProvider: "privy",
        canManage: true,
        version: 1,
      })
    ).toMatchObject({ status: "in_progress", currentStep: "custody" });
  });

  it("keeps backfilled organizations complete even without provider selections", () => {
    expect(
      resolveOnboardingSetup({
        completedAt: "2026-07-21 12:00:00",
        rpcProvider: null,
        custodyProvider: null,
        canManage: false,
        version: 1,
      })
    ).toMatchObject({
      status: "complete",
      currentStep: "complete",
      completedAt: "2026-07-21 12:00:00",
      canManage: false,
    });
  });
});
