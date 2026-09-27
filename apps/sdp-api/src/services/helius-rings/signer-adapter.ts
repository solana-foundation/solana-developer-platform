import { SigningError } from "@sdp/custody/signing";
import { getBase64Codec } from "@solana/codecs";
import {
  address,
  getAddressEncoder,
  getSignatureFromTransaction,
  getTransactionDecoder,
  getTransactionEncoder,
  signatureBytes,
  type Transaction,
  type TransactionWithinSizeLimit,
  type TransactionWithLifetime,
  verifySignature,
} from "@solana/kit";
import {
  createSignableMessage,
  isMessagePartialSigner,
  isTransactionModifyingSigner,
  isTransactionPartialSigner,
  type TransactionSigner,
} from "@solana/signers";
import { getDb } from "@/db";
import { AppError } from "@/lib/errors";
import type { SigningProviderType } from "@/services/adapters/signing";
import { CustodyRuntimeTargets } from "@/services/domain/signing/custody-runtime-target";
import { createOrgSignerForCustodyWallet } from "@/services/solana/signer";
import { CustodyConfigStore } from "@/services/stores/custody-config.store";
import type { Env } from "@/types/env";
import { RingsAdapterError } from "./adapter-error";

/**
 * Signs the gateway-built outer transaction with the SDP custody signer.
 * Base64 bytes in, base64 bytes out — no SecretRef crosses this boundary, and
 * the transaction bytes are never logged here (they can carry routing
 * metadata the redaction registry does not model).
 */

/** Signer errors that a retry cannot fix. */
const NON_RETRYABLE_SIGNING_CODES = new Set([
  "PROVIDER_NOT_CONFIGURED",
  "WALLET_NOT_FOUND",
  "NOT_FOUND",
  "INVALID_REQUEST",
  "APPROVAL_REJECTED",
]);

/**
 * Providers that sign raw message bytes as-is, and reproducibly.
 *
 * Rings needs more than raw-byte signing: the shielded keys derive from the
 * owner's signature over Zolana's derivation message, re-derived on every use,
 * so the provider must return the exact same 64 bytes for that message forever.
 * A provider that fails either requirement cannot hold a Rings wallet at all.
 *
 * The omissions are deliberate, and none is a passing structural check.
 *
 * Cannot sign the bytes:
 *  - `coinbase_cdp` UTF-8-decodes the payload, and the derivation envelope opens
 *    with `0xff`, which is not valid UTF-8.
 *  - `utila` has a `signMessages` that throws, so `isMessagePartialSigner` says
 *    yes and the call fails afterwards — as a *retryable* signer failure, which
 *    would retry forever. Refusing up front is the difference.
 *  - `anchorage` does no transaction signing in SDP.
 *
 * Sign the bytes, but not reproducibly:
 *  - `fireblocks`, `para` and `dfns` are MPC custodians. No party holds the
 *    whole key, so none can compute the RFC 8032 deterministic nonce, and
 *    threshold EdDSA must randomize it anyway — deterministic nonces enable
 *    key recovery across signing ceremonies (RFC 9591 §"nonces MUST be
 *    sampled uniformly at random"; Fireblocks' SECURITY-MODEL.md documents
 *    CSPRNG nonces as deliberate). Same message, different signature, every
 *    call: the wallet derives a fresh identity per read and pauses on the
 *    first sync that misses the one it published. Re-keying cannot converge.
 *  - `ibm_haven` is unverified either way; refused until its signing is
 *    proven reproducible.
 *
 * `privy` and `turnkey` were verified reproducible against their live APIs
 * (identical signatures for repeated signs, 2026-09-11); `local` signs with
 * `@solana/kit`, which is RFC 8032 deterministic.
 *
 * Signing the bare `"TSPP/derive/v1"` payload instead would get CDP past this,
 * and is why it is not done: the bare payload yields a different seed, so those
 * wallets would fork onto identities no other provider can reproduce.
 */
const RAW_MESSAGE_SIGNING_PROVIDERS: ReadonlySet<SigningProviderType> = new Set([
  "local",
  "privy",
  "turnkey",
]);

export interface SignRingsOuterTransactionInput {
  env: Env;
  organizationId: string;
  projectId: string;
  /**
   * The address the transaction requires a signature from — the Rings wallet's
   * owner, which is also the fee payer of every outer transaction.
   *
   * Named explicitly rather than left to the organization's default signer.
   * Rings registers an identity *to* an owner and spends *from* it, so signing
   * with whichever wallet the org config happens to default to would at best
   * be rejected for a missing signature and at worst move the wrong wallet's
   * money.
   */
  owner: string;
  unsignedTxBase64: string;
  /**
   * The custody-wallet row this rings wallet was provisioned against, when the
   * caller has one recorded. That row is the authority the operation was
   * authorized against: while it qualifies it is preferred, and when it no
   * longer does, resolution refuses rather than signing through another row.
   */
  custodyWalletId?: string | null;
  /** Test seam; production resolves the owner's custody wallet. */
  signer?: TransactionSigner;
}

