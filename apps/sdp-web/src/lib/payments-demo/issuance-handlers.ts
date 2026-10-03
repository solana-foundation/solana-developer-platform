import { ASSET_CATEGORIES, isAssetTypeSupported, type PublicToken } from "@sdp/types";
import { z } from "zod";
import { type DemoWorld, findWallet } from "./demo-fixtures";
import type { DemoAnswer, DemoWriteResult, WriteContext } from "./demo-handlers";
import { type DemoOp, newDemoId } from "./demo-ops";
import { type DemoIssuedToken, findIssuedToken, toUnits } from "./issuance-fixtures";

/*
 * What the demo answers for the Issuance writes: a draft created, its fields and profile edited,
 * its deploy, and every operation on a live token (mint, burn, seize, force burn, freeze,
 * unfreeze, pause, resume, authority changes, control list changes, supply refresh). Each runs
 * the checks the SDP API runs, with its codes and messages, records the action for the session
 * and answers with the API's envelope read from the world with the action applied.
 */

type Handler = (context: WriteContext) => DemoWriteResult;

const SOLANA_ADDRESS = /^[1-9A-HJ-NP-Za-km-z]{32,44}$/;
const DECIMAL = /^\d+(\.\d+)?$/;
const SYMBOL = /^[A-Za-z0-9]+(?:\.[A-Za-z0-9]+)*$/;

function meta() {
  return { requestId: "demo_request", timestamp: new Date().toISOString() };
}

function answer(data: unknown, status = 200): DemoAnswer {
  return { status, body: { data, meta: meta() } };
}

function fail(status: number, code: string, message: string): DemoWriteResult {
  return { ops: [], answer: () => ({ status, body: { error: { code, message } } }) };
}

const badRequest = (message: string, code = "BAD_REQUEST") => fail(400, code, message);
const notFound = (resource: string) => fail(404, "NOT_FOUND", `${resource} not found`);

function record(ops: DemoOp[], respond: (world: DemoWorld) => DemoAnswer): DemoWriteResult {
  return { ops, answer: respond };
}

function parse<T>(schema: z.ZodType<T>, body: unknown): { data: T } | { failure: DemoWriteResult } {
  const parsed = schema.safeParse(body);
  if (parsed.success) return { data: parsed.data };
  const issue = parsed.error.issues[0];
  const field = issue?.path.join(".");
  return {
    failure: badRequest(
      `Invalid request body:\n✖ ${issue?.message ?? "Invalid input"}${field ? `\n  → at ${field}` : ""}`
    ),
  };
}

const address = z.string().trim().regex(SOLANA_ADDRESS, "Enter a valid Solana address.");
const amount = z
  .string()
  .trim()
  .regex(DECIMAL, "Enter an amount, like 25.00.")
  .refine((value) => Number(value) > 0, "Enter an amount greater than zero.");
const memo = z.string().max(100).optional();
const walletId = z.string().min(1).max(80);
const options = z.object({ priorityFee: z.unknown().optional(), simulate: z.unknown().optional() });

/** A transaction's seed; its id is `demo_ttx_<seed>`, as the seeded ones are. */
function txId() {
  return newDemoId("ttx").replace("demo_new_ttx_", "new_");
}

/** The token the path names, or the API's 404. */
function tokenFor(context: WriteContext): DemoIssuedToken | DemoWriteResult {
  const entry = findIssuedToken(context.world.issuance, context.segments[2] ?? "");
  return entry ?? notFound("Token");
}

function isFailure(value: DemoIssuedToken | DemoWriteResult): value is DemoWriteResult {
  return "answer" in value;
}

/** Null when the wallet belongs to the project; otherwise the API's refusal. */
function walletRefusal(context: WriteContext, id: string | undefined | null) {
  if (!id) return null;
  return findWallet(context.world, id)
    ? null
    : fail(404, "NOT_FOUND", "Signing wallet not found in this project");
}

function tokenAnswer(tokenId: string, status = 200) {
  return (world: DemoWorld) => {
    const entry = findIssuedToken(world.issuance, tokenId);
    return entry ? answer({ token: entry.token }, status) : { status: 404, body: {} };
  };
}

