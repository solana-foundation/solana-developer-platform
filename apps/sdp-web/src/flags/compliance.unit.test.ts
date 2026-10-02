import { describe, expect, it } from "vitest";
import { resolveComplianceEnabled } from "./compliance";

const on = async () => true;
const off = async () => false;

describe("resolveComplianceEnabled", () => {
  it.each([
    ["policies on", on, true],
    ["policies off", off, false],
  ] as const)("experimental, %s → %s", async (_, policies, expected) => {
    await expect(
      resolveComplianceEnabled({ releaseChannel: "experimental", policies })
    ).resolves.toBe(expected);
  });

  it("stays hidden on stable, where the policies flag is capped off", async () => {
    await expect(
      resolveComplianceEnabled({ releaseChannel: "stable", policies: off })
    ).resolves.toBe(false);
  });
});
