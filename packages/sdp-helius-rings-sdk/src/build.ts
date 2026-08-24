import type { ZolanaClient } from "@heliuslabs/zolana/client";
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
import { CustodyWalletAuthority } from "./authority.js";
import { buildShieldTransaction } from "./flows/shield.js";
import { buildMerge, buildTransfer, buildWithdrawal, type SpendDeps } from "./flows/spend.js";
import { assertShieldedIdentity, type ShieldedMaterialSource } from "./material.js";
import { hydrateWallet } from "./wallet.js";

/**
 * Turns a persisted operation into an unsigned, proved outer transaction.
 *
 * The whole build happens inside one `withMaterial` scope, because every step
 * needs the shielded keys and none of them should outlive the call. What comes
 * back out is only what SDP can safely hold: base64 transaction bytes, the
 * blockhash's expiry, and the commitments of the notes spent.
 */

/**
 * The blockhash a build is pinned to. Structural rather than imported: the
 * SDK declares `LatestBlockhash` but does not re-export it from any public
 * entry point, and reaching into its dist would break on the next release.
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
        assertShieldedIdentity(material, input.expectedShieldedAddress);
      }

      const asset = requireAsset(input);
      // One blockhash for the whole build, so the expiry SDP persists is the
      // expiry of the bytes it persists rather than a second, later guess.
      const lifetime = await deps.client.getLatestBlockhash();

      if (operation.opType === "shield") {
        // No wallet, no authority, no note selection: a deposit creates notes.
        return finish(
          await buildShieldTransaction(deps.client, {
            owner: input.owner,
            material,
            mint: asset.mint,
            amountRaw: asset.amountRaw,
          }),
          [],
          lifetime
        );
      }

      // Every spend reads the wallet first: note selection is only as good as
      // the state it selects from. `requireComplete` is what makes an
      // incomplete read fatal here, unlike on the reporting path.
      const authority = new CustodyWalletAuthority({
        material,
        authorization: {
          owner: input.owner,
          operationId: operation.id,
          intentKey: operation.intentKey,
        },
      });
      const { wallet } = await hydrateWallet({
        client: deps.client,
        material,
        authority,
        requireComplete: true,
        // Selection is where a stale read costs the most: a note the indexer
        // has not yet seen consumed still looks spendable, and the chain
        // rejects the transaction it is chosen for.
        ...(input.requireSlot ? { requireSlot: BigInt(input.requireSlot) } : {}),
      });

      const spend: SpendDeps = { client: deps.client, wallet, authority, material, owner };
      const pinned = input.pinnedInputs;
      const pin = pinned ? { pinnedInputs: pinned } : {};

      const built =
        operation.opType === "merge"
          ? await buildMerge(spend, { mint: asset.mint, ...pin })
          : operation.opType === "withdraw"
            ? await buildWithdrawal(spend, {
                recipient: requireRecipient(input),
                mint: asset.mint,
                amountRaw: asset.amountRaw,
                ...pin,
              })
            : await buildTransfer(spend, {
                recipient: requireRecipient(input),
                mint: asset.mint,
                amountRaw: asset.amountRaw,
                ...pin,
              });

      // Instructions get assembled against the blockhash chosen above, so the
      // recorded expiry is exactly this transaction's. A merge arrives already
      // built and keeps its own; see `finish`.
      const transaction = built.instructions
        ? assemble(owner, built.instructions, lifetime)
        : requireTransaction(built.transaction);

      return finish(transaction, built.inputNotes, lifetime);
    }
  );
}

function requireTransaction(transaction: Transaction | undefined): Transaction {
  if (!transaction) {
    throw new HeliusRingsError(
      "gateway_unavailable",
      "a Rings flow produced neither a transaction nor instructions"
    );
  }
  return transaction;
}

/** Fee payer, blockhash, instructions — what the low-level rail leaves to us. */
function assemble(
  owner: ReturnType<typeof address>,
  instructions: readonly Instruction[],
  lifetime: Lifetime
): Transaction {
  return compileTransaction(
    pipe(
      createTransactionMessage({ version: 0 }),
      (message) => setTransactionMessageFeePayer(owner, message),
      (message) => setTransactionMessageLifetimeUsingBlockhash(lifetime, message),
      (message) => appendTransactionMessageInstructions(instructions, message)
    )
  );
}

/**
 * Wraps a built transaction into the port's result, checking the one thing SDP
 * cannot check for itself.
 *
 * The signer assertion belongs here rather than at the caller: only this side
 * knows what the SDK produced, and a transaction that needs a signature nobody
 * will provide fails at submission with an opaque error rather than at build
 * with a clear one.
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
      // Proved by the real prover, inside the builder. `simulated` is reserved
      // for the in-memory gateway, and the distinction is what tells an
      // operator whether a completed operation moved real value.
      source: "live",
      // The prover's output is embedded in the transaction bytes, so there is no
      // separate artifact to keep. The reference exists so the operation row can
      // record that a proof was obtained.
      ref: new SecretRef(`inline:${signers.length}:${inputNotes.length}`),
      createdAt: new Date().toISOString(),
    },
  };
}

function requireAsset(input: BuildOperationInput): { mint: string; amountRaw: string } {
  const asset = input.operation.input?.asset;
  if (!asset) {
    // The route's schemas make this unreachable. It stays because an absent
    // asset must never be read as native SOL by default: that would move the
    // wrong token, and the caller never said which one they meant.
    throw new HeliusRingsError(
      "invalid_input",
      `a ${input.operation.opType} needs an explicit asset and amount`
    );
  }
  return asset;
}

function requireRecipient(input: BuildOperationInput): string {
  const to = input.operation.input?.to;
  if (!to) {
    throw new HeliusRingsError("invalid_input", `a ${input.operation.opType} needs a recipient`);
  }
  return to;
}