function transactionAnswer(tokenId: string, txId: string, extra: Record<string, unknown> = {}) {
  return (world: DemoWorld) => {
    const transaction = findIssuedToken(world.issuance, tokenId)?.transactions.find(
      (row) => row.id === `demo_ttx_${txId}`
    );
    return answer({ transaction, ...extra });
  };
}

function precisionRefusal(token: PublicToken, value: string) {
  const fraction = value.split(".")[1] ?? "";
  return fraction.length > token.decimals
    ? badRequest(`Amount has more than ${token.decimals} decimal places.`)
    : null;
}

function notDeployed(token: PublicToken) {
  return token.mintAddress === null
    ? badRequest("Token is not deployed yet.", "TOKEN_NOT_DEPLOYED")
    : null;
}

// ─── Drafts, edits and profiles ──────────────────────────────────────────────

const createSchema = z
  .object({
    name: z.string().trim().min(1).max(100),
    symbol: z.string().trim().min(1).max(10).regex(SYMBOL, "Use letters and numbers."),
    signingCustodyWalletId: walletId.optional(),
    decimals: z.number().int().min(0).max(18).optional(),
    description: z.string().max(500).optional(),
    uri: z.string().url().max(512).optional(),
    imageUrl: z.string().url().max(512).optional(),
    maxSupply: z.string().regex(DECIMAL).optional(),
    template: z.enum(["stablecoin", "rwa", "arcade", "tokenized-security", "custom"]).optional(),
    requiresAllowlist: z.boolean().optional(),
    isMintable: z.boolean().optional(),
    isFreezable: z.boolean().optional(),
    overrides: z.unknown().optional(),
    assetCategory: z.enum(ASSET_CATEGORIES).default("generic"),
    assetType: z.string().default("generic"),
    issuanceMetadata: z.record(z.string(), z.unknown()).optional(),
  })
  .superRefine((value, context) => {
    if (!isAssetTypeSupported(value.assetCategory, value.assetType)) {
      context.addIssue({
        code: "custom",
        path: ["assetType"],
        message: `${value.assetType} is not a ${value.assetCategory} type`,
      });
    }
    if (value.template === "stablecoin" && value.decimals !== undefined && value.decimals !== 6) {
      context.addIssue({
        code: "custom",
        path: ["decimals"],
        message: "A stablecoin has 6 decimals.",
      });
    }
  });

/** `POST /asset-profiles` (and `POST /tokens`): a draft token and its profile. */
function createDraft(context: WriteContext): DemoWriteResult {
  const parsed = parse(createSchema, context.body);
  if ("failure" in parsed) return parsed.failure;
  const body = parsed.data;
  const refusal = walletRefusal(context, body.signingCustodyWalletId);
  if (refusal) return refusal;
  const template = body.template ?? "custom";
  const id = newDemoId("tok");
  const profile = newDemoId("asset_profile");
  const withProfile = context.segments[1] === "asset-profiles";
  return record(
    [
      {
        k: "iss-create",
        id,
        at: context.now.getTime(),
        profile,
        name: body.name,
        symbol: body.symbol,
        description: body.description ?? null,
        decimals: body.decimals ?? (template === "stablecoin" ? 6 : 9),
        template,
        category: body.assetCategory,
        type: body.assetType,
        requiresAllowlist: body.requiresAllowlist ?? false,
        freezable: body.isFreezable ?? template === "stablecoin",
        maxSupply: body.maxSupply ?? null,
        signer: body.signingCustodyWalletId ?? null,
        metadata: body.issuanceMetadata ?? {},
      },
    ],
    (world) => {
      const entry = findIssuedToken(world.issuance, id);
      return answer(
        withProfile
          ? { token: entry?.token, assetProfile: entry?.profile }
          : { token: entry?.token },
        201
      );
    }
  );
}

const nullableUrl = z.string().url().max(512).nullable();
const patchSchema = z
  .object({
    signingCustodyWalletId: walletId.optional(),
    name: z.string().trim().min(1).max(100).optional(),
    symbol: z.string().trim().min(1).max(10).regex(SYMBOL).optional(),
    decimals: z.number().int().min(0).max(18).optional(),
    description: z.string().max(500).nullable().optional(),
    uri: nullableUrl.optional(),
    imageUrl: nullableUrl.optional(),
    requiresAllowlist: z.boolean().optional(),
    maxSupply: z.string().regex(DECIMAL).nullable().optional(),
  })
  .strict();

