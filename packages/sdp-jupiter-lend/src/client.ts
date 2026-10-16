import { lendingPda } from "@jup-ag/lend";
import {
  getDepositContext,
  getLendingProgram,
  getLendingTokenDetails,
  getOrCreateATAInstruction,
  getWithdrawContext,
} from "@jup-ag/lend/earn";
import { supportsPortfolioWallets } from "@sdp/earn/capabilities";
import { badRequest } from "@sdp/earn/errors";
import { JupiterLendEarnClient } from "@sdp/earn/providers/jupiter_lend/client";
import type {
  EarnRuntimeContext,
  EarnVaultDepositInput,
  EarnVaultDepositQuote,
  EarnVaultDepositQuoteInput,
  EarnVaultDepositQuoteProvider,
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
import { readStamp } from "@sdp/rpc/read-context";
import type { SolanaCluster } from "@sdp/types";
import { JUPITER_LEND_USDT } from "@sdp/types/jupiter-lend-programs";
import {
  type AccountInfo,
  type Commitment,
  type Connection,
  type GetAccountInfoConfig,
  PublicKey,
  TransactionInstruction,
} from "@solana/web3.js";
import BN from "bn.js";
import { fromAtoms, toAtoms } from "./amounts";
import { SdpJupiterLendError } from "./errors";
import { assertJupiterLendPlanPrograms, permittedJupiterLendPrograms } from "./guards";
import { canJoinJupiterLendRead, jupiterLendConnection } from "./rpc";

// biome-ignore lint/security/noSecrets: public Solana program address
const ATA_PROGRAM = "ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL";
// biome-ignore lint/security/noSecrets: public Solana program address
const TOKEN_PROGRAM = new PublicKey("TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA");
const U64_MAX = new BN(1).ushln(64).subn(1);
const ASSET_MINT = new PublicKey(JUPITER_LEND_USDT.assetMint);
const SHARE_MINT = new PublicKey(JUPITER_LEND_USDT.shareMint);
const DERIVED_SHARE_MINT = lendingPda.getLendingToken(ASSET_MINT, "main");
const TOKEN_ACCOUNT_SIZE = 165;
/** USDT and jlUSDT are classic SPL Token mints; the SDK reads only their owner. */
const PINNED_MINT: AccountInfo<Buffer> = {
  executable: false,
  owner: TOKEN_PROGRAM,
  lamports: 0,
  data: Buffer.alloc(0),
};

let withdrawableAssetsInFlight:
  | { stamp: number; sentAt: number; read: Promise<string> }
  | undefined;

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

function associatedTokenAddress(owner: PublicKey, mint: PublicKey): PublicKey {
  return PublicKey.findProgramAddressSync(
    [owner.toBuffer(), TOKEN_PROGRAM.toBuffer(), mint.toBuffer()],
    new PublicKey(ATA_PROGRAM)
  )[0];
}

/** The SDK's reads of the two pinned mints are answered from constants. Everything else is live. */
function withPinnedMintOwners(connection: Connection): Connection {
  return new Proxy(connection, {
    get(target, property, receiver) {
      if (property !== "getAccountInfo") return Reflect.get(target, property, receiver);
      return async (address: PublicKey, config?: Commitment | GetAccountInfoConfig) => {
        if (address.equals(ASSET_MINT) || address.equals(SHARE_MINT)) return PINNED_MINT;
        return target.getAccountInfo(address, config);
      };
    },
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

function readU64Atoms(field: string, value: unknown): BN {
  if (typeof value !== "string" || value.length === 0 || value.length > 20) {
    throw new SdpJupiterLendError(
      "VAULT_UNREADABLE",
      `Jupiter Lend returned an unreadable ${field}`
    );
  }
  let atoms: BN;
  try {
    atoms = new BN(value, 10);
  } catch {
    throw new SdpJupiterLendError(
      "VAULT_UNREADABLE",
      `Jupiter Lend returned an unreadable ${field}`
    );
  }
  if (atoms.isNeg() || atoms.gt(U64_MAX) || atoms.toString(10) !== value) {
    throw new SdpJupiterLendError(
      "VAULT_UNREADABLE",
      `Jupiter Lend returned an unreadable ${field}`
    );
  }
  return atoms;
}

export class JupiterLendVaultDirectClient
  extends JupiterLendEarnClient
  implements
    EarnVaultWithdrawProvider,
    EarnVaultDepositQuoteProvider,
    EarnVaultWithdrawQuoteProvider
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
      return operation(jupiterLendConnection(rpcUrl), assertActive);
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

  private async lendingTokenDetails(connection: Connection) {
    const details = await getLendingTokenDetails({
      lendingToken: new PublicKey(JUPITER_LEND_USDT.shareMint),
      connection,
      market: "main",
    });
    if (
      details.address.toBase58() !== JUPITER_LEND_USDT.shareMint ||
      details.asset.toBase58() !== JUPITER_LEND_USDT.assetMint ||
      details.decimals !== JUPITER_LEND_USDT.decimals ||
      details.convertToShares.lten(0) ||
      details.convertToAssets.lten(0)
    ) {
      throw new SdpJupiterLendError(
        "PROGRAM_MISMATCH",
        "Jupiter Lend returned accounting outside SDP's admitted USDT market"
      );
    }
    return details;
  }

  private async withdrawalAccounting(connection: Connection) {
    const [details, withdrawableAssetsRaw] = await Promise.all([
      this.lendingTokenDetails(connection),
      this.readUsdtWithdrawableAssets(),
    ]);
    const withdrawableAssets = readU64Atoms("USDT withdrawal liquidity", withdrawableAssetsRaw);
    const scale = new BN(10).pow(new BN(details.decimals));
    // `withdrawable` is denominated in underlying atoms. Divide by the live
    // assets-per-share rate, rounding DOWN, so this cap never advertises more
    // shares than the same accounting says Jupiter can pay immediately.
    const withdrawableShares = withdrawableAssets.mul(scale).div(details.convertToAssets);
    return { details, scale, withdrawableAssets, withdrawableShares };
  }

  /**
   * Concurrent reads share one in-flight catalogue request, but only one
   * `canJoinJupiterLendRead` admits: never sent before the caller's read floor,
   * never sent a join window or more ago.
   */
  protected override readUsdtWithdrawableAssets(): Promise<string> {
    const inFlight = withdrawableAssetsInFlight;
    if (inFlight && canJoinJupiterLendRead(inFlight)) return inFlight.read;
    const entry = {
      stamp: readStamp(),
      sentAt: Date.now(),
      read: super.readUsdtWithdrawableAssets(),
    };
    const forget = () => {
      if (withdrawableAssetsInFlight === entry) withdrawableAssetsInFlight = undefined;
    };
    entry.read.then(forget, forget);
    withdrawableAssetsInFlight = entry;
    return entry.read;
  }

  /**
   * The atoms in the owner's jlUSDT ATA from the account's own bytes, or null
   * when the account is confirmed missing. Reads what `getTokenAccountBalance`
   * reads, including an ATA whose token owner was reassigned. Anything else at
   * that address (lamports sent to it, say) fails the read, never reads zero.
   */
  private async shareBalance(connection: Connection, owner: PublicKey): Promise<BN | null> {
    const account = await connection.getAccountInfo(associatedTokenAddress(owner, SHARE_MINT));
    if (account === null) return null;
    const { data } = account;
    const state = data[108];
    if (
      !account.owner.equals(TOKEN_PROGRAM) ||
      data.length !== TOKEN_ACCOUNT_SIZE ||
      !data.subarray(0, 32).equals(SHARE_MINT.toBuffer()) ||
      (state !== 1 && state !== 2)
    ) {
      throw new Error("The owner's jlUSDT address does not hold a jlUSDT token account");
    }
    return new BN(data.readBigUInt64LE(64).toString());
  }

  async quoteVaultDeposit(
    ctx: EarnRuntimeContext,
    input: EarnVaultDepositQuoteInput
  ): Promise<EarnVaultDepositQuote> {
    this.asset(input.providerReference);
    const amount = toAtoms("amount", input.amount, JUPITER_LEND_USDT.decimals);

    try {
      return await this.withConnection(
        ctx,
        "Quoting the Jupiter Lend deposit",
        async (connection) => {
          const details = await this.lendingTokenDetails(connection);
          const scale = new BN(10).pow(new BN(details.decimals));
          const sharesOut = amount.mul(details.convertToShares).div(scale);
          if (sharesOut.isZero()) {
            throw new SdpJupiterLendError(
              "INVALID_AMOUNT",
              "Jupiter Lend deposit amount is too small to mint one share atom"
            );
          }
          return {
            sharesOut: fromAtoms(sharesOut, details.decimals),
            shareDecimals: details.decimals,
            blockingIssues: [],
          };
        }
      );
    } catch (error) {
      if (error instanceof SdpJupiterLendError) throw error;
      throw new SdpJupiterLendError(
        "VAULT_UNREADABLE",
        "Could not quote the Jupiter Lend USDT deposit",
        { cause: error }
      );
    }
  }

  async buildVaultDeposit(
    ctx: EarnRuntimeContext,
    input: EarnVaultDepositInput
  ): Promise<EarnVaultTransactionPlan> {
    if (input.minSharesOut === undefined) {
      throw new SdpJupiterLendError(
        "INVALID_AMOUNT",
        "Jupiter Lend deposits require minSharesOut: SDP will not choose a slippage floor on the caller's behalf."
      );
    }
    const asset = this.asset(input.providerReference);
    const owner = publicKey("owner", input.owner);
    const rentPayer = publicKey("rentPayer", input.rentPayer ?? input.owner);
    const amount = toAtoms("amount", input.amount, JUPITER_LEND_USDT.decimals);
    const minSharesOut = toAtoms("minSharesOut", input.minSharesOut, JUPITER_LEND_USDT.decimals);

    try {
      return await this.withConnection(
        ctx,
        "Building the Jupiter Lend deposit",
        async (connection, assertActive) => {
          const sdkConnection = withPinnedMintOwners(connection);
          const context = await getDepositContext({
            asset,
            signer: owner,
            connection: sdkConnection,
            market: "main",
          });
          this.assertShareMint(context.fTokenMint);
          const ataIxs = await getOrCreateATAInstruction(owner, context.fTokenMint, sdkConnection);
          const createsShareAccount = ataIxs.length > 0;
          assertActive();
          // `getDepositIxs` still emits the legacy unbounded `deposit(assets)`
          // instruction. Build through the same SDK's current IDL so the floor
          // is checked atomically by Jupiter, not merely before submission.
          const depositIx = await getLendingProgram({
            connection,
            market: "main",
            signer: owner,
          })
            .methods.depositWithMinAmountOut(amount, minSharesOut)
            .accounts(context)
            .instruction();
          assertActive();
          return assertJupiterLendPlanPrograms({
            cluster: "mainnet-beta",
            instructions: [...ataIxs, depositIx]
              .map((ix) => rewriteAtaPayer(ix, owner, rentPayer))
              .map(toEarnInstruction),
            lookupTables: [],
            assetIdentity: {
              depositTokenMint: asset.toBase58(),
              shareMint: context.fTokenMint.toBase58(),
            },
            accepted: {
              amount: fromAtoms(amount, JUPITER_LEND_USDT.decimals),
              minSharesOut: fromAtoms(minSharesOut, JUPITER_LEND_USDT.decimals),
            },
            createsShareAccount,
          });
        }
      );
    } catch (error) {
      if (error instanceof SdpJupiterLendError) throw error;
      throw new SdpJupiterLendError(
        "VAULT_UNREADABLE",
        "Could not build the Jupiter Lend USDT deposit",
        { cause: error }
      );
    }
  }

  async buildVaultWithdrawal(
    ctx: EarnRuntimeContext,
    input: EarnVaultWithdrawInput
  ): Promise<EarnVaultTransactionPlan> {
    if (input.minAmountOut === undefined) {
      throw new SdpJupiterLendError(
        "INVALID_AMOUNT",
        "Jupiter Lend withdrawals require minAmountOut: SDP will not choose a slippage floor on the caller's behalf."
      );
    }
    const asset = this.asset(input.providerReference);
    const owner = publicKey("owner", input.owner);
    const rentPayer = publicKey("rentPayer", input.rentPayer ?? input.owner);
    const shares = toAtoms("shares", input.shares, JUPITER_LEND_USDT.decimals);
    const minAmountOut = toAtoms("minAmountOut", input.minAmountOut, JUPITER_LEND_USDT.decimals);

    try {
      return await this.withConnection(
        ctx,
        "Building the Jupiter Lend withdrawal",
        async (connection, assertActive) => {
          const sdkConnection = withPinnedMintOwners(connection);
          const context = await getWithdrawContext({
            asset,
            signer: owner,
            connection: sdkConnection,
            market: "main",
          });
          this.assertShareMint(context.fTokenMint);
          const ataIxs = await getOrCreateATAInstruction(owner, asset, sdkConnection);
          assertActive();
          // `getRedeemIxs` has the same legacy behavior on exits. The guarded
          // instruction compares the actual assets returned with this exact
          // caller-selected floor inside the transaction.
          const redeemIx = await getLendingProgram({
            connection,
            market: "main",
            signer: owner,
          })
            .methods.redeemWithMinAmountOut(shares, minAmountOut)
            .accounts(context)
            .instruction();
          assertActive();
          return assertJupiterLendPlanPrograms({
            cluster: "mainnet-beta",
            instructions: [...ataIxs, redeemIx]
              .map((ix) => rewriteAtaPayer(ix, owner, rentPayer))
              .map(toEarnInstruction),
            lookupTables: [],
            assetIdentity: {
              depositTokenMint: asset.toBase58(),
              shareMint: context.fTokenMint.toBase58(),
            },
            accepted: {
              shares: fromAtoms(shares, JUPITER_LEND_USDT.decimals),
              minAmountOut: fromAtoms(minAmountOut, JUPITER_LEND_USDT.decimals),
            },
          });
        }
      );
    } catch (error) {
      if (error instanceof SdpJupiterLendError) throw error;
      throw new SdpJupiterLendError(
        "VAULT_UNREADABLE",
        "Could not build the Jupiter Lend USDT withdrawal",
        { cause: error }
      );
    }
  }

  async quoteVaultWithdrawal(
    ctx: EarnRuntimeContext,
    input: EarnVaultWithdrawQuoteInput
  ): Promise<EarnVaultWithdrawQuote> {
    this.asset(input.providerReference);
    const shares = toAtoms("shares", input.shares, JUPITER_LEND_USDT.decimals);

    try {
      return await this.withConnection(
        ctx,
        "Quoting the Jupiter Lend withdrawal",
        async (connection) => {
          const { details, scale, withdrawableShares } =
            await this.withdrawalAccounting(connection);
          const assetsOut = shares.mul(details.convertToAssets).div(scale);
          if (assetsOut.isZero()) {
            throw new SdpJupiterLendError(
              "INVALID_AMOUNT",
              "Jupiter Lend share amount is too small to redeem one asset atom"
            );
          }
          return {
            assetsOut: fromAtoms(assetsOut, details.decimals),
            assetDecimals: details.decimals,
            blockingIssues: shares.gt(withdrawableShares)
              ? [
                  {
                    code: "INSUFFICIENT_WITHDRAWAL_LIQUIDITY",
                    message:
                      "The requested shares exceed Jupiter Lend's current immediately withdrawable USDT liquidity.",
                  },
                ]
              : [],
          };
        }
      );
    } catch (error) {
      if (error instanceof SdpJupiterLendError) throw error;
      throw new SdpJupiterLendError(
        "VAULT_UNREADABLE",
        "Could not quote the Jupiter Lend USDT withdrawal",
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
    return this.withConnection(
      ctx,
      "Reading the Jupiter Lend position",
      async (connection, assertActive) => {
        try {
          this.assertShareMint(DERIVED_SHARE_MINT);
          const shareAtoms = await this.shareBalance(connection, owner);
          assertActive();
          // A missing ATA is a confirmed zero. For full-shelf discovery that is
          // not a holding; an exact requested-vault read still returns the
          // truthful zero snapshot.
          if (shareAtoms === null || shareAtoms.isZero()) {
            if (input.providerReferences.length === 0) return [];
            return [
              {
                providerReference: JUPITER_LEND_USDT.assetMint,
                owner: owner.toBase58(),
                cluster: "mainnet-beta",
                shares: "0",
                withdrawableShares: "0",
                tokenValue: "0",
                tokenMint: JUPITER_LEND_USDT.assetMint,
                shareMint: JUPITER_LEND_USDT.shareMint,
              },
            ];
          }
          const { details, scale, withdrawableShares } =
            await this.withdrawalAccounting(connection);
          assertActive();
          const shares = fromAtoms(shareAtoms, JUPITER_LEND_USDT.decimals);
          const immediatelyWithdrawable = shareAtoms.lt(withdrawableShares)
            ? shareAtoms
            : withdrawableShares;
          const tokenValue = shareAtoms.mul(details.convertToAssets).div(scale);
          return [
            {
              providerReference: JUPITER_LEND_USDT.assetMint,
              owner: owner.toBase58(),
              cluster: "mainnet-beta",
              shares,
              withdrawableShares: fromAtoms(immediatelyWithdrawable, JUPITER_LEND_USDT.decimals),
              tokenValue: fromAtoms(tokenValue, JUPITER_LEND_USDT.decimals),
              tokenMint: JUPITER_LEND_USDT.assetMint,
              shareMint: JUPITER_LEND_USDT.shareMint,
            },
          ];
        } catch (error) {
          if (error instanceof SdpJupiterLendError) throw error;
          throw new SdpJupiterLendError(
            "VAULT_UNREADABLE",
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
