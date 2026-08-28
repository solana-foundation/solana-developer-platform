import type { SolanaCluster } from "@sdp/types";
import { SPL_TOKEN_PROGRAMS } from "@sdp/types";
import { WISDOMTREE_TRANSFER_HOOK_PROGRAM_IDS } from "@sdp/types/wisdomtree-programs";
import type { Address } from "@solana/kit";
import type { WisdomTreeInstructionPlan } from "./types";

/**
 * Cluster-invariant programs a plan may name without being cluster-specific —
 * the same closed set `@sdp/kamino`'s guard carries, for the same reason: an
 * unexpected program is a finding, not noise.
 */
const CLUSTER_INVARIANT_PROGRAMS: readonly string[] = [
  "11111111111111111111111111111111",
  SPL_TOKEN_PROGRAMS["spl-token"],
  SPL_TOKEN_PROGRAMS["token-2022"],
  // biome-ignore lint/security/noSecrets: a public Solana program address, not a credential
  "ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL",
  // biome-ignore lint/security/noSecrets: a public Solana program address, not a credential
  "MemoSq4gqABAXKb96qnH8TysNcWxMyWCqXgDLGmfcHr",
  "ComputeBudget111111111111111111111111111111",
];

export class WisdomTreeProgramMismatchError extends Error {
  constructor(
    readonly cluster: SolanaCluster,
    readonly offendingProgram: Address
  ) {
    super(
      `WisdomTree instruction targets ${offendingProgram}, which is not a permitted ${cluster} ` +
        "program for this integration."
    );
    this.name = "WisdomTreeProgramMismatchError";
  }
}

/**
 * Every program a plan for `cluster` may legitimately contain. Shared with
 * `sponsoredPrograms` on purpose (the Kamino rule): what this package ENFORCES
 * on its own output and what it DECLARES to a paymaster must be one object.
 *
 * Devnet answers the invariants alone — WisdomTree deploys nothing there, so
 * no cluster-specific program can legitimately appear, and no plan should ever
 * be built for it in the first place (the builders refuse earlier).
 */
export function permittedPlanPrograms(cluster: SolanaCluster): ReadonlySet<string> {
  const hookProgram = WISDOMTREE_TRANSFER_HOOK_PROGRAM_IDS[cluster];
  return new Set<string>([
    ...CLUSTER_INVARIANT_PROGRAMS,
    ...(hookProgram === undefined ? [] : [hookProgram]),
  ]);
}

/** Output-side allowlist re-check on every emitted plan — belt AND braces, like Kamino's. */
export function assertPlanTargetsCluster(
  plan: WisdomTreeInstructionPlan
): WisdomTreeInstructionPlan {
  const permitted = permittedPlanPrograms(plan.cluster);
  for (const instruction of plan.instructions) {
    if (!permitted.has(String(instruction.programAddress))) {
      throw new WisdomTreeProgramMismatchError(plan.cluster, instruction.programAddress);
    }
  }
  return plan;
}
