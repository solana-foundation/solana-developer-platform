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
  bytesEqual,
  compileTransaction,
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
import type { Env } from "@/types/env";
import { assertClusterEndpoint } from "./execution-registry";
import type { VaultDeadline } from "./vault-deadline";
import { describeVaultSimulationError } from "./vault-simulation-error";
import type { VaultFeeMode } from "./vault-sponsorship";

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
  kind: "vault-deposit" | "vault-withdrawal" | "external-deposit" | "external-withdrawal",
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

/**
 * Typed oversize refusal, so a caller that can legitimately fall back — the
 * swap-funded deposit build splits into a swap transaction plus a follow-up
 * deposit when the composed plan cannot fit — can recognize this exact
 * verdict without matching on message text. Everything else still treats it
 * as the hard stop it is.
 */
export class VaultTransactionTooLargeError extends Error {
  constructor(
    public readonly bytes: number,
    extraSigner: "sponsored" | "caller-provided" | false
  ) {
    super(
      `Vault transaction is ${bytes} bytes; Solana allows at most ` +
        `${SOLANA_TRANSACTION_SIZE_LIMIT_BYTES}` +
        (extraSigner === "sponsored"
          ? ". Sponsorship adds 96 bytes (one signature slot plus one account key) " +
            "that the provider did not know about when it sized this plan."
          : extraSigner === "caller-provided"
            ? ". The caller-provided fee payer adds 96 bytes (one signature slot plus one " +
              "account key) that the provider did not know about when it sized this plan."
            : "")
    );
    this.name = "VaultTransactionTooLargeError";
  }
}

/**
 * Refuse an oversized transaction, and on the sponsored path refuse it BEFORE
 * the paymaster is contacted.
 *
 * Safe to check on partially-signed bytes because the compiled message header
 * fixes `numRequiredSignatures`, so kit writes that many 64-byte slots whether
 * they are filled or not: the owner-signed encoding and the fully-signed
 * encoding of one message are byte-identical. Checking after the round trip
 * would spend a budget reservation (`signAsFeePayer` admits before it signs, and
 * nothing after that releases it) on a plan that can never be sent.
 */
