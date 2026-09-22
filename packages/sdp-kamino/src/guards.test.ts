import { createHash } from "node:crypto";
import { KAMINO_KVAULT_PROGRAM_IDS } from "@sdp/types";
import { address } from "@solana/kit";
import { describe, expect, it } from "vitest";
import {
  assertPlanInstructionsSupported,
  assertPlanTargetsCluster,
  KaminoProgramMismatchError,
  KaminoUnsupportedInstructionError,
  planProgramAddresses,
} from "./guards";
import { foreignKvaultProgramId, kaminoClusterConfig } from "./programs";
import type { KaminoInstructionPlan } from "./types";

const ATA_PROGRAM = address("ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL");
const ASSET_IDENTITY = {
  depositTokenMint: address("EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v"),
  shareMint: address("So11111111111111111111111111111111111111112"),
};

function plan(
  cluster: KaminoInstructionPlan["cluster"],
  programs: readonly string[]
): KaminoInstructionPlan {
  return {
    cluster,
    instructions: programs.map((programAddress) => ({
      programAddress: address(programAddress),
      accounts: [],
      data: new Uint8Array(),
    })),
    lookupTables: [],
    assetIdentity: ASSET_IDENTITY,
    accepted: {},
  } as KaminoInstructionPlan;
}

describe("assertPlanTargetsCluster", () => {
  it("accepts a devnet plan naming the devnet kvault program", () => {
    const devnet = kaminoClusterConfig("devnet");
    const accepted = assertPlanTargetsCluster(plan("devnet", [devnet.kvaultProgramId]));
    expect(accepted.cluster).toBe("devnet");
  });

  /**
   * THE REGRESSION THIS PACKAGE EXISTS FOR.
   *
   * klend-sdk's ordinary `new KaminoVault(rpc, addr, state, programId)` applies
   * the program id to account reads only and builds its internal client without
   * it, so a devnet vault emits MAINNET instructions — silently. That is the
   * default outcome of following Kamino's own published recipe. If `sdk.ts`
   * regresses to the plain constructor, this is the test that fails.
   */
  it("REJECTS a devnet plan carrying the mainnet kvault program", () => {
    const mainnetKvault = KAMINO_KVAULT_PROGRAM_IDS["mainnet-beta"];
    expect(() => assertPlanTargetsCluster(plan("devnet", [mainnetKvault]))).toThrow(
      KaminoProgramMismatchError
    );
  });

  it("rejects the mirror case — a mainnet plan carrying the devnet program", () => {
    const devnetKvault = KAMINO_KVAULT_PROGRAM_IDS.devnet;
    expect(() => assertPlanTargetsCluster(plan("mainnet-beta", [devnetKvault]))).toThrow(
      KaminoProgramMismatchError
    );
  });

  it("names the offending program and the cluster in the error", () => {
    const foreign = foreignKvaultProgramId("devnet");
    try {
      assertPlanTargetsCluster(plan("devnet", [foreign]));
      expect.unreachable("expected a program mismatch");
    } catch (error) {
      expect(error).toBeInstanceOf(KaminoProgramMismatchError);
      const mismatch = error as KaminoProgramMismatchError;
      expect(mismatch.cluster).toBe("devnet");
      expect(mismatch.offendingProgram).toBe(foreign);
    }
  });

  it("allows cluster-invariant programs such as the ATA program", () => {
    const devnet = kaminoClusterConfig("devnet");
    expect(() =>
      assertPlanTargetsCluster(plan("devnet", [ATA_PROGRAM, devnet.kvaultProgramId]))
    ).not.toThrow();
  });

  it("rejects an unrecognized program rather than ignoring it", () => {
    // A closed allowlist: an unexpected program is a finding, not noise.
    expect(() =>
      assertPlanTargetsCluster(plan("devnet", ["11111111111111111111111111111112"]))
    ).toThrow(KaminoProgramMismatchError);
  });

  it("checks every instruction, not just the first", () => {
    const devnet = kaminoClusterConfig("devnet");
    const mixedPrograms: KaminoInstructionPlan = {
      cluster: "devnet",
      instructions: [
        { programAddress: devnet.kvaultProgramId, accounts: [], data: new Uint8Array() },
        {
          programAddress: address(KAMINO_KVAULT_PROGRAM_IDS["mainnet-beta"]),
          accounts: [],
          data: new Uint8Array(),
        },
      ],
      lookupTables: [],
      assetIdentity: ASSET_IDENTITY,
      accepted: {},
    } as KaminoInstructionPlan;
    expect(() => assertPlanTargetsCluster(mixedPrograms)).toThrow(KaminoProgramMismatchError);
  });
});

