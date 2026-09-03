import { supportsPortfolioWallets } from "@sdp/earn/capabilities";
import { OndoEarnClient } from "@sdp/earn/providers/ondo/client";
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
  EarnVaultWithdrawInput,
  EarnVaultWithdrawProvider,
  EarnVaultWithdrawQuote,
  EarnVaultWithdrawQuoteInput,
  EarnVaultWithdrawQuoteProvider,
} from "@sdp/earn/types";
import { AmountError, formatDecimalAmount, parseDecimalAmount } from "@sdp/solana/amount";
import { CLUSTER_BY_SDP_ENVIRONMENT, type SolanaCluster } from "@sdp/types";
import { type OndoDeployment, ondoDeployment, ondoDepositMints } from "@sdp/types/ondo-programs";
import { SdpOndoError } from "./errors";
import type { OndoRuntime, OndoSwapLeg, OndoSwapPort, OndoVaultOperationRunner } from "./types";

/**
 * Ondo as an EXECUTING provider: the catalogue client plus the vault-direct,
 * vault-withdraw and both quote capabilities.
 *
 * ── The instrument, restated for this half ──────────────────────────────────
 * The "vault" is the open market. A deposit converts the strategy's deposit
 * token (USDC) into USDY with a Jupiter-routed ExactIn swap signed by the
 * owner; the position is the owner's USDY token balance; the exit is the
 * reverse swap. The exchange rate is the live market price, which is also why
 * both builders REQUIRE an explicit slippage floor and both quote capabilities
 * exist to derive one — a floor nobody chose is the appearance of protection,
 * not protection (Veda's rule, inherited).
 *
 * ── Where the trust boundary lives ──────────────────────────────────────────
 * Everything on-chain-executable comes through the injected `OndoSwapPort`;
 * the API's implementation admits Jupiter's instructions against the reviewed
 * contract in `services/earn/jupiter-swap.service.ts` (pinned programs, no
 * foreign signer, encoded amounts matching the request). This class treats a
 * returned leg as ADMITTED and adds only what it builds itself: the
 * compute-unit limit instruction below.
 *
 * USDY decimals are 6 (verified on-chain; the catalogue read refuses drift)
 * and USDC's are 6, so every decimal↔atom conversion here uses the same scale.
 */

/** Both sides of the pair carry 6 decimals; the catalogue read enforces USDY's. */
const TOKEN_DECIMALS = 6;

const COMPUTE_BUDGET_PROGRAM_ID = "ComputeBudget111111111111111111111111111111";
// biome-ignore lint/security/noSecrets: public on-chain program id, not a secret.
const ASSOCIATED_TOKEN_PROGRAM_ID = "ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL";
// biome-ignore lint/security/noSecrets: public on-chain program id, not a secret.
const JUPITER_AGGREGATOR_PROGRAM_ID = "JUP6LkbZbjS1jKKwapdHNy74zcZ3tLUZoi5QNyVTaV4";

/**
 * Static compute-unit ceiling for a swap plan.
 *
 * A Jupiter route routinely exceeds Solana's default per-transaction budget,
 * so the plan carries its own SetComputeUnitLimit as the first instruction.
 * Static rather than probe-derived (the API's swap-funded path simulates at
 * the maximum and rebuilds) because this builder has no simulation seam; the
 * value covers the routes the pair actually takes with wide margin while
 * staying under the 1.4M cap, and the execution layer's pre-sign simulation
 * still catches a route that needs more. Locally constructed, never taken from
 * the wire — same rule as `computeUnitLimitInstruction` in the API's swap
 * service, which this deliberately mirrors.
 */
export const ONDO_SWAP_COMPUTE_UNIT_LIMIT = 800_000;

function computeUnitLimitInstruction(units: number): EarnVaultInstruction {
  const data = new Uint8Array(5);
  data[0] = 2; // SetComputeUnitLimit discriminator
  new DataView(data.buffer).setUint32(1, units, true);
  return {
    programAddress: COMPUTE_BUDGET_PROGRAM_ID,
    accounts: [],
    data: Buffer.from(data).toString("base64"),
  };
}

/** One reference deep: the position read never fans out unbounded. */
const RPC_READ_TIMEOUT_MS = 30_000;

