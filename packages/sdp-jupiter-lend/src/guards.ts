import type { EarnVaultTransactionPlan } from "@sdp/earn/types";
import type { SolanaCluster } from "@sdp/types";
import { JUPITER_LEND_EARN_PROGRAM_IDS } from "@sdp/types/jupiter-lend-programs";
import { SdpJupiterLendError } from "./errors";

// biome-ignore lint/security/noSecrets: public Solana program address
const ASSOCIATED_TOKEN_PROGRAM = "ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL";

export function permittedJupiterLendPrograms(cluster: SolanaCluster): ReadonlySet<string> {
  const earn = JUPITER_LEND_EARN_PROGRAM_IDS[cluster];
  return new Set([ASSOCIATED_TOKEN_PROGRAM, ...(earn ? [earn] : [])]);
}

export function assertJupiterLendPlanPrograms(
  plan: EarnVaultTransactionPlan
): EarnVaultTransactionPlan {
  const permitted = permittedJupiterLendPrograms(plan.cluster);
  for (const instruction of plan.instructions) {
    if (!permitted.has(instruction.programAddress)) {
      throw new SdpJupiterLendError(
        "PROGRAM_MISMATCH",
        `Jupiter Lend emitted unexpected program ${instruction.programAddress} on ${plan.cluster}`
      );
    }
  }
  return plan;
}
