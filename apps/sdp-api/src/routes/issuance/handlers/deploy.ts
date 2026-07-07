import type { TokenResponse } from "@sdp/types";
import type { Address, Signature } from "@solana/kit";
import type { Context } from "hono";
import { z } from "zod";
import { getDb } from "@/db";
import { AppError, badRequest, notFound } from "@/lib/errors";
import { success } from "@/lib/response";
import { resolveApiKeySigningWalletId } from "@/services/api-key-scope.service";
import { AuditService } from "@/services/audit.service";
import {
  createMosaicService,
  deriveAblListAddress,
  MintMetadataUpdateError,
  type MosaicFeePayment,
  PACKET_DATA_SIZE,
} from "@/services/mosaic";
import { createOrgSigner } from "@/services/solana";
import {
  accountExists,
  createRpc,
  getAccountInfo,
  getSignatureStatuses,
  getTransaction,
  type ParsedTransaction,
  simulateTransaction,
} from "@/services/solana/rpc";
import { TokenService } from "@/services/token.service";
import type { Env } from "@/types/env";
import { requireProjectScope } from "../helpers";
import { confirmDeploySchema, deployTokenSchema } from "../schemas";
import { getMosaicAclMode, shouldEnableOnChainAcl } from "./access-control";
import { getInitialPermanentDelegateAuthority } from "./authority-resolution";
import { buildIdempotencyMetadata } from "./idempotency";
import { canonicalMetadataUrl, resolveMetadataOrigin } from "./metadata";

type AppContext = Context<{ Bindings: Env }>;

/**
 * Conservative floor (0.01 SOL) a signing wallet must hold for a wallet-paid
 * deploy: covers mint + ABL account rent and transaction fees with headroom,
 * not an exact quote.
 */
const MIN_WALLET_PAID_DEPLOY_LAMPORTS = 10_000_000n;

/**
 * Ensure the signing wallet holds enough SOL to pay deploy rent and fees
 * itself, so wallet-paid deploys fail with a clear error up front instead of a
 * raw Solana debit failure mid-transaction. A missing account means the wallet
 * has never been funded, i.e. zero balance.
 */
async function assertWalletCanPayDeployFees(env: Env, address: Address): Promise<void> {
  const account = await getAccountInfo(createRpc(env), address);
  const lamports = account === null ? 0n : account.lamports;
  if (lamports < MIN_WALLET_PAID_DEPLOY_LAMPORTS) {
    throw badRequest(
      `Signing wallet ${address} holds ${lamports} lamports but needs at least ` +
        `${MIN_WALLET_PAID_DEPLOY_LAMPORTS} to pay deployment rent and fees from its own SOL`
    );
  }
}

/**
 * Persist a mint that landed on-chain even though its metadata-URI follow-up
 * failed (see MintMetadataUpdateError). Mirrors the deploy success path: records
 * the mint, stamps the initial permanent delegate, and confirms the transaction
 * row. Isolated in its own try/catch so a secondary DB failure is logged rather
 * than escaping and burying the mint address — the caller still throws afterward
 * so the client knows the mint exists and not to redeploy. A swallowed write
 * here just means the mint isn't recorded, which the caller's error reports.
 */
async function persistRecoveredMint(params: {
  tokenService: TokenService;
  txId: string;
  tokenId: string;
  token: NonNullable<Awaited<ReturnType<TokenService["getToken"]>>>;
  custodyAddress: Address;
  aclMode: ReturnType<typeof getMosaicAclMode>;
  feePayment: MosaicFeePayment;
  result: MintMetadataUpdateError["result"];
}): Promise<void> {
  const { tokenService, txId, tokenId, token, custodyAddress, aclMode, feePayment, result } =
    params;
  const { mint, signature, slot, listAddress } = result;
  // The caller only invokes this once it has confirmed the mint landed on-chain;
  // bail defensively (and to narrow the type) if it somehow didn't.
  if (!mint) {
    return;
  }
  const freezeAuthority = token.isFreezable ? custodyAddress : null;
  try {
    await tokenService.setTokenDeployed(
      tokenId,
      mint,
      custodyAddress,
      freezeAuthority,
      listAddress as string | undefined
    );
    // Mirror the success path: stamp the initial permanent delegate into the DB
    // for tokens with that extension. Skipping it would leave `permanentDelegate`
    // null, so later seize/force-transfer ops would target the wrong authority
    // with no recovery short of a manual DB patch.
    const initialPermanentDelegate = getInitialPermanentDelegateAuthority(token, custodyAddress);
    if (initialPermanentDelegate !== undefined) {
      await tokenService.updateTokenAuthorities(tokenId, {
        permanentDelegate: initialPermanentDelegate,
      });
    }
    await tokenService.updateTransaction(txId, {
      status: "confirmed",
      signature,
      slot: Number(slot),
      params: {
        operation: "deploy",
        mintAddress: mint,
        mintAuthority: custodyAddress,
        freezeAuthority,
        ablListAddress: listAddress,
        aclMode,
        feePayment,
        metadataUriFailed: true,
      },
    });
  } catch (persistError) {
    console.error("Failed to persist recovered mint after metadata-URI failure", {
      tokenId,
      mintAddress: mint,
      error: persistError instanceof Error ? persistError.message : String(persistError),
    });
  }
}

