/**
 * Mosaic Service
 *
 * Template-based token issuance using @solana/mosaic-sdk.
 * Replaces manual Token-2022 transaction building with Mosaic's
 * pre-configured templates and ABL integration.
 *
 * The SDK handles:
 * - Token-2022 extension configuration per template
 * - sRFC-37 Token ACL setup (freeze authority delegation)
 * - ABL (Allowlist/Blocklist) on-chain gating
 * - Decimal-aware amount conversion for minting
 */

import {
  type Address,
  appendTransactionMessageInstructions,
  compileTransaction,
  createNoopSigner,
  createTransactionMessage,
  fetchEncodedAccount,
  generateKeyPairSigner,
  getBase64EncodedWireTransaction,
  getTransactionEncoder,
  pipe,
  type Rpc,
  type SolanaRpcApi,
  setTransactionMessageFeePayerSigner,
  setTransactionMessageLifetimeUsingBlockhash,
  signTransactionMessageWithSigners,
  type TransactionSigner,
} from "@solana/kit";
import {
  createArcadeTokenInitTransaction,
  // Template builders
  createCustomTokenInitTransaction,
  createForceBurnTransaction,
  createForceTransferTransaction,
  // Token operations
  createMintToTransaction,
  createPauseTransaction,
  createResumeTransaction,
  createStablecoinInitTransaction,
  createTokenizedSecurityInitTransaction,
  createTransferTransaction,
  // Types
  type FullTransaction,
  // ABL wallet management (object input pattern)
  getAddWalletTransaction,
  // Token ACL freeze/thaw (object input pattern)
  getFreezeTransaction,
  getListConfigPda,
  getRemoveAuthorityTransaction,
  getRemoveWalletTransaction,
  getThawPermissionlessTransaction,
  getThawTransaction,
  getTokenMetadata,
  getUpdateAuthorityTransaction,
  resolveTokenAccount,
} from "@solana/mosaic-sdk";
import { partiallySignTransactionMessageWithSigners } from "@solana/signers";
import { findWalletEntryPda } from "@solana/token-acl-gate-sdk";
import { getTransferSolInstruction } from "@solana-program/system";
import {
  decodeMint,
  getMintSize,
  getUpdateTokenMetadataFieldInstruction,
  TOKEN_2022_PROGRAM_ADDRESS,
} from "@solana-program/token-2022";
import { parseDecimalAmount } from "@/lib/amount";
import type { FeePaymentPort } from "@/services/ports/fee-payment.port";
import { confirmTransaction, createRpcForSdk } from "@/services/solana/rpc";
import type { Env } from "@/types/env";
import {
  type AblWalletOptions,
  type CreateTokenOptions,
  DEFAULT_ACL_MODE,
  type ExecuteTransferOptions,
  type FreezeThawOptions,
  type MintToOptions,
  type MosaicTransaction,
  type MosaicTransactionResult,
  TEMPLATE_MAP,
  type TransferOptions,
  type UpdateMetadataOptions,
} from "./types";
import { safeStringify } from "./utils";

// ═══════════════════════════════════════════════════════════════════════════
// Mosaic Service
// ═══════════════════════════════════════════════════════════════════════════

type MosaicSdkRpc = Parameters<typeof resolveTokenAccount>[0];

/**
 * Resolve the mint authority's address from create options, which accepts
 * either a raw address (prepare/client-signing mode) or a TransactionSigner.
 */
function resolveMintAuthorityAddress(options: CreateTokenOptions): Address {
  return typeof options.mintAuthority === "string"
    ? (options.mintAuthority as Address)
    : (options.mintAuthority.address as Address);
}

export class MosaicService {
  private env: Env;
  private signer: TransactionSigner;
  private feePayment?: FeePaymentPort;
  private rpc: Rpc<SolanaRpcApi> & MosaicSdkRpc;

  constructor(env: Env, signer: TransactionSigner, feePayment?: FeePaymentPort) {
    this.env = env;
    this.signer = signer;
    this.feePayment = feePayment;
    this.rpc = createRpcForSdk<MosaicSdkRpc>(env);
  }

  private isRetryableRpcError(error: unknown): boolean {
    if (!(error instanceof Error)) {
      return false;
    }

    return (
      /HTTP error \((429|5\d\d)\)/i.test(error.message) ||
      /fetch failed/i.test(error.message) ||
      /timed out/i.test(error.message)
    );
  }

