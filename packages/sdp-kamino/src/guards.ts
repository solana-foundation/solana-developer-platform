import type { SolanaCluster } from "@sdp/types";
import type { Address, Instruction } from "@solana/kit";
import { kaminoProgramAllowlist } from "./programs";
import type { KaminoInstructionPlan } from "./types";

/**
 * Programs that are the same on every cluster and may appear in a plan without
 * being cluster-specific: system, both token programs, the ATA program, memo and
 * compute budget. Listed explicitly rather than skipped, so the allowlist stays
 * a closed set — an unexpected program is a finding, not noise.
 */
const CLUSTER_INVARIANT_PROGRAMS: readonly string[] = [
  "11111111111111111111111111111111",
  // biome-ignore lint/security/noSecrets: a public Solana program address, not a credential
  "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA",
  // biome-ignore lint/security/noSecrets: a public Solana program address, not a credential
  "TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb",
  // biome-ignore lint/security/noSecrets: a public Solana program address, not a credential
  "ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL",
  // biome-ignore lint/security/noSecrets: a public Solana program address, not a credential
  "MemoSq4gqABAXKb96qnH8TysNcWxMyWCqXgDLGmfcHr",
  "ComputeBudget111111111111111111111111111111",
];

export class KaminoProgramMismatchError extends Error {
  constructor(
    readonly cluster: SolanaCluster,
    readonly offendingProgram: Address
  ) {
    super(
      `Kamino instruction targets ${offendingProgram}, which is not a ${cluster} program. ` +
        "This is the program-id override being silently dropped — see @sdp/kamino/sdk.ts."
    );
    this.name = "KaminoProgramMismatchError";
  }
}

/**
 * Refuse a plan whose instructions name a program that does not belong to this
 * cluster. **The single most important check in this package.**
 *
 * Why it exists: klend-sdk's `new KaminoVault(rpc, addr, state, programId)`
 * applies `programId` to account READS only and constructs its own internal
 * client WITHOUT forwarding it. The result is a vault that reads devnet state
 * and emits instructions addressed to the MAINNET kvault program — no error, no
 * warning, and a transaction that fails on-chain or, worse, succeeds against the
 * wrong deployment. Kamino's own published recipe uses that constructor, so this
 * is the default outcome for anyone following the docs.
 *
 * `./sdk.ts` binds reads and writes together so the trap cannot spring, and this
 * asserts that it worked. Belt AND braces, deliberately: the binding is a
 * convention inside one function, while this is a property of the OUTPUT, and
 * only the second one survives an SDK upgrade that reshuffles construction.
 */
export function assertPlanTargetsCluster(plan: KaminoInstructionPlan): KaminoInstructionPlan {
  const allowed = kaminoProgramAllowlist(plan.cluster);
  const invariant = new Set<string>(CLUSTER_INVARIANT_PROGRAMS);

  for (const batch of plan.instructions) {
    for (const instruction of batch) {
      const program = instruction.programAddress;
      if (allowed.has(program) || invariant.has(program)) continue;
      throw new KaminoProgramMismatchError(plan.cluster, program);
    }
  }
  return plan;
}

/** Flatten a plan for callers that genuinely want one transaction's worth. */
export function planInstructionCount(plan: KaminoInstructionPlan): number {
  return plan.instructions.reduce((total, batch) => total + batch.length, 0);
}

/** Every distinct program a plan touches — useful for Kora allowlist assertions. */
export function planProgramAddresses(plan: KaminoInstructionPlan): readonly Address[] {
  const seen = new Set<Address>();
  for (const batch of plan.instructions) {
    for (const instruction of batch as readonly Instruction[]) {
      seen.add(instruction.programAddress);
    }
  }
  return [...seen];
}