/**
 * Record the bookkeeping for a non-custodial deploy that has already landed
 * on-chain — by the time this runs, `setTokenDeployed` has flipped the token to
 * `active` and recorded the mint, which is irreversible. Stamps the initial
 * permanent delegate, writes the transaction row for audit parity with the
 * custodial path, and logs the audit event.
 *
 * Isolated in its own try/catch: a secondary DB failure here must NOT surface as
 * a 500. A retry would hit confirmDeploy's `status !== "pending"` guard and 400
 * permanently, stranding a live token with no transaction/audit row and no
 * recovery. Log and return the best-available token instead. Returns the token
 * with permanent-delegate authorities applied when that write succeeded, else
 * the already-deployed token row.
 */
async function recordConfirmedDeploy(params: {
  c: AppContext;
  tokenService: TokenService;
  organizationId: string;
  initiatedByKeyId: string;
  token: NonNullable<Awaited<ReturnType<TokenService["getToken"]>>>;
  tokenId: string;
  mint: Address;
  custodyAddress: Address;
  freezeAuthority: Address | null;
  listAddress: Address | undefined;
  signature: string;
  slot: number | bigint;
  deployedToken: Awaited<ReturnType<TokenService["setTokenDeployed"]>>;
}): Promise<Awaited<ReturnType<TokenService["setTokenDeployed"]>>> {
  const {
    c,
    tokenService,
    organizationId,
    initiatedByKeyId,
    token,
    tokenId,
    mint,
    custodyAddress,
    freezeAuthority,
    listAddress,
    signature,
    slot,
    deployedToken,
  } = params;
  try {
    const initialPermanentDelegate = getInitialPermanentDelegateAuthority(token, custodyAddress);
    const updatedToken =
      initialPermanentDelegate !== undefined
        ? await tokenService.updateTokenAuthorities(tokenId, {
            permanentDelegate: initialPermanentDelegate,
          })
        : deployedToken;

    // prepareDeploy persists no transaction row, so record one here for history /
    // audit parity with the custodial deploy path.
    const { transaction: tx } = await tokenService.createTransaction({
      tokenId,
      organizationId,
      type: "deploy",
      params: {
        operation: "deploy",
        tokenId,
        template: token.template,
        name: token.name,
        symbol: token.symbol,
      },
      initiatedByKeyId,
    });

    await tokenService.updateTransaction(tx.id, {
      status: "confirmed",
      signature,
      slot: Number(slot),
      params: {
        operation: "deploy",
        mode: "confirm",
        mintAddress: mint,
        mintAuthority: custodyAddress,
        freezeAuthority,
        ablListAddress: listAddress ?? null,
      },
    });

    const auditService = new AuditService(getDb(c.env));
    await auditService.log(c, {
      action: "deploy",
      resourceType: "token",
      resourceId: tokenId,
      metadata: {
        mode: "confirm",
        mintAddress: mint,
        signature,
        slot: slot.toString(),
        template: token.template,
        ablListAddress: listAddress ?? null,
      },
    });

    return updatedToken;
  } catch (bookkeepingError) {
    console.error("confirmDeploy: token is live on-chain but post-deploy bookkeeping failed", {
      tokenId,
      mintAddress: mint,
      error:
        bookkeepingError instanceof Error ? bookkeepingError.message : String(bookkeepingError),
    });
    return deployedToken;
  }
}

