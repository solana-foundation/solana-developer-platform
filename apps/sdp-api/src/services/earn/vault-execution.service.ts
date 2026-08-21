import type { EarnVaultAssetIdentity, EarnVaultTransactionPlan } from "@sdp/earn/types";
import * as solanaRpc from "@sdp/rpc/solana";
import type { SolanaCluster } from "@sdp/types";
import {
  type Address,
  type AddressesByLookupTableAddress,
  address,
  addSignersToTransactionMessage,
  appendTransactionMessageInstructions,
  type Blockhash,
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
function toKitInstruction(instruction: EarnVaultTransactionPlan["instructions"][number]) {
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
 * Bind the caller's idempotency key into the transaction plan.
 *
 * Deterministic Solana signing plus a shared recent blockhash would make
 * otherwise independent requests produce the same signature. The memo gives
 * each ledger intent a unique on-chain identity while retries of the same key
 * remain byte-for-byte equivalent. One helper for both directions so the
 * format cannot drift. The final signed transaction is measured after this
 * memo and any lookup-table compression are applied.
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
    instructions: [...plan.instructions, memo],
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
  /** Successful simulation preparation reused to sign the exact same plan. */
  prepared?: PreparedVaultPlanExecution;
}

export interface PreparedVaultPlanExecution {
  plan: EarnVaultTransactionPlan;
  lookupTables: AddressesByLookupTableAddress;
  blockhash: Blockhash;
  lastValidBlockHeight: bigint;
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
 * Solana's serialized transaction packet limit, including signatures and the
 * message: https://solana.com/docs/core/transactions/transaction-structure
 *
 * Vault exits deliberately fail closed here after lookup-table compression. If
 * a real provider plan exceeds this limit, supporting it requires a deliberate
 * multi-transaction design with ordered persistence, submission and
 * reconciliation. Do not silently split the plan or revive child records here.
 */
const SOLANA_TRANSACTION_SIZE_LIMIT_BYTES = 1232;

/** Sign exactly one complete vault transaction without broadcasting it. */
export async function signVaultPlan(
  env: Env,
  input: SignVaultPlanInput
): Promise<SignedVaultTransaction> {
  assertExpectedPlan(input.plan, input.cluster, input.expectedAssetIdentity);
  const instructions = planInstructions(input.plan).map(toKitInstruction);
  let prepared = input.prepared;
  if (prepared && prepared.plan !== input.plan) {
    throw new Error("Vault execution preparation belongs to a different plan");
  }
  if (!prepared) {
    await verifyVaultRpc(env, input);
    const rpc = solanaRpc.createRpc(env, { rpcUrl: input.rpcUrl });
    const [lookupTables, { blockhash, lastValidBlockHeight }] = await Promise.all([
      resolveLookupTables(env, input),
      input.deadline.run("Fetching the vault transaction blockhash", () =>
        solanaRpc.getRecentBlockhash(rpc, "confirmed")
      ),
    ]);
    prepared = { plan: input.plan, lookupTables, blockhash, lastValidBlockHeight };
  }
  const { lookupTables, blockhash, lastValidBlockHeight } = prepared;

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
      (m) => applyLookupTables(m, lookupTables),
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
      (m) => applyLookupTables(m, lookupTables),
      (m) => addSignersToTransactionMessage([input.owner], m)
    );
    const signed = await input.deadline.run("Signing the vault transaction", () =>
      signTransactionMessageWithSigners(message)
    );
    signedBytes = new Uint8Array(getTransactionEncoder().encode(signed));
  }

  if (signedBytes.length > SOLANA_TRANSACTION_SIZE_LIMIT_BYTES) {
    throw new Error(
      `Vault transaction is ${signedBytes.length} bytes; Solana allows at most ${SOLANA_TRANSACTION_SIZE_LIMIT_BYTES}`
    );
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

/** Return the one complete transaction supported by vault execution. */
function planInstructions(plan: EarnVaultTransactionPlan) {
  if (plan.instructions.length === 0) {
    throw new Error("Vault plan carried no instructions");
  }
  return plan.instructions;
}

/**
 * Simulate before signing.
 *
 * Worth the extra round trip on this path specifically: the instructions were
 * assembled by a third-party SDK against live vault state, so a stale reserve
 * set or a changed vault config surfaces here as a readable program error
 * instead of a landed, failed transaction the customer still paid for.
 *
 */
export async function simulateVaultPlan(
  env: Env,
  input: VaultPlanExecutionScope & {
    plan: EarnVaultTransactionPlan;
    owner: Address;
    rpcUrl: string;
  }
): Promise<
  | { ok: true; prepared: PreparedVaultPlanExecution }
  | { ok: false; error: string; logs: readonly string[] }
> {
  assertExpectedPlan(input.plan, input.cluster, input.expectedAssetIdentity);
  let instructions: EarnVaultTransactionPlan["instructions"];
  try {
    instructions = planInstructions(input.plan);
  } catch (cause) {
    return {
      ok: false,
      error: cause instanceof Error ? cause.message : "invalid vault plan",
      logs: [],
    };
  }

  await verifyVaultRpc(env, input);
  const rpc = solanaRpc.createRpc(env, { rpcUrl: input.rpcUrl });
  // Lookup-table transport failures are infrastructure failures, not a
  // program simulation verdict. Let them reject so callers preserve their
  // idempotency key and return a retryable 5xx instead of a caller-fault 400.
  const [lookupTables, { blockhash, lastValidBlockHeight }] = await Promise.all([
    resolveLookupTables(env, input),
    input.deadline.run("Fetching the vault simulation blockhash", () =>
      solanaRpc.getRecentBlockhash(rpc, "confirmed")
    ),
  ]);
  const message = pipe(
    createTransactionMessage({ version: 0 }),
    (m) => setTransactionMessageFeePayer(input.owner, m),
    (m) => setTransactionMessageLifetimeUsingBlockhash({ blockhash, lastValidBlockHeight }, m),
    (m) => appendTransactionMessageInstructions(instructions.map(toKitInstruction), m),
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
  return {
    ok: true,
    prepared: { plan: input.plan, lookupTables, blockhash, lastValidBlockHeight },
  };
}