/** `PATCH /tokens/:id`: name, description, links and supply cap; the rest only before deploy. */
function updateToken(context: WriteContext): DemoWriteResult {
  const entry = tokenFor(context);
  if (isFailure(entry)) return entry;
  const parsed = parse(patchSchema, context.body);
  if ("failure" in parsed) return parsed.failure;
  const patch = parsed.data;
  const { token } = entry;
  const deployed = token.mintAddress !== null;
  if (deployed && (patch.symbol !== undefined || patch.decimals !== undefined)) {
    return badRequest("Symbol and decimals are fixed once the token is deployed.");
  }
  if (
    deployed &&
    patch.requiresAllowlist !== undefined &&
    patch.requiresAllowlist !== token.requiresAllowlist
  ) {
    return badRequest("Access control is fixed once the token is deployed.");
  }
  if (token.template === "stablecoin" && patch.decimals !== undefined && patch.decimals !== 6) {
    return badRequest("A stablecoin has 6 decimals.");
  }
  if (deployed && patch.maxSupply !== undefined && token.mintAuthority === null) {
    return badRequest("The supply is locked, so its cap can't change.");
  }
  if (
    patch.maxSupply &&
    toUnits(patch.maxSupply, token.decimals) < toUnits(token.totalSupply, token.decimals)
  ) {
    return badRequest("The cap is below the supply already issued.", "MAX_SUPPLY_EXCEEDED");
  }
  const refusal = walletRefusal(context, patch.signingCustodyWalletId);
  if (refusal) return refusal;
  return record(
    [{ k: "iss-update", id: token.id, at: context.now.getTime(), patch }],
    tokenAnswer(token.id)
  );
}

const profilePatchSchema = z
  .object({
    assetCategory: z.enum(ASSET_CATEGORIES).optional(),
    assetType: z.string().optional(),
    issuanceMetadata: z.record(z.string(), z.unknown()).optional(),
  })
  .refine(
    (value) => Object.values(value).some((field) => field !== undefined),
    "Provide at least one field to update."
  );

/** `PATCH /asset-profiles/:id`: the classification and the issuance metadata. */
function updateProfile(context: WriteContext): DemoWriteResult {
  const profileId = context.segments[2] ?? "";
  const entry = context.world.issuance.tokens.find(
    (candidate) => candidate.profile.id === profileId
  );
  if (!entry) return notFound("Asset profile");
  const parsed = parse(profilePatchSchema, context.body);
  if ("failure" in parsed) return parsed.failure;
  const patch = parsed.data;
  const category = patch.assetCategory ?? entry.profile.assetCategory;
  const type = patch.assetType ?? entry.profile.assetType;
  if (!isAssetTypeSupported(category, type)) {
    return badRequest(`${type} is not a ${category} type.`);
  }
  return record(
    [
      {
        k: "iss-profile",
        id: profileId,
        at: context.now.getTime(),
        ...(patch.assetCategory ? { category: patch.assetCategory } : {}),
        ...(patch.assetType ? { type: patch.assetType } : {}),
        ...(patch.issuanceMetadata ? { metadata: patch.issuanceMetadata } : {}),
      },
    ],
    (world) => {
      const updated = world.issuance.tokens.find((candidate) => candidate.profile.id === profileId);
      return answer({ assetProfile: updated?.profile });
    }
  );
}

// ─── Deploy ──────────────────────────────────────────────────────────────────

const deploySchema = z
  .object({
    signingCustodyWalletId: walletId.optional(),
    authorityCustodyWalletIds: z
      .object({
        metadata: walletId.optional(),
        freeze: walletId.optional(),
        permanentDelegate: walletId.optional(),
      })
      .strict()
      .optional(),
    feePayment: z.enum(["sponsored", "wallet"]).default("sponsored"),
  })
  .strict();

