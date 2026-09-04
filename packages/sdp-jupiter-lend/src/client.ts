import {
  getDepositContext,
  getDepositIxs,
  getRedeemIxs,
  getUserLendingPositionByAsset,
} from "@jup-ag/lend/earn";
import { supportsPortfolioWallets } from "@sdp/earn/capabilities";
import { badRequest } from "@sdp/earn/errors";
import { JupiterLendEarnClient } from "@sdp/earn/providers/jupiter_lend/client";
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
import type { SolanaCluster } from "@sdp/types";
import { JUPITER_LEND_USDT } from "@sdp/types/jupiter-lend-programs";
import { Connection, PublicKey, TransactionInstruction } from "@solana/web3.js";
import { fromAtoms, toAtoms } from "./amounts";
import { SdpJupiterLendError } from "./errors";
import { assertJupiterLendPlanPrograms, permittedJupiterLendPrograms } from "./guards";

// biome-ignore lint/security/noSecrets: public Solana program address
const ATA_PROGRAM = "ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL";
export type JupiterLendVaultOperationRunner = <T>(
  label: string,
  operation: (assertActive: () => void) => Promise<T>
) => Promise<T>;

function publicKey(field: string, value: string): PublicKey {
  try {
    return new PublicKey(value);
  } catch {
    throw badRequest(`${field} is not a valid Solana address`);
  }
}

function rewriteAtaPayer(
  instruction: TransactionInstruction,
  owner: PublicKey,
  rentPayer: PublicKey
): TransactionInstruction {
  if (instruction.programId.toBase58() !== ATA_PROGRAM || rentPayer.equals(owner))
    return instruction;
  const payer = instruction.keys[0];
  if (!payer?.pubkey.equals(owner) || !payer.isSigner || !payer.isWritable) {
    throw new SdpJupiterLendError(
      "PROGRAM_MISMATCH",
      "Jupiter Lend emitted an associated-token instruction with an unexpected payer layout"
    );
  }
  return new TransactionInstruction({
    programId: instruction.programId,
    data: instruction.data,
    keys: [{ ...payer, pubkey: rentPayer }, ...instruction.keys.slice(1)],
  });
}

function toEarnInstruction(instruction: TransactionInstruction): EarnVaultInstruction {
  return {
    programAddress: instruction.programId.toBase58(),
    accounts: instruction.keys.map((key) => ({
      address: key.pubkey.toBase58(),
      role: (key.isSigner ? 2 : 0) + (key.isWritable ? 1 : 0),
    })),
    data: instruction.data.toString("base64"),
  };
}

