import { supportsPortfolioWallets } from "@sdp/earn/capabilities";
import { badRequest } from "@sdp/earn/errors";
import { WisdomTreeEarnClient } from "@sdp/earn/providers/wisdomtree/client";
import { getWisdomTreeOnReceiptWallet } from "@sdp/earn/providers/wisdomtree/connect";
import type {
  EarnRuntimeContext,
  EarnVaultDepositInput,
  EarnVaultInstruction,
  EarnVaultPositionInput,
  EarnVaultPositionSnapshot,
  EarnVaultTransactionPlan,
  EarnVaultWithdrawInput,
  EarnVaultWithdrawProvider,
} from "@sdp/earn/types";
import {
  CLUSTER_BY_SDP_ENVIRONMENT,
  type SolanaCluster,
  wellKnownDecimals,
  wellKnownMint,
} from "@sdp/types";
import {
  type WisdomTreeFund,
  wisdomTreeFundByMint,
  wisdomTreeFundsForCluster,
} from "@sdp/types/wisdomtree-programs";
import { address, createNoopSigner } from "@solana/kit";
import { createWisdomTreeChainReader, type WisdomTreeChainReader } from "./chain";
import { SdpWisdomTreeError } from "./errors";
import { permittedPlanPrograms } from "./guards";
import { buildWisdomTreeDepositPlan, buildWisdomTreeRedemptionPlan } from "./plan";
import { readWisdomTreePosition } from "./positions";
import type { WisdomTreeInstructionPlan, WisdomTreeRuntime } from "./types";

/** Same API-owned execution guard shape as `KaminoVaultOperationRunner`. */
export type WisdomTreeVaultOperationRunner = <T>(
  label: string,
  operation: (assertActive: () => void) => Promise<T>
) => Promise<T>;

/** Convert the kit-native plan to the dependency-free Earn wire contract. */
export function toEarnVaultTransactionPlan(
  plan: WisdomTreeInstructionPlan
): EarnVaultTransactionPlan {
  return {
    cluster: plan.cluster,
    instructions: plan.instructions.map(
      (instruction): EarnVaultInstruction => ({
        programAddress: String(instruction.programAddress),
        accounts: (instruction.accounts ?? []).map((account) => ({
          address: String(account.address),
          role: Number(account.role),
        })),
        data: Buffer.from(instruction.data ?? new Uint8Array()).toString("base64"),
      })
    ),
    lookupTables: plan.lookupTables.map(String),
    assetIdentity: {
      depositTokenMint: String(plan.assetIdentity.depositTokenMint),
      shareMint: String(plan.assetIdentity.shareMint),
    },
    accepted: { ...plan.accepted },
    ...(plan.createsShareAccount === undefined
      ? {}
      : { createsShareAccount: plan.createsShareAccount }),
  };
}

/**
 * WisdomTree as an EXECUTING provider: the catalogue + eligibility client plus
 * the vault-direct capability, money in, money OUT (`EarnVaultWithdrawProvider`),
 * and position reads.
 *
 * Lives here rather than in `@sdp/earn` so the hourly catalogue cron never
 * loads `@solana/kit`. The arrow points inward: this package depends on
 * `@sdp/earn`, never the reverse.
 */