  private async withRpcRetry<T>(operation: () => Promise<T>): Promise<T> {
    const retryDelaysMs = [250, 750];
    let lastError: unknown;

    for (let attempt = 0; attempt <= retryDelaysMs.length; attempt += 1) {
      try {
        return await operation();
      } catch (error) {
        lastError = error;
        if (attempt === retryDelaysMs.length || !this.isRetryableRpcError(error)) {
          throw error;
        }

        await new Promise((resolve) => setTimeout(resolve, retryDelaysMs[attempt]));
      }
    }

    throw lastError instanceof Error ? lastError : new Error("RPC operation failed");
  }

  // ═════════════════════════════════════════════════════════════════════════
  // Token Creation (Templates)
  // ═════════════════════════════════════════════════════════════════════════

  /**
   * Create a token using Mosaic templates.
   *
   * Templates configure Token-2022 extensions automatically:
   * - stablecoin: metadata, pausable, default-account-state, confidential-balances, permanent-delegate
   * - arcade: metadata, pausable, default-account-state, permanent-delegate (allowlist-only)
   * - tokenized-security: same as stablecoin + scaled-ui-amount
   */
  async createToken(options: CreateTokenOptions): Promise<MosaicTransactionResult> {
    const mosaicTemplate = TEMPLATE_MAP[options.template];

    // Generate a new mint keypair - Mosaic templates require a signer
    const mintKeypair = await generateKeyPairSigner();
    const mint = mintKeypair.address;

    // Determine ACL mode and sRFC-37 enablement
    const aclMode = options.aclMode ?? DEFAULT_ACL_MODE[mosaicTemplate];
    const requestedSrfc37 = options.enableTokenAcl ?? options.enableAbl ?? false;
    const enableSrfc37 = requestedSrfc37 && options.freezeAuthority !== null;

    const fullTx = await this.buildCreateTokenTransaction(
      mosaicTemplate,
      options,
      mintKeypair,
      aclMode,
      enableSrfc37
    );

    // Both plain and sRFC-37 deploys go through Kora when configured. The
    // patched mosaic-sdk templates emit the on-chain Token-ACL/ABL setup with a
    // payer (Kora) distinct from the authority (custody), so we no longer bypass
    // fee payment to keep mintAuthority === feePayer.
    const result = await this.signAndSubmitWithMintKeypair(fullTx, mintKeypair);

    let listAddress: Address | undefined;
    if (enableSrfc37) {
      // The patched mosaic-sdk seeds the ABL list-config PDA from the mint
      // authority (custody), not the fee payer. Derive the list address from
      // that same authority so it matches on-chain — `this.signer` is equal to
      // it in production, but the SDK contract is the mint authority.
      listAddress = await getListConfigPda({
        authority: resolveMintAuthorityAddress(options),
        mint,
      });
    }

    return {
      ...result,
      mint,
      listAddress,
    };
  }

  /**
   * Prepare a token creation transaction (unsigned) for client signing.
   */
  async prepareCreateToken(options: CreateTokenOptions): Promise<MosaicTransaction> {
    const mosaicTemplate = TEMPLATE_MAP[options.template];

    const mintKeypair = await generateKeyPairSigner();
    const mint = mintKeypair.address;

    const aclMode = options.aclMode ?? DEFAULT_ACL_MODE[mosaicTemplate];
    const requestedSrfc37 = options.enableTokenAcl ?? options.enableAbl ?? false;
    const enableSrfc37 = requestedSrfc37 && options.freezeAuthority !== null;

    const fullTx = await this.buildCreateTokenTransaction(
      mosaicTemplate,
      options,
      mintKeypair,
      aclMode,
      enableSrfc37,
      // Client-signed: the caller submits this transaction themselves, so it
      // must use options.feePayer — they cannot produce a Kora signature.
      true
    );

    return this.toMosaicTransaction(fullTx, mint);
  }