export interface AssertRingsSignedTransactionMatchesInput {
  owner: string;
  unsignedTxBase64: string;
  signedTxBase64: string;
}

/**
 * Binds signer output to the exact transaction that passed the wire policy.
 *
 * A modifying signer is allowed by the generic Solana signer interface, but
 * Rings approves one immutable compiled message. The signed envelope must
 * therefore contain that message unchanged and exactly one non-null signature
 * in its sole owner slot.
 */
export async function assertRingsSignedTransactionMatches(
  input: AssertRingsSignedTransactionMatchesInput
): Promise<string> {
  try {
    const owner = address(input.owner);
    const unsigned = decodeCanonicalTransaction(input.unsignedTxBase64);
    const signed = decodeCanonicalTransaction(input.signedTxBase64);

    if (!equalBytes(unsigned.messageBytes, signed.messageBytes)) {
      throw new Error("signed message changed");
    }

    const unsignedSignatures = Object.entries(unsigned.signatures);
    const signedSignatures = Object.entries(signed.signatures);
    if (
      unsignedSignatures.length !== 1 ||
      unsignedSignatures[0]?.[0] !== owner ||
      unsignedSignatures[0]?.[1] !== null ||
      signedSignatures.length !== 1 ||
      signedSignatures[0]?.[0] !== owner ||
      signedSignatures[0]?.[1] === null
    ) {
      throw new Error("signed envelope has unexpected signatures");
    }

    const ownerSignature = signedSignatures[0][1];
    const ownerPublicKey = await crypto.subtle.importKey(
      "raw",
      new Uint8Array(getAddressEncoder().encode(owner)),
      { name: "Ed25519" },
      false,
      ["verify"]
    );
    if (
      !(await verifySignature(ownerPublicKey, signatureBytes(ownerSignature), signed.messageBytes))
    ) {
      throw new Error("owner signature does not verify");
    }

    return getSignatureFromTransaction(signed);
  } catch {
    throw new RingsAdapterError(
      "signer_failed",
      "signer output does not match the approved transaction",
      { retryable: false }
    );
  }
}

function decodeCanonicalTransaction(value: string): Transaction {
  const bytes = new Uint8Array(getBase64Codec().encode(value));
  const [transaction, offset] = getTransactionDecoder().read(bytes, 0);
  if (offset !== bytes.length || !equalBytes(getTransactionEncoder().encode(transaction), bytes)) {
    throw new Error("noncanonical transaction");
  }
  return transaction;
}

function equalBytes(left: ArrayLike<number>, right: ArrayLike<number>): boolean {
  if (left.length !== right.length) return false;
  for (let index = 0; index < left.length; index += 1) {
    if (left[index] !== right[index]) return false;
  }
  return true;
}

/** The test-seam signer, or the owner's custody signer with failures mapped once. */
async function ownerSigner(
  input: Pick<
    SignRingsOuterTransactionInput,
    "env" | "organizationId" | "projectId" | "owner" | "custodyWalletId"
  > & {
    signer?: TransactionSigner;
  }
): Promise<TransactionSigner> {
  try {
    return input.signer ?? (await resolveOwnerSigner(input));
  } catch (error) {
    throw toSignerFailure(error);
  }
}

export async function signRingsOuterTransaction(
  input: SignRingsOuterTransactionInput
): Promise<string> {
  const base64 = getBase64Codec();

  const signer = await ownerSigner(input);
  let signed: Transaction;

  // The decoder returns an unbranded Transaction; the gateway built these
  // bytes as a complete compiled tx, which is what the signer brands assert.
  const transaction = getTransactionDecoder().decode(
    base64.encode(input.unsignedTxBase64)
  ) as Transaction & TransactionWithinSizeLimit & TransactionWithLifetime;

  try {
    if (isTransactionModifyingSigner(signer)) {
      [signed] = await signer.modifyAndSignTransactions([transaction]);
    } else if (isTransactionPartialSigner(signer)) {
      const [signatures] = await signer.signTransactions([transaction]);
      signed = { ...transaction, signatures: { ...transaction.signatures, ...signatures } };
    } else {
      throw new RingsAdapterError(
        "signer_failed",
        "custody signer cannot sign compiled transactions",
        { retryable: false }
      );
    }
  } catch (error) {
    throw toSignerFailure(error);
  }

  return base64.decode(getTransactionEncoder().encode(signed));
}

