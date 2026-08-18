import type { EarnVaultAssetIdentity, EarnVaultTransactionPlan } from "@sdp/earn/types";
import * as solanaRpc from "@sdp/rpc/solana";
import type { SolanaCluster } from "@sdp/types";
import {
  type Address,
  address,
  addSignersToTransactionMessage,
  appendTransactionMessageInstructions,
  createTransactionMessage,
  getBase64EncodedWireTransaction,
  getSignatureFromTransaction,
  getTransactionDecoder,
  getTransactionEncoder,
  type Instruction,
  pipe,
  type Signature,
  setTransactionMessageFeePayer,
  setTransactionMessageFeePayerSigner,
  setTransactionMessageLifetimeUsingBlockhash,
  type TransactionSigner,
} from "@solana/kit";
import {
  partiallySignTransactionMessageWithSigners,
  signTransactionMessageWithSigners,
} from "@solana/signers";
import type { FeePaymentPort } from "@/services/ports";
import type { Env } from "@/types/env";
import { assertClusterEndpoint } from "./execution-registry";
import type { VaultDeadline } from "./vault-deadline";

/**
 * Turn a provider's unsigned plan into a landed transaction, signed by an SDP
 * custody wallet.
 *
 * This is the seam the whole vault-direct model rests on: a `vault_direct`
 * provider custodies nothing and hands back instructions, so the ONLY thing
 * that moves money is SDP signing with a wallet it controls. Nothing here is
 * Kamino-specific — it consumes the neutral `EarnVaultTransactionPlan`.
 */

/** A plain-data instruction from the provider contract, back in kit form. */
function toKitInstruction(instruction: EarnVaultTransactionPlan["transactions"][number][number]) {
  return {
    programAddress: address(instruction.programAddress),
    accounts: instruction.accounts.map((account) => ({
      address: address(account.address),
      role: account.role,
    })),
    data: Uint8Array.from(Buffer.from(instruction.data, "base64")),
  } as unknown as Instruction;
}

export type VaultFeeMode =
  | { kind: "sponsored"; feePayment: FeePaymentPort }
  | { kind: "wallet-pays" };

export interface VaultExecutionScope {
  /** Cluster derived from the authenticated SDP project environment. */
  cluster: SolanaCluster;
  /** One absolute budget shared by every stage in this vault workflow. */
  deadline: VaultDeadline;
}

export interface VaultPlanExecutionScope extends VaultExecutionScope {
  /** Catalogue identity authorized by the route before provider plan creation. */
  expectedAssetIdentity: EarnVaultAssetIdentity;
}

export interface SignVaultPlanInput extends VaultPlanExecutionScope {
  plan: EarnVaultTransactionPlan;
  /** The custody wallet signer — the vault `user`, and the only real signer. */
  owner: TransactionSigner;
  rpcUrl: string;
  fee: VaultFeeMode;
}

export interface SignedVaultTransaction {
  /** The wire bytes, ready to broadcast. */
  bytes: Uint8Array;
  /**
   * The signature this transaction WILL have on chain, known before it is
   * sent — a Solana signature is the fee payer's signature over the message,
   * so signing determines it and broadcasting only publishes it.
   */
  signature: Signature;
  /** Inclusive block height after which these exact bytes cannot land. */
  lastValidBlockHeight: string;
}

function assertExpectedPlan(
  plan: EarnVaultTransactionPlan,
  expectedCluster: SolanaCluster,
  expectedAssetIdentity: EarnVaultAssetIdentity
): void {
  if (plan.cluster !== expectedCluster) {
    throw new Error(
      `Vault plan targets ${plan.cluster}, not the expected ${expectedCluster} cluster`
    );
  }
  if (plan.assetIdentity.depositTokenMint !== expectedAssetIdentity.depositTokenMint) {
    throw new Error(
      `Vault plan deposit token mint ${plan.assetIdentity.depositTokenMint} does not match ` +
        `the expected ${expectedAssetIdentity.depositTokenMint}`
    );
  }
  if (plan.assetIdentity.shareMint !== expectedAssetIdentity.shareMint) {
    throw new Error(
      `Vault plan share mint ${plan.assetIdentity.shareMint} does not match ` +
        `the expected ${expectedAssetIdentity.shareMint}`
    );
  }
}

