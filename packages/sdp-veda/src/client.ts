import { supportsPortfolioWallets } from "@sdp/earn/capabilities";
import { VedaEarnClient } from "@sdp/earn/providers/veda/client";
import type {
  EarnRuntimeContext,
  EarnVaultDepositInput,
  EarnVaultDepositQuote,
  EarnVaultDepositQuoteInput,
  EarnVaultDepositQuoteProvider,
  EarnVaultDirectProvider,
  EarnVaultInstruction,
  EarnVaultPositionInput,
  EarnVaultPositionSnapshot,
  EarnVaultTransactionPlan,
} from "@sdp/earn/types";
import { CLUSTER_BY_SDP_ENVIRONMENT, type SolanaCluster } from "@sdp/types";
import { address } from "@solana/kit";
import { SdpVedaError } from "./errors";
import { type VedaClusterConfig, vedaClusterConfig } from "./programs";
import { buildVedaDepositPlan, previewVedaDeposit, readVedaPosition } from "./sdk";
import type { VedaInstructionPlan, VedaRuntime } from "./types";

/** One position page may fan out over several vaults; never fan out unbounded. */
export const VEDA_POSITION_READ_CONCURRENCY = 4;

/**
 * API-owned execution guard for one provider operation. The API injects its
 * absolute vault deadline here without creating a dependency from this package
 * back to the application layer.
 */
export type VedaVaultOperationRunner = <T>(
  label: string,
  operation: (assertActive: () => void) => Promise<T>
) => Promise<T>;