  private async buildCreateTokenTransaction(
    template: string,
    options: CreateTokenOptions,
    mintKeypair: TransactionSigner,
    aclMode: "allowlist" | "blocklist",
    enableSrfc37: boolean,
    forClientSigning = false
  ): Promise<FullTransaction> {
    // Resolve fee payer - use Kora if available, otherwise from options. This
    // applies to sRFC-37 deploys too: the patched mosaic-sdk templates fund the
    // on-chain ABL/TACL setup from the fee payer (Kora) while keeping the mint
    // authority (custody) as the on-chain authority, so the two can differ.
    //
    // The Kora substitution only holds when the service submits the transaction
    // itself (createToken). For client-signed transactions (prepareCreateToken)
    // the caller cannot sign as Kora, so we must respect options.feePayer.
    const feePayer =
      this.feePayment && !forClientSigning ? await this.feePayment.getFeePayer() : options.feePayer;
    const mintAuthority =
      typeof options.mintAuthority === "string" && options.mintAuthority === this.signer.address
        ? this.signer
        : options.mintAuthority;
    const mintAuthorityAddress = resolveMintAuthorityAddress(options);

    const freezeAuthority = options.freezeAuthority ?? undefined;
    const permanentDelegateAuthority =
      typeof options.extensions?.permanentDelegate === "string"
        ? (options.extensions.permanentDelegate as Address)
        : undefined;
    const pausableAuthority = options.extensions?.pausable?.authority as Address | undefined;
    const scaledUiAmount = options.extensions?.scaledUiAmount;
    const transferHook = options.extensions?.transferHook;

    switch (template) {
      case "stablecoin":
        // Stablecoin: full compliance features with blocklist default
        // Signature: (rpc, name, symbol, decimals, uri, mintAuthority, mint, feePayer,
        //            aclMode?, metadataAuth?, pausableAuth?, confidentialAuth?, delegateAuth?,
        //            enableSrfc37?, freezeAuthority?)
        return createStablecoinInitTransaction(
          this.rpc,
          options.metadata.name,
          options.metadata.symbol,
          options.decimals,
          options.metadata.uri,
          mintAuthority,
          mintKeypair,
          feePayer,
          aclMode,
          mintAuthorityAddress, // metadataAuthority
          pausableAuthority ?? mintAuthorityAddress, // pausableAuthority
          mintAuthorityAddress, // confidentialBalancesAuthority
          permanentDelegateAuthority ?? mintAuthorityAddress, // permanentDelegateAuthority
          enableSrfc37,
          freezeAuthority
        );

      case "arcade":
        // Arcade: closed-loop gaming tokens (always allowlist)
        // Note: No aclMode parameter - arcade is always allowlist
        // Signature: (rpc, name, symbol, decimals, uri, mintAuthority, mint, feePayer,
        //            metadataAuth?, pausableAuth?, delegateAuth?, enableSrfc37?, freezeAuthority?)
        return createArcadeTokenInitTransaction(
          this.rpc,
          options.metadata.name,
          options.metadata.symbol,
          options.decimals,
          options.metadata.uri,
          mintAuthority,
          mintKeypair,
          feePayer,
          mintAuthorityAddress, // metadataAuthority
          pausableAuthority ?? mintAuthorityAddress, // pausableAuthority
          permanentDelegateAuthority ?? mintAuthorityAddress, // permanentDelegateAuthority
          enableSrfc37,
          freezeAuthority
        );

      case "tokenized-security":
        // Tokenized Security: stablecoin features + scaled UI amount
        // Uses options object for optional parameters
        return createTokenizedSecurityInitTransaction(
          this.rpc,
          options.metadata.name,
          options.metadata.symbol,
          options.decimals,
          options.metadata.uri,
          mintAuthority,
          mintKeypair,
          feePayer,
          freezeAuthority,
          {
            aclMode,
            metadataAuthority: mintAuthorityAddress,
            pausableAuthority: pausableAuthority ?? mintAuthorityAddress,
            confidentialBalancesAuthority: mintAuthorityAddress,
            permanentDelegateAuthority: permanentDelegateAuthority ?? mintAuthorityAddress,
            enableSrfc37,
            scaledUiAmount: scaledUiAmount
              ? {
                  authority:
                    (scaledUiAmount.authority as Address | undefined) ?? mintAuthorityAddress,
                  multiplier: scaledUiAmount.multiplier,
                  newMultiplier: scaledUiAmount.newMultiplier,
                  newMultiplierEffectiveTimestamp:
                    scaledUiAmount.newMultiplierEffectiveTimestamp ?? undefined,
                }
              : undefined,
          }
        );

      case "custom": {
        const extensions = options.extensions ?? {};
        const transferFee = extensions.transferFee;
        const interestBearing = extensions.interestBearing;
        const defaultAccountState = extensions.defaultAccountState;
        const transferFeeMaximum = transferFee
          ? parseDecimalAmount(transferFee.maxFee, options.decimals)
          : undefined;
        return createCustomTokenInitTransaction(
          this.rpc,
          options.metadata.name,
          options.metadata.symbol,
          options.decimals,
          options.metadata.uri,
          mintAuthority,
          mintKeypair,
          feePayer,
          {
            enableSrfc37,
            aclMode,
            enableDefaultAccountState: !!defaultAccountState,
            defaultAccountStateInitialized:
              defaultAccountState !== undefined ? defaultAccountState !== "frozen" : undefined,
            enablePermanentDelegate: !!extensions.permanentDelegate,
            permanentDelegateAuthority,
            enablePausable: !!extensions.pausable,
            pausableAuthority: pausableAuthority,
            enableTransferFee: !!transferFee,
            transferFeeAuthority: transferFee?.transferFeeConfigAuthority as Address | undefined,
            withdrawWithheldAuthority: transferFee?.withdrawWithheldAuthority as
              | Address
              | undefined,
            transferFeeBasisPoints: transferFee?.basisPoints,
            transferFeeMaximum,
            enableInterestBearing: !!interestBearing,
            interestBearingAuthority: interestBearing?.rateAuthority as Address | undefined,
            interestRate: interestBearing?.rate,
            enableNonTransferable: extensions.nonTransferable === true,
            enableScaledUiAmount: !!scaledUiAmount,
            scaledUiAmountAuthority: scaledUiAmount?.authority as Address | undefined,
            scaledUiAmountMultiplier: scaledUiAmount?.multiplier,
            scaledUiAmountNewMultiplier: scaledUiAmount?.newMultiplier,
            scaledUiAmountNewMultiplierEffectiveTimestamp:
              scaledUiAmount?.newMultiplierEffectiveTimestamp,
            enableTransferHook: !!transferHook,
            transferHookAuthority: transferHook?.authority as Address | undefined,
            transferHookProgramId: transferHook?.programId as Address | undefined,
            freezeAuthority,
          }
        );
      }

      default:
        throw new Error(`Unsupported template: ${template}`);
    }
  }