export const deployToken = async (c: AppContext) => {
  const { tokenId } = c.req.param();
  const { auth, projectId, orgId } = requireProjectScope(c);
  const body = await c.req.json().catch(() => ({}));
  const parsed = deployTokenSchema.safeParse(body);

  if (!parsed.success) {
    throw badRequest("Invalid request body", {
      errors: z.flattenError(parsed.error).fieldErrors,
    });
  }

  const tokenService = new TokenService(getDb(c.env));
  const token = await tokenService.getToken({
    tokenId,
    organizationId: orgId,
    projectId,
  });

  if (!token) {
    throw notFound("Token");
  }

  // Validate token is in pending status
  if (token.status !== "pending") {
    throw new AppError(
      "BAD_REQUEST",
      "Token has already been deployed or is not in pending status"
    );
  }

  if (token.mintAddress) {
    throw badRequest("Token already has a mint address");
  }

  const { feePayment } = parsed.data;

  const idempotencyMetadata = buildIdempotencyMetadata(c.req.header("Idempotency-Key"), {
    tokenId,
    operation: "deploy",
    mode: "execute",
    params: {
      token: {
        name: token.name,
        symbol: token.symbol,
        template: token.template,
      },
      status: token.status,
      feePayment,
    },
  });

  const { transaction: tx, replayed } = await tokenService.createTransaction({
    tokenId,
    organizationId: auth.organizationId,
    type: "deploy",
    params: {
      operation: "deploy",
      tokenId,
      template: token.template,
      name: token.name,
      symbol: token.symbol,
      feePayment,
    },
    initiatedByKeyId: auth.id,
    idempotencyKey: idempotencyMetadata.idempotencyKey,
    idempotencyFingerprint: idempotencyMetadata.idempotencyFingerprint,
  });

  if (replayed) {
    return success(c, { token });
  }

  const signingWalletId = resolveApiKeySigningWalletId(
    auth,
    parsed.data.signingWalletId ?? token.signingWalletId,
    ["tokens:write"]
  );

  // Deploy using Mosaic templates - handles ABL setup automatically
  const enableAbl = shouldEnableOnChainAcl(token);
  const aclMode = getMosaicAclMode(token);

  // Hoisted so the catch block can persist the mint authority if createToken
  // fails after the mint is already live on-chain (see MintMetadataUpdateError).
  let custodyAddress: Address | undefined;

  try {
    // Get custody signer (resolves via 3-tier: project → org → env fallback)
    const signer = await createOrgSigner(
      c.env,
      auth.organizationId,
      auth.projectId,
      signingWalletId
    );
    custodyAddress = signer.address;

    if (feePayment === "wallet") {
      await assertWalletCanPayDeployFees(c.env, signer.address);
    }

    // Create Mosaic service for template-based token deployment
    const mosaic = createMosaicService(c.env, signer, feePayment);

    const result = await mosaic.createToken({
      template: token.template,
      metadata: {
        name: token.name,
        symbol: token.symbol,
        // Fall back to the SDP-hosted metadata JSON when the issuer didn't
        // supply their own URI (HOO-466). Origin resolves to PUBLIC_API_ORIGIN
        // when set, else the request origin, so the on-chain MetadataPointer
        // points each environment at itself.
        uri:
          token.uri?.trim() ||
          canonicalMetadataUrl(resolveMetadataOrigin(c.env, c.req.url), token.id),
      },
      decimals: token.decimals,
      mintAuthority: signer,
      freezeAuthority: token.isFreezable ? custodyAddress : null,
      feePayer: signer,
      extensions: token.extensions ?? undefined,
      enableAbl,
      aclMode,
    });

    const freezeAuthority = token.isFreezable ? custodyAddress : null;

    // Update token with deployment info (including ABL list if created)
    const deployedToken = await tokenService.setTokenDeployed(
      tokenId,
      result.mint as Address,
      custodyAddress,
      freezeAuthority,
      result.listAddress as Address | undefined
    );

    const initialPermanentDelegate = getInitialPermanentDelegateAuthority(token, custodyAddress);
    const updatedToken =
      initialPermanentDelegate !== undefined
        ? await tokenService.updateTokenAuthorities(tokenId, {
            permanentDelegate: initialPermanentDelegate,
          })
        : deployedToken;

    await tokenService.updateTransaction(tx.id, {
      status: "confirmed",
      signature: result.signature,
      slot: Number(result.slot),
      params: {
        operation: "deploy",
        mintAddress: result.mint,
        mintAuthority: custodyAddress,
        freezeAuthority: token.isFreezable ? custodyAddress : null,
        ablListAddress: result.listAddress,
        aclMode,
        feePayment,
      },
    });

    // Audit log
    const auditService = new AuditService(getDb(c.env));
    await auditService.log(c, {
      action: "deploy",
      resourceType: "token",
      resourceId: tokenId,
      metadata: {
        mintAddress: result.mint,
        signature: result.signature,
        slot: result.slot.toString(),
        template: token.template,
        ablListAddress: result.listAddress,
        aclMode,
        feePayment,
      },
    });

    const response: TokenResponse = { token: updatedToken };
    return success(c, response);
  } catch (error) {
    // The mint was created on-chain but the metadata-URI follow-up failed. The
    // create is irreversible, so record the mint (marking the token active)
    // before surfacing the error — otherwise a retry generates a new keypair
    // and mints a second, orphaned token. The hosted-URI pointer is left unset;
    // it can be fixed later via a metadata update.
    if (error instanceof MintMetadataUpdateError && custodyAddress && error.result.mint) {
      await persistRecoveredMint({
        tokenService,
        txId: tx.id,
        tokenId,
        token,
        custodyAddress,
        aclMode,
        feePayment,
        result: error.result,
      });

      throw new AppError(
        "TRANSACTION_FAILED",
        "Token mint was created on-chain, but setting its metadata URI failed. " +
          "The mint is recorded — do not redeploy; set the metadata URI via a follow-up update.",
        { mintAddress: error.result.mint }
      );
    }

    await tokenService.updateTransaction(tx.id, {
      status: "failed",
      error: error instanceof Error ? error.message : "Unknown error",
    });
    throw error;
  }
};

