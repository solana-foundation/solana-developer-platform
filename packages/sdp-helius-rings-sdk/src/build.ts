import type { ShieldedAddress } from "@heliuslabs/zolana";
import type { WalletKeys, ZolanaClient } from "@heliuslabs/zolana/client";
import { checkedTransactionSize } from "@heliuslabs/zolana/interface";
import { fetchUserRecord, resolvedAddressFromRecord } from "@heliuslabs/zolana/wallet";
import {
  type BuildOperationInput,
  type BuildOperationResult,
  HeliusRingsError,
  SecretRef,
} from "@sdp/helius-rings";
import {
  address,
  appendTransactionMessageInstructions,
  compileTransaction,
  createTransactionMessage,
  getBase64Codec,
  getTransactionEncoder,
  type Instruction,
  pipe,
  setTransactionMessageFeePayer,
  setTransactionMessageLifetimeUsingBlockhash,
  type Transaction,
} from "@solana/kit";
import {
  getSetComputeUnitLimitInstruction,
  MAX_COMPUTE_UNIT_LIMIT,
} from "@solana-program/compute-budget";
import { withZolanaErrorBridgeSync } from "./error-bridge.js";
import { buildMerge } from "./flows/merge.js";
import {
  buildRingEntryTx,
  buildRingExitTx,
  buildRingTransferTx,
  buildRingWithdrawalTx,
} from "./flows/ring-spend.js";
import { buildShieldTransaction } from "./flows/shield.js";
import { buildTransfer, buildWithdrawal, type SpendDeps } from "./flows/spend.js";
import { spendKeys } from "./keys.js";
import {
  assertProvisionedIdentity,
  canonicalShieldedIdentity,
  type ShieldedMaterialSource,
} from "./material.js";
import { hydrateWallet } from "./wallet.js";

/**
 * Turns a persisted operation into an unsigned, proved outer transaction.
 *
 * The whole build runs inside one `withMaterial` scope: every step needs the
 * shielded keys and none should outlive the call. Only what SDP can safely hold
 * comes back out — transaction bytes, the blockhash expiry, and the
 * commitments of the notes spent.
 */

/**
 * The blockhash a build is pinned to. Structural rather than imported: the SDK
 * declares `LatestBlockhash` but does not re-export it publicly.
 */
type Lifetime = Awaited<ReturnType<ZolanaClient["getLatestBlockhash"]>>;

export interface BuildDeps {
  readonly client: ZolanaClient;
  readonly material: ShieldedMaterialSource;
  readonly organizationId: string;
  readonly projectId: string;
}

export async function buildRingsOperation(
  deps: BuildDeps,
  input: BuildOperationInput
): Promise<BuildOperationResult> {
  const operation = input.operation;
  const owner = address(input.owner);

  return deps.material.withMaterial(
    {
      organizationId: deps.organizationId,
      projectId: deps.projectId,
      walletId: operation.walletId,
      owner: input.owner,
    },
    async (material) => {
      if (input.expectedShieldedAddress) {
        assertProvisionedIdentity(material, input.expectedShieldedAddress);
      }

      const mint = requireMint(input);

      if (operation.opType === "shield") {
        // No wallet, no keys, no note selection: a deposit creates notes.
        // The builder fetches its own blockhash, so this one is only a floor
        // for the recorded expiry — read here to keep that floor tight.
        const floor = await deps.client.getLatestBlockhash();
        return finish(
          await buildShieldTransaction(deps.client, {
            owner: input.owner,
            material,
            mint,
            amountRaw: requireAmount(input),
            ...(operation.ringProgramId ? { ringProgramId: operation.ringProgramId } : {}),
          }),
          [],
          floor
        );
      }

      const isRingMove = operation.opType === "ring_exit" || operation.opType === "ring_entry";
      if (
        operation.opType !== "withdraw" &&
        operation.opType !== "transfer_registered" &&
        operation.opType !== "merge" &&
        !isRingMove
      ) {
        throw new HeliusRingsError(
          "invalid_input",
          `unsupported Rings operation type: ${operation.opType}`
        );
      }

      // Ring-bound notes are consolidated by an instruction the protocol
      // reserves a tag for but ships no builder for, so this is refused rather
      // than routed. Unreachable through the route schema, which has no `ring`
      // on the merge arm at all.
      if (operation.opType === "merge" && operation.ringProgramId) {
        throw new HeliusRingsError(
          "invalid_input",
          "ring-bound notes cannot be merged; merge the default ring's notes instead"
        );
      }

      // A pinned ring routes to the SDK's one-call ring builders after wallet
      // hydration. They need the ring's lookup table; its absence fails here,
      // before the wallet read it could never use. A ring move demands the
      // pair unconditionally — the ring is the operation's whole meaning, so a
      // missing pin must be this config_error, never a default-pool build.
      const ring = isRingMove || operation.ringProgramId ? requireRing(input) : null;

      // Copies of the material's keys, so they carry their own lifetime inside
      // the material's scope.
      const keys = spendKeys(material, deps.client);

      try {
        // Every spend reads the wallet first: note selection is only as good as
        // the state it selects from. `requireComplete` makes an incomplete read
        // fatal here, unlike on the reporting path.
        const { wallet } = await hydrateWallet({
          walletId: operation.walletId,
          client: deps.client,
          keys,
          requireComplete: true,
          // A note the indexer has not yet seen consumed still looks spendable,
          // and the chain rejects the transaction it is chosen for.
          ...(input.requireSlot ? { requireSlot: BigInt(input.requireSlot) } : {}),
        });

        if (ring) {
          return await buildRingSpend(deps, input, {
            ring,
            mint,
            wallet,
            keys,
            owner,
            self: material.shieldedAddress,
          });
        }

        return await buildDefaultSpend(deps, input, { mint, wallet, keys, owner });
      } finally {
        keys.destroy();
      }
    }
  );
}