/** `POST /tokens/:id/deploy`: submits the deploy; it lands a few seconds later. */
function deploy(context: WriteContext): DemoWriteResult {
  const entry = tokenFor(context);
  if (isFailure(entry)) return entry;
  const parsed = parse(deploySchema, context.body);
  if ("failure" in parsed) return parsed.failure;
  const { token } = entry;
  if (token.mintAddress !== null || token.status !== "pending") {
    return badRequest("Token is already deployed.");
  }
  if (entry.transactions.some((row) => row.type === "deploy" && row.status === "processing")) {
    return fail(409, "CONFLICT", "A deploy for this token is already in progress.");
  }
  const signer = parsed.data.signingCustodyWalletId ?? token.signingCustodyWalletId;
  const ids = parsed.data.authorityCustodyWalletIds ?? {};
  for (const id of [signer, ids.metadata, ids.freeze, ids.permanentDelegate]) {
    const refusal = walletRefusal(context, id);
    if (refusal) return refusal;
  }
  if (!signer) return badRequest("Pick the wallet that signs the deploy.");
  const auth: Record<string, string> = {};
  if (ids.metadata) auth.metadata = ids.metadata;
  if (ids.freeze) auth.freeze = ids.freeze;
  if (ids.permanentDelegate) auth.permanentDelegate = ids.permanentDelegate;
  return record(
    [
      {
        k: "iss-deploy",
        id: token.id,
        at: context.now.getTime(),
        tx: txId(),
        signer,
        auth,
      },
    ],
    tokenAnswer(token.id)
  );
}

// ─── Supply ──────────────────────────────────────────────────────────────────

function onBlocklist(entry: DemoIssuedToken, target: string) {
  return (
    !entry.token.requiresAllowlist &&
    entry.controlList.some((row) => row.status === "active" && row.address === target)
  );
}

const mintSchema = z
  .object({
    signingCustodyWalletId: walletId.optional(),
    mint: z.object({ destination: address, amount, memo }).strict(),
    options: options.optional(),
  })
  .strict();

/** `POST /tokens/:id/mint`: new supply to an address, within the cap. */
function mint(context: WriteContext): DemoWriteResult {
  const entry = tokenFor(context);
  if (isFailure(entry)) return entry;
  const parsed = parse(mintSchema, context.body);
  if ("failure" in parsed) return parsed.failure;
  const { token } = entry;
  const body = parsed.data;
  const refusal =
    notDeployed(token) ??
    walletRefusal(context, body.signingCustodyWalletId) ??
    precisionRefusal(token, body.mint.amount);
  if (refusal) return refusal;
  if (token.mintAuthority === null) {
    return badRequest("The supply is locked: this token has no mint authority.");
  }
  if (onBlocklist(entry, body.mint.destination)) {
    return fail(403, "ON_TOKEN_BLOCKLIST", "That address is on the token's blocklist.");
  }
  if (
    token.maxSupply !== null &&
    toUnits(token.totalSupply, token.decimals) + toUnits(body.mint.amount, token.decimals) >
      toUnits(token.maxSupply, token.decimals)
  ) {
    return badRequest(
      `Minting ${body.mint.amount} would take the supply past its ${token.maxSupply} cap.`,
      "MAX_SUPPLY_EXCEEDED"
    );
  }
  const tx = txId();
  return record(
    [
      {
        k: "iss-supply",
        id: token.id,
        at: context.now.getTime(),
        tx,
        type: "mint",
        amount: body.mint.amount,
        from: null,
        to: body.mint.destination,
        memo: body.mint.memo ?? null,
      },
    ],
    transactionAnswer(token.id, tx, { tokenAccount: body.mint.destination })
  );
}

function supplyRefusal(entry: DemoIssuedToken, value: string) {
  const { token } = entry;
  return toUnits(value, token.decimals) > toUnits(token.totalSupply, token.decimals)
    ? badRequest(`Only ${token.totalSupply} ${token.symbol} is in circulation.`)
    : null;
}

const burnSchema = z
  .object({
    signingCustodyWalletId: walletId,
    burn: z.object({ source: address, amount, memo }).strict(),
    options: options.optional(),
  })
  .strict();

