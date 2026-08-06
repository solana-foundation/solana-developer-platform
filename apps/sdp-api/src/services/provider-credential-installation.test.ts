import { describe, expect, it } from "vitest";
import { decideInstallation, type InstallationFacts } from "./provider-credential-installation";

const NOW = Date.parse("2026-08-06T12:00:00.000Z");

function facts(overrides: Partial<InstallationFacts> = {}): InstallationFacts {
  return {
    connectionStatus: "pending",
    credentialStatus: "pending",
    isStoredProjectCredential: true,
    hasDefaultWallet: false,
    hasOwnedWallet: false,
    providerAccountFingerprint: null,
    activatedAt: null,
    lastCheckStatus: null,
    lastCheckAt: null,
    hasSiblingUnfinished: false,
    fullCompletionEnabled: true,
    nowMs: NOW,
    ...overrides,
  };
}

describe("provider credential installation decisions", () => {
  it("admits full completion, blocks a live lease, and reclaims an expired lease", () => {
    expect(decideInstallation(facts()).complete).toEqual({ kind: "execute", mode: "full" });

    const checking = {
      connectionStatus: "checking" as const,
      lastCheckStatus: "running",
      lastCheckAt: "2026-08-06T11:59:30.000Z",
    };
    expect(decideInstallation(facts(checking)).complete).toEqual({
      kind: "conflict",
      reason: "completion_in_progress",
    });
    expect(
      decideInstallation(facts({ ...checking, lastCheckAt: "2026-08-06T11:58:00.000Z" })).complete
    ).toEqual({ kind: "execute", mode: "full" });
  });

  it("allows flag-off reconciliation only after the Provider account is pinned", () => {
    expect(decideInstallation(facts({ fullCompletionEnabled: false })).complete).toEqual({
      kind: "disabled",
    });
    expect(
      decideInstallation(
        facts({
          fullCompletionEnabled: false,
          providerAccountFingerprint: "sha256:app",
          lastCheckStatus: "retry_unknown",
          lastCheckAt: "2026-08-06T11:58:00.000Z",
        })
      ).complete
    ).toEqual({ kind: "execute", mode: "reconcile_only" });

    expect(
      decideInstallation(
        facts({
          providerAccountFingerprint: "sha256:app",
          lastCheckStatus: "retry_unknown",
          lastCheckAt: "2026-08-06T11:58:00.000Z",
        })
      ).complete
    ).toEqual({ kind: "execute", mode: "full" });
  });

  it("allows cancellation only before account pinning and replacement only for safe failure", () => {
    expect(decideInstallation(facts()).cancel).toEqual({ kind: "execute" });
    expect(decideInstallation(facts({ providerAccountFingerprint: "sha256:app" })).cancel).toEqual({
      kind: "conflict",
      reason: "installation_completion_required",
    });

    const failed = facts({
      connectionStatus: "failed",
      credentialStatus: "failed_validation",
      lastCheckStatus: "failed",
      lastCheckAt: "2026-08-06T11:58:00.000Z",
    });
    expect(decideInstallation(failed).replace).toEqual({ kind: "execute" });
    expect(decideInstallation({ ...failed, hasSiblingUnfinished: true }).replace).toEqual({
      kind: "conflict",
      reason: "unfinished_installation_exists",
    });
  });

  it("fails closed on inconsistent persisted lifecycle facts", () => {
    const decision = decideInstallation(
      facts({ connectionStatus: "active", credentialStatus: "active" })
    );
    expect(decision.consistent).toBe(false);
    expect(decision.complete).toEqual({ kind: "conflict" });
    expect(decision.cancel).toEqual({ kind: "conflict" });
    expect(decision.replace).toEqual({ kind: "conflict" });

    expect(decideInstallation(facts({ isStoredProjectCredential: false })).consistent).toBe(false);
    expect(
      decideInstallation(
        facts({
          connectionStatus: "deactivated",
          credentialStatus: "deactivated",
          providerAccountFingerprint: "sha256:established",
          activatedAt: "2026-08-06T11:58:00.000Z",
        })
      ).consistent
    ).toBe(false);

    expect(
      decideInstallation(
        facts({ connectionStatus: "deactivated", credentialStatus: "deactivated" })
      ).cancel
    ).toEqual({ kind: "replay" });
  });
});
