import { address } from "@solana/kit";
import { beforeAll, describe, expect, it } from "vitest";
import {
  CustodyWalletAuthority,
  type OperationAuthorization,
  RingsApprovalMismatchError,
  RingsUnsupportedFlowError,
} from "./authority.js";
import { createShieldedMaterial, type ShieldedMaterial } from "./material.js";

const OWNER = "GsbwXfJraMomNxBcjK1DiP5Mth8ZmQpDUFTmKfhtiHgo";
const OTHER_OWNER = "6Ecs4vFmtiZ7WeQMWZibhFPQF3q3Pmqrb7CQGRJJKQTM";

const AUTHORIZATION: OperationAuthorization = {
  owner: OWNER,
  operationId: "op-1",
  intentKey: "sha256:abc",
};

let material: ShieldedMaterial;

function authorityFor(authorization: Partial<OperationAuthorization> = {}): CustodyWalletAuthority {
  return new CustodyWalletAuthority({
    material,
    authorization: { ...AUTHORIZATION, ...authorization },
  });
}

// Fixed bytes rather than a derivation: the authority is indifferent to where
// its material came from, and depending on a key authority here would make the
// authority's tests break when that authority is eventually replaced.
beforeAll(async () => {
  material = await createShieldedMaterial({
    viewingKeyBytes: new Uint8Array(32).fill(7),
    nullifierKeyBytes: new Uint8Array(31).fill(11),
    owner: OWNER,
  });

  return () => material.destroy();
});

describe("CustodyWalletAuthority", () => {
  it("reports the authorized owner as the Solana identity", () => {
    expect(authorityFor().solanaPublicKey()).toBe(OWNER);
  });

  it("carries the operation and intent it was authorized for", () => {
    const authority = authorityFor();

    expect(authority.operationId()).toBe("op-1");
    expect(authority.intentKey()).toBe("sha256:abc");
  });

  it.each(["operationId", "intentKey"] as const)(
    "refuses to be constructed without %s",
    (field) => {
      expect(() => authorityFor({ [field]: "" })).toThrow(/needs the/);
    }
  );

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