/** `POST /tokens/:id/burn`: supply out of an address the signer holds. */
function burn(context: WriteContext): DemoWriteResult {
  const entry = tokenFor(context);
  if (isFailure(entry)) return entry;
  const parsed = parse(burnSchema, context.body);
  if ("failure" in parsed) return parsed.failure;
  const body = parsed.data;
  const refusal =
    notDeployed(entry.token) ??
    walletRefusal(context, body.signingCustodyWalletId) ??
    precisionRefusal(entry.token, body.burn.amount) ??
    supplyRefusal(entry, body.burn.amount);
  if (refusal) return refusal;
  const tx = txId();
  return record(
    [
      {
        k: "iss-supply",
        id: entry.token.id,
        at: context.now.getTime(),
        tx,
        type: "burn",
        amount: body.burn.amount,
        from: body.burn.source,
        to: null,
        memo: body.burn.memo ?? null,
      },
    ],
    transactionAnswer(entry.token.id, tx)
  );
}

function delegateRefusal(entry: DemoIssuedToken) {
  return entry.token.extensions?.permanentDelegate
    ? null
    : badRequest("This token has no permanent delegate.");
}

const seizeSchema = z
  .object({
    signingCustodyWalletId: walletId.optional(),
    seize: z
      .object({
        source: address,
        destination: address,
        amount,
        delegateAuthority: z.string().optional(),
        memo,
      })
      .strict(),
    options: options.optional(),
  })
  .strict();

/** `POST /tokens/:id/seize`: the permanent delegate moves tokens out of an account. */
function seize(context: WriteContext): DemoWriteResult {
  const entry = tokenFor(context);
  if (isFailure(entry)) return entry;
  const parsed = parse(seizeSchema, context.body);
  if ("failure" in parsed) return parsed.failure;
  const body = parsed.data;
  const refusal =
    notDeployed(entry.token) ??
    delegateRefusal(entry) ??
    walletRefusal(context, body.signingCustodyWalletId) ??
    precisionRefusal(entry.token, body.seize.amount) ??
    supplyRefusal(entry, body.seize.amount);
  if (refusal) return refusal;
  const tx = txId();
  return record(
    [
      {
        k: "iss-supply",
        id: entry.token.id,
        at: context.now.getTime(),
        tx,
        type: "seize",
        amount: body.seize.amount,
        from: body.seize.source,
        to: body.seize.destination,
        memo: body.seize.memo ?? null,
      },
    ],
    transactionAnswer(entry.token.id, tx)
  );
}

const forceBurnSchema = z
  .object({
    signingCustodyWalletId: walletId.optional(),
    forceBurn: z
      .object({ source: address, amount, delegateAuthority: z.string().optional(), memo })
      .strict(),
    options: options.optional(),
  })
  .strict();

/** `POST /tokens/:id/force-burn`: the permanent delegate burns tokens out of an account. */
function forceBurn(context: WriteContext): DemoWriteResult {
  const entry = tokenFor(context);
  if (isFailure(entry)) return entry;
  const parsed = parse(forceBurnSchema, context.body);
  if ("failure" in parsed) return parsed.failure;
  const body = parsed.data;
  const refusal =
    notDeployed(entry.token) ??
    delegateRefusal(entry) ??
    walletRefusal(context, body.signingCustodyWalletId) ??
    precisionRefusal(entry.token, body.forceBurn.amount) ??
    supplyRefusal(entry, body.forceBurn.amount);
  if (refusal) return refusal;
  const tx = txId();
  return record(
    [
      {
        k: "iss-supply",
        id: entry.token.id,
        at: context.now.getTime(),
        tx,
        type: "force_burn",
        amount: body.forceBurn.amount,
        from: body.forceBurn.source,
        to: null,
        memo: body.forceBurn.memo ?? null,
      },
    ],
    transactionAnswer(entry.token.id, tx)
  );
}

// ─── Freeze and pause ────────────────────────────────────────────────────────

const freezeSchema = z
  .object({
    accountAddress: address,
    reason: z.string().max(500).optional(),
    signingCustodyWalletId: walletId.optional(),
  })
  .strict();

function frozenAnswer(tokenId: string, account: string, tx: string, status: number) {
  return (world: DemoWorld) => {
    const entry = findIssuedToken(world.issuance, tokenId);
    const frozenAccount = entry?.frozen.find((row) => row.accountAddress === account);
    return answer({ frozenAccount: { ...frozenAccount, signature: `demo_sig_${tx}` } }, status);
  };
}