async function verifyVaultRpc(
  env: Env,
  input: Pick<VaultExecutionScope, "cluster" | "deadline"> & { rpcUrl: string }
): Promise<void> {
  await input.deadline.run(`Verifying the ${input.cluster} RPC endpoint`, () =>
    assertClusterEndpoint(env, input.cluster, input.rpcUrl)
  );
}

/**
 * Sign, WITHOUT sending.
 *
 * Split from the broadcast so the caller can durably record the signature
 * before the transaction can possibly land. That ordering is the only thing
 * that makes an ambiguous send recoverable: once bytes are on the wire, a
 * timeout, a crash or a lost DB write leaves a transaction that may be on chain
 * with money moved, and without the signature there is nothing to reconcile it
 * against — SDP would not know the transfer exists.
 *
 * Works for both fee modes. Sponsored signing is deliberately sign-only: the
 * custody owner signs first, the fee-payment port adds the fee-payer signature
 * without broadcasting, and the fully signed bytes plus deterministic
 * signature return to the caller for durable intent persistence.
 */
export async function signVaultPlan(
  env: Env,
  input: SignVaultPlanInput
): Promise<SignedVaultTransaction> {
  assertExpectedPlan(input.plan, input.cluster, input.expectedAssetIdentity);
  const instructions = singleBatchInstructions(input.plan).map(toKitInstruction);
  await verifyVaultRpc(env, input);
  const rpc = solanaRpc.createRpc(env, { rpcUrl: input.rpcUrl });
  const { blockhash, lastValidBlockHeight } = await input.deadline.run(
    "Fetching the vault transaction blockhash",
    () => solanaRpc.getRecentBlockhash(rpc, "confirmed")
  );

  let signedBytes: Uint8Array;
  if (input.fee.kind === "sponsored") {
    const { feePayment } = input.fee;
    const feePayer = await input.deadline.run("Resolving the sponsored fee payer", () =>
      feePayment.getFeePayer()
    );
    const message = pipe(
      createTransactionMessage({ version: 0 }),
      (m) => setTransactionMessageFeePayer(feePayer, m),
      (m) => setTransactionMessageLifetimeUsingBlockhash({ blockhash, lastValidBlockHeight }, m),
      (m) => appendTransactionMessageInstructions(instructions, m),
      (m) => addSignersToTransactionMessage([input.owner], m)
    );
    const ownerSigned = await input.deadline.run("Signing the vault transaction", () =>
      partiallySignTransactionMessageWithSigners(message)
    );
    const ownerSignedBytes = new Uint8Array(getTransactionEncoder().encode(ownerSigned));
    signedBytes = await input.deadline.run("Signing the sponsored vault fee", () =>
      feePayment.signAsFeePayer(ownerSignedBytes)
    );
  } else {
    const message = pipe(
      createTransactionMessage({ version: 0 }),
      (m) => setTransactionMessageFeePayerSigner(input.owner, m),
      (m) => setTransactionMessageLifetimeUsingBlockhash({ blockhash, lastValidBlockHeight }, m),
      (m) => appendTransactionMessageInstructions(instructions, m),
      (m) => addSignersToTransactionMessage([input.owner], m)
    );
    const signed = await input.deadline.run("Signing the vault transaction", () =>
      signTransactionMessageWithSigners(message)
    );
    signedBytes = new Uint8Array(getTransactionEncoder().encode(signed));
  }

  const signed = getTransactionDecoder().decode(signedBytes);
  if (
    signed.signatures[input.owner.address] === null ||
    signed.signatures[input.owner.address] === undefined
  ) {
    throw new Error("Vault transaction is missing the custody-owner signature");
  }
  return {
    bytes: signedBytes,
    signature: getSignatureFromTransaction(signed),
    lastValidBlockHeight: String(lastValidBlockHeight),
  };
}

