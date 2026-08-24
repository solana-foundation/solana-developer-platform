import type { FeePaymentPort } from "@sdp/payments/fee-payment";
import type { SolanaCluster } from "@sdp/types";
import type { Address } from "@solana/kit";
import { isEarnVaultSponsorshipEnabled } from "@/lib/feature-flags";
import { createProjectSponsorshipFeePayment } from "@/services/sponsorship.service";
import type { Env } from "@/types/env";
import type { VaultDeadline } from "./vault-deadline";

/**
 * Who pays for an Earn vault movement, decided once per request.
 *
 * ── Why one value instead of three decisions ────────────────────────────────
 * Sponsorship touches three places that must agree, and disagreement is silent
 * rather than loud:
 *
 *   1. the compile-time transaction fee payer,
 *   2. the `rentPayer` handed to the provider's builder, which lands INSIDE the
 *      instruction accounts and funds the share ATA a first deposit creates,
 *   3. the fee payer used to SIMULATE, because simulation enforces that the fee
 *      payer can pay. A zero-SOL wallet simulated as its own fee payer fails
 *      with `AccountNotFound` and no logs, before signing is ever reached.
 *
 * Passing one resolved value to all three makes "sponsor pays the fee but the
 * wallet still funds rent" unrepresentable, which was the actual bug: fees were
 * sponsored while a wallet holding zero SOL still could not make a first
 * deposit.
 *
 * ── Why the sponsor address is captured here ────────────────────────────────
 * `getFeePayer()` is a network call. Resolving it once, before the provider
 * builds, is what lets the same address be both the rent payer (needed at BUILD
 * time, because it is embedded in the instructions) and the fee payer (needed at
 * COMPILE time). Signing no longer makes the call at all.
 *
 * One sponsor identity fills both roles, or neither does. Solana deduplicates
 * account keys, so an address that is both the fee payer and a writable signer
 * inside an instruction occupies ONE signature slot: a single
 * `signAsFeePayer` satisfies both roles, with no second key and no second round
 * trip. A sponsor rent payer WITHOUT a sponsor fee payer would instead need a
 * second real signature that SDP cannot produce, which is why these never split.
 */
export type VaultFeeMode =
  | { kind: "sponsored"; feePayment: FeePaymentPort; sponsor: Address }
  | { kind: "wallet-pays" };

export interface ResolveVaultSponsorshipInput {
  organizationId: string;
  projectId: string;
  /** Custody wallet id, used as the sponsorship quota actor. */
  walletId: string;
  /** Cluster the movement executes on, NOT the process's default network. */
  cluster: SolanaCluster;
  deadline: VaultDeadline;
}

/**
 * Decide who pays, and resolve the sponsor when that is SDP.
 *
 * CALL THIS AFTER the idempotency replay short-circuit, never before. A replay
 * is a pure durable read that must keep answering during a paymaster or RPC
 * outage; resolving sponsorship first would make a already-signed movement
 * un-returnable exactly when a caller is retrying.
 *
 * Fail-closed by construction: an unset flag or an unlisted cluster answers
 * `wallet-pays`, so turning sponsorship off is a configuration change and never
 * a code change. Provider construction goes through the shared sponsorship
 * boundary rather than a raw adapter, so managed deployments keep the budget
 * reservation and the Kora usage identity that boundary owns; bypassing it would
 * spend the fee payer's lamports without any budget seeing it.
 */
export async function resolveVaultSponsorship(
  env: Env,
  input: ResolveVaultSponsorshipInput
): Promise<VaultFeeMode> {
  if (!isEarnVaultSponsorshipEnabled(env, input.cluster)) {
    return { kind: "wallet-pays" };
  }

  const feePayment = await createProjectSponsorshipFeePayment(env, {
    organizationId: input.organizationId,
    projectId: input.projectId,
    actor: { type: "wallet", id: input.walletId },
  });
  const sponsor = await input.deadline.run("Resolving the sponsored fee payer", () =>
    feePayment.getFeePayer()
  );
  return { kind: "sponsored", feePayment, sponsor };
}

/**
 * The address that funds rent for accounts a plan creates, as the neutral
 * provider contract wants it: a plain address, or undefined to let the owner pay.
 *
 * A provider client turns this into whatever signer shape its own SDK needs. The
 * plan that comes back is plain data with no signer objects, so only the
 * writable+signer ROLE survives to compile time and the paymaster supplies the
 * signature.
 */
export function vaultRentPayer(fee: VaultFeeMode): string | undefined {
  return fee.kind === "sponsored" ? fee.sponsor : undefined;
}
