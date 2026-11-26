import { HastraEarnClient } from "@sdp/earn/providers/hastra/client";
import type {
  EarnRuntimeContext,
  EarnSwapLeg,
  EarnSwapPort,
  EarnVaultDepositInput,
  EarnVaultDepositQuote,
  EarnVaultDepositQuoteInput,
  EarnVaultDepositQuoteProvider,
  EarnVaultDirectProvider,
  EarnVaultInstruction,
  EarnVaultParRedemptionCancelInput,
  EarnVaultParRedemptionLifecycleEvent,
  EarnVaultParRedemptionLifecycleInput,
  EarnVaultParRedemptionOptions,
  EarnVaultParRedemptionProvider,
  EarnVaultParRedemptionQuote,
  EarnVaultParRedemptionQuoteInput,
  EarnVaultParRedemptionRequestInput,
  EarnVaultParRedemptionRequestLookup,
  EarnVaultParRedemptionRequestPlan,
  EarnVaultParRedemptionRequestReadInput,
  EarnVaultPositionInput,
  EarnVaultPositionSnapshot,
  EarnVaultTransactionPlan,
  EarnVaultWithdrawalOptionsInput,
  EarnVaultWithdrawInput,
  EarnVaultWithdrawProvider,
  EarnVaultWithdrawQuote,
  EarnVaultWithdrawQuoteInput,
  EarnVaultWithdrawQuoteProvider,
} from "@sdp/earn/types";
import { hastraDeployment } from "@sdp/types/hastra-programs";
import { CLUSTER_BY_SDP_ENVIRONMENT, type SolanaCluster } from "@sdp/types/well-known-tokens";
import { address } from "@solana/kit";
import type { HastraClusterConfig } from "./addresses";
import {
  associatedTokenAddress,
  deriveHastraAddresses,
  hastraClusterConfig,
  legacyTicketAddress,
  publicKey,
  redemptionRequestAddress,
} from "./addresses";
import {
  assetsForShares,
  canonicalAmount,
  formatAtoms,
  minimumSharesForPar,
  sharesForAssets,
} from "./amounts";
import {
  ASSOCIATED_TOKEN_PROGRAM_ID,
  COMPUTE_BUDGET_PROGRAM_ID,
  HASTRA_JUPITER_MAX_ACCOUNTS,
  HASTRA_NATIVE_COMPUTE_UNIT_LIMIT,
  HASTRA_PAR_MINIMUM_ASSET_ATOMS,
  HASTRA_PAR_MINIMUM_ASSETS,
  HASTRA_SWAP_COMPUTE_UNIT_LIMIT,
  JUPITER_AGGREGATOR_PROGRAM_ID,
  TOKEN_DECIMALS,
} from "./constants";
import { SdpHastraError } from "./errors";
import {
  computeUnitLimitInstruction,
  createAssociatedTokenInstruction,
  mintDepositInstruction,
  parCancelInstruction,
  parRequestInstruction,
  stakeDepositInstruction,
  stakeRedeemInstruction,
  transientTokenAccountPlan,
} from "./instructions";
import {
  assertNoBlockingIssues,
  depositBlockingIssues,
  parBlockingIssues,
  parRequestBlockingIssues,
  stakeBlockingIssues,
} from "./issues";
import {
  admitParRequest,
  decodeLegacyTicket,
  decodeRedemptionRequest,
  parRedemptionSource,
  parseParLifecycleEvents,
} from "./redemption";
import {
  decodeRpcAccount,
  decodeRpcAccounts,
  getAccount,
  getMultipleAccounts,
  getMultipleAccountWires,
} from "./rpc";
import {
  assertExistingOwnerTokenUsable,
  assertOwnerTokenUsable,
  decodeTokenAccount,
  loadHastraState,
  readHastraState,
} from "./state";
import type { HastraRuntime, HastraVaultOperationRunner } from "./types";