  // ═════════════════════════════════════════════════════════════════════════
  // Token Operations
  // ═════════════════════════════════════════════════════════════════════════

  /**
   * Mint tokens to a destination address.
   *
   * The SDK handles:
   * - Creating ATA if needed (idempotent)
   * - Permissionless thaw for sRFC-37 tokens (if account is frozen)
   * - Decimal conversion (amount is decimal, e.g., 100 for 100 tokens)
   */
  async mintTo(options: MintToOptions): Promise<MosaicTransactionResult> {
    const fallbackFeePayer =
      options.feePayer === this.signer.address ? this.signer : options.feePayer;
    const feePayer = await this.resolveFeePayer(fallbackFeePayer);

    // SDK signature: (rpc, mint, recipient, amount, mintAuthority, feePayer)
    // Note: amount is decimal number, SDK converts using mint decimals
    const fullTx = await createMintToTransaction(
      this.rpc,
      options.mint,
      options.destination,
      options.amount,
      this.signer, // mintAuthority as TransactionSigner
      feePayer
    );

    const tokenAccountInfo = await resolveTokenAccount(this.rpc, options.destination, options.mint);
    const result = await this.signAndSubmit(fullTx);

    return {
      ...result,
      tokenAccount: tokenAccountInfo.tokenAccount,
    };
  }

  /**
   * Prepare a mint transaction (unsigned) for client signing.
   */
  async prepareMintTo(
    options: MintToOptions
  ): Promise<MosaicTransaction & { tokenAccount: Address }> {
    const fallbackFeePayer =
      options.feePayer === this.signer.address ? this.signer : options.feePayer;
    const feePayer = await this.resolveFeePayer(fallbackFeePayer);

    const fullTx = await createMintToTransaction(
      this.rpc,
      options.mint,
      options.destination,
      options.amount,
      options.mintAuthority, // Just the address for prepare mode
      feePayer
    );

    const tokenAccountInfo = await resolveTokenAccount(this.rpc, options.destination, options.mint);

    return {
      ...this.toMosaicTransaction(fullTx),
      tokenAccount: tokenAccountInfo.tokenAccount,
    };
  }

  /**
   * Prepare a Token-2022 transfer transaction (unsigned) for client signing.
   */
  async prepareTransfer(options: TransferOptions): Promise<MosaicTransaction> {
    const feePayer = await this.resolveFeePayer(options.feePayer);

    const fullTx = await createTransferTransaction({
      rpc: this.rpc,
      mint: options.mint,
      from: options.from,
      to: options.to,
      authority: options.authority,
      feePayer,
      amount: options.amount,
      memo: options.memo,
    });

    return this.toMosaicTransaction(fullTx);
  }

  /**
   * Execute a Token-2022 transfer transaction with custody signing.
   */
  async transfer(options: ExecuteTransferOptions): Promise<MosaicTransactionResult> {
    const feePayer = await this.resolveFeePayerSigner(options.feePayer);

    const fullTx = await createTransferTransaction({
      rpc: this.rpc,
      mint: options.mint,
      from: options.from,
      to: options.to,
      authority: options.authority,
      feePayer,
      amount: options.amount,
      memo: options.memo,
    });

    return this.signAndSubmit(fullTx);
  }

  // ═════════════════════════════════════════════════════════════════════════
  // ABL (Allowlist/Blocklist) Operations
  // ═════════════════════════════════════════════════════════════════════════