/** `POST /tokens/:id/freeze` and `/unfreeze`. */
function freeze(frozen: boolean): Handler {
  return (context) => {
    const entry = tokenFor(context);
    if (isFailure(entry)) return entry;
    const parsed = parse(freezeSchema, context.body);
    if ("failure" in parsed) return parsed.failure;
    const body = parsed.data;
    const refusal = notDeployed(entry.token) ?? walletRefusal(context, body.signingCustodyWalletId);
    if (refusal) return refusal;
    if (!entry.token.freezeAuthority) {
      return badRequest("This token has no freeze authority.");
    }
    const current = entry.frozen.some(
      (row) => row.accountAddress === body.accountAddress && row.unfrozenAt === null
    );
    if (frozen && current) return fail(409, "CONFLICT", "That account is already frozen.");
    if (!frozen && !current) return fail(404, "NOT_FOUND", "Frozen account not found");
    const tx = txId();
    return record(
      [
        {
          k: "iss-freeze",
          id: entry.token.id,
          at: context.now.getTime(),
          tx,
          frozen,
          account: body.accountAddress,
          reason: frozen ? (body.reason ?? null) : null,
        },
      ],
      frozenAnswer(entry.token.id, body.accountAddress, tx, frozen ? 201 : 200)
    );
  };
}

const pauseSchema = z
  .object({ signingCustodyWalletId: walletId.optional(), options: options.optional() })
  .strict();

/** `POST /tokens/:id/pause` and `/unpause`. */
function pause(paused: boolean): Handler {
  return (context) => {
    const entry = tokenFor(context);
    if (isFailure(entry)) return entry;
    const parsed = parse(pauseSchema, context.body);
    if ("failure" in parsed) return parsed.failure;
    const refusal =
      notDeployed(entry.token) ?? walletRefusal(context, parsed.data.signingCustodyWalletId);
    if (refusal) return refusal;
    if (!entry.token.extensions?.pausable) {
      return badRequest("This token can't be paused.");
    }
    if (paused === (entry.token.status === "paused")) {
      return badRequest(paused ? "Transfers are already paused." : "Transfers aren't paused.");
    }
    const tx = txId();
    return record(
      [{ k: "iss-pause", id: entry.token.id, at: context.now.getTime(), tx, paused }],
      transactionAnswer(entry.token.id, tx)
    );
  };
}

// ─── Authorities and the control list ────────────────────────────────────────

const authoritySchema = z
  .object({
    signingCustodyWalletId: walletId.optional(),
    authority: z
      .object({
        role: z.enum(["mint", "freeze", "permanentDelegate", "metadata"]),
        currentAuthority: z.string().optional(),
        newAuthority: address.nullable(),
      })
      .strict(),
    options: options.optional(),
  })
  .strict();

/** `POST /tokens/:id/authority`: hands an authority to another address, or gives it up. */
function changeAuthority(context: WriteContext): DemoWriteResult {
  const entry = tokenFor(context);
  if (isFailure(entry)) return entry;
  const parsed = parse(authoritySchema, context.body);
  if ("failure" in parsed) return parsed.failure;
  const body = parsed.data;
  const refusal = notDeployed(entry.token) ?? walletRefusal(context, body.signingCustodyWalletId);
  if (refusal) return refusal;
  const { token } = entry;
  const current =
    body.authority.role === "mint"
      ? token.mintAuthority
      : body.authority.role === "freeze"
        ? token.freezeAuthority
        : body.authority.role === "metadata"
          ? (token.metadataAuthority ?? token.mintAuthority)
          : (token.extensions?.permanentDelegate ?? null);
  if (current === null) {
    return badRequest("That authority has already been given up.");
  }
  const tx = txId();
  return record(
    [
      {
        k: "iss-authority",
        id: token.id,
        at: context.now.getTime(),
        tx,
        role: body.authority.role,
        next: body.authority.newAuthority,
      },
    ],
    transactionAnswer(token.id, tx)
  );
}

