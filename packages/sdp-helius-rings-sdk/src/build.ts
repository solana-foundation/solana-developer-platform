import type { ShieldedAddress } from "@heliuslabs/zolana";
import type { ZolanaClient } from "@heliuslabs/zolana/client";
import { checkedTransactionSize } from "@heliuslabs/zolana/interface";
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
import { CustodyWalletAuthority } from "./authority.js";
import { withZolanaErrorBridgeSync } from "./error-bridge.js";
import { buildRingTransferTx, buildRingWithdrawalTx } from "./flows/ring-spend.js";
import { buildShieldTransaction } from "./flows/shield.js";
import { buildTransfer, buildWithdrawal, type SpendDeps } from "./flows/spend.js";
import { assertProvisionedIdentity, type ShieldedMaterialSource } from "./material.js";
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
        // No wallet, no authority, no note selection: a deposit creates notes.
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

      if (operation.opType !== "withdraw" && operation.opType !== "transfer_registered") {
        throw new HeliusRingsError(
          "invalid_input",
          `unsupported Rings operation type: ${operation.opType}`
        );
      }

      // A pinned ring routes to the SDK's one-call ring builders after wallet
      // hydration. They need the ring's lookup table; its absence fails here,
      // before the wallet read it could never use.
      const ringLookupTable = operation.ringProgramId ? input.ringLookupTable : undefined;
      if (operation.ringProgramId && !ringLookupTable) {
        throw new HeliusRingsError(
          "config_error",
          "a ring-bound spend needs the ring's lookup table; resume ring bring-up"
        );
      }

      // Every spend reads the wallet first: note selection is only as good as
      // the state it selects from. `requireComplete` makes an incomplete read
      // fatal here, unlike on the reporting path.
      const authority = new CustodyWalletAuthority({
        material,
        authorization: {
          owner: input.owner,
          operationId: operation.id,
          intentKey: operation.intentKey,
        },
      });
      const { wallet } = await hydrateWallet({
        walletId: operation.walletId,
        client: deps.client,
        material,
        authority,
        requireComplete: true,
        // A note the indexer has not yet seen consumed still looks spendable,
        // and the chain rejects the transaction it is chosen for.
        ...(input.requireSlot ? { requireSlot: BigInt(input.requireSlot) } : {}),
      });

      if (operation.ringProgramId && ringLookupTable) {
        return buildRingSpend(deps, input, {
          ringProgramId: operation.ringProgramId,
          ringLookupTable,
          mint,
          wallet,
          authority,
          owner,
        });
      }

      const spend: SpendDeps = { client: deps.client, wallet, authority, material, owner };

      if (operation.opType === "transfer_registered") {
        const built = await buildTransfer(spend, {
          recipient: await liftRecipientShieldedAddress(deps, input),
          mint,
          amountRaw: requireAmount(input),
          ...(input.pinnedInputs ? { pinnedInputs: input.pinnedInputs } : {}),
        });

        const lifetime = await deps.client.getLatestBlockhash();
        return finish(
          assemble(owner, built.instructions ?? [], lifetime),
          built.inputNotes,
          lifetime
        );
      }

      const built = await buildWithdrawal(spend, {
        recipient: requireRecipient(input),
        mint,
        amountRaw: requireAmount(input),
        ...(input.pinnedInputs ? { pinnedInputs: input.pinnedInputs } : {}),
      });

      const lifetime = await deps.client.getLatestBlockhash();
      return finish(
        assemble(owner, built.instructions ?? [], lifetime),
        built.inputNotes,
        lifetime
      );
    }
  );
}

/**
 * A ring-bound spend, through the SDK's one-call ring builders. They return a
 * finished compiled v0 transaction and fetch their own blockhash, so the read
 * here only floors the recorded expiry (the shield branch's contract). No
 * pinned inputs and none returned: the builder re-selects same-ring notes on
 * every build, so `input_notes` round-trips as [] exactly like a shield's and
 * a retry rebuild may spend different notes. Ring spends also never reach
 * validatePreparedTransferIntent — the builders don't expose the prepared
 * transfer — leaving the final-wire policy as the custody-side check on these
 * bytes.
 */
async function buildRingSpend(
  deps: BuildDeps,
  input: BuildOperationInput,
  context: Readonly<{
    ringProgramId: string;
    ringLookupTable: string;
    mint: string;
    wallet: Awaited<ReturnType<typeof hydrateWallet>>["wallet"];
    authority: CustodyWalletAuthority;
    owner: ReturnType<typeof address>;
  }>
): Promise<BuildOperationResult> {
  const floor = await deps.client.getLatestBlockhash();
  const ringSpend = {
    client: deps.client,
    wallet: context.wallet,
    authority: context.authority,
    owner: context.owner,
  };
  const ringInput = {
    ringProgramId: context.ringProgramId,
    lookupTable: context.ringLookupTable,
    mint: context.mint,
    amountRaw: requireAmount(input),
  };

  if (input.operation.opType === "transfer_registered") {
    const tx = await buildRingTransferTx(ringSpend, {
      ...ringInput,
      recipient: await liftRecipientShieldedAddress(deps, input),
    });
    return finish(tx, [], floor);
  }

  const tx = await buildRingWithdrawalTx(ringSpend, {
    ...ringInput,
    recipient: requireRecipient(input),
  });
  return finish(tx, [], floor);
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
  return deps.material.withMaterial(
    {
      organizationId: deps.organizationId,
      projectId: deps.projectId,
      walletId: recipient.walletId,
      owner: recipient.owner,
    },
    async (recipientMaterial) => {
      assertProvisionedIdentity(recipientMaterial, recipient.expectedShieldedAddress);
      return recipientMaterial.shieldedAddress;
    }
  );
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
