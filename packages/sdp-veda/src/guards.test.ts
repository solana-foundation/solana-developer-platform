import type { VedaDeployment } from "@sdp/types/veda-programs";
import { address, type Instruction } from "@solana/kit";
import { describe, expect, it } from "vitest";
import {
  assertPlanTargetsCluster,
  planInstructionCount,
  planProgramAddresses,
  VedaProgramMismatchError,
} from "./guards";
import { toClusterConfig } from "./programs";
import type { VedaInstructionPlan } from "./types";

const VAULT_PROGRAM = "5J76xGGXn5op9S48pMqWV6Ex48ZxsKsRs4bGeDzSHEVc";
const QUEUE_PROGRAM = "Cchro8d7bN5Xfk77z9hJKxREJwSAjpz5K2seK4iNN396";
const HOOK_PROGRAM = "FSZPGBfPWb6fUQWSwiKv8de55NabpBWgPmB6RV7kDgv9";
const OTHER_PROGRAM = "KvauGMspG5k6rtzrqqn7WNn3oZdyKqLKwK2XWQ8FLjd";
const SOME_MINT = "So11111111111111111111111111111111111111112";

const DEPLOYMENT: VedaDeployment = {
  vaultProgramAddress: VAULT_PROGRAM,
  queueProgramAddress: QUEUE_PROGRAM,
  hookProgramAddress: HOOK_PROGRAM,
  vaultStateAddresses: [SOME_MINT],
};
const config = toClusterConfig("devnet", DEPLOYMENT);

function instruction(programAddress: string): Instruction {
  return {
    programAddress: address(programAddress),
    accounts: [],
    data: new Uint8Array([1, 2, 3]),
  } as unknown as Instruction;
}

function plan(...programs: string[]): VedaInstructionPlan {
  return {
    cluster: "devnet",
    instructions: programs.map(instruction),
    lookupTables: [],
    assetIdentity: { depositTokenMint: address(SOME_MINT), shareMint: address(SOME_MINT) },
    accepted: { amount: "1", minSharesOut: "1" },
  };
}

describe("assertPlanTargetsCluster", () => {
  it("passes a plan built entirely from this deployment's programs", () => {
    const built = plan(VAULT_PROGRAM, "11111111111111111111111111111111");
    expect(assertPlanTargetsCluster(built, config)).toBe(built);
  });

  /**
   * THE CHECK THIS PACKAGE EXISTS TO MAKE. Construction passes explicit program
   * addresses to the SDK, but that is a convention inside one function; this is
   * a property of what is actually EMITTED, and only the second survives an SDK
   * upgrade that derives or defaults an address internally.
   */
  it("refuses an instruction addressed to a program this deployment never named", () => {
    expect(() => assertPlanTargetsCluster(plan(VAULT_PROGRAM, OTHER_PROGRAM), config)).toThrow(
      VedaProgramMismatchError
    );
  });

  it("names the offending program and the cluster in the failure", () => {
    try {
      assertPlanTargetsCluster(plan(OTHER_PROGRAM), config);
      expect.unreachable("expected a program mismatch");
    } catch (error) {
      expect(error).toBeInstanceOf(VedaProgramMismatchError);
      expect((error as VedaProgramMismatchError).offendingProgram).toBe(OTHER_PROGRAM);
      expect((error as VedaProgramMismatchError).code).toBe("PROGRAM_MISMATCH");
      expect((error as Error).message).toContain("devnet");
    }
  });

  it("checks every instruction, not only the first", () => {
    const multi: VedaInstructionPlan = {
      ...plan(VAULT_PROGRAM),
      instructions: [instruction(VAULT_PROGRAM), instruction(OTHER_PROGRAM)],
    };
    expect(() => assertPlanTargetsCluster(multi, config)).toThrow(VedaProgramMismatchError);
  });

  it("refuses a queue instruction when the deployment declares no queue", () => {
    const { queueProgramAddress: _omitted, ...noQueue } = DEPLOYMENT;
    expect(() =>
      assertPlanTargetsCluster(plan(QUEUE_PROGRAM), toClusterConfig("devnet", noQueue))
    ).toThrow(VedaProgramMismatchError);
  });
});

describe("plan inspection helpers", () => {
  it("counts every instruction in the plan", () => {
    const multi: VedaInstructionPlan = {
      ...plan(VAULT_PROGRAM),
      instructions: [instruction(VAULT_PROGRAM), instruction(VAULT_PROGRAM)],
    };
    expect(planInstructionCount(multi)).toBe(2);
  });

  it("reports each distinct program once", () => {
    const built = plan(VAULT_PROGRAM, VAULT_PROGRAM, HOOK_PROGRAM);
    expect(planProgramAddresses(built).map(String).sort()).toEqual(
      [HOOK_PROGRAM, VAULT_PROGRAM].sort()
    );
  });
});
