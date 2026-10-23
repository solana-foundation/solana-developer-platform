import { validate } from "node-cron";
import { describe, expect, it } from "vitest";
import { env } from "@/test/helpers/env";
import { CRON_DEFINITIONS } from "./runner";

describe("CRON_DEFINITIONS", () => {
  it("gives every definition a unique name", () => {
    const names = CRON_DEFINITIONS.map((definition) => definition.name);

    expect(names).toEqual([...new Set(names)]);
  });

  it("pins the definitions that start money, so a new one is reviewed for admission", () => {
    const starts = CRON_DEFINITIONS.filter((definition) => definition.effect === "starts").map(
      (definition) => definition.name
    );

    expect(starts).toEqual(["collect-recurring-payments"]);
  });

  it("keeps every Money Exit but track-pending-withdrawals enabled with every feature flag off", () => {
    const featuresOff = {
      ...env,
      SDP_RELEASE_CHANNEL: "experimental",
      MARKETS_ENABLED: "false",
      EARN_ENABLED: "false",
      PRIVATE_CHANNELS_ENABLED: "false",
      HELIUS_RINGS_ENABLED: "false",
    };

    const disabledExits = CRON_DEFINITIONS.filter(
      (definition) => definition.effect === "finishes" && !definition.enabled(featuresOff)
    ).map((definition) => definition.name);

    expect(disabledExits).toEqual(["track-pending-withdrawals"]);
  });

  it("runs the Earn reconcilers and the metrics refresh once per Environment", () => {
    const scopeByName = new Map(
      CRON_DEFINITIONS.map((definition) => [definition.name, definition.scope])
    );

    expect(
      [
        "reconcile-earn-vault-movements",
        "detect-orphaned-earn-split-swaps",
        "refresh-earn-metrics",
      ].map((name) => scopeByName.get(name))
    ).toEqual(["cluster", "cluster", "cluster"]);
  });

  it("runs the payment request hot lane every 30 seconds and its sweep and expiry every minute", () => {
    const byName = new Map(CRON_DEFINITIONS.map((definition) => [definition.name, definition]));

    expect(byName.get("reconcile-payment-requests-hot")?.schedule).toBe("*/30 * * * * *");
    expect(byName.get("reconcile-payment-requests")?.schedule).toBe("* * * * *");
    expect(byName.get("expire-payment-requests")?.schedule).toBe("* * * * *");
  });

  it("gives every definition a schedule node-cron accepts", () => {
    const invalid = CRON_DEFINITIONS.filter((definition) => !validate(definition.schedule)).map(
      (definition) => definition.name
    );

    expect(invalid).toEqual([]);
  });
});