type HydratedWallet = Awaited<ReturnType<typeof hydrateWallet>>["wallet"];

/** The port's `ring` pair, or the config_error a ring-bound spend fails with without it. */
function requireRing(input: BuildOperationInput): NonNullable<BuildOperationInput["ring"]> {
  if (!input.ring) {
    throw new HeliusRingsError(
      "config_error",
      "a ring-bound spend needs the ring's lookup table; resume ring bring-up"
    );
  }
  return input.ring;
}

/**
 * A ring-bound spend, through the SDK's one-call ring builders. No pinned
 * inputs and none returned; see docs/ops/helius-rings.md, "Semantics worth
 * knowing", for the rebuild and prepared-intent contracts.
 */
async function buildRingSpend(
  deps: BuildDeps,
  input: BuildOperationInput,
  context: Readonly<{
    ring: Readonly<{ programId: string; lookupTable: string }>;
    mint: string;
    wallet: HydratedWallet;
    keys: WalletKeys;
    owner: ReturnType<typeof address>;
    /** The wallet's own shielded address; a ring exit's only allowed recipient. */
    self: ShieldedAddress;
  }>
): Promise<BuildOperationResult> {
  const ringSpend = {
    client: deps.client,
    wallet: context.wallet,
    keys: context.keys,
    owner: context.owner,
  };
  const ringInput = {
    ringProgramId: context.ring.programId,
    lookupTable: context.ring.lookupTable,
    mint: context.mint,
    amountRaw: requireAmount(input),
  };

  // The builders fetch their own blockhash, so this read only floors the
  // recorded expiry (the shield branch's contract). It is independent of the
  // transfer's recipient-material load, so the two run together — settled
  // jointly, then inspected in the old sequential order so which failure
  // surfaces is unchanged.
  const [floor, recipient] = await Promise.allSettled([
    deps.client.getLatestBlockhash(),
    input.operation.opType === "transfer_registered"
      ? liftRecipientShieldedAddress(deps, input)
      : Promise.resolve(null),
  ]);
  if (floor.status === "rejected") throw floor.reason;
  if (recipient.status === "rejected") throw recipient.reason;

  const tx = recipient.value
    ? await buildRingTransferTx(ringSpend, { ...ringInput, recipient: recipient.value })
    : input.operation.opType === "ring_exit"
      ? await buildRingExitTx(ringSpend, { ...ringInput, recipient: context.self })
      : input.operation.opType === "ring_entry"
        ? await buildRingEntryTx(ringSpend, ringInput)
        : await buildRingWithdrawalTx(ringSpend, {
            ...ringInput,
            recipient: requireRecipient(input),
          });
  return finish(tx, [], floor.value);
}

/**
 * A default-pool spend after wallet hydration: merge consolidates the wallet's
 * own notes; transfer and withdrawal differ only in how the recipient is named
 * — a shielded address the recipient's own material has to yield, or a public
 * one.
 */
async function buildDefaultSpend(
  deps: BuildDeps,
  input: BuildOperationInput,
  context: Readonly<{
    mint: string;
    wallet: HydratedWallet;
    keys: WalletKeys;
    owner: ReturnType<typeof address>;
  }>
): Promise<BuildOperationResult> {
  const { mint, wallet, keys, owner } = context;

  if (input.operation.opType === "merge") {
    // The merge builder assembles and blockhashes its own transaction, so this
    // read only floors the recorded expiry — the shield branch's contract.
    const floor = await deps.client.getLatestBlockhash();
    const merged = await buildMerge(
      { client: deps.client, wallet, keys, owner },
      {
        mint,
        ...(input.pinnedInputs ? { pinnedInputs: input.pinnedInputs } : {}),
      }
    );
    return finish(merged.transaction, merged.inputNotes, floor);
  }

  const spend: SpendDeps = { client: deps.client, wallet, keys, owner };
  const asset = {
    mint,
    amountRaw: requireAmount(input),
    ...(input.pinnedInputs ? { pinnedInputs: input.pinnedInputs } : {}),
  };

  const built =
    input.operation.opType === "transfer_registered"
      ? await buildTransfer(spend, {
          ...asset,
          recipient: await liftRecipientShieldedAddress(deps, input),
        })
      : await buildWithdrawal(spend, { ...asset, recipient: requireRecipient(input) });

  const lifetime = await deps.client.getLatestBlockhash();
  return finish(assemble(owner, built.instructions ?? [], lifetime), built.inputNotes, lifetime);
}