export interface SignRingsMessageInput {
  env: Env;
  organizationId: string;
  projectId: string;
  /** Base58 address of the key the message requires a signature from. */
  owner: string;
  messageBase64: string;
  /**
   * The custody-wallet row this rings wallet was provisioned against, when the
   * caller has one recorded. Same authority as the transaction path.
   */
  custodyWalletId?: string | null;
  /** Test seam; production resolves the owner's custody signer. */
  signer?: TransactionSigner;
}

/**
 * Ed25519 over raw message bytes with the same custody signer resolution as the
 * transaction path. Ring bring-up needs it for the auditor-key attestation,
 * which is a signed message rather than a transaction.
 */
export async function signRingsMessage(input: SignRingsMessageInput): Promise<string> {
  const base64 = getBase64Codec();

  const signer = await ownerSigner(input);
  if (!isMessagePartialSigner(signer)) {
    throw new RingsAdapterError("signer_failed", "custody signer cannot sign raw messages", {
      retryable: false,
    });
  }

  try {
    const [signatures] = await signer.signMessages([
      createSignableMessage(new Uint8Array(base64.encode(input.messageBase64))),
    ]);
    const signature = signatures?.[signer.address];
    if (!signature) {
      throw new RingsAdapterError(
        "signer_failed",
        "custody signing produced no signature for the named owner",
        { retryable: false }
      );
    }
    return base64.decode(signature);
  } catch (error) {
    throw toSignerFailure(error);
  }
}

/**
 * Resolves the custody wallet holding the owner's key.
 *
 * By public key rather than by the `custody_wallet_id` recorded on the rings
 * wallet: that link is the durable audit trail, but the only thing that makes
 * a signature valid is that it comes from the key the transaction names. The
 * lookup is scoped to the organization and to active wallets, so an owner
 * custody no longer controls fails here rather than at the chain.
 *
 * When the caller has a recorded custody-wallet row, that row is the authority
 * the operation was authorized against: it is preferred while it still
 * qualifies, and a runtime denial of it is raised by its admission rather
 * than bypassed through another row. When it no longer qualifies (inactive,
 * moved off the tenant, rekeyed), resolution refuses: key-based resolution
 * would sign through a different row that was never authorized as the
 * replacement. The config store only sees `custody_configs` wallets, so when
 * there is no recorded row and the key-based lookups miss there, the resolver
 * re-queries through the connection-aware custody path before giving up: an
 * owner provisioned under an active custody connection (the BYOK path) is
 * otherwise unreachable and every provisioning attempt strands its Rings row
 * in `pending`. Either way the signer is built from one exact custody-wallet
 * row and must still hold the owner's key.
 */
async function resolveOwnerSigner(
  input: Pick<
    SignRingsOuterTransactionInput,
    "env" | "organizationId" | "projectId" | "owner" | "custodyWalletId"
  >
): Promise<TransactionSigner> {
  const runtimeTargets = new CustodyRuntimeTargets(getDb(input.env), input.env, new Map());

  if (input.custodyWalletId) {
    const recorded = await runtimeTargets.findAuthorizedWalletRecordById({
      organizationId: input.organizationId,
      projectId: input.projectId,
      custodyWalletId: input.custodyWalletId,
      publicKey: input.owner,
    });
    if (recorded) {
      assertRawMessageSigningProvider(recorded.provider);
      return ownerSignerForWalletRecord(input, recorded.id);
    }
    // The recorded row no longer backs the owner's key in this tenant — the
    // row is gone, inactive, or rekeyed. Falling through to the key-based
    // paths would sign through a different row the caller never authorized as
    // the replacement, so the miss is refused. Relinking the rings wallet (or
    // re-provisioning) is the fix, and the row id is named so an operator can
    // find which wallet is stranded.
    throw new SigningError(
      `recorded custody wallet ${input.custodyWalletId} no longer backs owner ${input.owner}`,
      "WALLET_NOT_FOUND"
    );
  }

  const configWallet = await new CustodyConfigStore(
    getDb(input.env),
    input.env
  ).findActiveWalletByPublicKey(input.organizationId, input.projectId, input.owner);
  if (configWallet) {
    assertRawMessageSigningProvider(configWallet.provider);
    return ownerSignerForWalletRecord(input, configWallet.id);
  }
  return resolveConnectionOwnerSigner(input, runtimeTargets);
}

