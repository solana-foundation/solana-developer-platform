import { describe, expect, it } from "vitest";
import { DEVNET_IDENTITY_VERSION, deriveDevnetOwner } from "./harness.js";

describe("versioned devnet identities", () => {
  it("pins the owner namespace to v2", async () => {
    const seed = new Uint8Array(32).fill(1);

    const owner0 = await deriveDevnetOwner(seed, 0);
    const owner1 = await deriveDevnetOwner(seed, 1);

    expect(DEVNET_IDENTITY_VERSION).toBe("v2");
    expect([owner0.address, owner1.address]).toEqual([
      "Fo5Z6a3V4uzNTKgSQ5o3ZK9gUtRejavZwyD1cdJeoey2",
      "9TNve634uHv2UygkVhxPvRuYmcAtKEfvA8AhK2rBGBdY",
    ]);
  });
});