  /**
   * Add a wallet to the token's ABL list.
   *
   * For allowlist tokens: allows wallet to receive/hold tokens
   * For blocklist tokens: blocks wallet from receiving/holding tokens
   */
  async addToList(options: AblWalletOptions): Promise<MosaicTransactionResult> {
    const payer = await this.resolveFeePayerSigner();

    // SDK uses object input pattern for ABL operations
    const fullTx = await getAddWalletTransaction({
      rpc: this.rpc,
      payer, // payer must be a TransactionSigner
      authority: this.signer, // authority as TransactionSigner
      wallet: options.wallet,
      list: options.list,
    });

    return this.signAndSubmit(fullTx);
  }

  /**
   * Check whether a wallet is present on a token's on-chain ABL list.
   *
   * Best-effort/optimistic view at `processed` commitment (which can be rolled
   * back) — not a durable membership check. This is deliberate: it lets a
   * just-submitted add-to-list tx be seen before it confirms, which is what we
   * need when DB mirrors lag behind a pending on-chain tx (e.g. concurrent mint
   * requests). Do not use it where durable membership matters. One RPC.
   */
  async isWalletOnList(list: Address, wallet: Address): Promise<boolean> {
    const [walletEntryPda] = await findWalletEntryPda({ listConfig: list, wallet });
    // `processed` so a just-submitted add-to-list tx is visible before it
    // confirms — this method's whole point is to reflect pending on-chain
    // state during concurrent mints, where `confirmed` returns false negatives.
    const info = await this.rpc.getAccountInfo(walletEntryPda, { commitment: "processed" }).send();
    return info.value !== null;
  }

  /**
   * Remove a wallet from the token's ABL list.
   */
  async removeFromList(options: AblWalletOptions): Promise<MosaicTransactionResult> {
    const payer = await this.resolveFeePayerSigner();

    const fullTx = await getRemoveWalletTransaction({
      rpc: this.rpc,
      payer,
      authority: this.signer,
      wallet: options.wallet,
      list: options.list,
    });

    return this.signAndSubmit(fullTx);
  }

  // ═════════════════════════════════════════════════════════════════════════
  // Token ACL (Freeze/Thaw) Operations
  // ═════════════════════════════════════════════════════════════════════════

  /**
   * Freeze a token account.
   *
   * The SDK automatically detects whether to use:
   * - Token ACL instruction (if freeze authority is Token ACL program)
   * - Standard SPL Token-2022 freeze (if freeze authority is a wallet)
   */
  async freezeAccount(options: FreezeThawOptions): Promise<MosaicTransactionResult> {
    const payer = await this.resolveFeePayerSigner();

    // SDK uses object input pattern - note: NO mint parameter!
    // The SDK fetches mint from the token account
    const fullTx = await getFreezeTransaction({
      rpc: this.rpc,
      payer,
      authority: this.signer,
      tokenAccount: options.tokenAccount,
    });

    return this.signAndSubmit(fullTx);
  }

  /**
   * Thaw a token account (requires freeze authority).
   *
   * The SDK automatically detects whether to use:
   * - Token ACL instruction (if freeze authority is Token ACL program)
   * - Standard SPL Token-2022 thaw (if freeze authority is a wallet)
   */
  async thawAccount(options: FreezeThawOptions): Promise<MosaicTransactionResult> {
    const payer = await this.resolveFeePayerSigner();

    const fullTx = await getThawTransaction({
      rpc: this.rpc,
      payer,
      authority: this.signer,
      tokenAccount: options.tokenAccount,
    });

    return this.signAndSubmit(fullTx);
  }

  /**
   * Permissionless thaw (sRFC-37).
   *
   * Allows thawing without freeze authority signature when:
   * - Token has sRFC-37 enabled (freeze authority = Token ACL program)
   * - Permissionless thaw is enabled for the mint
   * - Wallet is on the allowlist (or not on blocklist)
   */
  async thawPermissionless(
    mint: Address,
    tokenAccount: Address,
    tokenAccountOwner: Address,
    _feePayer: Address // TODO: Use when fee payment abstraction is complete
  ): Promise<MosaicTransactionResult> {
    const payer = await this.resolveFeePayerSigner();

    const fullTx = await getThawPermissionlessTransaction({
      rpc: this.rpc,
      payer,
      authority: this.signer,
      mint,
      tokenAccount,
      tokenAccountOwner,
    });

    return this.signAndSubmit(fullTx);
  }

  // ═════════════════════════════════════════════════════════════════════════
  // Management & Administration Operations
  // ═════════════════════════════════════════════════════════════════════════