/**
 * Fallback for owners held by connection-owned custody wallets, resolved
 * through the same tenant-scoped, connection-aware path every runtime flow
 * uses. The lookup is address-scoped — the config path above already settled
 * config-owned rows — and orders candidates so a connection that can sign now
 * beats one that cannot: when several rows hold the owner's key, the signer is
 * built from the row whose connection can actually serve the signature, and a
 * paused or unavailable connection is chosen only when nothing else holds the
 * key, in which case its runtime admission names the custody state. Either way
 * the signer is built from one exact custody-wallet row and must still hold
 * the owner's key.
 */
async function resolveConnectionOwnerSigner(
  input: Pick<
    SignRingsOuterTransactionInput,
    "env" | "organizationId" | "projectId" | "owner" | "custodyWalletId"
  >,
  runtimeTargets: CustodyRuntimeTargets
): Promise<TransactionSigner> {
  const candidates = await runtimeTargets.findConnectionWalletsByAddress({
    organizationId: input.organizationId,
    projectId: input.projectId,
    publicKey: input.owner,
  });

  const candidate = candidates[0];
  if (!candidate) {
    throw new SigningError(`custody does not control ${input.owner}`, "WALLET_NOT_FOUND");
  }
  assertRawMessageSigningProvider(candidate.provider);
  return ownerSignerForWalletRecord(input, candidate.id);
}

function assertRawMessageSigningProvider(provider: SigningProviderType): void {
  if (RAW_MESSAGE_SIGNING_PROVIDERS.has(provider)) {
    return;
  }
  // Raised as its own failure code rather than as a signer failure: nothing
  // signed and nothing broke, so "custody could not sign" would send an
  // operator looking for an outage. Names the provider, the requirement it
  // does not meet, and the providers that do — the only fix is moving the
  // wallet, and the message has to be able to say so on its own.
  throw new RingsAdapterError(
    "provider_unsupported",
    `custody provider ${provider} cannot back a Rings private wallet: its shielded keys are re-derived from an owner custody signature on every use, which needs a provider that signs raw messages and returns the same signature every time. Providers that do: ${[...RAW_MESSAGE_SIGNING_PROVIDERS].join(", ")}.`,
    { retryable: false }
  );
}

/** Builds the signer for one exact custody-wallet row, verified against the owner. */
async function ownerSignerForWalletRecord(
  input: Pick<SignRingsOuterTransactionInput, "env" | "organizationId" | "projectId" | "owner">,
  custodyWalletId: string
): Promise<TransactionSigner> {
  const signer = await createOrgSignerForCustodyWallet(
    input.env,
    input.organizationId,
    input.projectId,
    custodyWalletId
  );

  // Unreachable via the scoped lookups above, but the cost of being wrong is
  // signing someone else's transfer. Names the row so an operator can find the
  // divergence between it and its provider.
  if (signer.address !== input.owner) {
    throw new SigningError(
      `custody wallet ${custodyWalletId} resolved ${signer.address} for owner ${input.owner}`,
      "WALLET_NOT_FOUND"
    );
  }

  return signer;
}

/**
 * Runtime admission refusals, raised while building the signer for one exact
 * custody-wallet row: the connection is paused or otherwise unavailable, or
 * the provider is not entitled on this tier. Nothing signed and nothing broke,
 * and no retry fixes them — custody (or the tier) has to change first. They
 * therefore carry their own failure code rather than signer_failed: filing
 * them as a signing failure (retryable or not) reads as a signer bug or a
 * service outage, when the row has to name the custody state that names the
 * fix.
 */
const RUNTIME_ADMISSION_FAILURE_REASONS = new Set([
  "runtime_execution_paused",
  "runtime_execution_unavailable",
  "provider_not_entitled",
]);

function toSignerFailure(error: unknown): RingsAdapterError {
  if (error instanceof RingsAdapterError) return error;
  if (error instanceof SigningError) {
    return new RingsAdapterError("signer_failed", error.message, {
      retryable: !NON_RETRYABLE_SIGNING_CODES.has(error.code),
      cause: error,
    });
  }
  if (
    error instanceof AppError &&
    typeof error.details?.reason === "string" &&
    RUNTIME_ADMISSION_FAILURE_REASONS.has(error.details.reason)
  ) {
    // The admission messages are built for the operator in this codebase and
    // are redacted again below, so they are safe to carry verbatim — the row
    // (and the caller) learns whether the wallet is paused, the connection is
    // unavailable, or the tier is not entitled, instead of a generic custody
    // signing failure.
    return new RingsAdapterError("custody_unavailable", error.message, {
      retryable: false,
      cause: error,
    });
  }
  return new RingsAdapterError("signer_failed", "custody signing failed", {
    retryable: true,
    cause: error,
  });
}
