import type { EarnVaultAssetIdentity, EarnVaultTransactionPlan } from "@sdp/earn/types";
import * as solanaRpc from "@sdp/rpc/solana";
import type { SolanaCluster } from "@sdp/types";
import {
  type Address,
  type AddressesByLookupTableAddress,
  address,
  addSignersToTransactionMessage,
  appendTransactionMessageInstructions,
  compressTransactionMessageUsingAddressLookupTables,
  createTransactionMessage,
  fetchAddressesForLookupTables,
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

// biome-ignore lint/security/noSecrets: public Solana Memo program address.
const MEMO_PROGRAM_ADDRESS = "MemoSq4gqABAXKb96qnH8TysNcWxMyWCqXgDLGmfcHr";

/**
 * Bind the caller's idempotency key into every transaction of a plan.
 *
 * Deterministic Solana signing plus a shared recent blockhash would make
 * otherwise independent requests produce the same signature. The memo gives
 * each ledger intent a unique on-chain identity while retries of the same key
 * remain byte-for-byte equivalent. One helper for both directions so the
 * format cannot drift — and so the size stays inside the headroom every plan
 * batch reserves for it (`EARN_VAULT_TRANSACTION_HEADROOM_BYTES` in
 * `@sdp/earn`): the worst legal key is 255 bytes, and a memo instruction
 * carrying it measures within that reservation.
 */
export function appendVaultRequestMemo(
  plan: EarnVaultTransactionPlan,
  kind: "vault-deposit" | "vault-withdrawal",
  requestId: string
): EarnVaultTransactionPlan {
  const memo = {
    programAddress: MEMO_PROGRAM_ADDRESS,
    accounts: [],
    data: Buffer.from(`sdp:earn:${kind}:${requestId}`, "utf8").toString("base64"),
  };
  return {
    ...plan,
    transactions: plan.transactions.map((batch) => [...batch, memo]),
  };
}

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
 * Resolve a plan's declared lookup tables to their address lists.
 *
 * REQUIRED, not best-effort, and that asymmetry with the builder is deliberate:
 * the builder may build WITHOUT a table (it just splits earlier), but a plan
 * that declares one was SIZED with it, so compiling without it here could
 * exceed the packet limit — or worse, compile a different message than the one
 * simulated. A fetch failure is therefore a retryable error, never a silent
 * fallback.
 */
async function resolveLookupTables(
  env: Env,
  input: VaultExecutionScope & { plan: EarnVaultTransactionPlan; rpcUrl: string }
): Promise<AddressesByLookupTableAddress> {
  if (input.plan.lookupTables.length === 0) return {};
  const rpc = solanaRpc.createRpc(env, { rpcUrl: input.rpcUrl });
  return input.deadline.run("Fetching the vault lookup tables", () =>
    fetchAddressesForLookupTables(
      input.plan.lookupTables.map((table) => address(table)),
      rpc
    )
  );
}

function applyLookupTables<TMessage>(
  message: TMessage,
  lookupTables: AddressesByLookupTableAddress
): TMessage {
  if (Object.keys(lookupTables).length === 0) return message;
  return compressTransactionMessageUsingAddressLookupTables(
    // biome-ignore lint/suspicious/noExplicitAny: kit narrows the message type through each pipe stage; compression preserves compilability.
    message as any,
    lookupTables
  ) as TMessage;
}

/**
 * Sign every transaction a plan carries, WITHOUT sending any of them.
 *
 * Split from the broadcast so the caller can durably record every signature
 * before any transaction can possibly land. That ordering is the only thing
 * that makes an ambiguous send recoverable: once bytes are on the wire, a
 * timeout, a crash or a lost DB write leaves a transaction that may be on chain
 * with money moved, and without the signature there is nothing to reconcile it
 * against — SDP would not know the transfer exists.
 *
 * All batches share ONE blockhash read: a multi-leg plan is one intent, and one
 * expiry window for the whole group is what lets the reconciliation sweep
 * reason about "this group can no longer land" leg by leg with the same rule.
 *
 * Works for both fee modes. Sponsored signing is deliberately sign-only: the
 * custody owner signs first, the fee-payment port adds the fee-payer signature
 * without broadcasting, and the fully signed bytes plus deterministic
 * signature return to the caller for durable intent persistence.
 */
export async function signVaultPlanTransactions(
  env: Env,
  input: SignVaultPlanInput
): Promise<SignedVaultTransaction[]> {
  assertExpectedPlan(input.plan, input.cluster, input.expectedAssetIdentity);
  const batches = planBatches(input.plan).map((batch) => batch.map(toKitInstruction));
  await verifyVaultRpc(env, input);
  const rpc = solanaRpc.createRpc(env, { rpcUrl: input.rpcUrl });
  const [lookupTables, { blockhash, lastValidBlockHeight }] = await Promise.all([
    resolveLookupTables(env, input),
    input.deadline.run("Fetching the vault transaction blockhash", () =>
      solanaRpc.getRecentBlockhash(rpc, "confirmed")
    ),
  ]);

  const signedTransactions: SignedVaultTransaction[] = [];
  for (const instructions of batches) {
    let signedBytes: Uint8Array;
    if (input.fee.kind === "sponsored") {
      const { feePayment } = input.fee;
      // react-doctor-disable-next-line react-doctor/async-await-in-loop -- custody signing is intentionally serialized because signer ports may be stateful or rate-limited.
      const feePayer = await input.deadline.run("Resolving the sponsored fee payer", () =>
        feePayment.getFeePayer()
      );
      const message = pipe(
        createTransactionMessage({ version: 0 }),
        (m) => setTransactionMessageFeePayer(feePayer, m),
        (m) => setTransactionMessageLifetimeUsingBlockhash({ blockhash, lastValidBlockHeight }, m),
        (m) => appendTransactionMessageInstructions(instructions, m),
        (m) => applyLookupTables(m, lookupTables),
        (m) => addSignersToTransactionMessage([input.owner], m)
      );
      // react-doctor-disable-next-line react-doctor/async-await-in-loop -- preserve signer ordering across transaction legs.
      const ownerSigned = await input.deadline.run("Signing the vault transaction", () =>
        partiallySignTransactionMessageWithSigners(message)
      );
      const ownerSignedBytes = new Uint8Array(getTransactionEncoder().encode(ownerSigned));
      // react-doctor-disable-next-line react-doctor/async-await-in-loop -- fee-payer signing depends on the owner-signed bytes and stays ordered across legs.
      signedBytes = await input.deadline.run("Signing the sponsored vault fee", () =>
        feePayment.signAsFeePayer(ownerSignedBytes)
      );
    } else {
      const message = pipe(
        createTransactionMessage({ version: 0 }),
        (m) => setTransactionMessageFeePayerSigner(input.owner, m),
        (m) => setTransactionMessageLifetimeUsingBlockhash({ blockhash, lastValidBlockHeight }, m),
        (m) => appendTransactionMessageInstructions(instructions, m),
        (m) => applyLookupTables(m, lookupTables),
        (m) => addSignersToTransactionMessage([input.owner], m)
      );
      // react-doctor-disable-next-line react-doctor/async-await-in-loop -- preserve signer ordering across transaction legs.
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
    signedTransactions.push({
      bytes: signedBytes,
      signature: getSignatureFromTransaction(signed),
      lastValidBlockHeight: String(lastValidBlockHeight),
    });
  }
  return signedTransactions;
}

/**
 * The single-transaction path (deposits). A deposit plan never legitimately
 * carries more than one batch, and signing several under a caller that records
 * only one movement row would broadcast money the ledger cannot see — so the
 * old submitter refusal survives here, at the same seam, for the path that
 * still needs it.
 */
export async function signVaultPlan(
  env: Env,
  input: SignVaultPlanInput
): Promise<SignedVaultTransaction> {
  if (input.plan.transactions.length > 1) {
    throw new Error(
      `Vault plan needs ${input.plan.transactions.length} transactions; this path signs exactly one`
    );
  }
  const [signed] = await signVaultPlanTransactions(env, input);
  if (!signed) {
    throw new Error("Vault plan carried no instructions");
  }
  return signed;
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

/**
 * A plan's batches, validated for SHAPE: at least one batch, none empty. Size
 * and count are the BUILDER's contract (transaction-sized batches); this seam
 * only refuses the shapes nothing could legitimately produce.
 */
function planBatches(plan: EarnVaultTransactionPlan) {
  if (plan.transactions.length === 0) {
    throw new Error("Vault plan carried no instructions");
  }
  for (const batch of plan.transactions) {
    if (batch.length === 0) {
      throw new Error("Vault plan carried an empty transaction batch");
    }
  }
  return plan.transactions;
}

/**
 * Simulate before signing.
 *
 * Worth the extra round trip on this path specifically: the instructions were
 * assembled by a third-party SDK against live vault state, so a stale reserve
 * set or a changed vault config surfaces here as a readable program error
 * instead of a landed, failed transaction the customer still paid for.
 *
 * Only the FIRST batch is simulated, by necessity rather than economy: a later
 * leg's instructions consume state its predecessor creates (an unstake frees
 * the shares later withdraws burn), so simulating it against current chain
 * state would fail spuriously. Later legs are protected by ordered submission
 * — each broadcasts only after its predecessor is committed.
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
  let batch: EarnVaultTransactionPlan["transactions"][number];
  try {
    [batch] = planBatches(input.plan);
  } catch (cause) {
    return {
      ok: false,
      error: cause instanceof Error ? cause.message : "invalid vault plan",
      logs: [],
    };
  }

  await verifyVaultRpc(env, input);
  const rpc = solanaRpc.createRpc(env, { rpcUrl: input.rpcUrl });
  let lookupTables: AddressesByLookupTableAddress;
  try {
    lookupTables = await resolveLookupTables(env, input);
  } catch (cause) {
    return {
      ok: false,
      error: cause instanceof Error ? cause.message : "vault lookup tables unavailable",
      logs: [],
    };
  }
  const { blockhash, lastValidBlockHeight } = await input.deadline.run(
    "Fetching the vault simulation blockhash",
    () => solanaRpc.getRecentBlockhash(rpc, "confirmed")
  );
  const message = pipe(
    createTransactionMessage({ version: 0 }),
    (m) => setTransactionMessageFeePayer(input.owner, m),
    (m) => setTransactionMessageLifetimeUsingBlockhash({ blockhash, lastValidBlockHeight }, m),
    (m) => appendTransactionMessageInstructions(batch.map(toKitInstruction), m),
    (m) => applyLookupTables(m, lookupTables)
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