  async prepareForceTransfer(options: {
    mint: Address;
    source: Address;
    destination: Address;
    amount: number;
    permanentDelegate: Address;
    feePayer: Address;
  }): Promise<MosaicTransaction> {
    const fullTx = await createForceTransferTransaction(
      this.rpc,
      options.mint,
      options.source,
      options.destination,
      options.amount,
      createNoopSigner(options.permanentDelegate),
      createNoopSigner(options.feePayer)
    );

    return this.toMosaicTransaction(fullTx);
  }

  async forceTransfer(options: {
    mint: Address;
    source: Address;
    destination: Address;
    amount: number;
    permanentDelegate: TransactionSigner;
    feePayer: TransactionSigner;
  }): Promise<MosaicTransactionResult> {
    const feePayer = await this.resolveFeePayerSigner(options.feePayer);

    const fullTx = await createForceTransferTransaction(
      this.rpc,
      options.mint,
      options.source,
      options.destination,
      options.amount,
      options.permanentDelegate,
      feePayer
    );

    return this.signAndSubmit(fullTx);
  }

  async prepareForceBurn(options: {
    mint: Address;
    source: Address;
    amount: number;
    permanentDelegate: Address;
    feePayer: Address;
  }): Promise<MosaicTransaction> {
    const fullTx = await createForceBurnTransaction(
      this.rpc,
      options.mint,
      options.source,
      options.amount,
      createNoopSigner(options.permanentDelegate),
      createNoopSigner(options.feePayer)
    );

    return this.toMosaicTransaction(fullTx);
  }

  async forceBurn(options: {
    mint: Address;
    source: Address;
    amount: number;
    permanentDelegate: TransactionSigner;
    feePayer: TransactionSigner;
  }): Promise<MosaicTransactionResult> {
    const feePayer = await this.resolveFeePayerSigner(options.feePayer);

    const fullTx = await createForceBurnTransaction(
      this.rpc,
      options.mint,
      options.source,
      options.amount,
      options.permanentDelegate,
      feePayer
    );

    return this.signAndSubmit(fullTx);
  }

  async prepareUpdateAuthority(options: {
    mint: Address;
    role: Parameters<typeof getUpdateAuthorityTransaction>[0]["role"];
    currentAuthority: Address;
    newAuthority: Address | null;
    feePayer: Address;
  }): Promise<MosaicTransaction> {
    const payer = createNoopSigner(options.feePayer);
    const currentAuthority = createNoopSigner(options.currentAuthority);

    const fullTx = await this.withRpcRetry(() =>
      options.newAuthority === null
        ? getRemoveAuthorityTransaction({
            rpc: this.rpc,
            payer,
            mint: options.mint,
            role: options.role,
            currentAuthority,
          })
        : getUpdateAuthorityTransaction({
            rpc: this.rpc,
            payer,
            mint: options.mint,
            role: options.role,
            currentAuthority,
            newAuthority: options.newAuthority,
          })
    );

    return this.toMosaicTransaction(fullTx);
  }

  async updateAuthority(options: {
    mint: Address;
    role: Parameters<typeof getUpdateAuthorityTransaction>[0]["role"];
    currentAuthority: TransactionSigner;
    newAuthority: Address | null;
    feePayer: TransactionSigner;
  }): Promise<MosaicTransactionResult> {
    const feePayer = await this.resolveFeePayerSigner(options.feePayer);

    const fullTx = await this.withRpcRetry(() =>
      options.newAuthority === null
        ? getRemoveAuthorityTransaction({
            rpc: this.rpc,
            payer: feePayer,
            mint: options.mint,
            role: options.role,
            currentAuthority: options.currentAuthority,
          })
        : getUpdateAuthorityTransaction({
            rpc: this.rpc,
            payer: feePayer,
            mint: options.mint,
            role: options.role,
            currentAuthority: options.currentAuthority,
            newAuthority: options.newAuthority,
          })
    );

    return this.signAndSubmit(fullTx);
  }

