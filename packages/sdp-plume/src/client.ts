import { SdpEarnError } from "@sdp/earn/errors";
import {
  plumeCancellationStatusSchema,
  plumeMintStatusSchema,
  plumePriceSchema,
  plumeRedeemStatusSchema,
  plumeRequest,
  plumeTransactionSchema,
} from "@sdp/earn/providers/plume/api";
import { PlumeEarnClient } from "@sdp/earn/providers/plume/client";
import type {
  EarnRuntimeContext,
  EarnVaultDepositInput,
  EarnVaultDirectProvider,
  EarnVaultPositionInput,
  EarnVaultPositionSnapshot,
  EarnVaultProviderOrderWithdrawProvider,
  EarnVaultTransactionPlan,
  EarnVaultWithdrawInput,
} from "@sdp/earn/types";
import { decimalStringFromNumber, multiplyDecimalAmounts } from "@sdp/payments/decimal";
import { createClusterRpc } from "@sdp/rpc/factory";
import { currentClusterScope } from "@sdp/rpc/scope";
import { deriveAssociatedTokenAddress } from "@sdp/solana/address";
import { AmountError, formatDecimalAmount, parseDecimalAmount } from "@sdp/solana/amount";
import { PLUME_PROGRAMS, PLUME_VAULTS, plumeVault } from "@sdp/types/plume-programs";
import { MEMO_PROGRAM_ADDRESS } from "@sdp/types/well-known-programs";
import {
  type SolanaCluster,
  SPL_TOKEN_PROGRAMS,
  wellKnownMint,
} from "@sdp/types/well-known-tokens";
import {
  address,
  createNoopSigner,
  getCompiledTransactionMessageDecoder,
  getTransactionDecoder,
  isSome,
} from "@solana/kit";
import { getCreateAssociatedTokenIdempotentInstruction } from "@solana-program/token";
import type { z } from "zod";
import { oftSendDecoder, redeemCompose } from "./abi";
import { readPlumeVault } from "./chain";
import { SdpPlumeError } from "./errors";
import {
  assertPlumeOperationActive,
  type PlumeOperationRunner,
  withPlumeOperation,
} from "./operation";
import { admitPlumeTransaction } from "./plan";

function amount(value: string, decimals: number, numeric: boolean) {
  let atoms: bigint;
  try {
    atoms = parseDecimalAmount(value, decimals);
  } catch (cause) {
    if (!(cause instanceof AmountError)) throw cause;
    throw new SdpPlumeError("INVALID_AMOUNT", `Amount must use at most ${decimals} decimals`);
  }
  if (
    atoms <= 0n ||
    atoms > (1n << 64n) - 1n ||
    (numeric && atoms > BigInt(Number.MAX_SAFE_INTEGER))
  )
    throw new SdpPlumeError("INVALID_AMOUNT", "Amount exceeds Plume's exact integer range");
  return { atoms, text: formatDecimalAmount(atoms, decimals) };
}

function configuration(ctx: EarnRuntimeContext, reference: string) {
  const scope = currentClusterScope();
  if (ctx.environment !== scope.environment)
    throw new SdpPlumeError(
      "DEPLOYMENT_NOT_CONFIGURED",
      "Plume runtime does not match the project's environment"
    );
  const vault = plumeVault(scope.cluster, reference);
  const depositMint = wellKnownMint("USDC", scope.cluster);
  if (!vault || depositMint === undefined)
    throw new SdpPlumeError(
      "DEPLOYMENT_NOT_CONFIGURED",
      "Plume has no approved deployment on this project's cluster"
    );
  return { vault, depositMint };
}