function assertVaultTransactionFits(
  bytes: Uint8Array,
  extraSigner: "sponsored" | "caller-provided" | false
): void {
  if (bytes.length <= SOLANA_TRANSACTION_SIZE_LIMIT_BYTES) return;
  throw new VaultTransactionTooLargeError(bytes.length, extraSigner);
}

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
    // The sponsor was resolved before the provider built, because its address
    // also had to travel into the instructions as the rent payer. Reusing it
    // here is not just a saved round trip: re-reading it could hand signing a
    // DIFFERENT address than the one the instructions already name.
    const { feePayment, sponsor: feePayer } = input.fee;
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
    assertVaultTransactionFits(ownerSignedBytes, "sponsored");
    signedBytes = await input.deadline.run("Signing the sponsored vault fee", () =>
      feePayment.signAsFeePayer(ownerSignedBytes)
    );
    // A paymaster returns BYTES, not a signature, so nothing about the call
    // constrains it to return the message SDP just signed. Both checks belong
    // HERE, before the bytes are persisted: past that point a sigverify
    // rejection at broadcast is indistinguishable from a lost response, and the
    // movement parks reconcilable until its blockhash expires.
    //
    // Message equality is the check that catches a swap, because the cheaper
    // ones do not. The owner slot still carries a signature (over the OLD
    // message), and a SUBSTITUTED fee payer still satisfies
    // `getSignatureFromTransaction` below, which reads whatever sits in slot
    // zero. It also means Kora may not rewrite the plan: a relayer that injects
    // its own compute-budget or fee-transfer instruction fails here, loudly,
    // rather than sending bytes that were never simulated or size-checked.
    const sponsorSigned = getTransactionDecoder().decode(signedBytes);
    if (!bytesEqual(sponsorSigned.messageBytes, ownerSigned.messageBytes)) {
      throw new Error("Sponsored vault transaction came back over a different message");
    }
    if (
      sponsorSigned.signatures[feePayer] === null ||
      sponsorSigned.signatures[feePayer] === undefined
    ) {
      throw new Error("Vault transaction is missing the sponsor fee-payer signature");
    }
  } else if (input.fee.kind === "caller-provided") {
    // Unreachable from the custody paths by construction; asserted so a new
    // caller cannot silently fall through to wallet-pays and sign the custody
    // wallet as the fee payer. A caller-provided fee payer signs OUTSIDE SDP —
    // that flow compiles unsigned bytes via compileUnsignedVaultTransaction.
    throw new Error(
      "Caller-provided fee payers cannot be signed by SDP; compile the transaction unsigned instead"
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

  assertVaultTransactionFits(signedBytes, input.fee.kind === "sponsored" ? "sponsored" : false);
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

export interface CompileUnsignedVaultTransactionInput extends VaultPlanExecutionScope {
  plan: EarnVaultTransactionPlan;
  /**
   * The external wallet: required signer of the compiled message, and its fee
   * payer unless `feePayer` names someone else. A plain address on purpose —
   * SDP holds no signer for it, which is the whole point of the caller-signed
   * flow (PRO-1722).
   */
  owner: Address;
  /**
   * Optional caller-provided fee payer (the partner's wallet). When present
   * the compiled message requires ITS signature in slot zero alongside the
   * owner's, and whoever holds its key co-signs outside SDP before submit.
   */
  feePayer?: Address;
  /**
   * The successful simulation's preparation, REQUIRED rather than optional:
   * the caller-signed flow always simulates before handing bytes out, and
   * compiling from the same preparation is what guarantees the message the
   * owner signs is byte-for-byte the message that was simulated (same
   * blockhash, same resolved lookup tables).
   */
  prepared: PreparedVaultPlanExecution;
}

export interface UnsignedVaultTransaction {
  /** Wire bytes with every signature slot zeroed, ready for the owner to sign. */
  bytes: Uint8Array;
  /** Inclusive block height after which these exact bytes cannot land. */
  lastValidBlockHeight: string;
}

/**
 * Compile exactly one complete vault transaction WITHOUT any signature — the
 * caller-signed twin of `signVaultPlan`.
 *
 * The message shape must stay identical to the wallet-pays branch of
 * `signVaultPlan` (fee payer, lifetime, instructions, lookup-table
 * compression, in that order): the submit step later proves a signed
 * transaction is one SDP built by comparing MESSAGE bytes, so any divergence
 * here is a refused submit, not a subtle drift. A caller-provided `feePayer`
 * changes only who sits in the fee-payer seat (adding its signature slot); the
 * pipeline order is unchanged. Signature slots encode as
 * zeroed 64-byte runs, which means the unsigned encoding and the signed one
 * are the same length and the size check below is exact.
 */
export function compileUnsignedVaultTransaction(
  input: CompileUnsignedVaultTransactionInput
): UnsignedVaultTransaction {
  assertExpectedPlan(input.plan, input.cluster, input.expectedAssetIdentity);
  if (input.prepared.plan !== input.plan) {
    throw new Error("Vault execution preparation belongs to a different plan");
  }
  // A fee payer equal to the owner IS the owner paying: Solana deduplicates
  // account keys, so the compiled message would carry one signer slot and the
  // two-slot assertion below would refuse a legitimate build. Normalized here
  // so the invariant cannot depend on every caller pre-normalizing.
  const feePayer = input.feePayer === input.owner ? undefined : input.feePayer;
  const { lookupTables, blockhash, lastValidBlockHeight } = input.prepared;
  const instructions = planInstructions(input.plan).map(toKitInstruction);
  const message = pipe(
    createTransactionMessage({ version: 0 }),
    (m) => setTransactionMessageFeePayer(feePayer ?? input.owner, m),
    (m) => setTransactionMessageLifetimeUsingBlockhash({ blockhash, lastValidBlockHeight }, m),
    (m) => appendTransactionMessageInstructions(instructions, m),
    (m) => applyLookupTables(m, lookupTables)
  );
  const transaction = compileTransaction(message);
  // Ordered and exact, never a bare set: kit places the fee payer at static
  // slot zero, and this assertion is what refuses a provider plan that
  // smuggles an extra signer — with or without a caller-provided fee payer.
  const requiredSignerAddresses = Object.keys(transaction.signatures);
  const expectedSignerAddresses = feePayer === undefined ? [input.owner] : [feePayer, input.owner];
  if (
    requiredSignerAddresses.length !== expectedSignerAddresses.length ||
    expectedSignerAddresses.some((address, index) => requiredSignerAddresses[index] !== address)
  ) {
    throw new Error(
      feePayer === undefined
        ? "External-wallet vault transactions must require only the owner signature"
        : "External-wallet vault transactions must require exactly the fee-payer and owner signatures"
    );
  }
  const bytes = new Uint8Array(getTransactionEncoder().encode(transaction));
  assertVaultTransactionFits(bytes, feePayer === undefined ? false : "caller-provided");
  return { bytes, lastValidBlockHeight: String(lastValidBlockHeight) };
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
    /**
     * The SAME fee mode signing will use. Simulation enforces that the fee
     * payer can cover the fee, so simulating as the owner while signing as a
     * sponsor asks the chain a question about a transaction SDP never sends: a
     * custody wallet holding zero SOL is rejected here, with `AccountNotFound`
     * and no logs, and never reaches the signing it would have passed.
     */
    fee: VaultFeeMode;
  }
): Promise<
  | {
      ok: true;
      prepared: PreparedVaultPlanExecution;
      /** Compute units the simulation consumed, when the RPC reports them. */
      unitsConsumed?: bigint;
    }
  | {
      ok: false;
      error: string;
      fault: "caller" | "sponsor";
      /** See `VaultSimulationVerdict.sponsorCause`; present on sponsor faults. */
      sponsorCause?: "balance" | "prefund";
      logs: readonly string[];
    }
> {
  assertExpectedPlan(input.plan, input.cluster, input.expectedAssetIdentity);
  let instructions: EarnVaultTransactionPlan["instructions"];
  try {
    instructions = planInstructions(input.plan);
  } catch (cause) {
    return {
      ok: false,
      error: cause instanceof Error ? cause.message : "invalid vault plan",
      fault: "caller",
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
  // The owner stays a writable signer through the plan's own instruction
  // accounts either way, so the sponsored shape simulates as it will be sent:
  // funded sponsor as fee payer, owner unfunded, both signature slots still
  // empty (`sigVerify: false` is what makes that legal).
  // The SAME fee payer the transaction will carry: sponsorship's sponsor, a
  // caller-provided partner wallet, or the owner. Simulating any other payer
  // would check the wrong wallet's lamports AND produce a message that differs
  // from the compiled one.
  const feePayer =
    input.fee.kind === "sponsored"
      ? input.fee.sponsor
      : input.fee.kind === "caller-provided"
        ? input.fee.feePayer
        : input.owner;
  const message = pipe(
    createTransactionMessage({ version: 0 }),
    (m) => setTransactionMessageFeePayer(feePayer, m),
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
    // Logs sharpen the verdict: `Custom: 1` alone is unreadable, while the
    // failing program's own log line says "insufficient lamports" outright.
    const verdict = describeVaultSimulationError(
      result.value.err,
      input.fee,
      result.value.logs ?? []
    );
    return {
      ok: false,
      error: verdict.message,
      fault: verdict.fault,
      ...(verdict.sponsorCause === undefined ? {} : { sponsorCause: verdict.sponsorCause }),
      logs: result.value.logs ?? [],
    };
  }
  const unitsConsumed = result.value.unitsConsumed;
  return {
    ok: true,
    prepared: { plan: input.plan, lookupTables, blockhash, lastValidBlockHeight },
    ...(unitsConsumed === undefined ? {} : { unitsConsumed: BigInt(unitsConsumed) }),
  };
}