/** Anchor's instruction discriminator: sha256("global:<snake_case_name>")[0..8]. */
function anchorDiscriminator(name: string): Uint8Array {
  return new Uint8Array(createHash("sha256").update(`global:${name}`).digest().subarray(0, 8));
}

function planWithData(
  cluster: KaminoInstructionPlan["cluster"],
  instructions: readonly { program: string; data: Uint8Array }[]
): KaminoInstructionPlan {
  return {
    cluster,
    instructions: instructions.map(({ program, data }) => ({
      programAddress: address(program),
      accounts: [],
      data,
    })),
    lookupTables: [],
    assetIdentity: ASSET_IDENTITY,
    accepted: {},
  } as KaminoInstructionPlan;
}

describe("assertPlanInstructionsSupported", () => {
  const floorVariant = anchorDiscriminator("deposit_with_min_shares_out");
  const legacyDeposit = anchorDiscriminator("deposit");
  const devnet = kaminoClusterConfig("devnet");
  const mainnet = kaminoClusterConfig("mainnet-beta");

  it("pins the floor variant's discriminator to the bytes klend-sdk 10 emits", () => {
    // The guard carries the bytes rather than hashing at runtime; this is what
    // keeps a typo in that constant from silently disabling the check.
    expect([...floorVariant]).toEqual([74, 127, 128, 80, 4, 221, 193, 91]);
    expect([...legacyDeposit]).toEqual([242, 35, 198, 137, 82, 225, 242, 182]);
  });

  /**
   * THE DEVNET REGRESSION OF 2026-09-18. Kamino's devnet kvault build (IDL 2.0.1)
   * has no `deposit_with_min_shares_out`; klend-sdk emits it for any
   * `minSharesOut`; the chain answers Anchor 101 InstructionFallbackNotFound.
   * `sdk.ts` refuses the floor before building; this catches an SDK that emits
   * the variant unasked.
   */
  it("REJECTS the floor variant addressed to the devnet kvault program", () => {
    const plan = planWithData("devnet", [
      { program: devnet.kvaultProgramId, data: new Uint8Array([...floorVariant, 1, 2, 3]) },
    ]);
    expect(() => assertPlanInstructionsSupported(plan)).toThrow(KaminoUnsupportedInstructionError);
    // ...and the cluster assertion every builder already runs includes it.
    expect(() => assertPlanTargetsCluster(plan)).toThrow(KaminoUnsupportedInstructionError);
  });

  it("names the instruction and the cluster in the error", () => {
    try {
      assertPlanInstructionsSupported(
        planWithData("devnet", [{ program: devnet.kvaultProgramId, data: floorVariant }])
      );
      expect.unreachable("expected an unsupported instruction");
    } catch (error) {
      expect(error).toBeInstanceOf(KaminoUnsupportedInstructionError);
      const unsupported = error as KaminoUnsupportedInstructionError;
      expect(unsupported.cluster).toBe("devnet");
      expect(unsupported.instruction).toBe("deposit_with_min_shares_out");
    }
  });

  it("accepts the legacy deposit on devnet, which that build does implement", () => {
    expect(() =>
      assertPlanTargetsCluster(
        planWithData("devnet", [{ program: devnet.kvaultProgramId, data: legacyDeposit }])
      )
    ).not.toThrow();
  });

  it("accepts the floor variant on mainnet, whose build implements it", () => {
    expect(() =>
      assertPlanTargetsCluster(
        planWithData("mainnet-beta", [{ program: mainnet.kvaultProgramId, data: floorVariant }])
      )
    ).not.toThrow();
  });

  it("only reads the kvault program's own instructions", () => {
    // The same eight bytes in an ATA-program instruction mean nothing here.
    expect(() =>
      assertPlanTargetsCluster(
        planWithData("devnet", [{ program: ATA_PROGRAM, data: floorVariant }])
      )
    ).not.toThrow();
  });

  it("ignores instructions too short to carry a discriminator", () => {
    expect(() =>
      assertPlanTargetsCluster(
        planWithData("devnet", [
          { program: devnet.kvaultProgramId, data: new Uint8Array([74, 127]) },
        ])
      )
    ).not.toThrow();
  });
});

describe("planProgramAddresses", () => {
  it("dedupes program addresses for Kora allowlist assertions", () => {
    const devnet = kaminoClusterConfig("devnet");
    const programs = planProgramAddresses(
      plan("devnet", [devnet.kvaultProgramId, devnet.kvaultProgramId, ATA_PROGRAM])
    );
    expect([...programs].sort()).toEqual([ATA_PROGRAM, devnet.kvaultProgramId].sort());
  });
});