  async updateMetadata(options: UpdateMetadataOptions): Promise<MosaicTransactionResult | null> {
    const feePayer = await this.resolveFeePayerSigner(options.feePayer);
    const encodedMint = await fetchEncodedAccount(this.rpc, options.mint, {
      commitment: "confirmed",
    });

    if (!encodedMint.exists) {
      throw new Error(`Mint account not found at address: ${options.mint}`);
    }

    const decodedMint = decodeMint(encodedMint);
    const currentMetadata = await getTokenMetadata(this.rpc, options.mint, "confirmed");

    if (!currentMetadata) {
      throw new Error("Token metadata extension is not available for this mint");
    }

    const updates: Array<{ field: string; value: string }> = [];

    const maybePushUpdate = (field: string, nextValue: string, currentValue?: string | null) => {
      const normalizedCurrent = currentValue ?? "";
      if (nextValue === normalizedCurrent) {
        return;
      }

      updates.push({ field, value: nextValue });
    };

    if (options.name !== undefined) {
      maybePushUpdate("name", options.name, currentMetadata.name);
    }

    if (options.uri !== undefined) {
      maybePushUpdate("uri", options.uri ?? "", currentMetadata.uri);
    }

    if (options.description !== undefined) {
      maybePushUpdate(
        "description",
        options.description ?? "",
        currentMetadata.additionalMetadata?.get("description")
      );
    }

    if (options.imageUrl !== undefined) {
      maybePushUpdate(
        "image",
        options.imageUrl ?? "",
        currentMetadata.additionalMetadata?.get("image")
      );
    }

    if (updates.length === 0) {
      return null;
    }

    const toMetadataField = (field: string) => {
      switch (field) {
        case "name":
          return { __kind: "Name" } as const;
        case "uri":
          return { __kind: "Uri" } as const;
        default:
          return { __kind: "Key", fields: [field] as const } as const;
      }
    };

    const currentExtensions =
      decodedMint.data.extensions?.__option === "Some" ? decodedMint.data.extensions.value : [];
    const updatedAdditionalMetadata = new Map(currentMetadata.additionalMetadata ?? []);

    if (options.description !== undefined) {
      updatedAdditionalMetadata.set("description", options.description ?? "");
    }

    if (options.imageUrl !== undefined) {
      updatedAdditionalMetadata.set("image", options.imageUrl ?? "");
    }

    const targetExtensions = currentExtensions.map((extension) =>
      extension.__kind === "TokenMetadata"
        ? {
            ...extension,
            name: options.name ?? currentMetadata.name ?? extension.name,
            uri: options.uri ?? currentMetadata.uri ?? extension.uri,
            additionalMetadata: updatedAdditionalMetadata,
          }
        : extension
    );
    const targetMintSize = getMintSize(targetExtensions);
    const currentMintSize = encodedMint.data.length;
    const targetRent = await this.rpc
      .getMinimumBalanceForRentExemption(BigInt(targetMintSize))
      .send();
    const additionalRentLamports =
      targetMintSize > currentMintSize && targetRent > encodedMint.lamports
        ? targetRent - encodedMint.lamports
        : 0n;

    const instructions = [
      ...(additionalRentLamports > 0n
        ? [
            getTransferSolInstruction({
              source: feePayer,
              destination: options.mint,
              amount: additionalRentLamports,
            }),
          ]
        : []),
      ...updates.map((update) =>
        getUpdateTokenMetadataFieldInstruction(
          {
            metadata: options.mint,
            updateAuthority: options.updateAuthority,
            field: toMetadataField(update.field),
            value: update.value,
          },
          { programAddress: TOKEN_2022_PROGRAM_ADDRESS }
        )
      ),
    ];

    const { value: latestBlockhash } = await this.rpc.getLatestBlockhash().send();
    const transactionMessage = pipe(
      createTransactionMessage({ version: 0 }),
      (tx) => setTransactionMessageFeePayerSigner(feePayer, tx),
      (tx) => setTransactionMessageLifetimeUsingBlockhash(latestBlockhash, tx),
      (tx) => appendTransactionMessageInstructions(instructions, tx)
    );

    return this.signAndSubmit(transactionMessage);
  }

  async preparePauseToken(options: {
    mint: Address;
    pauseAuthority: Address;
    feePayer: Address;
  }): Promise<MosaicTransaction> {
    const { transactionMessage } = await createPauseTransaction(this.rpc, {
      mint: options.mint,
      pauseAuthority: createNoopSigner(options.pauseAuthority),
      feePayer: createNoopSigner(options.feePayer),
    });

    return this.toMosaicTransaction(transactionMessage);
  }

  async pauseToken(options: {
    mint: Address;
    pauseAuthority: TransactionSigner;
    feePayer: TransactionSigner;
  }): Promise<MosaicTransactionResult> {
    const feePayer = await this.resolveFeePayerSigner(options.feePayer);

    const { transactionMessage } = await createPauseTransaction(this.rpc, {
      mint: options.mint,
      pauseAuthority: options.pauseAuthority,
      feePayer,
    });

    return this.signAndSubmit(transactionMessage);
  }

  async prepareUnpauseToken(options: {
    mint: Address;
    pauseAuthority: Address;
    feePayer: Address;
  }): Promise<MosaicTransaction> {
    const { transactionMessage } = await createResumeTransaction(this.rpc, {
      mint: options.mint,
      pauseAuthority: createNoopSigner(options.pauseAuthority),
      feePayer: createNoopSigner(options.feePayer),
    });

    return this.toMosaicTransaction(transactionMessage);
  }