export const prepareDeploy = async (c: AppContext) => {
  const { tokenId } = c.req.param();
  const { auth, projectId, orgId } = requireProjectScope(c);
  const body = await c.req.json().catch(() => ({}));
  const parsed = deployTokenSchema.safeParse(body);

  if (!parsed.success) {
    throw badRequest("Invalid request body", {
      errors: z.flattenError(parsed.error).fieldErrors,
    });
  }

  const tokenService = new TokenService(getDb(c.env));
  const token = await tokenService.getToken({
    tokenId,
    organizationId: orgId,
    projectId,
  });

  if (!token) {
    throw notFound("Token");
  }

  if (token.status !== "pending") {
    throw new AppError(
      "BAD_REQUEST",
      "Token has already been deployed or is not in pending status"
    );
  }

  if (token.mintAddress) {
    throw badRequest("Token already has a mint address");
  }

  const signingWalletId = resolveApiKeySigningWalletId(
    auth,
    parsed.data.signingWalletId ?? token.signingWalletId,
    ["tokens:write"]
  );

  // Pin the resolved signing wallet on the token so confirmDeploy derives the
  // SAME custody address — and thus the same mint/metadata authorities and ABL
  // list PDA. Without this, a caller that passes a custom signingWalletId here
  // but omits it in confirmDeploy would fall back to a different wallet and
  // silently record wrong authorities. This is the one piece of state prepare
  // must persist; everything else it hands the client to sign.
  if (signingWalletId !== token.signingWalletId) {
    await tokenService.updateToken(tokenId, { signingWalletId });
  }

  // Get custody signer (resolves via 3-tier: project → org → env fallback)
  const signer = await createOrgSigner(c.env, auth.organizationId, auth.projectId, signingWalletId);
  const custodyAddress = signer.address;

  // Create Mosaic service and prepare transaction
  const mosaic = createMosaicService(c.env, signer, "sponsored");

  const enableAbl = shouldEnableOnChainAcl(token);
  const aclMode = getMosaicAclMode(token);

  // See deployToken above: SDP-hosted metadata fallback (HOO-466).
  const resolvedUri =
    token.uri?.trim() || canonicalMetadataUrl(resolveMetadataOrigin(c.env, c.req.url), token.id);

  const buildMetadata = (uri: string) => ({ name: token.name, symbol: token.symbol, uri });
  const prepareOptions = {
    template: token.template,
    decimals: token.decimals,
    mintAuthority: signer,
    freezeAuthority: token.isFreezable ? custodyAddress : null,
    feePayer: signer,
    extensions: token.extensions ?? undefined,
    enableAbl,
    aclMode,
  };

  let prepared = await mosaic.prepareCreateToken({
    ...prepareOptions,
    metadata: buildMetadata(resolvedUri),
  });

  // The client signs and submits this tx itself, so the server can't set the
  // uri afterward (the client owns the update authority). When the inline uri
  // pushes the create tx over the packet limit (heavy template + long hosted
  // URL), re-prepare the create tx with an empty uri and signal that the client
  // must set the real uri in a follow-up tx (POST .../deploy/prepare-metadata)
  // after the create tx confirms. Lighter templates / short URIs keep the
  // single-tx fast path.
  let metadataUriFollowUp: { required: true; uri: string } | undefined;
  if (Buffer.from(prepared.serializedTx, "base64").length > PACKET_DATA_SIZE) {
    prepared = await mosaic.prepareCreateToken({
      ...prepareOptions,
      metadata: buildMetadata(""),
    });
    metadataUriFollowUp = { required: true, uri: resolvedUri };
  }

  const rpc = createRpc(c.env);
  const txBytes = Buffer.from(prepared.serializedTx, "base64");
  const simulation = await simulateTransaction(rpc, txBytes);

  // Audit log
  const auditService = new AuditService(getDb(c.env));
  await auditService.log(c, {
    action: "deploy",
    resourceType: "token",
    resourceId: tokenId,
    metadata: {
      mode: "prepare",
      mint: prepared.mint,
      template: token.template,
      aclMode,
      metadataUriFollowUp: metadataUriFollowUp?.required ?? false,
    },
  });

  return success(c, {
    transaction: {
      serialized: prepared.serializedTx,
      blockhash: prepared.blockhash,
      lastValidBlockHeight: prepared.lastValidBlockHeight.toString(),
    },
    mint: prepared.mint,
    listAddress: prepared.listAddress,
    simulation,
    ...(metadataUriFollowUp ? { metadataUriFollowUp } : {}),
  });
};

