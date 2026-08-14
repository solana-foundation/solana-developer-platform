import type { PolicyRule } from "@sdp/types";
import { describe, expect, it } from "vitest";
import { collectDestinationAllowlist, resolveTransferCaps } from "./wallet-policy-rules";

describe("wallet policy rules", () => {
  it("collects destination allowlist variants without duplicates", () => {
    const rules: PolicyRule[] = [
      {
        kind: "destination",
        destination: "DestinationA",
        destinations: ["DestinationB"],
        allowlist: ["DestinationA", "DestinationC"],
      },
    ];

    expect(collectDestinationAllowlist(rules)).toEqual([
      "DestinationA",
      "DestinationB",
      "DestinationC",
    ]);
  });

  it("expands singular and plural transfer caps and keeps the first cap per asset", () => {
    const rules: PolicyRule[] = [
      {
        kind: "amount",
        asset: "MintA",
        assets: ["MintA", "MintB"],
        max: "100",
      },
      { kind: "amount", asset: "MintB", max: "50" },
      { kind: "amount", assets: ["MintC"], min: "1", max: "75" },
      { kind: "amount", max: "25" },
    ];

    expect(resolveTransferCaps(rules)).toEqual([
      { asset: "MintA", max: "100" },
      { asset: "MintB", max: "100" },
      { asset: "MintC", max: "75" },
    ]);
  });
});
