import { createHash } from "node:crypto";
import type { EarnVaultAssetIdentity, EarnVaultTransactionPlan } from "@sdp/earn/types";
import { createClusterRpc } from "@sdp/rpc/factory";
import { currentClusterScope } from "@sdp/rpc/scope";
import { getRecentBlockhash, sendTransaction } from "@sdp/rpc/solana";
import { withTransientRpcRetry } from "@sdp/rpc/transient";
import { MEMO_PROGRAM_ADDRESS } from "@sdp/types/well-known-programs";
import {
  type Address,
  type AddressesByLookupTableAddress,
  address,
  appendTransactionMessageInstructions,
  type Blockhash,
  compileTransaction,
  compressTransactionMessageUsingAddressLookupTables,
  createTransactionMessage,
  fetchAddressesForLookupTables,
  getBase64EncodedWireTransaction,
  getCompiledTransactionMessageDecoder,
  getTransactionDecoder,
  getTransactionEncoder,
  type Instruction,
  blockhash as parseBlockhash,
  pipe,
  setTransactionMessageFeePayer,
  setTransactionMessageLifetimeUsingBlockhash,
} from "@solana/kit";
import { partiallySignTransactionMessageWithSigners } from "@solana/signers";
import type { VaultDeadline } from "./vault-deadline";
import { describeVaultSimulationError } from "./vault-simulation-error";
import type { VaultFeeMode } from "./vault-sponsorship";

/**
 * Validate, simulate and compile provider-neutral strategy plans. Signing is
 * owned by the operation worker; broadcasting takes already-recorded bytes.
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
  kind:
    | "strategy-deposit"
    | "strategy-withdrawal"
    | "strategy-withdrawal-request"
    | "strategy-withdrawal-cancel",
  requestId: string,
  options: { compact?: boolean } = {}
): EarnVaultTransactionPlan {
  // A CCTP event signer makes every mint unique. Appending a memo would erase
  // its authorization. The ledger's signature constraint also refuses reused builds.
  if (plan.providerTransaction !== undefined) return plan;
  // A second, caller-provided fee-payer signer costs 96 packet bytes. Some
  // provider plans fit with the owner paying but cross Solana's 1232-byte
  // limit with that extra signer. Preserve the idempotency binding in a short
  // cryptographic form when a caller explicitly asks for the compact retry:
  // 132 bits remains far beyond the collision budget for transaction intents.
  const payload = options.compact
    ? `sdp:e:${
        {
          "strategy-deposit": "sd",
          "strategy-withdrawal": "sw",
          "strategy-withdrawal-request": "sr",
          "strategy-withdrawal-cancel": "sc",
        }[kind]
      }:${createHash("sha256").update(requestId).digest("base64url").slice(0, 22)}`
    : `sdp:earn:${kind}:${requestId}`;
  const memo = {
    programAddress: MEMO_PROGRAM_ADDRESS,
    accounts: [],
    data: Buffer.from(payload, "utf8").toString("base64"),
  };
  return {
    ...plan,
    instructions: [...plan.instructions, memo],
  };
}

export interface VaultExecutionScope {
  /** One absolute budget shared by every stage in this vault workflow. */
  deadline: VaultDeadline;
}

export interface VaultPlanExecutionScope extends VaultExecutionScope {
  /** Catalogue identity authorized by the route before provider plan creation. */
  expectedAssetIdentity: EarnVaultAssetIdentity;
}

export interface PreparedVaultPlanExecution {
  plan: EarnVaultTransactionPlan;
  lookupTables: AddressesByLookupTableAddress;
  blockhash: Blockhash;
  lastValidBlockHeight: bigint;
}

