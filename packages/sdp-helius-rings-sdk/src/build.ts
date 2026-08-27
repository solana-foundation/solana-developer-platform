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

      const mint = requireMint(input);

      if (operation.opType === "shield") {
        // No wallet, no authority, no note selection: a deposit creates notes.
        //
        // The builder fetches its own blockhash, so the one taken here is only
        // a floor for the recorded expiry — read immediately before the call to
        // keep that floor as tight as possible.
        const floor = await deps.client.getLatestBlockhash();
        return finish(
          await buildShieldTransaction(deps.client, {
            owner: input.owner,
            material,
            mint,
            amountRaw: requireAmount(input),
          }),
          [],
          floor
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

      // A merge is built by the SDK against a blockhash of its own, so this is
      // a floor for the recorded expiry rather than the real one. Taken here,
      // immediately before the call, for the same reason as the shield's.
      const mergeFloor =
        operation.opType === "merge" ? await deps.client.getLatestBlockhash() : undefined;

      let built: Awaited<ReturnType<typeof buildMerge>>;
      switch (operation.opType) {
        case "merge":
          built = await buildMerge(spend, { mint, ...pin });
          break;
        case "withdraw":
          built = await buildWithdrawal(spend, {
            recipient: requireRecipient(input),
            mint,
            amountRaw: requireAmount(input),
            ...pin,
          });
          break;
        case "transfer_registered":
          built = await buildTransfer(spend, {
            recipient: requireRecipient(input),
            mint,
            amountRaw: requireAmount(input),
            ...pin,
          });
          break;
        case "transfer_anonymous":
        case "timelock_create":
        case "timelock_settle":
        case "zone_create":
          return unsupportedOperation(operation.opType);
        default:
          return assertNever(operation.opType);
      }

      if (built.instructions) {
        // Fetched now rather than before the wallet sync and the prover round
        // trip, which together can burn a large part of a blockhash's ~90
        // second life. Assembling against a hash chosen after that work means
        // the transaction gets the full window, and the recorded expiry is
        // exactly this transaction's rather than a floor.
        const lifetime = await deps.client.getLatestBlockhash();
        return finish(assemble(owner, built.instructions, lifetime), built.inputNotes, lifetime);
      }

      return finish(
        requireTransaction(built.transaction),
        built.inputNotes,
        requireLifetime(mergeFloor)
      );
    }
  );
}

function unsupportedOperation(opType: string): never {
  throw new HeliusRingsError("invalid_input", `unsupported Rings operation type: ${opType}`);
}

function assertNever(opType: never): never {
  return unsupportedOperation(String(opType));
}

/** Only a merge reaches the transaction branch, and only it takes a floor. */
function requireLifetime(lifetime: Lifetime | undefined): Lifetime {
  if (!lifetime) {
    throw new HeliusRingsError(
      "gateway_unavailable",
      "a Rings flow returned a built transaction without a recorded blockhash"
    );
  }
  return lifetime;
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
  return withZolanaErrorBridgeSync(() =>
    checkedTransactionSize(
      compileTransaction(
        pipe(
          createTransactionMessage({ version: 0 }),
          (message) => setTransactionMessageFeePayer(owner, message),
          (message) => setTransactionMessageLifetimeUsingBlockhash(lifetime, message),
          (message) =>
            appendTransactionMessageInstructions(
              // Deliberately use Solana's 1.4M maximum rather than Zolana's 300K so this
              // manual alpha path is not under-budgeted; no CU-price instruction means no priority fee.
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

function requireMint(input: BuildOperationInput): string {
  const mint = input.operation.input?.asset?.mint;
  if (!mint) {
    // The route's schemas make this unreachable. It stays because an absent
    // asset must never be read as native SOL by default: that would move the
    // wrong token, and the caller never said which one they meant.
    throw new HeliusRingsError("invalid_input", `a ${input.operation.opType} needs an asset`);
  }
  return mint;
}

/**
 * The amount, for the flows that move a caller-chosen one.
 *
 * Separate from the mint because a merge has no amount: it consolidates
 * whatever notes of that mint the wallet holds. Reading one there would put a
 * figure on the row that nothing honours.
 */
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