interface OndoClusterConfig {
  cluster: SolanaCluster;
  deployment: OndoDeployment;
  /** The single deposit mint SDP fronts on this cluster (USDC). */
  depositMint: string;
}

/**
 * Deployment + deposit mint for one cluster, or a typed refusal.
 *
 * The deposit mint comes from the same predicate the catalogue admits rows
 * with (`ondoDepositMints`), so the asset the shelf names and the asset a swap
 * spends cannot drift. More than one match is REFUSED, not first-picked —
 * widening `ONDO_DEPOSIT_TOKEN_SYMBOLS` means carrying a mint on the provider
 * contract first (Veda's rule).
 */
export function ondoClusterConfig(cluster: SolanaCluster): OndoClusterConfig {
  const deployment = ondoDeployment(cluster);
  if (!deployment) {
    throw new SdpOndoError(
      "DEPLOYMENT_NOT_CONFIGURED",
      `Ondo has no ${cluster} deployment: USDY exists on mainnet-beta only.`
    );
  }
  const mints = ondoDepositMints(cluster);
  if (mints.length !== 1 || !mints[0]) {
    throw new SdpOndoError(
      "DEPLOYMENT_NOT_CONFIGURED",
      `Ondo expects exactly one deposit mint on ${cluster} and found ${mints.length}; ` +
        "a swap must never pick an asset silently."
    );
  }
  return { cluster, deployment, depositMint: mints[0] };
}

/** Canonical decimal amount at the pair's scale, or a typed refusal. */
function canonicalAmount(value: string, label: string): { text: string; atoms: bigint } {
  let atoms: bigint;
  try {
    atoms = parseDecimalAmount(value, TOKEN_DECIMALS);
  } catch (error) {
    if (error instanceof AmountError) {
      throw new SdpOndoError(
        "INVALID_AMOUNT",
        `${label} is not usable at the token's ${TOKEN_DECIMALS}-decimal scale: ${error.message}`
      );
    }
    throw error;
  }
  if (atoms <= 0n) {
    throw new SdpOndoError("INVALID_AMOUNT", `${label} must be greater than zero`);
  }
  return { text: formatDecimalAmount(atoms, TOKEN_DECIMALS), atoms };
}

interface RpcTokenAccountsResponse {
  value?: {
    account?: {
      data?: {
        parsed?: { info?: { tokenAmount?: { amount?: string } } };
      };
    };
  }[];
}

