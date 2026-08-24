import { address } from "@solana/kit";
import { beforeAll, describe, expect, it } from "vitest";
import {
  CustodyWalletAuthority,
  RingsApprovalMismatchError,
  RingsUnsupportedFlowError,
} from "./authority.js";
import { deriveShieldedMaterial, type ShieldedMaterial } from "./identity.js";

const SEED = new Uint8Array(32).fill(3);
const OWNER = "GsbwXfJraMomNxBcjK1DiP5Mth8ZmQpDUFTmKfhtiHgo";
const OTHER_OWNER = "6Ecs4vFmtiZ7WeQMWZibhFPQF3q3Pmqrb7CQGRJJKQTM";

let material: ShieldedMaterial;

function authorityFor(owner = OWNER): CustodyWalletAuthority {
  return new CustodyWalletAuthority({
    material,
    authorization: { owner, operationId: "op-1" },
  });
}

beforeAll(async () => {
  material = await deriveShieldedMaterial({ seed: SEED, scope: "authority", owner: OWNER });
  return () => material.destroy();
});

describe("CustodyWalletAuthority", () => {
  it("reports the authorized owner as the Solana identity", () => {
    expect(authorityFor().solanaPublicKey()).toBe(OWNER);
  });

  it("exposes the derived material for sync", async () => {
    const sync = await authorityFor().syncMaterial();

    expect(sync.identity).toBe(material.shieldedAddress);
    expect(sync.viewingKeys).toStrictEqual([material.viewingKey]);
    expect(sync.nullifierKey).toBe(material.nullifierKey);
  });

  it("approves a request for the authorized owner and records its summary", async () => {
    const authority = authorityFor();

    await expect(
      authority.requestUserApproval({ solanaPublicKey: address(OWNER), summary: "withdraw 1 SOL" })
    ).resolves.toBeUndefined();
    expect(authority.approvedSummaries()).toStrictEqual(["withdraw 1 SOL"]);
  });

  it("rejects a request to spend under an owner that was not authorized", async () => {
    const authority = authorityFor();

    await expect(
      authority.requestUserApproval({
        solanaPublicKey: address(OTHER_OWNER),
        summary: "withdraw 1 SOL",
      })
    ).rejects.toBeInstanceOf(RingsApprovalMismatchError);
    expect(authority.approvedSummaries()).toStrictEqual([]);
  });

  it("refuses anonymous transfers", async () => {
    await expect(
      authorityFor().encryptAnonymousTransfer(
        {} as Parameters<CustodyWalletAuthority["encryptAnonymousTransfer"]>[0]
      )
    ).rejects.toBeInstanceOf(RingsUnsupportedFlowError);
  });

  it("refuses splits", async () => {
    await expect(
      authorityFor().encryptSplit({} as Parameters<CustodyWalletAuthority["encryptSplit"]>[0])
    ).rejects.toBeInstanceOf(RingsUnsupportedFlowError);
  });
});
