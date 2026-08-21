import { KAMINO_KVAULT_PROGRAM_IDS } from "@sdp/types";
import { address } from "@solana/kit";
import { describe, expect, it } from "vitest";
import {
  assertPlanTargetsCluster,
  KaminoProgramMismatchError,
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

describe("planProgramAddresses", () => {
  it("dedupes program addresses for Kora allowlist assertions", () => {
    const devnet = kaminoClusterConfig("devnet");
    const programs = planProgramAddresses(
      plan("devnet", [devnet.kvaultProgramId, devnet.kvaultProgramId, ATA_PROGRAM])
    );
    expect([...programs].sort()).toEqual([ATA_PROGRAM, devnet.kvaultProgramId].sort());
  });
});
