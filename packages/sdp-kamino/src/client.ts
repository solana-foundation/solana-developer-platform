import { supportsPortfolioWallets } from "@sdp/earn/capabilities";
import { KaminoEarnClient } from "@sdp/earn/providers/kamino/client";
import type {
  EarnRuntimeContext,
  EarnVaultDepositInput,
  EarnVaultDirectProvider,
  EarnVaultInstruction,
  EarnVaultPositionInput,
  EarnVaultPositionSnapshot,
  EarnVaultTransactionPlan,
} from "@sdp/earn/types";
import { CLUSTER_BY_SDP_ENVIRONMENT, type SolanaCluster } from "@sdp/types";
import { type Address, address, createNoopSigner } from "@solana/kit";
import { SdpKaminoError } from "./errors";
import { createKaminoRpc } from "./rpc";
import { buildKaminoDepositPlan, discoverKaminoPositionVaults, readKaminoPosition } from "./sdk";
import type { KaminoInstructionPlan, KaminoRuntime } from "./types";

/** One portfolio request may fan out over many vaults; never fan out the RPCs without a bound. */
export const KAMINO_POSITION_READ_CONCURRENCY = 4;

async function mapSettledWithConcurrency<T, U>(
  items: readonly T[],
  concurrency: number,
  mapper: (item: T) => Promise<U>
): Promise<Array<PromiseSettledResult<U>>> {
  const results = new Array<PromiseSettledResult<U>>(items.length);
  let nextIndex = 0;
  const workerCount = Math.min(concurrency, items.length);

  await Promise.all(
    Array.from({ length: workerCount }, async () => {
      while (nextIndex < items.length) {
        const index = nextIndex;
        nextIndex += 1;
        try {
          results[index] = { status: "fulfilled", value: await mapper(items[index] as T) };
        } catch (reason) {
          results[index] = { status: "rejected", reason };
        }
      }
    })
  );

  return results;
}

/** Convert the kit-native plan to the dependency-free Earn wire contract. */
export function toEarnVaultTransactionPlan(plan: KaminoInstructionPlan): EarnVaultTransactionPlan {
  return {
    cluster: plan.cluster,
    transactions: plan.instructions.map((batch) =>
      batch.map(
        (instruction): EarnVaultInstruction => ({
          programAddress: String(instruction.programAddress),
          accounts: (instruction.accounts ?? []).map((account) => ({
            address: String(account.address),
            role: Number(account.role),
          })),
          // Base64 keeps the contract JSON-safe: a plan may cross a queue or a
          // log before it is compiled, and a Uint8Array does not survive that.
          data: Buffer.from(instruction.data ?? new Uint8Array()).toString("base64"),
        })
      )
    ),
    lookupTables: plan.lookupTables.map(String),
    assetIdentity: {
      depositTokenMint: String(plan.assetIdentity.depositTokenMint),
      shareMint: String(plan.assetIdentity.shareMint),
    },
    // These are the mint-scale amounts the instructions actually encode. The
    // API ledgers this shape; dropping it reintroduces raw-request drift.
    accepted: { ...plan.accepted },
  };
}

/**
 * Kamino as an EXECUTING provider: the catalogue client plus the vault-direct
 * capability.
 *
 * Lives here rather than in `@sdp/earn` so that package keeps its single
 * `@sdp/types` dependency — its hourly catalogue cron runs in both environments
 * and must never load klend-sdk. The arrow points inward: `@sdp/kamino` depends
 * on `@sdp/earn`, never the reverse.
 *
 * Registered by the API's execution registry, which prefers this class over the
 * catalogue-only `KaminoEarnClient` when a route needs to move money. Callers
 * still discover the capability with `supportsVaultDirect`, never a provider-id
 * check.
 */
export class KaminoVaultDirectClient extends KaminoEarnClient implements EarnVaultDirectProvider {
  /**
   * Where the RPC endpoint comes from.
   *
   * Injected rather than read from `ctx.env.SOLANA_RPC_URL` directly, because
   * that variable is PROCESS-level while the cluster is PER-REQUEST: syncing the
   * sandbox environment inside a production deployment reaches this code with a
   * MAINNET url. The API resolves the right endpoint for the cluster it is
   * serving and hands it in; `listKaminoDevnetVaults` guards the same hazard
   * with a genesis-hash check.
   */
  constructor(
    private readonly resolveRpcUrl: (ctx: EarnRuntimeContext, cluster: SolanaCluster) => string
  ) {
    super();
  }

  private runtime(ctx: EarnRuntimeContext): KaminoRuntime {
    const cluster = CLUSTER_BY_SDP_ENVIRONMENT[ctx.environment];
    const rpcUrl = this.resolveRpcUrl(ctx, cluster);
    if (!rpcUrl.trim()) {
      throw new SdpKaminoError(
        "VAULT_UNREADABLE",
        `No Solana RPC endpoint configured for ${cluster}; Kamino cannot build a transaction.`
      );
    }
    return { cluster, rpcUrl };
  }

  /**
   * The owner arrives as an ADDRESS, not a signer — custody lives in the API and
   * a private key must never reach a provider client. klend-sdk needs a signer
   * shaped object to place the account correctly, so a noop signer stands in: it
   * contributes the right address and role and signs nothing. The API attaches
   * the real custody signer at compile time, where kit matches by address.
   */
  private owner(value: string) {
    return createNoopSigner(address(value));
  }