// `initializeMint`/`initializeMint2` are the SPL Token / Token-2022 instructions
// that bring a mint account into existence; a tx that creates a mint always
// carries one targeting that mint. jsonParsed decodes both legacy `spl-token`
// and `spl-token-2022` programs under the same instruction `type`.
const MINT_INIT_INSTRUCTION_TYPES = new Set(["initializeMint", "initializeMint2"]);

/**
 * Whether `tx` contains an instruction that initializes `mint` — i.e. the
 * transaction actually created this mint, rather than merely referencing or
 * coexisting with it. Used by `confirmDeploy` to bind a confirmed signature to
 * the mint a caller claims it produced.
 */
const transactionInitializesMint = (tx: ParsedTransaction, mint: Address): boolean =>
  tx.instructions.some(
    (ix) =>
      ix.parsedType !== null &&
      MINT_INIT_INSTRUCTION_TYPES.has(ix.parsedType) &&
      ix.info?.mint === mint
  );

/**
 * Record a confirmed non-custodial deploy.
 *
 * `prepareDeploy` hands the client an unsigned create tx and persists only the
 * resolved signing wallet (so this endpoint can re-derive the same authorities).
 * After the client signs and submits that tx and sees it confirm, it calls THIS
 * endpoint with the create-tx signature and the `mint` it received from
 * `prepareDeploy`. The server verifies the tx landed, that it actually
 * initialized the supplied mint, and that the mint account exists on-chain, then
 * records the mint and flips the token to `active`.
 *
 * This is the step that records `mintAddress` for the non-custodial path — both
 * the single-tx case and the overflow case. It is also what unblocks the
 * `deploy/prepare-metadata` follow-up, whose `mintAddress` guard would otherwise
 * reject every non-custodial caller.
 *
 * Authority fields are recomputed from the signing wallet (never trusted from
 * the request) so a caller can't record a mint under authorities it doesn't
 * control.
 */
