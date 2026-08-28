import { wellKnownMint } from "@sdp/types";
import { wisdomTreeFundsForCluster } from "@sdp/types/wisdomtree-programs";
import type {
  EarnDeclaredStrategySupport,
  EarnDepositEligibility,
  EarnDepositEligibilityInput,
  EarnDepositEligibilityProvider,
  EarnRuntimeContext,
  ProviderStrategySnapshot,
} from "../../types";
import { StubEarnClient } from "../stub";
import { checkWisdomTreeWalletEligibility, listWisdomTreeProducts } from "./connect";

/**
 * WisdomTree Connect vault-infra client — catalogue plus the deposit-eligibility
 * capability. Instruction building (the on-receipt transfer legs) lives in
 * `@sdp/wisdomtree`, which extends this class; this package stays chain-SDK-free
 * for the hourly catalogue cron.
 *
 * ── What a WisdomTree strategy IS ───────────────────────────────────────────
 * A tokenized SEC-registered fund: a Token-2022 mint with a compliance transfer
 * hook (see `@sdp/types/wisdomtree-programs`). There is no vault — a deposit is
 * a USDC transfer into WisdomTree's on-receipt wallet that opens a primary-market
 * subscription, and fund tokens settle back to the sender after NAV strike. The
 * snapshot's `providerReference` and `shareMint` are therefore the SAME address:
 * the fund mint, which is both the instrument's identity and the receipt token.
 *
 * ── Two sources, and both must agree ────────────────────────────────────────
 * The fund registry in `@sdp/types` is measured on-chain and owns identity
 * (mint, decimals, name — read from the mint's own TokenMetadata, which the
 * ISSUER controls, unlike Kamino's permissionless vault names). The Connect
 * products API owns availability: a registry fund the authenticated
 * organization cannot trade (missing from `/api/orders/products`, or
 * `can_trade !== true`) is NOT listed, so the sync's delist pass retires it —
 * fail-closed in the same direction as everything else on the money-in path.
 *
 * ── No rate, deliberately ───────────────────────────────────────────────────
 * WTGXX's 7-day yield lives in WisdomTree's separate Fund Data API (Dataspan),
 * a second credential SDP does not hold. Until that is provisioned and its
 * routes measured, snapshots carry no `currentApy` and the dashboard renders
 * "—" — the Kamino-devnet rule: a missing rate beats a fabricated one.
 */
export class WisdomTreeEarnClient extends StubEarnClient implements EarnDepositEligibilityProvider {
  readonly provider = "wisdomtree" as const;
  readonly declaredSupport: EarnDeclaredStrategySupport = {
    sourceKinds: ["rwa"],
    depositTokens: ["USDC"],
  };

  /**
   * The shelf. Production only: WisdomTree deploys on Solana mainnet
   * exclusively (their sandbox is Ethereum Sepolia), so every other
   * environment honestly answers an empty shelf and its browse rows arrive
   * via the sync's PRO-1742 production mirror instead.
   */
  override async listStrategies(ctx: EarnRuntimeContext): Promise<ProviderStrategySnapshot[]> {
    if (ctx.environment !== "production") {
      return [];
    }
    const funds = wisdomTreeFundsForCluster("mainnet-beta");
    if (funds.length === 0) {
      return [];
    }

    // One credentialed read for the whole shelf; a malformed response throws
    // (all-or-nothing) so the sync skips the pass rather than delisting funds
    // it failed to read.
    const products = await listWisdomTreeProducts(ctx);
    const productByExchangeCode = new Map(
      products.flatMap((product) =>
        typeof product.exchange_code === "string" ? [[product.exchange_code, product] as const] : []
      )
    );

    const usdcMint = wellKnownMint("USDC", "mainnet-beta");
    if (!usdcMint) {
      // Unreachable with the pinned token catalogue; stated so a future edit
      // there fails loudly here instead of listing a fund with no deposit mint.
      return [];
    }

    return funds.flatMap((fund): ProviderStrategySnapshot[] => {
      const product = productByExchangeCode.get(fund.exchangeCode);
      // `can_trade === true` exactly: a fund the org cannot trade — or whose
      // tradability the response left unstated — must not be offered as a
      // deposit target. Skipping (not throwing) lets the delist pass retire it.
      if (product?.can_trade !== true) {
        return [];
      }
      return [
        {
          providerReference: fund.mint,
          // Issuer-established (the mint's own TokenMetadata, verified when the
          // registry row was added) — NOT the attacker-controlled free text the
          // Kamino rule forbids parsing.
          name: fund.name,
          sourceKind: "rwa",
          underlyingSource: fund.exchangeCode.toLowerCase(),
          depositMints: [usdcMint],
          shareMint: fund.mint,
          hostCluster: fund.cluster,
          // A government MMF's 7-day yield floats with rates; "fixed" would
          // overstate the promise.
          apyType: "variable",
          // Primary-market redemption settles after NAV strike and
          // transfer-agent processing — T+1 in the ordinary '40 Act cycle.
          // WisdomTree's 2026 dealer-model instant settlement is a secondary
          // rail SDP does not front, so the conservative term is the honest one.
          liquidityTerm: "delayed",
          redemptionDelayDays: 1,
          // The issuer curates its own fund; "wisdomtree" is establishable from
          // the mint's issuer-controlled metadata, unlike a Kamino vault name.
          riskMetadata: { curator: "wisdomtree" },
        },
      ];
    });
  }

  /**
   * WisdomTree's KYC gate, asked API-side before money moves — see
   * `EarnDepositEligibilityProvider` for why. The `providerReference` is not
   * consulted: registration is per-wallet, not per-fund, in Connect's model.
   */
  async checkDepositEligibility(
    ctx: EarnRuntimeContext,
    input: EarnDepositEligibilityInput
  ): Promise<EarnDepositEligibility> {
    return checkWisdomTreeWalletEligibility(ctx, input.owner);
  }
}