export class JupiterLendVaultDirectClient
  extends JupiterLendEarnClient
  implements EarnVaultWithdrawProvider
{
  constructor(
    private readonly resolveProvenRpcUrl: (
      ctx: EarnRuntimeContext,
      cluster: SolanaCluster
    ) => Promise<string>,
    private readonly runOperation: JupiterLendVaultOperationRunner
  ) {
    super();
  }

  sponsoredPrograms(cluster: SolanaCluster): readonly string[] {
    return [...permittedJupiterLendPrograms(cluster)];
  }

  private async withConnection<T>(
    ctx: EarnRuntimeContext,
    label: string,
    operation: (connection: Connection, assertActive: () => void) => Promise<T>
  ): Promise<T> {
    return this.runOperation(label, async (assertActive) => {
      const cluster: SolanaCluster = ctx.environment === "production" ? "mainnet-beta" : "devnet";
      if (cluster !== "mainnet-beta") {
        throw new SdpJupiterLendError(
          "CLUSTER_UNSUPPORTED",
          "Jupiter Lend Earn is available on mainnet-beta only"
        );
      }
      const rpcUrl = await this.resolveProvenRpcUrl(ctx, cluster);
      assertActive();
      return operation(new Connection(rpcUrl, "confirmed"), assertActive);
    });
  }

  private asset(reference: string): PublicKey {
    if (reference !== JUPITER_LEND_USDT.assetMint) {
      throw badRequest("Jupiter Lend currently supports only the USDT earn market in SDP");
    }
    return new PublicKey(JUPITER_LEND_USDT.assetMint);
  }

  private assertShareMint(mint: PublicKey): void {
    if (mint.toBase58() !== JUPITER_LEND_USDT.shareMint) {
      throw new SdpJupiterLendError(
        "PROGRAM_MISMATCH",
        "Jupiter Lend derived a receipt mint outside SDP's admitted USDT market"
      );
    }
  }

  async buildVaultDeposit(
    ctx: EarnRuntimeContext,
    input: EarnVaultDepositInput
  ): Promise<EarnVaultTransactionPlan> {
    if (input.minSharesOut !== undefined) {
      throw badRequest("Jupiter Lend deposit instructions do not encode minSharesOut");
    }
    const asset = this.asset(input.providerReference);
    const owner = publicKey("owner", input.owner);
    const rentPayer = publicKey("rentPayer", input.rentPayer ?? input.owner);
    const amount = toAtoms("amount", input.amount, JUPITER_LEND_USDT.decimals);

    try {
      return await this.withConnection(
        ctx,
        "Building the Jupiter Lend deposit",
        async (connection, assertActive) => {
          const context = await getDepositContext({
            asset,
            signer: owner,
            connection,
            market: "main",
          });
          this.assertShareMint(context.fTokenMint);
          const createsShareAccount =
            (await connection.getAccountInfo(context.recipientTokenAccount)) === null;
          assertActive();
          const { ixs } = await getDepositIxs({
            amount,
            asset,
            signer: owner,
            connection,
            market: "main",
            includeWrapSol: false,
          });
          assertActive();
          return assertJupiterLendPlanPrograms({
            cluster: "mainnet-beta",
            instructions: ixs
              .map((ix) => rewriteAtaPayer(ix, owner, rentPayer))
              .map(toEarnInstruction),
            lookupTables: [],
            assetIdentity: {
              depositTokenMint: asset.toBase58(),
              shareMint: context.fTokenMint.toBase58(),
            },
            accepted: { amount: fromAtoms(amount, JUPITER_LEND_USDT.decimals) },
            createsShareAccount,
          });
        }
      );
    } catch (error) {
      if (error instanceof SdpJupiterLendError) throw error;
      throw new SdpJupiterLendError(
        "MARKET_UNREADABLE",
        "Could not build the Jupiter Lend USDT deposit",
        { cause: error }
      );
    }
  }

  async buildVaultWithdrawal(
    ctx: EarnRuntimeContext,
    input: EarnVaultWithdrawInput
  ): Promise<EarnVaultTransactionPlan> {
    if (input.minAmountOut !== undefined) {
      throw badRequest("Jupiter Lend redeem instructions do not encode minAmountOut");
    }
    const asset = this.asset(input.providerReference);
    const owner = publicKey("owner", input.owner);
    const rentPayer = publicKey("rentPayer", input.rentPayer ?? input.owner);
    const shares = toAtoms("shares", input.shares, JUPITER_LEND_USDT.decimals);

    try {
      return await this.withConnection(
        ctx,
        "Building the Jupiter Lend withdrawal",
        async (connection, assertActive) => {
          const context = await getDepositContext({
            asset,
            signer: owner,
            connection,
            market: "main",
          });
          this.assertShareMint(context.fTokenMint);
          const { ixs } = await getRedeemIxs({
            shares,
            asset,
            signer: owner,
            connection,
            market: "main",
          });
          assertActive();
          return assertJupiterLendPlanPrograms({
            cluster: "mainnet-beta",
            instructions: ixs
              .map((ix) => rewriteAtaPayer(ix, owner, rentPayer))
              .map(toEarnInstruction),
            lookupTables: [],
            assetIdentity: {
              depositTokenMint: asset.toBase58(),
              shareMint: context.fTokenMint.toBase58(),
            },
            accepted: { shares: fromAtoms(shares, JUPITER_LEND_USDT.decimals) },
          });
        }
      );
    } catch (error) {
      if (error instanceof SdpJupiterLendError) throw error;
      throw new SdpJupiterLendError(
        "MARKET_UNREADABLE",
        "Could not build the Jupiter Lend USDT withdrawal",
        { cause: error }
      );
    }
  }

  async readVaultPositions(
    ctx: EarnRuntimeContext,
    input: EarnVaultPositionInput
  ): Promise<EarnVaultPositionSnapshot[]> {
    if (input.providerReferences.some((reference) => reference !== JUPITER_LEND_USDT.assetMint)) {
      throw badRequest("Jupiter Lend currently supports only the USDT earn market in SDP");
    }
    const owner = publicKey("owner", input.owner);
    const asset = new PublicKey(JUPITER_LEND_USDT.assetMint);
    return this.withConnection(
      ctx,
      "Reading the Jupiter Lend position",
      async (connection, assertActive) => {
        try {
          const [position, context] = await Promise.all([
            getUserLendingPositionByAsset({ user: owner, asset, connection, market: "main" }),
            getDepositContext({ asset, signer: owner, connection, market: "main" }),
          ]);
          assertActive();
          this.assertShareMint(context.fTokenMint);
          if (position.lendingTokenShares.isZero() && input.providerReferences.length === 0)
            return [];
          const shares = fromAtoms(position.lendingTokenShares, JUPITER_LEND_USDT.decimals);
          return [
            {
              providerReference: JUPITER_LEND_USDT.assetMint,
              owner: owner.toBase58(),
              cluster: "mainnet-beta",
              shares,
              withdrawableShares: shares,
              tokenValue: fromAtoms(position.underlyingAssets, JUPITER_LEND_USDT.decimals),
              tokenMint: JUPITER_LEND_USDT.assetMint,
              shareMint: context.fTokenMint.toBase58(),
            },
          ];
        } catch (error) {
          if (error instanceof SdpJupiterLendError) throw error;
          throw new SdpJupiterLendError(
            "MARKET_UNREADABLE",
            "Could not read the Jupiter Lend USDT position",
            { cause: error }
          );
        }
      }
    );
  }
}

export function assertJupiterLendNotPortfolioProvider(client: JupiterLendVaultDirectClient): void {
  if (supportsPortfolioWallets(client)) {
    throw new SdpJupiterLendError(
      "PROGRAM_MISMATCH",
      "Jupiter Lend is non-custodial and must not expose portfolio-wallet capabilities"
    );
  }
}