async function mapSettledWithConcurrency<T, U>(
  items: readonly T[],
  concurrency: number,
  assertActive: () => void,
  mapper: (item: T) => Promise<U>
): Promise<Array<PromiseSettledResult<U>>> {
  const results = new Array<PromiseSettledResult<U>>(items.length);
  let nextIndex = 0;
  const workerCount = Math.min(concurrency, items.length);

  await Promise.all(
    Array.from({ length: workerCount }, async () => {
      while (nextIndex < items.length) {
        // A timed-out aggregate read cannot cancel an in-flight SDK request,
        // but it must never dequeue another vault after the budget expires.
        assertActive();
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
export function toEarnVaultTransactionPlan(plan: VedaInstructionPlan): EarnVaultTransactionPlan {
  return {
    cluster: plan.cluster,
    instructions: plan.instructions.map(
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
    ),
    lookupTables: plan.lookupTables.map(String),
    assetIdentity: {
      depositTokenMint: String(plan.assetIdentity.depositTokenMint),
      shareMint: String(plan.assetIdentity.shareMint),
    },
    // The mint-scale amounts the instructions actually encode. The API ledgers
    // this shape; dropping it reintroduces raw-request drift.
    accepted: { ...plan.accepted },
  };
}

/**
 * Veda as an EXECUTING provider: the catalogue client plus the vault-direct
 * capability.
 *
 * Lives here rather than in `@sdp/earn` so that package keeps its single
 * `@sdp/types` dependency — its hourly catalogue cron runs in both environments
 * and must never load `@vedatech/svm-sdk`. The arrow points inward:
 * `@sdp/veda` depends on `@sdp/earn`, never the reverse.
 *
 * Registered by the API's execution registry, which prefers this class over the
 * catalogue-only `VedaEarnClient` when a route needs to move money. Callers
 * still discover the capability with `supportsVaultDirect`, never a provider-id
 * check.
 *
 * **`buildVaultWithdrawal` is deliberately absent.** Money OUT is a separate
 * capability (`supportsVaultWithdraw`) and a separate piece of work: Veda offers
 * two independent exits — an instant redemption and a request/fulfil queue —
 * and the queue's lifecycle does not fit the `pending|submitted|confirmed|failed`
 * movement model the `POST /vault-withdrawals` route carries, while exposing
 * only the instant half would auto-select a mechanism Veda deliberately leaves
 * to the caller. Withholding the capability says SDP cannot carry Veda's exits
 * yet; it is never a permission gate, and it traps nothing: the shares sit in
 * the organization's own custody wallet and Veda's own surfaces can redeem them.
 * See `docs/decisions/` for the withdrawal design that lands it.
 */
export class VedaVaultDirectClient
  extends VedaEarnClient
  implements EarnVaultDirectProvider, EarnVaultDepositQuoteProvider
{
  /**
   * Where a PROVEN RPC endpoint comes from and how its operation is bounded.
   *
   * Injected rather than read from `ctx.env.SOLANA_RPC_URL`, because that
   * variable is PROCESS-level while the cluster is PER-REQUEST: one API process
   * serves both SDP environments, so a sandbox request inside a production
   * deployment would otherwise reach a MAINNET url. The API proves the resolved
   * URL's genesis before returning it. Keeping that resolver inside the client
   * makes proof a class invariant for deposits, positions and any future chain
   * capability, rather than something each route has to remember — and for Veda
   * it is load-bearing twice over, since its deployments may share addresses
   * across clusters.
   */
  constructor(
    private readonly resolveProvenRpcUrl: (
      ctx: EarnRuntimeContext,
      cluster: SolanaCluster
    ) => Promise<string>,
    private readonly runOperation: VedaVaultOperationRunner
  ) {
    super();
  }

  private async runtime(ctx: EarnRuntimeContext): Promise<{
    runtime: VedaRuntime;
    config: VedaClusterConfig;
  }> {
    const cluster = CLUSTER_BY_SDP_ENVIRONMENT[ctx.environment];
    // Resolved BEFORE the endpoint: an unconfigured deployment is a fact about
    // SDP, and reporting it should not depend on an RPC being reachable.
    const config = vedaClusterConfig(cluster);
    const rpcUrl = await this.resolveProvenRpcUrl(ctx, cluster);
    if (!rpcUrl.trim()) {
      throw new SdpVedaError(
        "VAULT_UNREADABLE",
        `No Solana RPC endpoint configured for ${cluster}; Veda cannot build a transaction.`
      );
    }
    return { runtime: { cluster, rpcUrl }, config };
  }

  /** Every chain capability enters through this proof-then-deadline boundary. */
  private async withRuntime<T>(
    ctx: EarnRuntimeContext,
    label: string,
    operation: (
      runtime: VedaRuntime,
      config: VedaClusterConfig,
      assertActive: () => void
    ) => Promise<T>
  ): Promise<T> {
    return this.runOperation(label, async (assertActive) => {
      // Endpoint resolution/proof and provider work are one operation, so they
      // consume one deadline rather than receiving independent budgets.
      const { runtime, config } = await this.runtime(ctx);
      assertActive();
      return operation(runtime, config, assertActive);
    });
  }

  /**
   * The live quote a slippage floor is derived from (`supportsVaultDepositQuote`).
   *
   * A READ: it enters through the same proof-then-deadline boundary as every
   * chain call, but takes no floor itself and moves nothing. Blocking
   * conditions come back in `blockingIssues` in the vault's own words rather
   * than as a thrown error — the caller is deciding whether to offer a
   * deposit, and "the vault is paused" is part of that answer.
   */
  async quoteVaultDeposit(
    ctx: EarnRuntimeContext,
    input: EarnVaultDepositQuoteInput
  ): Promise<EarnVaultDepositQuote> {
    const quote = await this.withRuntime(ctx, "Quoting the vault deposit", (runtime, config) =>
      previewVedaDeposit(runtime, config, {
        vault: address(input.providerReference),
        amount: input.amount,
      })
    );
    return {
      sharesOut: quote.sharesOut,
      shareDecimals: quote.shareDecimals,
      blockingIssues: quote.issues,
    };
  }

  async buildVaultDeposit(
    ctx: EarnRuntimeContext,
    input: EarnVaultDepositInput
  ): Promise<EarnVaultTransactionPlan> {
    // Refused HERE rather than defaulted. Veda's SDK will not apply an implicit
    // slippage tolerance, and SDP will not invent one on a caller's behalf: a
    // floor nobody chose is not protection, it is the appearance of it. The API
    // already requires one in production; for Veda it is required everywhere,
    // which is why this is a typed INVALID_AMOUNT rather than a silent build.
    if (input.minSharesOut === undefined) {
      throw new SdpVedaError(
        "INVALID_AMOUNT",
        "Veda deposits require minSharesOut: the vault refuses an implicit slippage tolerance, " +
          "and SDP will not choose a floor on the caller's behalf."
      );
    }

    const plan = await this.withRuntime(ctx, "Building the vault deposit", (runtime, config) =>
      buildVedaDepositPlan(runtime, config, {
        vault: address(input.providerReference),
        owner: address(input.owner),
        amount: input.amount,
        minSharesOut: input.minSharesOut as string,
      })
    );
    return toEarnVaultTransactionPlan(plan);
  }

  /**
   * Live positions, read from chain per call and never persisted — positions are
   * provider truth (ADR 0002), and for a vault-direct provider "the provider" is
   * the chain itself.
   *
   * An empty reference list means every vault SDP has configured for this
   * cluster. Veda's SDK deliberately publishes no vault discovery, and there is
   * nothing to discover: unlike Kamino's permissionless registry, a Veda vault
   * reaches SDP only by being named in `VEDA_DEPLOYMENTS`, so the configured
   * shelf IS the set of vaults an owner could hold through SDP.
   *
   * A vault that fails to read fails the WHOLE snapshot. Returning every other
   * vault would make the failed holding indistinguishable from no holding at
   * all; a partial portfolio is not a truthful portfolio.
   */
  async readVaultPositions(
    ctx: EarnRuntimeContext,
    input: EarnVaultPositionInput
  ): Promise<EarnVaultPositionSnapshot[]> {
    return this.withRuntime(
      ctx,
      "Reading vault positions",
      async (runtime, config, assertActive) => {
        const owner = address(input.owner);
        const readAllHoldings = input.providerReferences.length === 0;
        const references = readAllHoldings
          ? config.vaultStateAddresses.map(String)
          : input.providerReferences;
        if (references.length === 0) return [];

        const results = await mapSettledWithConcurrency(
          references,
          VEDA_POSITION_READ_CONCURRENCY,
          assertActive,
          (reference) => readVedaPosition(runtime, config, { vault: address(reference), owner })
        );

        const failures = results.flatMap((result, index) =>
          result.status === "rejected"
            ? [{ providerReference: references[index], cause: result.reason }]
            : []
        );
        if (failures.length > 0) {
          throw new SdpVedaError(
            "VAULT_UNREADABLE",
            `Veda could not read ${failures.length} of ${references.length} requested vault ` +
              "positions; refusing to return a partial portfolio.",
            {
              cause: new AggregateError(
                failures.map(({ providerReference, cause }) =>
                  cause instanceof Error
                    ? new Error(`Veda vault ${providerReference} read failed`, { cause })
                    : new Error(`Veda vault ${providerReference} read failed: ${String(cause)}`)
                ),
                "Veda vault position reads failed"
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
          // A full-shelf read reports HOLDINGS; an explicitly requested vault may
          // still return a truthful zero balance.
          if (readAllHoldings && position.shares === "0") return [];
          return [
            {
              providerReference: String(position.vault),
              owner: String(position.owner),
              cluster: position.cluster,
              shares: position.shares,
              withdrawableShares: position.withdrawableShares,
              ...(position.tokenValue === undefined ? {} : { tokenValue: position.tokenValue }),
              tokenMint: String(position.tokenMint),
              shareMint: String(position.shareMint),
            },
          ];
        });
      }
    );
  }
}

/**
 * Guard asserted at construction rather than trusted: the two capabilities
 * describe opposite money models, and a client answering yes to both would let a
 * portfolio route hand a customer the vault's own account as a deposit address —
 * where funds are destroyed. Exported so the API can assert it at registry wiring.
 */
export function assertNotPortfolioProvider(client: VedaVaultDirectClient): void {
  if (supportsPortfolioWallets(client)) {
    throw new SdpVedaError(
      "UNSUPPORTED_VAULT",
      "Veda must never report the portfolio-wallet capability: it custodies nothing, " +
        "and its vault-state account is not a fundable address."
    );
  }
}
