import { describe, expect, it } from "vitest";
import { vaultAsyncWithdrawalRequestFingerprint } from "./earn-vault-async-withdrawal-tracking";

describe("vaultAsyncWithdrawalRequestFingerprint", () => {
  const intent = {
    projectId: "project_1",
    positionId: "position_1",
    shares: "5",
    route: {
      kind: "queue" as const,
      discountBps: 25,
      deadlineSeconds: 360,
    },
  };

  it("is stable for the same asynchronous-withdrawal intent", () => {
    // A semantically identical intent whose object keys are ordered
    // differently must not change the fingerprint, so a whole-object
    // serialization would fail here.
    const sameIntent = {
      positionId: intent.positionId,
      shares: intent.shares,
      projectId: intent.projectId,
      route: {
        deadlineSeconds: intent.route.deadlineSeconds,
        discountBps: intent.route.discountBps,
        kind: intent.route.kind,
      },
    } satisfies typeof intent;
    expect(vaultAsyncWithdrawalRequestFingerprint(sameIntent)).toBe(
      vaultAsyncWithdrawalRequestFingerprint(intent)
    );
  });

  const changedIntents = [
    ["project", { ...intent, projectId: "project_2" }],
    ["position", { ...intent, positionId: "position_2" }],
    ["shares", { ...intent, shares: "6" }],
    ["discount", { ...intent, route: { ...intent.route, discountBps: 26 } }],
    ["deadline", { ...intent, route: { ...intent.route, deadlineSeconds: 361 } }],
  ] satisfies ReadonlyArray<readonly [string, typeof intent]>;

  it.each(changedIntents)("changes when the %s changes", (_label, changed) => {
    expect(vaultAsyncWithdrawalRequestFingerprint(changed)).not.toBe(
      vaultAsyncWithdrawalRequestFingerprint(intent)
    );
  });

  it("separates operator redemption from a solver queue without queue-only fields", () => {
    const operatorIntent = {
      projectId: intent.projectId,
      positionId: intent.positionId,
      shares: intent.shares,
      route: { kind: "operator_redemption" as const },
    };

    expect(vaultAsyncWithdrawalRequestFingerprint(operatorIntent)).toBe(
      JSON.stringify(["project_1", "position_1", "5", "operator_redemption"])
    );
    expect(vaultAsyncWithdrawalRequestFingerprint(operatorIntent)).not.toBe(
      vaultAsyncWithdrawalRequestFingerprint(intent)
    );
  });
});