function assertExpectedPlan(
  plan: EarnVaultTransactionPlan,
  expectedAssetIdentity: EarnVaultAssetIdentity
): void {
  const { cluster } = currentClusterScope();
  if (plan.cluster !== cluster) {
    throw new Error(`Vault plan targets ${plan.cluster}, not the expected ${cluster} cluster`);
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

function immutableVaultTransaction(
  plan: EarnVaultTransactionPlan,
  owner: string,
  feePayer: string
) {
  const immutable = plan.providerTransaction;
  if (immutable === undefined) throw new Error("Provider transaction is required");
  const bytes = Uint8Array.from(Buffer.from(immutable.transactionBase64, "base64"));
  assertVaultTransactionFits(bytes, feePayer === owner ? false : "caller-provided");
  const transaction = getTransactionDecoder().decode(bytes);
  const compiled = getCompiledTransactionMessageDecoder().decode(transaction.messageBytes);
  if (compiled.staticAccounts[0] !== feePayer)
    throw new Error("Provider transaction fee payer differs from the admitted payer");
  const expected = new Set([owner, feePayer, ...immutable.additionalSigners]);
  const actual = Object.keys(transaction.signatures);
  if (actual.length !== expected.size || actual.some((signer) => !expected.has(signer)))
    throw new Error("Provider transaction signer set differs from its admitted signer set");
  if (
    immutable.additionalSigners.length === 0 ||
    immutable.additionalSigners.some(
      (signer) =>
        signer === owner || signer === feePayer || transaction.signatures[address(signer)] == null
    )
  )
    throw new Error("Provider transaction lacks its required protocol signatures");
  return transaction;
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
  input: VaultExecutionScope & { plan: EarnVaultTransactionPlan }
): Promise<AddressesByLookupTableAddress> {
  if (input.plan.lookupTables.length === 0) return {};
  const rpc = createClusterRpc();
  return input.deadline.run("Fetching the vault lookup tables", () =>
    withTransientRpcRetry(() =>
      fetchAddressesForLookupTables(
        input.plan.lookupTables.map((table) => address(table)),
        rpc
      )
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
 * Typed oversize refusal lets atomic swap-funded deposits retry a more
 * compact route without matching error text. A plan that still cannot fit
 * is refused before signing; it is never split into separate transactions.
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

export interface CompileUnsignedVaultTransactionInput extends VaultPlanExecutionScope {
  plan: EarnVaultTransactionPlan;
  /**
   * The wallet: required signer of the compiled message, and its fee
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
  /**
   * Wire bytes awaiting owner and any fee-payer signatures. Required provider
   * signatures are already verified and preserved on their exact message.
   */
  bytes: Uint8Array;
  /** Inclusive block height after which these exact bytes cannot land. */
  lastValidBlockHeight: string;
}

/**
 * Compile one complete strategy transaction for its operation signing step.
 * The worker proves the returned signed message matches these exact bytes.
 * A caller-provided `feePayer`
 * changes only who sits in the fee-payer seat (adding its signature slot); the
 * pipeline order is unchanged. Signature slots encode as
 * zeroed 64-byte runs, which means the unsigned encoding and the signed one
 * are the same length and the size check below is exact.
 */
export function compileUnsignedVaultTransaction(
  input: CompileUnsignedVaultTransactionInput
): UnsignedVaultTransaction {
  assertExpectedPlan(input.plan, input.expectedAssetIdentity);
  if (input.plan.providerTransaction !== undefined) {
    immutableVaultTransaction(
      input.plan,
      input.owner,
      input.feePayer === undefined ? input.owner : input.feePayer
    );
    const bytes = Uint8Array.from(
      Buffer.from(input.plan.providerTransaction.transactionBase64, "base64")
    );
    return { bytes, lastValidBlockHeight: input.plan.providerTransaction.lastValidBlockHeight };
  }
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
        ? "Transactions must require only the owner signature"
        : "Transactions must require exactly the fee-payer and owner signatures"
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
  input: VaultExecutionScope & { bytes: Uint8Array }
): Promise<void> {
  const rpc = createClusterRpc();
  await input.deadline.run("Broadcasting the vault transaction", () =>
    sendTransaction(rpc, input.bytes)
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
  input: VaultPlanExecutionScope & {
    plan: EarnVaultTransactionPlan;
    owner: Address;
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
      /** The customer-facing sentence (`VaultSimulationVerdict.message`). */
      error: string;
      fault: "caller" | "sponsor";
      /** See `VaultSimulationVerdict.sponsorCause`; present on sponsor faults. */
      sponsorCause?: "balance" | "prefund";
      /**
       * The chain's own `TransactionError` variant, for operators and logs.
       * Absent when the plan was refused before the chain was asked.
       */
      raw?: string;
      logs: readonly string[];
    }
> {
  assertExpectedPlan(input.plan, input.expectedAssetIdentity);
  if (input.plan.providerTransaction !== undefined) {
    const feePayer =
      input.fee.kind === "sponsored"
        ? input.fee.sponsor
        : input.fee.kind === "caller-provided"
          ? input.fee.feePayer
          : input.owner;
    const transaction = immutableVaultTransaction(input.plan, input.owner, feePayer);
    const result = await input.deadline.run("Simulating the provider vault transaction", () =>
      createClusterRpc()
        .simulateTransaction(getBase64EncodedWireTransaction(transaction), {
          encoding: "base64",
          commitment: "confirmed",
          sigVerify: false,
          replaceRecentBlockhash: false,
        })
        .send()
    );
    if (result.value.err) {
      const verdict = describeVaultSimulationError(
        result.value.err,
        input.fee,
        result.value.logs === null ? [] : result.value.logs
      );
      return {
        ok: false,
        error: verdict.message,
        fault: verdict.fault,
        raw: verdict.raw,
        logs: result.value.logs === null ? [] : result.value.logs,
      };
    }
    const compiled = getCompiledTransactionMessageDecoder().decode(transaction.messageBytes);
    return {
      ok: true,
      prepared: {
        plan: input.plan,
        lookupTables: {},
        blockhash: parseBlockhash(compiled.lifetimeToken),
        lastValidBlockHeight: BigInt(input.plan.providerTransaction.lastValidBlockHeight),
      },
    };
  }
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

  const rpc = createClusterRpc();
  // Lookup-table transport failures are infrastructure failures, not a
  // program simulation verdict. Let them reject so callers preserve their
  // idempotency key and return a retryable 5xx instead of a caller-fault 400.
  const [lookupTables, { blockhash, lastValidBlockHeight }] = await Promise.all([
    resolveLookupTables(input),
    input.deadline.run("Fetching the vault simulation blockhash", () =>
      getRecentBlockhash(rpc, "confirmed")
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
  // Solana's RPC rejects an oversized base64 transaction before it can
  // simulate anything. Classify that locally with the same typed verdict the
  // signing/unsigned-compile paths use, so swap-funded callers can retry a
  // compact route before refusing an oversized atomic composition instead of
  // leaking the RPC's -32602 as an internal error.
  const compiledBytes = new Uint8Array(getTransactionEncoder().encode(compiled));
  assertVaultTransactionFits(
    compiledBytes,
    input.fee.kind === "sponsored"
      ? "sponsored"
      : input.fee.kind === "caller-provided"
        ? "caller-provided"
        : false
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
      raw: verdict.raw,
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