/**
 * Loads the recipient's material inside its own scope purely to lift out the
 * ShieldedAddress. That object is public — no secrets outlive the scope — and
 * Zolana's transfer builders need the full three-key form the canonical
 * shielded-identity string can't rebuild alone.
 */
async function liftRecipientShieldedAddress(
  deps: BuildDeps,
  input: BuildOperationInput
): Promise<ShieldedAddress> {
  if (!input.recipient) {
    throw new HeliusRingsError(
      "invalid_input",
      "a private transfer needs a recipient wallet identifier"
    );
  }
  const recipient = input.recipient;

  // Read the recipient off the registry rather than deriving it. Every half of a
  // recipient's identity is public and already published on chain, so a sender
  // needs none of their key material — which is what makes a recipient in another
  // project, or another tenant's custody entirely, resolvable at all.
  const record = await fetchUserRecord({ rpc: deps.client, owner: address(recipient.owner) });
  if (!record) {
    throw new HeliusRingsError(
      "conflict",
      `the Rings recipient ${recipient.owner} has no published user record; provision the recipient wallet first`
    );
  }

  const resolved = resolvedAddressFromRecord(address(recipient.owner), record);
  const published = canonicalShieldedIdentity(resolved.address);
  if (published !== recipient.expectedShieldedAddress) {
    // The registry moved under a persisted recipient: either it was re-keyed, or
    // the caller named an identity this owner never published.
    throw new HeliusRingsError(
      "conflict",
      `the Rings recipient ${recipient.owner} now publishes a different shielded identity; re-read the recipient wallet before transferring to it`
    );
  }

  return resolved.address;
}

/** Fee payer, blockhash, instructions — what the low-level rail leaves to us. */
function assemble(
  owner: ReturnType<typeof address>,
  instructions: readonly Instruction[],
  lifetime: Lifetime
): Transaction {
  return withZolanaErrorBridgeSync(() =>
    checkedTransactionSize(
      compileTransaction(
        pipe(
          createTransactionMessage({ version: 0 }),
          (message) => setTransactionMessageFeePayer(owner, message),
          (message) => setTransactionMessageLifetimeUsingBlockhash(lifetime, message),
          (message) =>
            appendTransactionMessageInstructions(
              // Solana's 1.4M maximum rather than Zolana's 300K, so this alpha
              // path is not under-budgeted. No CU-price instruction, so no
              // priority fee.
              [
                getSetComputeUnitLimitInstruction({ units: MAX_COMPUTE_UNIT_LIMIT }),
                ...instructions,
              ],
              message
            )
        )
      )
    )
  );
}

/**
 * Wraps a built transaction into the port's plain DTO.
 *
 * `requiredSigners` is advisory metadata for diagnostics. The caller validates
 * the serialized message header before custody signing; metadata derived from
 * this in-memory transaction is not the signing security boundary.
 */
function finish(
  transaction: Transaction,
  inputNotes: readonly string[],
  lifetime: Lifetime
): BuildOperationResult {
  const signers = Object.keys(transaction.signatures);

  return {
    outerUnsignedTxBase64: getBase64Codec().decode(getTransactionEncoder().encode(transaction)),
    requiredSigners: signers,
    lastValidBlockHeight: lifetime.lastValidBlockHeight.toString(),
    inputNotes: [...inputNotes],
    proof: {
      // `simulated` is reserved for the in-memory gateway; the distinction
      // tells an operator whether a completed operation moved real value.
      source: "live",
      // The proof is embedded in the transaction bytes, so there is no separate
      // artifact — the ref only records that one was obtained.
      ref: new SecretRef(`inline:${signers.length}:${inputNotes.length}`),
      createdAt: new Date().toISOString(),
    },
  };
}

function requireMint(input: BuildOperationInput): string {
  const mint = input.operation.input?.asset?.mint;
  if (!mint) {
    // Unreachable through the route schemas, but an absent asset must never
    // default to native SOL: that would move a token the caller never named.
    throw new HeliusRingsError("invalid_input", `a ${input.operation.opType} needs an asset`);
  }
  return mint;
}

function requireAmount(input: BuildOperationInput): string {
  const amountRaw = input.operation.input?.asset?.amountRaw;
  if (!amountRaw) {
    throw new HeliusRingsError("invalid_input", `a ${input.operation.opType} needs an amount`);
  }
  return amountRaw;
}

function requireRecipient(input: BuildOperationInput): string {
  const to = input.operation.input?.to;
  if (!to) {
    throw new HeliusRingsError("invalid_input", `a ${input.operation.opType} needs a recipient`);
  }
  return to;
}