  async unpauseToken(options: {
    mint: Address;
    pauseAuthority: TransactionSigner;
    feePayer: TransactionSigner;
  }): Promise<MosaicTransactionResult> {
    const feePayer = await this.resolveFeePayerSigner(options.feePayer);

    const { transactionMessage } = await createResumeTransaction(this.rpc, {
      mint: options.mint,
      pauseAuthority: options.pauseAuthority,
      feePayer,
    });

    return this.signAndSubmit(transactionMessage);
  }

  // ═════════════════════════════════════════════════════════════════════════
  // Custom Token Fallback (uses legacy Token2022Service)
  // ═════════════════════════════════════════════════════════════════════════

  /**
   * Create a custom token with manual extension configuration.
   * Falls back to Token2022Service for full control.
   */
  async createCustomToken(options: CreateTokenOptions): Promise<MosaicTransactionResult> {
    const { Token2022Service } = await import("@/services/solana/token-2022");
    const legacyService = new Token2022Service(this.env, this.signer, this.feePayment);

    const result = await legacyService.createMint({
      metadata: options.metadata,
      decimals: options.decimals,
      mintAuthority: options.mintAuthority,
      freezeAuthority: options.freezeAuthority,
      extensions: options.extensions,
    });

    return {
      signature: result.signature,
      slot: result.slot,
      mint: result.mint,
    };
  }

  // ═════════════════════════════════════════════════════════════════════════
  // Private Helpers
  // ═════════════════════════════════════════════════════════════════════════

  private toMosaicTransaction(fullTx: FullTransaction, mint?: Address): MosaicTransaction {
    // Compile the message so signatures can be applied client-side.
    const compiled = compileTransaction(fullTx);
    const encoded = getBase64EncodedWireTransaction(compiled);
    const lifetimeConstraint = (
      fullTx as { lifetimeConstraint?: { blockhash: string; lastValidBlockHeight: bigint } }
    ).lifetimeConstraint;
    const blockhash = lifetimeConstraint?.blockhash ?? "";
    const lastValidBlockHeight = lifetimeConstraint?.lastValidBlockHeight ?? 0n;

    return {
      serializedTx: encoded,
      blockhash,
      lastValidBlockHeight,
      mint,
      requiredSigners: [],
    };
  }

  private async signAndSubmit(fullTx: FullTransaction): Promise<MosaicTransactionResult> {
    if (this.feePayment) {
      // Two-signer flow: custody signs locally, Kora adds fee payer + submits
      const partiallySignedTx = await partiallySignTransactionMessageWithSigners(fullTx);
      const txEncoder = getTransactionEncoder();
      const txBytes = new Uint8Array(txEncoder.encode(partiallySignedTx));

      const signature = await this.feePayment.signAndSend(txBytes);
      const confirmation = await confirmTransaction(this.rpc, signature);

      if (confirmation.err) {
        throw new Error(`Transaction failed: ${safeStringify(confirmation.err)}`);
      }

      return {
        signature,
        slot: confirmation.slot,
      };
    }

    // No fee sponsor configured: sign and submit directly
    const signedTx = await signTransactionMessageWithSigners(fullTx);
    const encoded = getBase64EncodedWireTransaction(signedTx);

    const signature = await this.rpc
      .sendTransaction(encoded, {
        skipPreflight: false,
        encoding: "base64",
      })
      .send();

    const confirmation = await confirmTransaction(this.rpc, signature);

    if (confirmation.err) {
      throw new Error(`Transaction failed: ${safeStringify(confirmation.err)}`);
    }

    return {
      signature,
      slot: confirmation.slot,
    };
  }

  private async signAndSubmitWithMintKeypair(
    fullTx: FullTransaction,
    _mintKeypair: TransactionSigner
  ): Promise<MosaicTransactionResult> {
    // The mint keypair is already attached as a signer on `fullTx`, so the
    // shared submit path covers both flows: it signs with all attached signers
    // (Kora two-signer path) or signs and sends directly when no sponsor is set.
    return this.signAndSubmit(fullTx);
  }

  private async resolveFeePayer(
    fallback: Address | TransactionSigner
  ): Promise<Address | TransactionSigner> {
    if (!this.feePayment) {
      return fallback;
    }

    const feePayer = await this.feePayment.getFeePayer();
    return createNoopSigner(feePayer);
  }

  private async resolveFeePayerSigner(
    fallback: TransactionSigner = this.signer
  ): Promise<TransactionSigner> {
    if (!this.feePayment) {
      return fallback;
    }

    const feePayer = await this.feePayment.getFeePayer();
    return createNoopSigner(feePayer);
  }
}
