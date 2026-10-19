import { describe, expect, it } from "vitest";
import { env } from "@/test/helpers/env";
import { CRON_DEFINITIONS } from "./runner";

describe("CRON_DEFINITIONS", () => {
  it("gives every definition a unique name", () => {
    const names = CRON_DEFINITIONS.map((definition) => definition.name);

    expect(names).toEqual([...new Set(names)]);
  });

  it("pins the definitions that start money without admission, so the list only shrinks", () => {
    const gaps = CRON_DEFINITIONS.filter(
      (definition) => definition.effect === "starts" && "gap" in definition.admission
    ).map((definition) => definition.name);

    expect(gaps).toEqual(["poll-rings-indexing"]);
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