export class WisdomTreeVaultDirectClient
  extends WisdomTreeEarnClient
  implements EarnVaultWithdrawProvider
{
  constructor(
    private readonly resolveProvenRpcUrl: (
      ctx: EarnRuntimeContext,
      cluster: SolanaCluster
    ) => Promise<string>,
    private readonly runOperation: WisdomTreeVaultOperationRunner,
    /** Test seam: builders read the chain through this factory. */
    private readonly createReader: (
      rpcUrl: string
    ) => WisdomTreeChainReader = createWisdomTreeChainReader
  ) {
    super();
  }

  private async runtime(ctx: EarnRuntimeContext): Promise<WisdomTreeRuntime> {
    const cluster = CLUSTER_BY_SDP_ENVIRONMENT[ctx.environment];
    const rpcUrl = await this.resolveProvenRpcUrl(ctx, cluster);
    if (!rpcUrl.trim()) {
      throw new SdpWisdomTreeError(
        "CHAIN_UNREADABLE",
        `No Solana RPC endpoint configured for ${cluster}; WisdomTree cannot build a transaction.`
      );
    }
    return { cluster, rpcUrl };
  }

  private async withRuntime<T>(
    ctx: EarnRuntimeContext,
    label: string,
    operation: (runtime: WisdomTreeRuntime, assertActive: () => void) => Promise<T>
  ): Promise<T> {
    return this.runOperation(label, async (assertActive) => {
      const runtime = await this.runtime(ctx);
      assertActive();
      return operation(runtime, assertActive);
    });
  }

  /**
   * Registry resolution for a caller-supplied reference, phrased for the
   * caller: an unknown or wrong-cluster reference is a request problem, not a
   * provider outage. Admission gates upstream make the cluster case
   * unreachable in the API; this is the package's own last line.
   */
  private fundFor(reference: string, cluster: SolanaCluster): WisdomTreeFund {
    const fund = wisdomTreeFundByMint(reference);
    if (!fund) {
      throw badRequest(`${reference} names no fund in the WisdomTree registry.`);
    }
    if (fund.cluster !== cluster) {
      throw badRequest(
        `${fund.exchangeCode} lives on ${fund.cluster}, which is not reachable from a ${cluster} request.`
      );
    }
    return fund;
  }

  /** See `EarnVaultDirectProvider.sponsoredPrograms` — the enforced set IS the declared set. */
  sponsoredPrograms(cluster: SolanaCluster): readonly string[] {
    return [...permittedPlanPrograms(cluster)];
  }

  async buildVaultDeposit(
    ctx: EarnRuntimeContext,
    input: EarnVaultDepositInput
  ): Promise<EarnVaultTransactionPlan> {
    if (input.minSharesOut !== undefined) {
      // A primary-market subscription settles at NAV struck AFTER the transfer
      // lands; no instruction exists that could encode a share floor, and
      // accepting the field while enforcing nothing would be the appearance of
      // slippage protection without the substance (the @sdp/kamino rule).
      throw badRequest(
        "WisdomTree subscriptions settle at the fund's struck NAV; minSharesOut cannot be enforced " +
          "on-chain and is refused rather than silently ignored."
      );
    }

    const plan = await this.withRuntime(
      ctx,
      "Building the WisdomTree subscription transfer",
      async (runtime, assertActive) => {
        const fund = this.fundFor(input.providerReference, runtime.cluster);
        const depositMint = wellKnownMint("USDC", runtime.cluster);
        const depositDecimals = wellKnownDecimals("USDC", runtime.cluster);
        if (!depositMint || depositDecimals === undefined) {
          throw new SdpWisdomTreeError(
            "CLUSTER_UNSUPPORTED",
            `USDC is not catalogued for ${runtime.cluster}.`
          );
        }

        // The settlement address comes from WisdomTree's own API at build
        // time, never from configuration: a stale on-receipt wallet is money
        // sent to the wrong place.
        const onReceiptWallet = await getWisdomTreeOnReceiptWallet(ctx, {
          tradeType: "Purchase",
          fund: fund.exchangeCode,
          currency: "USDC",
        });
        assertActive();

        try {
          return await buildWisdomTreeDepositPlan(this.createReader(runtime.rpcUrl), runtime, {
            fund,
            owner: this.participant(input.owner),
            onReceiptWallet: address(onReceiptWallet),
            depositMint: address(depositMint),
            depositDecimals,
            amount: input.amount,
            ...(input.rentPayer === undefined
              ? {}
              : { rentPayer: this.participant(input.rentPayer) }),
          });
        } catch (error) {
          // Amount problems are the caller's to fix; everything else is the
          // provider integration's.
          if (error instanceof SdpWisdomTreeError && error.code === "INVALID_AMOUNT") {
            throw badRequest(error.message);
          }
          throw error;
        }
      }
    );
    return toEarnVaultTransactionPlan(plan);
  }

  /**
   * The money-OUT half: the on-chain leg of a primary-market redemption —
   * a Token-2022 TransferChecked of fund tokens to WisdomTree's on-receipt
   * Sale wallet, hook accounts resolved live. Implementing this is what flips
   * `supportsVaultWithdraw` to true (the same PRO-1702 mechanism Kamino used).
   *
   * Per ADR 0002 this path takes NO surfacing/entitlement/eligibility gate —
   * a wallet holding the tokens proved its standing on-chain, and the hook
   * re-proves it at execution. `rentRefundTo` is accepted and unused: no
   * account is closed by a redemption (see the builder).
   */
  async buildVaultWithdrawal(
    ctx: EarnRuntimeContext,
    input: EarnVaultWithdrawInput
  ): Promise<EarnVaultTransactionPlan> {
    const plan = await this.withRuntime(
      ctx,
      "Building the WisdomTree redemption transfer",
      async (runtime, assertActive) => {
        const fund = this.fundFor(input.providerReference, runtime.cluster);
        const depositMint = wellKnownMint("USDC", runtime.cluster);
        if (!depositMint) {
          throw new SdpWisdomTreeError(
            "CLUSTER_UNSUPPORTED",
            `USDC is not catalogued for ${runtime.cluster}.`
          );
        }

        const onReceiptWallet = await getWisdomTreeOnReceiptWallet(ctx, {
          tradeType: "Sale",
          fund: fund.exchangeCode,
          currency: "USDC",
        });
        assertActive();

        try {
          return await buildWisdomTreeRedemptionPlan(this.createReader(runtime.rpcUrl), runtime, {
            fund,
            owner: this.participant(input.owner),
            onReceiptWallet: address(onReceiptWallet),
            depositMint: address(depositMint),
            shares: input.shares,
            ...(input.rentPayer === undefined
              ? {}
              : { rentPayer: this.participant(input.rentPayer) }),
          });
        } catch (error) {
          if (error instanceof SdpWisdomTreeError && error.code === "INVALID_AMOUNT") {
            throw badRequest(error.message);
          }
          throw error;
        }
      }
    );
    return toEarnVaultTransactionPlan(plan);
  }

  /**
   * Live positions: the owner's Token-2022 balances in the registry's funds.
   * The chain is the provider here (ADR 0002) — nothing persisted, exact base
   * units, and an explicit request may truthfully answer zero while discovery
   * drops empty holdings.
   */
  async readVaultPositions(
    ctx: EarnRuntimeContext,
    input: EarnVaultPositionInput
  ): Promise<EarnVaultPositionSnapshot[]> {
    return this.withRuntime(ctx, "Reading WisdomTree positions", async (runtime, assertActive) => {
      const readAllHoldings = input.providerReferences.length === 0;
      const funds = readAllHoldings
        ? wisdomTreeFundsForCluster(runtime.cluster)
        : input.providerReferences.map((reference) => this.fundFor(reference, runtime.cluster));
      if (funds.length === 0) return [];

      const depositMint = wellKnownMint("USDC", runtime.cluster) ?? "";
      const reader = this.createReader(runtime.rpcUrl);
      const owner = address(input.owner);

      // Promise.all, not allSettled: any unreadable fund fails the whole page,
      // because a partial portfolio is not a truthful portfolio.
      const positions = await Promise.all(
        funds.map((fund) => readWisdomTreePosition(reader, { fund, owner }))
      );
      assertActive();

      return positions.flatMap((position) => {
        if (readAllHoldings && position.shares === "0") return [];
        return [
          {
            providerReference: position.fund.mint,
            owner: String(position.owner),
            cluster: runtime.cluster,
            shares: position.shares,
            // Fund tokens are not staked or locked on-chain; the redeemable
            // quantity is the balance. (Primary-market settlement timing is a
            // TERM of the strategy, not a property of the tokens.)
            withdrawableShares: position.shares,
            tokenMint: depositMint,
            shareMint: position.fund.mint,
          },
        ];
      });
    });
  }

  /** Addresses stand in as noop signers so kit places the account correctly; no key ever reaches this package. */
  private participant(value: string) {
    return createNoopSigner(address(value));
  }
}

/**
 * Same construction-time assertion as `@sdp/kamino`'s: the two capabilities
 * describe opposite money models, and a client answering yes to both would let
 * a portfolio route hand out WisdomTree's on-receipt wallet as a fundable
 * address — which strands money sent from any unregistered wallet.
 */
export function assertWisdomTreeNotPortfolioProvider(client: WisdomTreeVaultDirectClient): void {
  if (supportsPortfolioWallets(client)) {
    throw new SdpWisdomTreeError(
      "MINT_MISMATCH",
      "WisdomTree must never report the portfolio-wallet capability: SDP holds no fundable " +
        "address for it, and its on-receipt wallet only settles deposits from KYC-registered wallets."
    );
  }
}
