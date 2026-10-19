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
});