export class HastraVaultDirectClient
  extends HastraEarnClient
  implements
    EarnVaultDirectProvider,
    EarnVaultDepositQuoteProvider,
    EarnVaultWithdrawProvider,
    EarnVaultWithdrawQuoteProvider,
    EarnVaultParRedemptionProvider
{
  constructor(
    private readonly resolveProvenRpcUrl: (
      ctx: EarnRuntimeContext,
      cluster: SolanaCluster
    ) => Promise<string>,
    private readonly runOperation: HastraVaultOperationRunner,
    private readonly resolveSwapPort: (ctx: EarnRuntimeContext) => EarnSwapPort
  ) {
    super();
  }

  private async runtime(ctx: EarnRuntimeContext): Promise<{
    runtime: HastraRuntime;
    config: HastraClusterConfig;
  }> {
    const cluster = CLUSTER_BY_SDP_ENVIRONMENT[ctx.environment];
    const config = hastraClusterConfig(cluster);
    const rpcUrl = await this.resolveProvenRpcUrl(ctx, cluster);
    if (!rpcUrl.trim()) {
      throw new SdpHastraError(
        "POSITION_UNREADABLE",
        `No Solana RPC endpoint is configured for ${cluster}; Hastra cannot build or read.`
      );
    }
    return { runtime: { cluster, rpcUrl }, config };
  }

  private async withRuntime<T>(
    ctx: EarnRuntimeContext,
    label: string,
    operation: (
      runtime: HastraRuntime,
      config: HastraClusterConfig,
      assertActive: () => void
    ) => Promise<T>
  ): Promise<T> {
    return this.runOperation(label, async (assertActive) => {
      const { runtime, config } = await this.runtime(ctx);
      assertActive();
      return operation(runtime, config, assertActive);
    });
  }

  private assertKnownReference(config: HastraClusterConfig, providerReference: string): void {
    if (providerReference !== config.deployment.primeMint) {
      throw new SdpHastraError(
        "UNSUPPORTED_VAULT",
        `Hastra does not front ${providerReference} on ${config.cluster}; SDP's only Hastra ` +
          "strategy is PRIME."
      );
    }
  }

  sponsoredPrograms(cluster: SolanaCluster): readonly string[] {
    const deployment = hastraDeployment(cluster);
    if (!deployment) return [];
    return [
      COMPUTE_BUDGET_PROGRAM_ID,
      ASSOCIATED_TOKEN_PROGRAM_ID,
      deployment.vaultMintProgramAddress,
      deployment.vaultStakeProgramAddress,
      JUPITER_AGGREGATOR_PROGRAM_ID,
    ];
  }

  async quoteVaultDeposit(
    ctx: EarnRuntimeContext,
    input: EarnVaultDepositQuoteInput
  ): Promise<EarnVaultDepositQuote> {
    const amount = canonicalAmount(input.amount, "Deposit amount");
    return this.withRuntime(ctx, "Quoting the Hastra PRIME deposit", async (runtime, config) => {
      this.assertKnownReference(config, input.providerReference);
      const state = await loadHastraState(runtime, config);
      return {
        sharesOut: formatAtoms(sharesForAssets(amount.atoms, state.stakePrice)),
        shareDecimals: TOKEN_DECIMALS,
        blockingIssues: depositBlockingIssues(state),
      };
    });
  }

  async buildVaultDeposit(
    ctx: EarnRuntimeContext,
    input: EarnVaultDepositInput
  ): Promise<EarnVaultTransactionPlan> {
    if (input.minSharesOut !== undefined) {
      throw new SdpHastraError(
        "DEPOSIT_REFUSED",
        "Hastra's v0.0.6 deposit instructions do not encode a minimum-share floor; " +
          "minSharesOut must be omitted rather than represented as protection the chain cannot enforce."
      );
    }
    const amount = canonicalAmount(input.amount, "Deposit amount");
    const owner = publicKey("owner", input.owner, "DEPOSIT_REFUSED");
    const rentPayer = publicKey("rentPayer", input.rentPayer ?? input.owner, "DEPOSIT_REFUSED");

    return this.withRuntime(
      ctx,
      "Building the Hastra USDC to PRIME deposit",
      async (runtime, config) => {
        this.assertKnownReference(config, input.providerReference);
        const usdc = address(config.depositMint);
        const wylds = address(config.deployment.wYldsMint);
        const prime = address(config.deployment.primeMint);
        const userUsdc = await associatedTokenAddress(owner, usdc);
        const userWylds = await associatedTokenAddress(owner, wylds);
        const userPrime = await associatedTokenAddress(owner, prime);
        const ownerAccounts = [userUsdc, userWylds, userPrime];
        const { state, extra } = await readHastraState(runtime, config, ownerAccounts);
        assertNoBlockingIssues(depositBlockingIssues(state), "DEPOSIT_REFUSED", "The deposit");
        const shares = sharesForAssets(amount.atoms, state.stakePrice);
        if (shares === 0n) {
          throw new SdpHastraError(
            "INVALID_AMOUNT",
            "The deposit is too small to mint one PRIME atom at Hastra's live rate."
          );
        }

        const [userUsdcAccount, userWyldsAccount, userPrimeAccount] = decodeRpcAccounts(
          extra,
          ownerAccounts
        );
        assertOwnerTokenUsable(
          userUsdcAccount ?? null,
          "Owner USDC token account",
          config.depositMint,
          owner,
          "DEPOSIT_REFUSED",
          amount.atoms
        );
        assertExistingOwnerTokenUsable(
          userWyldsAccount ?? null,
          "Owner wYLDS token account",
          config.deployment.wYldsMint,
          owner,
          "DEPOSIT_REFUSED"
        );
        assertExistingOwnerTokenUsable(
          userPrimeAccount ?? null,
          "Owner PRIME token account",
          config.deployment.primeMint,
          owner,
          "DEPOSIT_REFUSED"
        );
        const shareAccountExisted = userPrimeAccount !== null;

        return {
          cluster: runtime.cluster,
          instructions: [
            computeUnitLimitInstruction(HASTRA_NATIVE_COMPUTE_UNIT_LIMIT),
            await createAssociatedTokenInstruction(rentPayer, owner, wylds),
            await createAssociatedTokenInstruction(rentPayer, owner, prime),
            mintDepositInstruction({
              config,
              state,
              owner,
              userUsdc,
              userWylds,
              amount: amount.atoms,
            }),
            stakeDepositInstruction({
              config,
              state,
              owner,
              userWylds,
              userPrime,
              amount: amount.atoms,
            }),
          ],
          lookupTables: [],
          assetIdentity: { depositTokenMint: config.depositMint, shareMint: prime },
          accepted: { amount: amount.text },
          createsShareAccount: !shareAccountExisted,
        };
      }
    );
  }

  async quoteVaultWithdrawal(
    ctx: EarnRuntimeContext,
    input: EarnVaultWithdrawQuoteInput
  ): Promise<EarnVaultWithdrawQuote> {
    const shares = canonicalAmount(input.shares, "Share amount");
    const swapPort = this.resolveSwapPort(ctx);
    return this.withRuntime(ctx, "Quoting the Hastra PRIME DEX exit", async (runtime, config) => {
      this.assertKnownReference(config, input.providerReference);
      const state = await loadHastraState(runtime, config);
      const issues = stakeBlockingIssues(state);
      const wylds = assetsForShares(shares.atoms, state.stakePrice);
      if (wylds === 0n) {
        return { assetsOut: "0", assetDecimals: TOKEN_DECIMALS, blockingIssues: issues };
      }
      // The port's own failures (no route, outage) are the API's answer and pass
      // through unchanged, as in the build; only an unusable quote is ours to name.
      const quote = await swapPort.quoteSwap({
        cluster: runtime.cluster,
        inputMint: config.deployment.wYldsMint,
        outputMint: config.depositMint,
        amount: formatAtoms(wylds),
      });
      let assetsOut: string;
      try {
        assetsOut = canonicalAmount(quote.outAmount, "Jupiter quoted output").text;
      } catch (cause) {
        throw new SdpHastraError("SWAP_UNAVAILABLE", "Jupiter returned an invalid wYLDS quote.", {
          cause,
        });
      }
      return {
        assetsOut,
        assetDecimals: TOKEN_DECIMALS,
        blockingIssues: issues,
      };
    });
  }

  async buildVaultWithdrawal(
    ctx: EarnRuntimeContext,
    input: EarnVaultWithdrawInput
  ): Promise<EarnVaultTransactionPlan> {
    if (input.minAmountOut === undefined) {
      throw new SdpHastraError(
        "INVALID_AMOUNT",
        "Hastra DEX exits require minAmountOut; SDP will not choose market slippage for the caller."
      );
    }
    const shares = canonicalAmount(input.shares, "Share amount");
    const floor = canonicalAmount(input.minAmountOut, "minAmountOut");
    const owner = publicKey("owner", input.owner, "WITHDRAW_REFUSED");
    const rentPayer = publicKey("rentPayer", input.rentPayer ?? input.owner, "WITHDRAW_REFUSED");
    const rentRefundTo = publicKey(
      "rentRefundTo",
      input.rentRefundTo ?? input.owner,
      "WITHDRAW_REFUSED"
    );
    const swapPort = this.resolveSwapPort(ctx);

    return this.withRuntime(
      ctx,
      "Building the Hastra PRIME DEX exit",
      async (runtime, config, assertActive) => {
        this.assertKnownReference(config, input.providerReference);
        const wylds = address(config.deployment.wYldsMint);
        const prime = address(config.deployment.primeMint);
        const usdc = address(config.depositMint);
        const userWylds = await associatedTokenAddress(owner, wylds);
        const userPrime = await associatedTokenAddress(owner, prime);
        const userUsdc = await associatedTokenAddress(owner, usdc);
        const ownerAccounts = [userWylds, userPrime, userUsdc];
        const ticket = await legacyTicketAddress(config.deployment, owner);
        const { state, extra } = await readHastraState(runtime, config, [...ownerAccounts, ticket]);
        assertNoBlockingIssues(stakeBlockingIssues(state), "WITHDRAW_REFUSED", "The DEX exit");
        const wyldsAtoms = assetsForShares(shares.atoms, state.stakePrice);
        if (wyldsAtoms === 0n) {
          throw new SdpHastraError(
            "INVALID_AMOUNT",
            "The withdrawal is too small to redeem one wYLDS atom at Hastra's live rate."
          );
        }
        if (state.stakeVaultLiquidity < wyldsAtoms) {
          throw new SdpHastraError(
            "WITHDRAW_REFUSED",
            "Hastra's PRIME vault does not currently hold enough wYLDS for this redemption."
          );
        }

        const [userWyldsAccount, userPrimeAccount, userUsdcAccount] = decodeRpcAccounts(
          extra,
          ownerAccounts
        );
        assertOwnerTokenUsable(
          userPrimeAccount ?? null,
          "Owner PRIME token account",
          config.deployment.primeMint,
          owner,
          "WITHDRAW_REFUSED",
          shares.atoms
        );
        assertExistingOwnerTokenUsable(
          userWyldsAccount ?? null,
          "Owner wYLDS token account",
          config.deployment.wYldsMint,
          owner,
          "WITHDRAW_REFUSED"
        );
        assertExistingOwnerTokenUsable(
          userUsdcAccount ?? null,
          "Owner USDC token account",
          config.depositMint,
          owner,
          "WITHDRAW_REFUSED"
        );
        const legacyTicket = await decodeLegacyTicket(
          decodeRpcAccount(extra[ownerAccounts.length] ?? null, ticket),
          config,
          owner
        );
        if (legacyTicket && input.rentRefundTo !== undefined && rentRefundTo !== owner) {
          throw new SdpHastraError(
            "WITHDRAW_REFUSED",
            "This wallet has a legacy Hastra ticket whose program-hardcoded rent refund goes to " +
              "the owner, not the requested rentRefundTo address."
          );
        }
        const transientWylds = await transientTokenAccountPlan({
          runtime,
          payer: rentPayer,
          owner,
          mint: wylds,
          destination: userWylds,
          refundTo: rentPayer,
          amount: wyldsAtoms,
        });
        const leg = await this.buildLegWithFloor({
          swapPort,
          runtime,
          config,
          amount: { atoms: wyldsAtoms, text: formatAtoms(wyldsAtoms) },
          floor,
          owner: owner,
          payer: rentPayer,
          assertActive,
        });

        return {
          cluster: runtime.cluster,
          instructions: [
            computeUnitLimitInstruction(HASTRA_SWAP_COMPUTE_UNIT_LIMIT),
            await createAssociatedTokenInstruction(rentPayer, owner, wylds),
            await createAssociatedTokenInstruction(rentPayer, owner, usdc),
            ...transientWylds.setupInstructions,
            stakeRedeemInstruction({
              config,
              state,
              owner,
              userWylds: transientWylds.address,
              userPrime,
              legacyTicket,
              amount: shares.atoms,
            }),
            ...transientWylds.settleInstructions,
            ...leg.instructions,
          ],
          lookupTables: [...new Set(leg.lookupTableAddresses)],
          assetIdentity: {
            depositTokenMint: config.depositMint,
            shareMint: config.deployment.primeMint,
          },
          accepted: { shares: shares.text, minAmountOut: floor.text },
        };
      }
    );
  }

  private async buildLegWithFloor(args: {
    swapPort: EarnSwapPort;
    runtime: HastraRuntime;
    config: HastraClusterConfig;
    amount: { text: string; atoms: bigint };
    floor: { text: string; atoms: bigint };
    owner: string;
    payer: string;
    assertActive: () => void;
  }): Promise<EarnSwapLeg> {
    const quote = await args.swapPort.quoteSwap({
      cluster: args.runtime.cluster,
      inputMint: args.config.deployment.wYldsMint,
      outputMint: args.config.depositMint,
      amount: args.amount.text,
    });
    let quoteAtoms: bigint;
    try {
      quoteAtoms = canonicalAmount(quote.outAmount, "Jupiter quoted output").atoms;
    } catch (cause) {
      throw new SdpHastraError("SWAP_UNAVAILABLE", "Jupiter returned an invalid wYLDS quote.", {
        cause,
      });
    }
    if (quoteAtoms < args.floor.atoms) {
      throw new SdpHastraError(
        "WITHDRAW_REFUSED",
        `The wYLDS market pays ${quote.outAmount} USDC, below the requested ${args.floor.text} floor.`
      );
    }
    let slippageBps = Number(((quoteAtoms - args.floor.atoms) * 10_000n) / quoteAtoms);
    slippageBps = Math.min(slippageBps, 9_999);

    for (;;) {
      args.assertActive();
      const leg = await args.swapPort.buildSwapLeg({
        cluster: args.runtime.cluster,
        inputMint: args.config.deployment.wYldsMint,
        outputMint: args.config.depositMint,
        amount: args.amount.text,
        owner: args.owner,
        payer: args.payer,
        slippageBps,
        maxAccounts: HASTRA_JUPITER_MAX_ACCOUNTS,
      });
      if (leg.instructions.length === 0) {
        throw new SdpHastraError(
          "SWAP_UNAVAILABLE",
          "Jupiter returned no executable instructions for the wYLDS exit."
        );
      }
      let thresholdAtoms: bigint;
      try {
        thresholdAtoms = canonicalAmount(leg.minOutAmount, "Jupiter guaranteed output").atoms;
      } catch (cause) {
        throw new SdpHastraError(
          "SWAP_UNAVAILABLE",
          "Jupiter returned an invalid guaranteed output.",
          { cause }
        );
      }
      if (thresholdAtoms >= args.floor.atoms) return leg;
      if (slippageBps === 0) {
        throw new SdpHastraError(
          "WITHDRAW_REFUSED",
          `Jupiter's guaranteed output ${leg.minOutAmount} is below the requested ` +
            `${args.floor.text} floor even at zero tolerance.`
        );
      }
      slippageBps = 0;
    }
  }

  async readVaultPositions(
    ctx: EarnRuntimeContext,
    input: EarnVaultPositionInput
  ): Promise<EarnVaultPositionSnapshot[]> {
    const owner = publicKey("owner", input.owner, "POSITION_UNREADABLE");
    return this.withRuntime(ctx, "Reading Hastra PRIME positions", async (runtime, config) => {
      const readAll = input.providerReferences.length === 0;
      const references = readAll ? [config.deployment.primeMint] : input.providerReferences;
      for (const reference of references) this.assertKnownReference(config, reference);
      if (references.length === 0) return [];

      const state = await loadHastraState(runtime, config);
      const [primeAccount, wyldsAccount] = await getMultipleAccounts(
        runtime,
        [
          await associatedTokenAddress(owner, address(config.deployment.primeMint)),
          await associatedTokenAddress(owner, address(config.deployment.wYldsMint)),
        ],
        "POSITION_UNREADABLE"
      );
      const prime = primeAccount
        ? decodeTokenAccount(
            primeAccount,
            "Owner PRIME token account",
            config.deployment.primeMint,
            owner
          )
        : null;
      const wylds = wyldsAccount
        ? decodeTokenAccount(
            wyldsAccount,
            "Owner wYLDS token account",
            config.deployment.wYldsMint,
            owner
          )
        : null;
      const atoms = prime?.amount ?? 0n;
      // wYLDS an open request has delegated to Hastra's redeem authority is
      // that request's; only the rest is a residual holding (a cancelled
      // request's wYLDS, for one).
      const pledged =
        wylds?.delegate === state.addresses.redeemVaultAuthority ? wylds.delegatedAmount : 0n;
      const freeWylds = wylds && wylds.amount > pledged ? wylds.amount - pledged : 0n;
      if (readAll && atoms === 0n && freeWylds === 0n) return [];
      const shares = formatAtoms(atoms);
      const parValue = formatAtoms(assetsForShares(atoms, state.stakePrice));
      return [
        {
          providerReference: config.deployment.primeMint,
          owner: owner,
          cluster: runtime.cluster,
          shares,
          // Hastra exposes freeze administration on PRIME. Frozen tokens stay
          // the owner's holding but the token program will reject a burn.
          withdrawableShares: prime?.frozen ? "0" : shares,
          tokenValue: parValue,
          tokenMint: config.depositMint,
          shareMint: config.deployment.primeMint,
          ...(freeWylds > 0n
            ? {
                parIntermediate: {
                  mint: config.deployment.wYldsMint,
                  amount: formatAtoms(freeWylds),
                  withdrawableAmount: wylds?.frozen ? "0" : formatAtoms(freeWylds),
                  // vault-mint redeems wYLDS for USDC one atom for one atom.
                  tokenValue: formatAtoms(freeWylds),
                },
              }
            : {}),
        },
      ];
    });
  }

  async getParRedemptionOptions(
    ctx: EarnRuntimeContext,
    input: EarnVaultWithdrawalOptionsInput
  ): Promise<EarnVaultParRedemptionOptions> {
    return this.withRuntime(
      ctx,
      "Reading Hastra par-redemption options",
      async (runtime, config) => {
        this.assertKnownReference(config, input.providerReference);
        const state = await loadHastraState(runtime, config);
        return {
          intermediateMint: config.deployment.wYldsMint,
          assetMint: config.depositMint,
          // An unavailable rate blocks only the PRIME source; redeeming held
          // wYLDS needs no rate, so the options stay readable for it.
          minimumShares:
            state.stakePrice.price > 0n ? formatAtoms(minimumSharesForPar(state.stakePrice)) : null,
          minimumIntermediateAmount: HASTRA_PAR_MINIMUM_ASSETS,
          shareDecimals: TOKEN_DECIMALS,
          assetDecimals: TOKEN_DECIMALS,
          cancelable: true,
          operatorSettled: true,
        };
      }
    );
  }

  async quoteParRedemption(
    ctx: EarnRuntimeContext,
    input: EarnVaultParRedemptionQuoteInput
  ): Promise<EarnVaultParRedemptionQuote> {
    const source = parRedemptionSource(input);
    return this.withRuntime(ctx, "Quoting the Hastra par redemption", async (runtime, config) => {
      this.assertKnownReference(config, input.providerReference);
      const state = await loadHastraState(runtime, config);
      const intermediate =
        source.kind === "shares"
          ? assetsForShares(source.shares.atoms, state.stakePrice)
          : source.amount.atoms;
      const blockingIssues =
        source.kind === "shares" ? parBlockingIssues(state) : parRequestBlockingIssues(state);
      if (intermediate < HASTRA_PAR_MINIMUM_ASSET_ATOMS) {
        blockingIssues.push({
          code: "HASTRA_REDEMPTION_DUST",
          message: "The request is too small to redeem one wYLDS atom at Hastra's live rate.",
        });
      }
      return {
        shares: source.kind === "shares" ? source.shares.text : "0",
        shareDecimals: TOKEN_DECIMALS,
        intermediateMint: config.deployment.wYldsMint,
        intermediateAmount: formatAtoms(intermediate),
        assetMint: config.depositMint,
        assets: formatAtoms(intermediate),
        assetDecimals: TOKEN_DECIMALS,
        blockingIssues,
      };
    });
  }

  async buildParRedemptionRequest(
    ctx: EarnRuntimeContext,
    input: EarnVaultParRedemptionRequestInput
  ): Promise<EarnVaultParRedemptionRequestPlan> {
    const owner = publicKey("owner", input.owner, "REDEMPTION_REFUSED");
    const rentPayer = publicKey("rentPayer", input.rentPayer ?? input.owner, "REDEMPTION_REFUSED");
    // `request_redeem` hardcodes the owner as the request account's rent payer
    // and refund recipient — the program has no payer knob, so a foreign
    // rentPayer cannot take over that one account. Everything else
    // rent-bearing in this plan is builder-controlled, so a sponsor funds the
    // idempotent ATA creates and the transient redeem account, and the plan
    // pre-funds the owner with exactly the request account's rent-exempt
    // minimum: the program's create consumes the prefund in the same
    // transaction, the owner nets zero, and the completion/cancellation refund
    // still lands with the owner. Wallet-pays plans change nothing.
    const sponsor = rentPayer === owner ? undefined : rentPayer;
    const source = parRedemptionSource(input);
    return this.withRuntime(
      ctx,
      "Building the Hastra par-redemption request",
      async (runtime, config) => {
        this.assertKnownReference(config, input.providerReference);
        const wylds = address(config.deployment.wYldsMint);
        const prime = address(config.deployment.primeMint);
        const usdc = address(config.depositMint);
        const userWylds = await associatedTokenAddress(owner, wylds);
        const userPrime = await associatedTokenAddress(owner, prime);
        const userUsdc = await associatedTokenAddress(owner, usdc);
        const ownerAccounts = [userWylds, userPrime, userUsdc];
        const ticket = await legacyTicketAddress(config.deployment, owner);
        const { state, extra } = await readHastraState(
          runtime,
          config,
          source.kind === "shares" ? [...ownerAccounts, ticket] : ownerAccounts
        );
        let intermediateAtoms: bigint;
        if (source.kind === "shares") {
          assertNoBlockingIssues(
            parBlockingIssues(state),
            "REDEMPTION_REFUSED",
            "The par-redemption request"
          );
          intermediateAtoms = assetsForShares(source.shares.atoms, state.stakePrice);
        } else {
          // Held wYLDS never touches the stake program, so neither its pause
          // nor its price can block this source.
          assertNoBlockingIssues(
            parRequestBlockingIssues(state),
            "REDEMPTION_REFUSED",
            "The par-redemption request"
          );
          intermediateAtoms = source.amount.atoms;
        }
        if (intermediateAtoms < HASTRA_PAR_MINIMUM_ASSET_ATOMS) {
          throw new SdpHastraError(
            "REDEMPTION_REFUSED",
            "The request is too small to redeem one wYLDS atom at Hastra's live rate."
          );
        }
        if (source.kind === "shares" && state.stakeVaultLiquidity < intermediateAtoms) {
          throw new SdpHastraError(
            "REDEMPTION_REFUSED",
            "Hastra's PRIME vault does not currently hold enough wYLDS for this request."
          );
        }

        const { request, prefund } = await admitParRequest({ runtime, config, owner, sponsor });
        const [userWyldsAccount, userPrimeAccount, userUsdcAccount] = decodeRpcAccounts(
          extra,
          ownerAccounts
        );
        if (source.kind === "shares") {
          assertOwnerTokenUsable(
            userPrimeAccount ?? null,
            "Owner PRIME token account",
            config.deployment.primeMint,
            owner,
            "REDEMPTION_REFUSED",
            source.shares.atoms
          );
          assertExistingOwnerTokenUsable(
            userWyldsAccount ?? null,
            "Owner wYLDS token account",
            config.deployment.wYldsMint,
            owner,
            "REDEMPTION_REFUSED"
          );
        } else {
          assertOwnerTokenUsable(
            userWyldsAccount ?? null,
            "Owner wYLDS token account",
            config.deployment.wYldsMint,
            owner,
            "REDEMPTION_REFUSED",
            intermediateAtoms
          );
        }
        assertExistingOwnerTokenUsable(
          userUsdcAccount ?? null,
          "Owner USDC token account",
          config.depositMint,
          owner,
          "REDEMPTION_REFUSED"
        );

        let conversion: EarnVaultInstruction[] = [];
        if (source.kind === "shares") {
          const legacyTicket = await decodeLegacyTicket(
            decodeRpcAccount(extra[ownerAccounts.length] ?? null, ticket),
            config,
            owner
          );
          const transientWylds = await transientTokenAccountPlan({
            runtime,
            payer: rentPayer,
            owner,
            mint: wylds,
            destination: userWylds,
            refundTo: rentPayer,
            amount: intermediateAtoms,
          });
          conversion = [
            ...transientWylds.setupInstructions,
            stakeRedeemInstruction({
              config,
              state,
              owner,
              userWylds: transientWylds.address,
              userPrime,
              legacyTicket,
              amount: source.shares.atoms,
            }),
            ...transientWylds.settleInstructions,
          ];
        }
        const intermediate = formatAtoms(intermediateAtoms);
        const shares = source.kind === "shares" ? source.shares.text : "0";

        return {
          cluster: runtime.cluster,
          instructions: [
            computeUnitLimitInstruction(HASTRA_NATIVE_COMPUTE_UNIT_LIMIT),
            ...(prefund ? [prefund] : []),
            await createAssociatedTokenInstruction(rentPayer, owner, wylds),
            // Completion is operator-signed, so prepare the user's canonical USDC destination now.
            await createAssociatedTokenInstruction(rentPayer, owner, usdc),
            ...conversion,
            parRequestInstruction({
              config,
              state,
              owner,
              userWylds,
              request,
              amount: intermediateAtoms,
            }),
          ],
          lookupTables: [],
          assetIdentity: {
            depositTokenMint: config.depositMint,
            shareMint: config.deployment.primeMint,
          },
          ...(source.kind === "shares" ? { accepted: { shares: source.shares.text } } : {}),
          requestAddress: request,
          expectedRequest: {
            shares,
            intermediateMint: config.deployment.wYldsMint,
            intermediateAmount: intermediate,
            assetMint: config.depositMint,
            assets: intermediate,
          },
        };
      }
    );
  }

  async buildParRedemptionCancel(
    ctx: EarnRuntimeContext,
    input: EarnVaultParRedemptionCancelInput
  ): Promise<EarnVaultTransactionPlan> {
    const owner = publicKey("owner", input.owner, "REDEMPTION_REFUSED");
    const request = publicKey("requestAddress", input.requestAddress, "REDEMPTION_REFUSED");
    return this.withRuntime(
      ctx,
      "Building the Hastra redemption cancel",
      async (runtime, config) => {
        this.assertKnownReference(config, input.providerReference);
        const expected = await redemptionRequestAddress(config.deployment, owner);
        if (request !== expected) {
          throw new SdpHastraError(
            "REDEMPTION_REFUSED",
            "The Hastra request address is not the deterministic request for this owner."
          );
        }
        const wylds = address(config.deployment.wYldsMint);
        const userWylds = await associatedTokenAddress(owner, wylds);
        // Derived first so the identity read is sent before the request read.
        const addresses = await deriveHastraAddresses(config.deployment);
        // The owner's wYLDS rides the request read; both were REQUEST_UNREADABLE reads.
        const [stateRead, requestRead] = await Promise.allSettled([
          loadHastraState(runtime, config, addresses),
          getMultipleAccountWires(runtime, [request, userWylds], "REQUEST_UNREADABLE"),
        ]);
        // The identity request went first, so a full outage stays PROGRAM_MISMATCH.
        if (stateRead.status === "rejected") throw stateRead.reason;
        if (requestRead.status === "rejected") throw requestRead.reason;
        const state = stateRead.value;
        const [requestWire, userWyldsWire] = requestRead.value;
        const account = decodeRpcAccount(requestWire ?? null, request);
        if (!account) {
          throw new SdpHastraError("REDEMPTION_REFUSED", "The Hastra request is already closed.");
        }
        const decoded = await decodeRedemptionRequest(account, config, request);
        if (decoded.owner !== owner) {
          throw new SdpHastraError(
            "REDEMPTION_REFUSED",
            "The Hastra request belongs to another owner."
          );
        }
        assertExistingOwnerTokenUsable(
          decodeRpcAccount(userWyldsWire ?? null, userWylds),
          "Owner wYLDS token account",
          config.deployment.wYldsMint,
          owner,
          "REDEMPTION_REFUSED"
        );
        return {
          cluster: runtime.cluster,
          instructions: [
            await createAssociatedTokenInstruction(owner, owner, wylds),
            parCancelInstruction({ config, state, owner, userWylds, request }),
          ],
          lookupTables: [],
          assetIdentity: {
            depositTokenMint: config.depositMint,
            shareMint: config.deployment.primeMint,
          },
        };
      }
    );
  }

  async readParRedemptionRequest(
    ctx: EarnRuntimeContext,
    input: EarnVaultParRedemptionRequestReadInput
  ): Promise<EarnVaultParRedemptionRequestLookup> {
    const requestAddress = publicKey("requestAddress", input.requestAddress, "REQUEST_UNREADABLE");
    return this.withRuntime(
      ctx,
      "Reading the Hastra redemption request",
      async (runtime, config) => {
        this.assertKnownReference(config, input.providerReference);
        await loadHastraState(runtime, config);
        const account = await getAccount(runtime, requestAddress, "REQUEST_UNREADABLE");
        if (!account) return { requestAddress, status: "closedOrUnknown", request: null };
        const decoded = await decodeRedemptionRequest(account, config, requestAddress);
        return {
          requestAddress,
          status: "pending",
          request: {
            requestAddress,
            providerReference: config.deployment.primeMint,
            owner: decoded.owner,
            intermediateMint: decoded.mint,
            intermediateAmount: formatAtoms(decoded.amount),
          },
        };
      }
    );
  }

  async decodeParRedemptionLifecycleEvents(
    ctx: EarnRuntimeContext,
    input: EarnVaultParRedemptionLifecycleInput
  ): Promise<readonly EarnVaultParRedemptionLifecycleEvent[]> {
    const cluster = CLUSTER_BY_SDP_ENVIRONMENT[ctx.environment];
    const config = hastraClusterConfig(cluster);
    this.assertKnownReference(config, input.providerReference);
    return await parseParLifecycleEvents(config, input);
  }
}