export class OndoVaultDirectClient
  extends OndoEarnClient
  implements
    EarnVaultDirectProvider,
    EarnVaultDepositQuoteProvider,
    EarnVaultWithdrawProvider,
    EarnVaultWithdrawQuoteProvider
{
  /**
   * Injected seams, same construction shape as the Kamino/Veda clients: the
   * API resolves and genesis-proves the per-request RPC endpoint, bounds every
   * operation with its vault deadline, and supplies the admitted swap builder
   * (see `OndoSwapPort`). Nothing here reads `ctx.env` directly.
   */
  constructor(
    private readonly resolveProvenRpcUrl: (
      ctx: EarnRuntimeContext,
      cluster: SolanaCluster
    ) => Promise<string>,
    private readonly runOperation: OndoVaultOperationRunner,
    /**
     * Resolved per request like the RPC endpoint: the port's implementation
     * reads platform credentials (the Jupiter swap key) from the request's
     * environment, which this package never sees directly.
     */
    private readonly resolveSwapPort: (ctx: EarnRuntimeContext) => OndoSwapPort
  ) {
    super();
  }

  private async runtime(ctx: EarnRuntimeContext): Promise<{
    runtime: OndoRuntime;
    config: OndoClusterConfig;
  }> {
    const cluster = CLUSTER_BY_SDP_ENVIRONMENT[ctx.environment];
    // Resolved BEFORE the endpoint: an unconfigured deployment is a fact about
    // SDP, and reporting it should not depend on an RPC being reachable.
    const config = ondoClusterConfig(cluster);
    const rpcUrl = await this.resolveProvenRpcUrl(ctx, cluster);
    if (!rpcUrl.trim()) {
      throw new SdpOndoError(
        "POSITION_UNREADABLE",
        `No Solana RPC endpoint configured for ${cluster}; Ondo cannot build or read.`
      );
    }
    return { runtime: { cluster, rpcUrl }, config };
  }

  /** Every chain capability enters through this proof-then-deadline boundary. */
  private async withRuntime<T>(
    ctx: EarnRuntimeContext,
    label: string,
    operation: (
      runtime: OndoRuntime,
      config: OndoClusterConfig,
      assertActive: () => void
    ) => Promise<T>
  ): Promise<T> {
    return this.runOperation(label, async (assertActive) => {
      const { runtime, config } = await this.runtime(ctx);
      assertActive();
      return operation(runtime, config, assertActive);
    });
  }

  /** The one instrument this client may build against, or a typed refusal. */
  private assertKnownReference(config: OndoClusterConfig, providerReference: string): void {
    if (providerReference !== config.deployment.usdyMint) {
      throw new SdpOndoError(
        "UNSUPPORTED_VAULT",
        `Ondo does not front ${providerReference} on ${config.cluster}; ` +
          "the only strategy is the USDY instrument itself."
      );
    }
  }

  /**
   * See `EarnVaultDirectProvider.sponsoredPrograms`. The truthful emission set
   * for a cluster with a deployment is the compute-budget program (built
   * locally), the associated-token program (the leg's idempotent ATA creates)
   * and Jupiter's aggregator; an undeployed cluster emits nothing so it
   * declares nothing (Veda's rule). In practice nothing here is ever
   * sponsored — Earn sponsorship is devnet-gated and Ondo is mainnet-only —
   * so this is a declaration kept honest for the allowlist assertions, not a
   * request to allowlist Jupiter for the paymaster.
   */
  sponsoredPrograms(cluster: SolanaCluster): readonly string[] {
    if (!ondoDeployment(cluster)) return [];
    return [COMPUTE_BUDGET_PROGRAM_ID, ASSOCIATED_TOKEN_PROGRAM_ID, JUPITER_AGGREGATOR_PROGRAM_ID];
  }

  /**
   * The live quote a deposit floor derives from (`supportsVaultDepositQuote`):
   * what the market pays for `amount` USDC right now, in USDY. A READ; a pair
   * Jupiter cannot route right now surfaces as `SWAP_UNAVAILABLE` upstream
   * rather than as blocking issues, because there is no vault to report a
   * pause in its own words.
   */
  async quoteVaultDeposit(
    ctx: EarnRuntimeContext,
    input: EarnVaultDepositQuoteInput
  ): Promise<EarnVaultDepositQuote> {
    const amount = canonicalAmount(input.amount, "Deposit amount");
    const swapPort = this.resolveSwapPort(ctx);
    return this.withRuntime(ctx, "Quoting the Ondo deposit swap", async (runtime, config) => {
      this.assertKnownReference(config, input.providerReference);
      const quote = await swapPort.quoteSwap({
        cluster: runtime.cluster,
        inputMint: config.depositMint,
        outputMint: config.deployment.usdyMint,
        amount: amount.text,
      });
      return {
        sharesOut: quote.outAmount,
        shareDecimals: TOKEN_DECIMALS,
        blockingIssues: [],
      };
    });
  }

  /** The exit twin: what redeeming `shares` USDY pays right now, in USDC. */
  async quoteVaultWithdrawal(
    ctx: EarnRuntimeContext,
    input: EarnVaultWithdrawQuoteInput
  ): Promise<EarnVaultWithdrawQuote> {
    const shares = canonicalAmount(input.shares, "Share amount");
    const swapPort = this.resolveSwapPort(ctx);
    return this.withRuntime(ctx, "Quoting the Ondo withdrawal swap", async (runtime, config) => {
      this.assertKnownReference(config, input.providerReference);
      const quote = await swapPort.quoteSwap({
        cluster: runtime.cluster,
        inputMint: config.deployment.usdyMint,
        outputMint: config.depositMint,
        amount: shares.text,
      });
      return {
        assetsOut: quote.outAmount,
        assetDecimals: TOKEN_DECIMALS,
        blockingIssues: [],
      };
    });
  }

  async buildVaultDeposit(
    ctx: EarnRuntimeContext,
    input: EarnVaultDepositInput
  ): Promise<EarnVaultTransactionPlan> {
    // Refused rather than defaulted, Veda's rule: a market swap without a
    // floor is not protection, and SDP will not choose one on the caller's
    // behalf. The API derives it from `quoteVaultDeposit`.
    if (input.minSharesOut === undefined) {
      throw new SdpOndoError(
        "INVALID_AMOUNT",
        "Ondo deposits require minSharesOut: the deposit is a market swap and SDP will not " +
          "choose a slippage floor on the caller's behalf."
      );
    }
    // Jupiter's ATA creates charge the taker; a foreign rent payer cannot be
    // honoured, and pretending otherwise would mis-attribute rent the exit
    // later refunds. Sponsorship never applies to this provider today (see
    // `sponsoredPrograms`), so this only fires on a misconfigured caller.
    if (input.rentPayer !== undefined && input.rentPayer !== input.owner) {
      throw new SdpOndoError(
        "DEPOSIT_REFUSED",
        "Ondo deposits cannot charge account rent to a sponsor: the swap route's account " +
          "creations are funded by the owner."
      );
    }

    const amount = canonicalAmount(input.amount, "Deposit amount");
    const minShares = canonicalAmount(input.minSharesOut, "minSharesOut");
    const swapPort = this.resolveSwapPort(ctx);

    return this.withRuntime(
      ctx,
      "Building the Ondo deposit swap",
      async (runtime, config, assertActive) => {
        this.assertKnownReference(config, input.providerReference);
        const leg = await this.buildLegWithFloor({
          swapPort,
          runtime,
          inputMint: config.depositMint,
          outputMint: config.deployment.usdyMint,
          amount: amount,
          floor: minShares,
          owner: input.owner,
          direction: "deposit",
          assertActive,
        });

        // Only the builder, which read the chain, can say whether this deposit
        // creates the owner's USDY account and therefore pays its rent.
        const hadShareAccount = await this.ownerHoldsTokenAccount(
          runtime,
          input.owner,
          config.deployment.usdyMint
        );

        return {
          cluster: runtime.cluster,
          instructions: [
            computeUnitLimitInstruction(ONDO_SWAP_COMPUTE_UNIT_LIMIT),
            ...leg.instructions,
          ],
          lookupTables: [...leg.lookupTableAddresses],
          assetIdentity: {
            depositTokenMint: config.depositMint,
            shareMint: config.deployment.usdyMint,
          },
          // `minSharesOut` is the floor the caller approved; the instructions
          // encode the route's own threshold, which `buildLegWithFloor` proved
          // is AT OR ABOVE it. Reporting the approved floor keeps the ledger
          // claim conservative (the chain guarantees at least this much) and
          // exact against the policy check.
          accepted: { amount: amount.text, minSharesOut: minShares.text },
          createsShareAccount: !hadShareAccount,
        };
      }
    );
  }

  /**
   * The exit: swap the position's USDY back to USDC, one transaction.
   * `minAmountOut` is refused-if-absent for the same reason `minSharesOut` is
   * on the deposit — on the way out the floor is the caller's money.
   * `rentRefundTo` is accepted and unused: this exit closes no account, so
   * there is no rent to give back (the USDY ATA stays, ready for re-entry).
   */
  async buildVaultWithdrawal(
    ctx: EarnRuntimeContext,
    input: EarnVaultWithdrawInput
  ): Promise<EarnVaultTransactionPlan> {
    if (input.minAmountOut === undefined) {
      throw new SdpOndoError(
        "INVALID_AMOUNT",
        "Ondo withdrawals require minAmountOut: the exit is a market swap and SDP will not " +
          "choose a slippage floor on the caller's behalf."
      );
    }
    if (input.rentPayer !== undefined && input.rentPayer !== input.owner) {
      throw new SdpOndoError(
        "WITHDRAW_REFUSED",
        "Ondo withdrawals cannot charge account rent to a sponsor: the swap route's account " +
          "creations are funded by the owner."
      );
    }

    const shares = canonicalAmount(input.shares, "Share amount");
    const minOut = canonicalAmount(input.minAmountOut, "minAmountOut");
    const swapPort = this.resolveSwapPort(ctx);

    return this.withRuntime(
      ctx,
      "Building the Ondo withdrawal swap",
      async (runtime, config, assertActive) => {
        this.assertKnownReference(config, input.providerReference);
        const leg = await this.buildLegWithFloor({
          swapPort,
          runtime,
          inputMint: config.deployment.usdyMint,
          outputMint: config.depositMint,
          amount: shares,
          floor: minOut,
          owner: input.owner,
          direction: "withdrawal",
          assertActive,
        });

        return {
          cluster: runtime.cluster,
          instructions: [
            computeUnitLimitInstruction(ONDO_SWAP_COMPUTE_UNIT_LIMIT),
            ...leg.instructions,
          ],
          lookupTables: [...leg.lookupTableAddresses],
          assetIdentity: {
            depositTokenMint: config.depositMint,
            shareMint: config.deployment.usdyMint,
          },
          // Same conservative claim as the deposit: the route's encoded
          // threshold was proven at or above this floor.
          accepted: { shares: shares.text, minAmountOut: minOut.text },
        };
      }
    );
  }

  /**
   * Build the swap leg and PROVE the route's guaranteed output covers the
   * caller's floor.
   *
   * Jupiter encodes a quote plus a tolerance, not an arbitrary floor, so the
   * tolerance is derived from a live quote such that the resulting threshold
   * sits at or above the requested floor: `bps = ⌊(quote − floor)/quote·10⁴⌋`
   * rounds the tolerance DOWN, which rounds the threshold UP. The built leg's
   * own threshold is then checked outright (its quote is fresher than ours),
   * with one tighter retry before refusing — a market genuinely below the
   * floor must refuse rather than build a transaction that will fail on chain.
   */
  private async buildLegWithFloor(args: {
    swapPort: OndoSwapPort;
    runtime: OndoRuntime;
    inputMint: string;
    outputMint: string;
    amount: { text: string; atoms: bigint };
    floor: { text: string; atoms: bigint };
    owner: string;
    direction: "deposit" | "withdrawal";
    assertActive: () => void;
  }): Promise<OndoSwapLeg> {
    const refusalCode = args.direction === "deposit" ? "DEPOSIT_REFUSED" : "WITHDRAW_REFUSED";
    const quote = await args.swapPort.quoteSwap({
      cluster: args.runtime.cluster,
      inputMint: args.inputMint,
      outputMint: args.outputMint,
      amount: args.amount.text,
    });
    const quoteAtoms = parseDecimalAmount(quote.outAmount, TOKEN_DECIMALS);
    if (quoteAtoms < args.floor.atoms) {
      throw new SdpOndoError(
        refusalCode,
        `The market pays ${quote.outAmount} right now, below the requested floor of ` +
          `${args.floor.text}; re-quote and choose a floor the market can meet.`
      );
    }

    let slippageBps = Number(((quoteAtoms - args.floor.atoms) * 10_000n) / quoteAtoms);
    slippageBps = Math.min(slippageBps, 9_999);

    for (;;) {
      args.assertActive();
      const leg = await args.swapPort.buildSwapLeg({
        cluster: args.runtime.cluster,
        inputMint: args.inputMint,
        outputMint: args.outputMint,
        amount: args.amount.text,
        owner: args.owner,
        slippageBps,
      });
      const thresholdAtoms = parseDecimalAmount(leg.minOutAmount, TOKEN_DECIMALS);
      if (thresholdAtoms >= args.floor.atoms) return leg;
      if (slippageBps === 0) {
        throw new SdpOndoError(
          refusalCode,
          `The route's guaranteed output ${leg.minOutAmount} is below the requested floor ` +
            `${args.floor.text} even with zero tolerance; the market moved — re-quote.`
        );
      }
      // The build's own, fresher quote sat below ours: tighten and try once
      // more from zero rather than walking down one basis point at a time.
      slippageBps = 0;
    }
  }

  /**
   * Live positions: the owner's USDY balance, read from chain per call and
   * never persisted. Balances are summed from the exact raw `amount` integer
   * strings — never `uiAmount`, which is a JSON number and lossy above 2^53
   * base units (the same rule the Kamino read follows).
   *
   * An empty reference list means the configured shelf, which for Ondo is the
   * single USDY instrument. The valuation is allowed to fail INDEPENDENTLY of
   * the balance read: a quote outage makes the VALUE unknown, not the HOLDING.
   */
  async readVaultPositions(
    ctx: EarnRuntimeContext,
    input: EarnVaultPositionInput
  ): Promise<EarnVaultPositionSnapshot[]> {
    const swapPort = this.resolveSwapPort(ctx);
    return this.withRuntime(
      ctx,
      "Reading Ondo positions",
      async (runtime, config, assertActive) => {
        const readAllHoldings = input.providerReferences.length === 0;
        const references = readAllHoldings
          ? [config.deployment.usdyMint]
          : input.providerReferences;

        const snapshots: EarnVaultPositionSnapshot[] = [];
        for (const reference of references) {
          assertActive();
          this.assertKnownReference(config, reference);
          const atoms = await this.readOwnerTokenBalance(runtime, input.owner, reference);
          if (readAllHoldings && atoms === 0n) continue;
          const shares = formatDecimalAmount(atoms, TOKEN_DECIMALS);

          let tokenValue: string | undefined;
          if (atoms > 0n) {
            try {
              const quote = await swapPort.quoteSwap({
                cluster: runtime.cluster,
                inputMint: config.deployment.usdyMint,
                outputMint: config.depositMint,
                amount: shares,
              });
              tokenValue = quote.outAmount;
            } catch {
              // Valuation unavailable; the holding is still the truth.
              tokenValue = undefined;
            }
          } else {
            tokenValue = "0";
          }

          snapshots.push({
            providerReference: reference,
            owner: input.owner,
            cluster: runtime.cluster,
            shares,
            // No lock: the whole balance is exitable on the open market.
            withdrawableShares: shares,
            ...(tokenValue === undefined ? {} : { tokenValue }),
            tokenMint: config.depositMint,
            shareMint: config.deployment.usdyMint,
          });
        }
        return snapshots;
      }
    );
  }

  private async ownerHoldsTokenAccount(
    runtime: OndoRuntime,
    owner: string,
    mint: string
  ): Promise<boolean> {
    const accounts = await this.tokenAccounts(runtime, owner, mint);
    return accounts.length > 0;
  }

  private async readOwnerTokenBalance(
    runtime: OndoRuntime,
    owner: string,
    mint: string
  ): Promise<bigint> {
    const accounts = await this.tokenAccounts(runtime, owner, mint);
    let total = 0n;
    for (const entry of accounts) {
      const raw = entry.account?.data?.parsed?.info?.tokenAmount?.amount;
      if (typeof raw !== "string" || !/^\d+$/.test(raw)) {
        throw new SdpOndoError(
          "POSITION_UNREADABLE",
          `A token account for ${mint} returned no exact raw balance; refusing to report a ` +
            "partial position."
        );
      }
      total += BigInt(raw);
    }
    return total;
  }

  private async tokenAccounts(
    runtime: OndoRuntime,
    owner: string,
    mint: string
  ): Promise<NonNullable<RpcTokenAccountsResponse["value"]>> {
    let response: Response;
    try {
      response = await fetch(runtime.rpcUrl, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          jsonrpc: "2.0",
          id: 1,
          method: "getTokenAccountsByOwner",
          params: [owner, { mint }, { encoding: "jsonParsed" }],
        }),
        signal: AbortSignal.timeout(RPC_READ_TIMEOUT_MS),
      });
    } catch (cause) {
      throw new SdpOndoError("POSITION_UNREADABLE", "The Solana RPC read failed", { cause });
    }
    if (!response.ok) {
      throw new SdpOndoError(
        "POSITION_UNREADABLE",
        `The Solana RPC answered HTTP ${response.status} reading token accounts`
      );
    }
    const body = (await response.json()) as { result?: RpcTokenAccountsResponse; error?: unknown };
    if (body.error || body.result?.value === undefined) {
      throw new SdpOndoError(
        "POSITION_UNREADABLE",
        "The Solana RPC returned an error reading token accounts"
      );
    }
    return body.result.value;
  }
}

/**
 * Guard asserted at construction rather than trusted, same as Kamino/Veda: a
 * client answering yes to both money models would let a portfolio route render
 * a token mint as a fundable deposit address.
 */
export function assertNotPortfolioProvider(client: OndoVaultDirectClient): void {
  if (supportsPortfolioWallets(client)) {
    throw new SdpOndoError(
      "UNSUPPORTED_VAULT",
      "Ondo must never report the portfolio-wallet capability: it custodies nothing, and the " +
        "USDY mint is not a fundable address."
    );
  }
}