export const confirmDeploy = async (c: AppContext) => {
  const { tokenId } = c.req.param();
  const { auth, projectId, orgId } = requireProjectScope(c);
  const body = await c.req.json().catch(() => ({}));
  const parsed = confirmDeploySchema.safeParse(body);

  if (!parsed.success) {
    throw badRequest("Invalid request body", {
      errors: z.flattenError(parsed.error).fieldErrors,
    });
  }

  const tokenService = new TokenService(getDb(c.env));
  const token = await tokenService.getToken({
    tokenId,
    organizationId: orgId,
    projectId,
  });

  if (!token) {
    throw notFound("Token");
  }

  // Mirror the deploy guards. A token that already has a mint has been
  // deployed; re-confirming would overwrite its recorded mint, so reject. This
  // also makes the endpoint safe to retry — the second call 400s instead of
  // double-recording.
  if (token.status !== "pending") {
    throw new AppError(
      "BAD_REQUEST",
      "Token has already been deployed or is not in pending status"
    );
  }

  if (token.mintAddress) {
    throw badRequest("Token already has a mint address");
  }

  const mint = parsed.data.mint as Address;

  // Verify the deploy actually landed before recording it: any tokens:write
  // caller could otherwise pin an arbitrary mint to this token and poison the
  // public metadata.json. The create tx must be confirmed (no error, past the
  // `processed`-only stage) and the mint account must now exist on-chain.
  const signature = parsed.data.signature as Signature;
  const rpc = createRpc(c.env);
  const [status] = await getSignatureStatuses(rpc, [signature]);

  if (!status || status.err !== null || status.confirmationStatus === "processed") {
    throw badRequest("Deploy transaction is not confirmed on-chain");
  }

  if (!(await accountExists(rpc, mint))) {
    throw badRequest("Mint account does not exist on-chain");
  }

  // Confirmed + exists is not enough: the two checks above are independent, so a
  // caller could pair a confirmed signature from an unrelated tx (e.g. a SOL
  // transfer) with any pre-existing mint and pass both. Fetch the tx and require
  // that it actually initialized THIS mint, linking the signature to the mint.
  const confirmedTx = await getTransaction(rpc, signature);

  // `getSignatureStatuses` and `getTransaction` are indexed independently on the
  // RPC, so a client that confirms via the former and immediately calls here can
  // outrun the latter: the tx is valid but not yet queryable and `getTransaction`
  // returns null. Surface that as a retryable error rather than the "wrong tx"
  // 400 below — which would tell the caller their deploy was bad and give them no
  // reason to retry, permanently rejecting a legitimate deploy.
  if (!confirmedTx) {
    throw new AppError(
      "SOLANA_RPC_ERROR",
      "Deploy transaction is confirmed but not yet indexed by the RPC; retry shortly"
    );
  }

  if (!transactionInitializesMint(confirmedTx, mint)) {
    throw badRequest("Deploy transaction did not create this mint");
  }

  // Use the signing wallet prepareDeploy resolved and persisted, NOT the request
  // body. A body value that diverged from prepare's would derive a different
  // custody address and silently record the wrong mint/metadata authorities —
  // and, for ABL tokens, the wrong list PDA. token.signingWalletId is the source
  // of truth; resolve it again only to re-assert the key still has access.
  const signingWalletId = resolveApiKeySigningWalletId(auth, token.signingWalletId, [
    "tokens:write",
  ]);

  // Recompute the authorities the deploy used (custody signer === mint &
  // metadata authority, matching prepareDeploy) rather than trusting the
  // request, so a recorded mint can't claim authorities the caller lacks.
  const signer = await createOrgSigner(c.env, auth.organizationId, auth.projectId, signingWalletId);
  const custodyAddress = signer.address;
  const freezeAuthority = token.isFreezable ? custodyAddress : null;

  // Re-derive the ABL list address server-side instead of trusting the request
  // body's `listAddress`: for allowlist/blocklist tokens a wrong value would
  // silently break every later allowlist op with no recovery short of a DB
  // patch. The list-config PDA is deterministic from (mint authority, mint) and
  // is only seeded on-chain when ACL is enabled and the mint is freezable —
  // mirror the `enableSrfc37` condition the create path uses (mosaic/service.ts).
  const listAddress =
    shouldEnableOnChainAcl(token) && freezeAuthority !== null
      ? await deriveAblListAddress(custodyAddress, mint)
      : undefined;

  // setTokenDeployed flips the token to `active` and records the mint — this is
  // the irreversible commit point. Everything after it is bookkeeping; see
  // recordConfirmedDeploy for why a failure there must not 500.
  const deployedToken = await tokenService.setTokenDeployed(
    tokenId,
    mint,
    custodyAddress,
    freezeAuthority,
    listAddress
  );

  const updatedToken = await recordConfirmedDeploy({
    c,
    tokenService,
    organizationId: auth.organizationId,
    initiatedByKeyId: auth.id,
    token,
    tokenId,
    mint,
    custodyAddress,
    freezeAuthority,
    listAddress,
    signature: parsed.data.signature,
    slot: status.slot,
    deployedToken,
  });

  const response: TokenResponse = { token: updatedToken };
  return success(c, response);
};