  async buildVaultDeposit(
    ctx: EarnRuntimeContext,
    input: EarnVaultDepositInput
  ): Promise<EarnVaultTransactionPlan> {
    const plan = await buildKaminoDepositPlan(this.runtime(ctx), {
      vault: address(input.providerReference),
      owner: this.owner(input.owner),
      amount: input.amount,
      ...(input.minSharesOut === undefined ? {} : { minSharesOut: input.minSharesOut }),
    });
    return toEarnVaultTransactionPlan(plan);
  }

  /*
   * NO `buildVaultWithdrawal` — the withdraw capability is WITHHELD, and its
   * absence is the mechanism, not an oversight.
   *
   * `buildKaminoWithdrawPlan` exists and is proven against a mainnet-forked
   * surfnet, but it does not yet honour the plan contract: it flattens every
   * unstake/withdraw/cleanup instruction into ONE batch and returns no lookup
   * table, while the pinned SDK documents that a multi-reserve exit "might have
   * to be split in multiple transactions". Implementing the method here would
   * make `supportsVaultWithdraw` answer true, which is what a future exit route
   * will narrow on — and it would then hand that route a plan that either
   * exceeds the packet limit or is refused by the submitter, after the customer
   * was told their withdrawal was prepared.
   *
   * Adding the method is therefore the LAST step of that work, not the first:
   * load the vault LUT, compile-measure and split at protocol boundaries (an
   * unstake must never land without its withdraw), and give the API a resumable
   * multi-leg submission. Until then the honest answer is that SDP has no exit
   * route — the shares are in the org's own wallet and Kamino's UI can redeem
   * them, which is why withholding this is safe rather than fund-trapping.
   */

  /**
   * Reads every requested vault against ONE slot, so a multi-position page is
   * priced consistently rather than drifting between reads.
   *
   * An empty reference list discovers owner-held vaults from the on-chain
   * kvault program, not the curated deposit catalogue: a visibility or TVL
   * gate may stop new money without hiding an existing position.
   *
   * A vault that fails to read fails the WHOLE snapshot. Returning every other
   * vault would make the failed holding indistinguishable from no holding at
   * all; a partial portfolio is not a truthful portfolio.
   */
  async readVaultPositions(
    ctx: EarnRuntimeContext,
    input: EarnVaultPositionInput
  ): Promise<EarnVaultPositionSnapshot[]> {
    const runtime = this.runtime(ctx);
    const owner: Address = address(input.owner);
    const readAllHoldings = input.providerReferences.length === 0;
    const providerReferences = readAllHoldings
      ? await discoverKaminoPositionVaults(runtime, owner)
      : input.providerReferences;
    if (providerReferences.length === 0) return [];

    // One shared slot makes the page internally consistent. The client carries
    // the same transport deadline as every nested Kamino SDK read below.
    const slot = await createKaminoRpc(runtime.rpcUrl).getSlot().send();

    const results = await mapSettledWithConcurrency(
      providerReferences,
      KAMINO_POSITION_READ_CONCURRENCY,
      (reference) => readKaminoPosition(runtime, { vault: address(reference), owner, slot })
    );

    const failures = results.flatMap((result, index) =>
      result.status === "rejected"
        ? [{ providerReference: providerReferences[index], cause: result.reason }]
        : []
    );
    if (failures.length > 0) {
      throw new SdpKaminoError(
        "VAULT_UNREADABLE",
        `Kamino could not read ${failures.length} of ${providerReferences.length} requested ` +
          "vault positions; refusing to return a partial portfolio.",
        {
          cause: new AggregateError(
            failures.map(({ providerReference, cause }) =>
              cause instanceof Error
                ? new Error(`Kamino vault ${providerReference} read failed`, { cause })
                : new Error(`Kamino vault ${providerReference} read failed: ${String(cause)}`)
            ),
            "Kamino vault position reads failed"
          ),
        }
      );
    }

    return results.flatMap((result) => {
      // All rejected results were handled above, so only fulfilled values can
      // reach the serializer. Keep the guard for TypeScript's settled-result
      // narrowing and as a defensive assertion if this block is later moved.
      if (result.status !== "fulfilled") return [];
      const position = result.value;
      // Exact reads serialize zero canonically as "0". A full-portfolio read
      // reports holdings, while an explicitly requested vault may still return
      // a truthful zero balance.
      if (readAllHoldings && position.shares === "0") return [];
      return [
        {
          providerReference: String(position.vault),
          owner: String(position.owner),
          cluster: position.cluster,
          shares: position.shares,
          ...(position.tokenValue === undefined ? {} : { tokenValue: position.tokenValue }),
          tokenMint: String(position.tokenMint),
          shareMint: String(position.sharesMint),
        },
      ];
    });
  }
}

/**
 * Guard asserted at construction rather than trusted: the two capabilities
 * describe opposite money models, and a client answering yes to both would let a
 * portfolio route hand a customer the vault's own account as a deposit address —
 * where funds are destroyed. Exported so the API can assert it at registry wiring.
 */
export function assertNotPortfolioProvider(client: KaminoVaultDirectClient): void {
  if (supportsPortfolioWallets(client)) {
    throw new SdpKaminoError(
      "VAULT_UNREADABLE",
      "Kamino must never report the portfolio-wallet capability: it custodies nothing, " +
        "and its vault account is not a fundable address."
    );
  }
}