export class PlumeVaultDirectClient
  extends PlumeEarnClient
  implements EarnVaultDirectProvider, EarnVaultProviderOrderWithdrawProvider
{
  constructor(
    private readonly runOperation: PlumeOperationRunner = async (_label, operation) =>
      operation(() => undefined)
  ) {
    super();
  }

  private async run<T>(label: string, operation: () => Promise<T>): Promise<T> {
    try {
      return await this.runOperation(label, (assertActive) =>
        withPlumeOperation(assertActive, operation)
      );
    } catch (cause) {
      if (cause instanceof SdpEarnError || cause instanceof SdpPlumeError) throw cause;
      throw new SdpPlumeError("VAULT_UNREADABLE", "Plume could not validate this operation", {
        cause,
      });
    }
  }

  getProviderRedemptionModes() {
    return ["standard", "instant"] as const;
  }
  readonly vaultWithdrawalSettlement = "provider_order" as const;

  sponsoredPrograms(cluster: SolanaCluster): readonly string[] {
    if (!PLUME_VAULTS.some((v) => v.cluster === cluster)) return [];
    return [
      ...Object.values(PLUME_PROGRAMS),
      MEMO_PROGRAM_ADDRESS,
      SPL_TOKEN_PROGRAMS["spl-token"],
      // biome-ignore lint/security/noSecrets: canonical associated-token program address.
      "ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL",
      "11111111111111111111111111111111",
      "ComputeBudget111111111111111111111111111111",
    ];
  }

  buildVaultDeposit(ctx: EarnRuntimeContext, input: EarnVaultDepositInput) {
    return this.run("Plume buildVaultDeposit", () => this.buildVaultDepositInternal(ctx, input));
  }

  private async buildVaultDepositInternal(
    ctx: EarnRuntimeContext,
    input: EarnVaultDepositInput
  ): Promise<EarnVaultTransactionPlan> {
    if (input.minSharesOut !== undefined)
      throw new SdpPlumeError(
        "INVALID_AMOUNT",
        "Plume cannot enforce a minimum share output for cross-chain settlement"
      );
    const { vault, depositMint } = configuration(ctx, input.providerReference);
    const value = amount(input.amount, 6, true);
    const rpc = createClusterRpc();
    const state = await readPlumeVault(rpc, vault, input.owner, depositMint);
    const feePayer = input.rentPayer === undefined ? input.owner : input.rentPayer;
    if (feePayer !== input.owner && !state.shareAccountExists)
      throw new SdpPlumeError(
        "DEPOSIT_REFUSED",
        `Create the wallet's Plume share token account before a sponsored mint (${state.shareAta})`
      );
    const tx = await this.build(
      "/solana/nest/mint/build-tx",
      {
        nestVaultSlug: vault.slug,
        rawAmountUsdc: Number(value.atoms),
        complianceVersion: "v2",
        finality: "standard",
        receiver: input.owner,
        feePayer,
      },
      "deposit"
    );
    return admitPlumeTransaction(rpc, {
      vault,
      depositMint,
      owner: input.owner,
      feePayer,
      atoms: value.atoms,
      canonicalAmount: value.text,
      mode: "mint",
      transactionBase64: tx.txBase64,
    });
  }

  buildVaultWithdrawal(ctx: EarnRuntimeContext, input: EarnVaultWithdrawInput) {
    return this.run("Plume buildVaultWithdrawal", () =>
      this.buildVaultWithdrawalInternal(ctx, input)
    );
  }

  private async buildVaultWithdrawalInternal(
    ctx: EarnRuntimeContext,
    input: EarnVaultWithdrawInput
  ): Promise<EarnVaultTransactionPlan> {
    if (input.minAmountOut !== undefined)
      throw new SdpPlumeError(
        "INVALID_AMOUNT",
        "Plume cannot enforce a minimum USDC output for cross-chain settlement"
      );
    const { vault, depositMint } = configuration(ctx, input.providerReference);
    const mode = input.redemptionMode === undefined ? "standard" : input.redemptionMode;
    const value = amount(input.shares, vault.shareDecimals, mode === "instant");
    const rate = 10n ** BigInt(Math.max(0, vault.shareDecimals - vault.plumeShareDecimals));
    if (value.atoms % rate !== 0n)
      throw new SdpPlumeError("INVALID_AMOUNT", "Share amount contains unrepresentable OFT dust");
    const rpc = createClusterRpc();
    const state = await readPlumeVault(rpc, vault, input.owner, depositMint);
    if (state.shares < value.atoms)
      throw new SdpPlumeError("WITHDRAW_REFUSED", "Insufficient Plume shares");
    const feePayer = input.rentPayer === undefined ? input.owner : input.rentPayer;
    const tx = await this.build(
      mode === "standard" ? "/solana/nest/async-redeem/build-tx" : "/solana/nest/redeem/build-tx",
      {
        nestVaultSlug: vault.slug,
        rawAmountNestToken: mode === "standard" ? value.atoms.toString() : Number(value.atoms),
        complianceVersion: "v1",
        owner: input.owner,
        feePayer,
      },
      "withdrawal"
    );
    return admitPlumeTransaction(rpc, {
      vault,
      depositMint,
      owner: input.owner,
      feePayer,
      atoms: value.atoms,
      canonicalAmount: value.text,
      mode,
      transactionBase64: tx.txBase64,
    });
  }

  readVaultPositions(ctx: EarnRuntimeContext, input: EarnVaultPositionInput) {
    return this.run("Plume readVaultPositions", () => this.readVaultPositionsInternal(ctx, input));
  }

  private async readVaultPositionsInternal(
    ctx: EarnRuntimeContext,
    input: EarnVaultPositionInput
  ): Promise<EarnVaultPositionSnapshot[]> {
    const refs =
      input.providerReferences.length === 0
        ? PLUME_VAULTS.filter((v) => v.cluster === currentClusterScope().cluster).map(
            (v) => v.shareMint
          )
        : input.providerReferences;
    const rpc = createClusterRpc();
    return Promise.all(
      refs.map(async (reference) => {
        const { vault, depositMint } = configuration(ctx, reference);
        const [state, price] = await Promise.all([
          readPlumeVault(rpc, vault, input.owner, depositMint),
          plumeExecutionRequest(
            `/vaults/${encodeURIComponent(vault.slug)}/price`,
            plumePriceSchema
          ),
        ]);
        const shares = formatDecimalAmount(state.shares, vault.shareDecimals);
        return {
          providerReference: vault.shareMint,
          owner: input.owner,
          cluster: vault.cluster,
          shares,
          withdrawableShares: shares,
          tokenMint: depositMint,
          shareMint: vault.shareMint,
          tokenValue: multiplyDecimalAmounts(shares, decimalStringFromNumber(price.price)),
        };
      })
    );
  }

  buildVaultPreparation(
    ctx: EarnRuntimeContext,
    input: { providerReference: string; owner: string; rentPayer?: string }
  ) {
    return this.run("Plume buildVaultPreparation", () =>
      this.buildVaultPreparationInternal(ctx, input)
    );
  }

  private async buildVaultPreparationInternal(
    ctx: EarnRuntimeContext,
    input: { providerReference: string; owner: string; rentPayer?: string }
  ): Promise<EarnVaultTransactionPlan> {
    const { vault, depositMint } = configuration(ctx, input.providerReference);
    const state = await readPlumeVault(createClusterRpc(), vault, input.owner, depositMint);
    if (state.shareAccountExists)
      return {
        cluster: vault.cluster,
        assetIdentity: { depositTokenMint: depositMint, shareMint: vault.shareMint },
        lookupTables: [],
        createsShareAccount: false,
        instructions: [],
      };
    const payer = input.rentPayer === undefined ? input.owner : input.rentPayer;
    const ix = getCreateAssociatedTokenIdempotentInstruction({
      payer: createNoopSigner(address(payer)),
      ata: state.shareAta,
      owner: address(input.owner),
      mint: address(vault.shareMint),
    });
    return {
      cluster: vault.cluster,
      assetIdentity: { depositTokenMint: depositMint, shareMint: vault.shareMint },
      lookupTables: [],
      createsShareAccount: !state.shareAccountExists,
      instructions: [
        {
          programAddress: ix.programAddress,
          accounts: ix.accounts.map((a) => ({ address: a.address, role: a.role })),
          data: Buffer.from(ix.data).toString("base64"),
        },
        {
          programAddress: MEMO_PROGRAM_ADDRESS,
          accounts: [{ address: input.owner, role: 2 }],
          data: Buffer.from("sdp:earn:account-preparation").toString("base64"),
        },
      ],
    };
  }

  private async originalComposer(
    ctx: EarnRuntimeContext,
    input: { providerReference: string; owner: string; sourceTransaction: string }
  ) {
    const { vault, depositMint } = configuration(ctx, input.providerReference);
    const original = getTransactionDecoder().decode(Buffer.from(input.sourceTransaction, "base64"));
    if (original.signatures[address(input.owner)] == null)
      throw new SdpPlumeError(
        "WITHDRAW_REFUSED",
        "The original order is not signed by this wallet"
      );
    const message = getCompiledTransactionMessageDecoder().decode(original.messageBytes);
    if (message.version !== 0)
      throw new SdpPlumeError("WITHDRAW_REFUSED", "Original order must be a versioned transaction");
    const sends = message.instructions.filter(
      (ix) =>
        ix.data !== undefined &&
        Buffer.from(ix.data)
          .subarray(0, 8)
          .equals(Buffer.from([102, 251, 20, 187, 65, 75, 12, 69]))
    );
    if (sends.length !== 1 || sends[0].data === undefined)
      throw new SdpPlumeError("WITHDRAW_REFUSED", "The original order has no unique OFT request");
    const send = oftSendDecoder.decode(sends[0].data);
    const usdcAta = await deriveAssociatedTokenAddress(
      input.owner,
      depositMint,
      SPL_TOKEN_PROGRAMS["spl-token"]
    );
    const plumeAtoms =
      send.amount / 10n ** BigInt(Math.max(0, vault.shareDecimals - vault.plumeShareDecimals));
    if (
      !isSome(send.compose) ||
      !Buffer.from(send.compose.value).equals(
        Buffer.from(redeemCompose(usdcAta, plumeAtoms, "standard"))
      )
    )
      throw new SdpPlumeError(
        "WITHDRAW_REFUSED",
        "Only a standard provider redemption may be cancelled"
      );
    return {
      vault,
      depositMint,
      composer: `0x${Buffer.from(send.to).subarray(12).toString("hex")}`,
    };
  }

  buildProviderOrderCancellation(
    ctx: EarnRuntimeContext,
    input: {
      providerReference: string;
      owner: string;
      sourceTransaction: string;
      rentPayer?: string;
    }
  ) {
    return this.run("Plume buildProviderOrderCancellation", () =>
      this.buildProviderOrderCancellationInternal(ctx, input)
    );
  }

  private async buildProviderOrderCancellationInternal(
    ctx: EarnRuntimeContext,
    input: {
      providerReference: string;
      owner: string;
      sourceTransaction: string;
      rentPayer?: string;
    }
  ): Promise<EarnVaultTransactionPlan> {
    const { vault, depositMint, composer } = await this.originalComposer(ctx, input);
    const feePayer = input.rentPayer === undefined ? input.owner : input.rentPayer;
    const tx = await this.build(
      "/solana/nest/async-redeem/update/build-tx",
      {
        nestVaultSlug: vault.slug,
        newRawAmountNestToken: "0",
        composerAddress: composer,
        owner: input.owner,
        feePayer,
      },
      "withdrawal"
    );
    return admitPlumeTransaction(createClusterRpc(), {
      vault,
      depositMint,
      owner: input.owner,
      feePayer,
      atoms: 0n,
      canonicalAmount: "0",
      mode: "cancel",
      originalComposer: composer,
      transactionBase64: tx.txBase64,
    });
  }

  readProviderOrderCancellation(
    ctx: EarnRuntimeContext,
    input: {
      providerReference: string;
      owner: string;
      sourceSignature: string;
      sourceTransaction: string;
    }
  ) {
    return this.run("Plume readProviderOrderCancellation", () =>
      this.readProviderOrderCancellationInternal(ctx, input)
    );
  }

  private async readProviderOrderCancellationInternal(
    ctx: EarnRuntimeContext,
    input: {
      providerReference: string;
      owner: string;
      sourceSignature: string;
      sourceTransaction: string;
    }
  ) {
    const { vault, composer } = await this.originalComposer(ctx, input);
    let status: z.output<typeof plumeCancellationStatusSchema>;
    try {
      status = await plumeExecutionRequest(
        `/solana/update-status/${encodeURIComponent(input.sourceSignature)}`,
        plumeCancellationStatusSchema
      );
    } catch (cause) {
      if (cause instanceof SdpEarnError && cause.details?.providerStatus === 404)
        return {
          sourceSignature: input.sourceSignature,
          owner: input.owner,
          destinationSignature: null,
          tokenMint: vault.shareMint,
          programAddress: PLUME_PROGRAMS.oft,
          requiredAccount: vault.oftStore,
          phase: "processing" as const,
        };
      throw cause;
    }
    if (
      status.sourceSignature !== input.sourceSignature ||
      status.owner !== input.owner ||
      status.composer.toLowerCase() !== composer.toLowerCase() ||
      BigInt(status.remainingShares) !== 0n
    )
      throw new SdpPlumeError(
        "VAULT_UNREADABLE",
        "Plume cancellation status differs from the original order"
      );
    return {
      sourceSignature: input.sourceSignature,
      owner: input.owner,
      destinationSignature: status.destinationSignature === "" ? null : status.destinationSignature,
      tokenMint: vault.shareMint,
      programAddress: PLUME_PROGRAMS.oft,
      requiredAccount: vault.oftStore,
      phase: "processing" as const,
    };
  }

  readProviderSettlement(
    ctx: EarnRuntimeContext,
    input: {
      providerReference: string;
      owner: string;
      sourceSignature: string;
      direction: "deposit" | "withdrawal";
    }
  ) {
    return this.run("Plume readProviderSettlement", () =>
      this.readProviderSettlementInternal(ctx, input)
    );
  }

  private async readProviderSettlementInternal(
    ctx: EarnRuntimeContext,
    input: {
      providerReference: string;
      owner: string;
      sourceSignature: string;
      direction: "deposit" | "withdrawal";
    }
  ) {
    const { vault, depositMint } = configuration(ctx, input.providerReference);
    const schema = input.direction === "deposit" ? plumeMintStatusSchema : plumeRedeemStatusSchema;
    let result: z.output<typeof plumeMintStatusSchema>;
    try {
      result = await plumeExecutionRequest(
        `/solana/${input.direction === "deposit" ? "mint-status" : "redeem-status"}/${encodeURIComponent(input.sourceSignature)}`,
        schema
      );
    } catch (cause) {
      if (cause instanceof SdpEarnError && cause.details?.providerStatus === 404)
        return {
          sourceSignature: input.sourceSignature,
          owner: input.owner,
          destinationSignature: null,
          tokenMint: input.direction === "deposit" ? vault.shareMint : depositMint,
          programAddress:
            input.direction === "deposit" ? PLUME_PROGRAMS.oft : PLUME_PROGRAMS.messageTransmitter,
          requiredAccount: input.direction === "deposit" ? vault.oftStore : depositMint,
          phase: "processing" as const,
        };
      throw cause;
    }
    if (result.sourceSignature !== input.sourceSignature || result.owner !== input.owner)
      throw new SdpPlumeError(
        "VAULT_UNREADABLE",
        "Plume status belongs to a different source transaction or wallet"
      );
    const destinationSignature =
      result.destinationSignature === "" ? null : result.destinationSignature;
    return {
      sourceSignature: input.sourceSignature,
      owner: input.owner,
      destinationSignature,
      tokenMint: input.direction === "deposit" ? vault.shareMint : depositMint,
      programAddress:
        input.direction === "deposit" ? PLUME_PROGRAMS.oft : PLUME_PROGRAMS.messageTransmitter,
      requiredAccount: input.direction === "deposit" ? vault.oftStore : depositMint,
      phase: result.recoveryRequired ? ("recovery_required" as const) : ("processing" as const),
    };
  }

  private async build(
    path: string,
    body: Record<string, string | number>,
    direction: "deposit" | "withdrawal"
  ) {
    try {
      return await plumeExecutionRequest(path, plumeTransactionSchema, body);
    } catch (cause) {
      if (cause instanceof SdpEarnError) {
        if (cause.details?.providerStatus === 403 && direction === "deposit")
          throw new SdpPlumeError(
            "COMPLIANCE_APPROVAL_REQUIRED",
            "Plume has not approved this wallet for deposits"
          );
        if (cause.code === "BAD_REQUEST")
          throw new SdpPlumeError(
            direction === "deposit" ? "DEPOSIT_REFUSED" : "WITHDRAW_REFUSED",
            "Plume refused this transaction; refresh the vault's eligibility and redemption availability"
          );
      }
      throw new SdpPlumeError("VAULT_UNREADABLE", "Plume transaction could not be built", {
        cause,
      });
    }
  }
}

function plumeExecutionRequest<T>(
  path: string,
  schema: z.ZodType<T>,
  body?: Record<string, string | number>
): Promise<T> {
  assertPlumeOperationActive();
  return plumeRequest(path, schema, body);
}