/**
 * Prepare the metadata-uri follow-up transaction for the non-custodial,
 * client-signed deploy flow (HOO-466).
 *
 * Two-tx contract: when `prepareDeploy` returns `metadataUriFollowUp.required`,
 * the client signs+sends the create tx, confirms it, records the mint via
 * `deploy/confirm` (without which the `mintAddress` guard below rejects the
 * call), then calls THIS endpoint to fetch an unsigned metadata field-update tx
 * (set with a fresh blockhash — the mint's metadata account only exists once
 * the create tx confirms), signs it with its update authority, and submits it.
 * The update authority is the same signing wallet used for the create tx, so no
 * server key is involved.
 */
export const prepareDeployMetadata = async (c: AppContext) => {
  const { tokenId } = c.req.param();
  const { auth, projectId, orgId } = requireProjectScope(c);
  const body = await c.req.json().catch(() => ({}));
  const parsed = deployTokenSchema.safeParse(body);

  if (!parsed.success) {
    throw new AppError("BAD_REQUEST", "Invalid request body", {
      errors: parsed.error.flatten().fieldErrors,
    });
  }

  const tokenService = new TokenService(getDb(c.env));
  const token = await tokenService.getToken({
    tokenId,
    organizationId: orgId,
    projectId,
  });

  if (!token) {
    throw notFound("Token");
  }

  if (!token.mintAddress) {
    throw new AppError("BAD_REQUEST", "Token has not been deployed yet");
  }

  // Use the signing wallet pinned at deploy/prepare (never the request body),
  // matching confirmDeploy. The follow-up tx is signed by the mint's metadata
  // update authority; a body override would resolve a different wallet and
  // produce a tx that can never succeed against the on-chain authority.
  const signingWalletId = resolveApiKeySigningWalletId(auth, token.signingWalletId, [
    "tokens:write",
  ]);

  const signer = await createOrgSigner(c.env, auth.organizationId, auth.projectId, signingWalletId);
  const mosaic = createMosaicService(c.env, signer, "sponsored");

  // Resolve the same uri prepareDeploy used so the on-chain pointer ends up at
  // the SDP-hosted (or issuer-supplied) URL.
  const resolvedUri =
    token.uri?.trim() || canonicalMetadataUrl(resolveMetadataOrigin(c.env, c.req.url), token.id);

  const prepared = await mosaic.prepareUpdateMetadata({
    mint: token.mintAddress as Address,
    uri: resolvedUri,
    updateAuthority: signer,
    feePayer: signer,
  });

  // On-chain uri already matches (e.g. the create tx fit and carried it
  // inline). Nothing for the client to sign.
  if (!prepared) {
    return success(c, { transaction: null, uri: resolvedUri });
  }

  const rpc = createRpc(c.env);
  const simulation = await simulateTransaction(rpc, Buffer.from(prepared.serializedTx, "base64"));

  const auditService = new AuditService(getDb(c.env));
  await auditService.log(c, {
    action: "deploy",
    resourceType: "token",
    resourceId: tokenId,
    metadata: {
      mode: "prepare-metadata",
      mint: token.mintAddress,
      template: token.template,
    },
  });

  return success(c, {
    transaction: {
      serialized: prepared.serializedTx,
      blockhash: prepared.blockhash,
      lastValidBlockHeight: prepared.lastValidBlockHeight.toString(),
    },
    uri: resolvedUri,
    simulation,
  });
};
