import type { CounterpartyEntityType } from "@sdp/types/counterparties";
import { wellKnownMint } from "@sdp/types/well-known-tokens";
import { wisdomTreeFundByMint, wisdomTreeFundsForCluster } from "@sdp/types/wisdomtree-programs";
import type { SdpEarnError } from "#/errors";
import { StubEarnClient } from "#/providers/stub";
import type {
  EarnDeclaredStrategySupport,
  EarnDepositEligibility,
  EarnDepositEligibilityInput,
  EarnDepositEligibilityProvider,
  EarnOnboardingApplicationResult,
  EarnOnboardingCorrectionAnswer,
  EarnOnboardingCustomerDetail,
  EarnOnboardingDocumentReference,
  EarnOnboardingForm,
  EarnOnboardingModerator,
  EarnOnboardingProvider,
  EarnOnboardingRegistrationScope,
  EarnRuntimeContext,
  ProviderStrategySnapshot,
} from "#/types";
import {
  checkWisdomTreeDepositEligibility,
  listWisdomTreeProducts,
  WISDOMTREE_DEPOSIT_INELIGIBLE_REASON,
} from "./connect";
import { wisdomTreeOnboardingClient } from "./onboarding";

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
export class WisdomTreeEarnClient
  extends StubEarnClient
  implements EarnDepositEligibilityProvider, EarnOnboardingProvider
{
  readonly provider = "wisdomtree" as const;
  readonly depositEligibilityCustomerScope = {
    required: true,
    ineligibleReason: WISDOMTREE_DEPOSIT_INELIGIBLE_REASON,
  } as const;
  readonly declaredSupport: EarnDeclaredStrategySupport = {
    sourceKinds: ["rwa"],
    depositTokens: ["USDC"],
  };

  /**
   * The KYC/KYB capability adapter, composed rather than re-implemented: the
   * wire client owns every Connect vocabulary choice, and the capability
   * forwards to the ONE shared instance so a test spy observes every call.
   */
  private readonly onboarding = wisdomTreeOnboardingClient;

  getOnboardingModerator(ctx: EarnRuntimeContext): Promise<EarnOnboardingModerator> {
    return this.onboarding.getOnboardingModerator(ctx);
  }

  getOnboardingForm(
    ctx: EarnRuntimeContext,
    entityType: CounterpartyEntityType
  ): Promise<EarnOnboardingForm> {
    return this.onboarding.getOnboardingForm(ctx, entityType);
  }

  onboardingApplicationFields(entityType: CounterpartyEntityType): ReadonlySet<string> {
    return this.onboarding.onboardingApplicationFields(entityType);
  }

  saveOnboardingApplication(
    ctx: EarnRuntimeContext,
    submission: {
      entityType: CounterpartyEntityType;
      application: Record<string, unknown>;
      documents?: Record<string, EarnOnboardingDocumentReference>;
      linkedOrganizationGuid?: string | null;
    }
  ): Promise<EarnOnboardingApplicationResult> {
    return this.onboarding.saveOnboardingApplication(ctx, submission);
  }

  getOnboardingCustomerDetail(
    ctx: EarnRuntimeContext,
    input: { entityType: CounterpartyEntityType; reference: string }
  ): Promise<EarnOnboardingCustomerDetail> {
    return this.onboarding.getOnboardingCustomerDetail(ctx, input);
  }

  uploadOnboardingDocument(
    ctx: EarnRuntimeContext,
    document: { documentType: string; file: File }
  ): Promise<EarnOnboardingDocumentReference> {
    return this.onboarding.uploadOnboardingDocument(ctx, document);
  }

  answerOnboardingCorrection(
    ctx: EarnRuntimeContext,
    input: { reference: string; reasonId: number; answer: EarnOnboardingCorrectionAnswer }
  ): Promise<void> {
    return this.onboarding.answerOnboardingCorrection(ctx, input);
  }

  registerOnboardingWallet(
    ctx: EarnRuntimeContext,
    input: { reference: string; owner: string }
  ): Promise<void> {
    return this.onboarding.registerOnboardingWallet(ctx, input);
  }

  walletRegistrationMessage(scope: EarnOnboardingRegistrationScope, owner: string): Uint8Array {
    return this.onboarding.walletRegistrationMessage(scope, owner);
  }

  onboardingRecoveryReferences(error: SdpEarnError): EarnOnboardingApplicationResult {
    return this.onboarding.onboardingRecoveryReferences(error);
  }

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
   * WisdomTree's admission gate, asked API-side before money moves — see
   * `EarnDepositEligibilityProvider` for why. The catalogue reference is first
   * resolved through SDP's curated registry, then Connect must report both an
   * approved wallet and a tradable matching exchange code in the mapped
   * customer child's context (or direct context for standalone tooling). Every valid negative result uses
   * the same reason so the build route cannot enumerate KYC or
   * product-entitlement state.
   */
  async checkDepositEligibility(
    ctx: EarnRuntimeContext,
    input: EarnDepositEligibilityInput
  ): Promise<EarnDepositEligibility> {
    const fund = wisdomTreeFundByMint(input.providerReference);
    if (!fund) {
      return {
        eligible: false,
        reason: WISDOMTREE_DEPOSIT_INELIGIBLE_REASON,
      };
    }
    return checkWisdomTreeDepositEligibility(ctx, {
      address: input.owner,
      exchangeCode: fund.exchangeCode,
      customer: input.customer,
    });
  }
}