const listAddSchema = z
  .object({
    address: z
      .string()
      .trim()
      .min(32)
      .max(44)
      .regex(SOLANA_ADDRESS, "Enter a valid Solana address."),
    label: z.string().max(100).optional(),
    signingCustodyWalletId: walletId.optional(),
  })
  .strict();

/** `POST /tokens/:id/allowlist`: an address onto the allowlist or blocklist. */
function addToList(context: WriteContext): DemoWriteResult {
  const entry = tokenFor(context);
  if (isFailure(entry)) return entry;
  const parsed = parse(listAddSchema, context.body);
  if ("failure" in parsed) return parsed.failure;
  const body = parsed.data;
  const refusal = walletRefusal(context, body.signingCustodyWalletId);
  if (refusal) return refusal;
  if (entry.controlList.some((row) => row.status === "active" && row.address === body.address)) {
    return fail(409, "CONFLICT", "Address is already on the control list");
  }
  const entryId = newDemoId("tal");
  return record(
    [
      {
        k: "iss-list-add",
        id: entry.token.id,
        at: context.now.getTime(),
        entry: entryId,
        address: body.address,
        label: body.label?.trim() || null,
      },
    ],
    (world) => {
      const row = findIssuedToken(world.issuance, entry.token.id)?.controlList.find(
        (candidate) => candidate.id === entryId
      );
      return answer({ entry: row }, 201);
    }
  );
}

/** `DELETE /tokens/:id/allowlist/:entryId`. */
function removeFromList(context: WriteContext): DemoWriteResult {
  const entry = tokenFor(context);
  if (isFailure(entry)) return entry;
  const entryId = context.segments[4] ?? "";
  const row = entry.controlList.find((candidate) => candidate.id === entryId);
  if (!row) return notFound("Allowlist entry");
  if (row.status === "revoked") return record([], () => ({ status: 204 }));
  return record(
    [{ k: "iss-list-remove", id: entry.token.id, at: context.now.getTime(), entry: entryId }],
    () => ({ status: 204 })
  );
}

/** `POST /tokens/:id/supply/refresh`: the supply is always current in the demo. */
function refreshSupply(context: WriteContext): DemoWriteResult {
  const entry = tokenFor(context);
  if (isFailure(entry)) return entry;
  const refusal = notDeployed(entry.token);
  if (refusal) return refusal;
  return record([], tokenAnswer(entry.token.id));
}

// ─── Routing ─────────────────────────────────────────────────────────────────

const ISSUANCE_WRITES: ReadonlyArray<[method: string, shape: string, handler: Handler]> = [
  ["POST", "issuance/asset-profiles", createDraft],
  ["PATCH", "issuance/asset-profiles/*", updateProfile],
  ["POST", "issuance/tokens", createDraft],
  ["PATCH", "issuance/tokens/*", updateToken],
  ["POST", "issuance/tokens/*/deploy", deploy],
  ["POST", "issuance/tokens/*/mint", mint],
  ["POST", "issuance/tokens/*/burn", burn],
  ["POST", "issuance/tokens/*/seize", seize],
  ["POST", "issuance/tokens/*/force-burn", forceBurn],
  ["POST", "issuance/tokens/*/freeze", freeze(true)],
  ["POST", "issuance/tokens/*/unfreeze", freeze(false)],
  ["POST", "issuance/tokens/*/pause", pause(true)],
  ["POST", "issuance/tokens/*/unpause", pause(false)],
  ["POST", "issuance/tokens/*/authority", changeAuthority],
  ["POST", "issuance/tokens/*/allowlist", addToList],
  ["DELETE", "issuance/tokens/*/allowlist/*", removeFromList],
  ["POST", "issuance/tokens/*/supply/refresh", refreshSupply],
];

function matchesShape(segments: readonly string[], shape: string): boolean {
  const parts = shape.split("/");
  return (
    parts.length === segments.length &&
    parts.every((part, index) => part === "*" || part === segments[index])
  );
}

/** The demo's handling of an Issuance write, or undefined when it has no stand-in for it. */
export function issuanceWrite(method: string, context: WriteContext): DemoWriteResult | undefined {
  const route = ISSUANCE_WRITES.find(
    ([routeMethod, shape]) => routeMethod === method && matchesShape(context.segments, shape)
  );
  return route?.[2](context);
}
