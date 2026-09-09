import type { Address, Instruction } from "@solana/kit";
import { SdpVedaError } from "./errors";
import { type VedaClusterConfig, vedaProgramAllowlist } from "./programs";
import type { VedaInstructionPlan } from "./types";

export class VedaProgramMismatchError extends SdpVedaError {
  constructor(
    readonly cluster: string,
    readonly offendingProgram: string
  ) {
    super(
      "PROGRAM_MISMATCH",
      `Veda instruction targets ${offendingProgram}, which is not a program this ${cluster} ` +
        "deployment may emit. See @sdp/veda/programs for the allowlist."
    );
    this.name = "VedaProgramMismatchError";
  }
}

/**
 * Refuse a plan whose instructions name a program outside this cluster's
 * deployment. **The most important check in this package.**
 *
 * Why it exists, and why it is not redundant with passing explicit addresses to
 * the SDK client:
 *
 * - Veda's own integration material implies devnet and mainnet may share
 *   program addresses. If that is true, nothing about an emitted instruction
 *   distinguishes the two, and the ONLY defence against building for the wrong
 *   chain is the genesis proof upstream. If it is NOT true — or stops being
 *   true — this is the check that notices, because the addresses come from a
 *   per-cluster table and the instruction has to match the one in play.
 * - `createVedaClient` takes program addresses at runtime, but a future SDK
 *   revision that derives or defaults one internally would emit an address this
 *   package never supplied. Construction is a convention inside one function;
 *   this is a property of the OUTPUT, and only the second survives an upgrade
 *   that reshuffles construction. Kamino's package learned that the hard way —
 *   its SDK's ordinary constructor binds a program id to READS only.
 *
 * `sdk-construction.test.ts` greps this package's own source to assert every
 * builder routes through here, because that fact is invisible to the type
 * checker.
 */
export function assertPlanTargetsCluster(
  plan: VedaInstructionPlan,
  config: VedaClusterConfig
): VedaInstructionPlan {
  const allowed = vedaProgramAllowlist(config);
  for (const instruction of plan.instructions) {
    const program = String(instruction.programAddress);
    if (allowed.has(program)) continue;
    throw new VedaProgramMismatchError(plan.cluster, program);
  }
  return plan;
}

/** Every distinct program a plan touches — useful for Kora allowlist assertions. */
export function planProgramAddresses(plan: VedaInstructionPlan): readonly Address[] {
  const seen = new Set<Address>();
  for (const instruction of plan.instructions as readonly Instruction[]) {
    seen.add(instruction.programAddress);
  }
  return [...seen];
}

/** How many instructions the plan's one transaction carries. */
export function planInstructionCount(plan: VedaInstructionPlan): number {
  return plan.instructions.length;
}