/**
 * Broadcast bytes whose signature the caller has already recorded.
 *
 * Throwing here does NOT mean the transaction failed — it may have landed and
 * the response been lost. The caller must treat a throw as UNKNOWN and leave
 * the ledger row reconcilable against its recorded signature, never mark it
 * failed.
 */
export async function broadcastVaultTransaction(
  env: Env,
  input: VaultExecutionScope & { bytes: Uint8Array; rpcUrl: string }
): Promise<void> {
  await verifyVaultRpc(env, input);
  const rpc = solanaRpc.createRpc(env, { rpcUrl: input.rpcUrl });
  await input.deadline.run("Broadcasting the vault transaction", () =>
    solanaRpc.sendTransaction(rpc, input.bytes)
  );
}

/** The single batch a deposit plan carries, with the multi-transaction refusal. */
function singleBatchInstructions(plan: EarnVaultTransactionPlan) {
  if (plan.lookupTables.length > 0) {
    // Address lookup tables require a different compilation path. Refuse them
    // at the shared boundary so simulation, signing and submission cannot each
    // make a different assumption about the same provider plan.
    throw new Error("Vault plans with address lookup tables are not implemented");
  }
  const batch = plan.transactions[0];
  if (!batch || batch.length === 0) {
    throw new Error("Vault plan carried no instructions");
  }
  if (plan.transactions.length > 1) {
    // Multi-transaction plans need per-leg ledger rows and a resume story; the
    // deposit path never produces one today, so refuse rather than silently
    // land only the first leg.
    throw new Error(
      `Vault plan needs ${plan.transactions.length} transactions; multi-transaction submission is not implemented`
    );
  }
  return batch;
}

/**
 * Simulate before signing.
 *
 * Worth the extra round trip on this path specifically: the instructions were
 * assembled by a third-party SDK against live vault state, so a stale reserve
 * set or a changed vault config surfaces here as a readable program error
 * instead of a landed, failed transaction the customer still paid for.
 */
export async function simulateVaultPlan(
  env: Env,
  input: VaultPlanExecutionScope & {
    plan: EarnVaultTransactionPlan;
    owner: Address;
    rpcUrl: string;
  }
): Promise<{ ok: true } | { ok: false; error: string; logs: readonly string[] }> {
  assertExpectedPlan(input.plan, input.cluster, input.expectedAssetIdentity);
  let batch: ReturnType<typeof singleBatchInstructions>;
  try {
    batch = singleBatchInstructions(input.plan);
  } catch (cause) {
    return {
      ok: false,
      error: cause instanceof Error ? cause.message : "invalid vault plan",
      logs: [],
    };
  }

  await verifyVaultRpc(env, input);
  const rpc = solanaRpc.createRpc(env, { rpcUrl: input.rpcUrl });
  const { blockhash, lastValidBlockHeight } = await input.deadline.run(
    "Fetching the vault simulation blockhash",
    () => solanaRpc.getRecentBlockhash(rpc, "confirmed")
  );
  const message = pipe(
    createTransactionMessage({ version: 0 }),
    (m) => setTransactionMessageFeePayer(input.owner, m),
    (m) => setTransactionMessageLifetimeUsingBlockhash({ blockhash, lastValidBlockHeight }, m),
    (m) => appendTransactionMessageInstructions(batch.map(toKitInstruction), m)
  );

  // `sigVerify: false` + `replaceRecentBlockhash` so an unsigned message can be
  // simulated: we want the PROGRAM's verdict, not a signature check.
  const compiled = await input.deadline.run("Compiling the vault simulation", () =>
    partiallySignTransactionMessageWithSigners(message)
  );
  const wire = getBase64EncodedWireTransaction(compiled);
  const result = await input.deadline.run("Simulating the vault transaction", () =>
    rpc
      .simulateTransaction(wire, {
        encoding: "base64",
        sigVerify: false,
        replaceRecentBlockhash: true,
      })
      .send()
  );

  if (result.value.err) {
    return {
      ok: false,
      error: JSON.stringify(result.value.err, (_key, value) =>
        typeof value === "bigint" ? value.toString() : value
      ),
      logs: result.value.logs ?? [],
    };
  }
  return { ok: true };
}
