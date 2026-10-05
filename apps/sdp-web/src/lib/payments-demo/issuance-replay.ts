import type {
  AssetCategory,
  IssuanceMetadata,
  PublicToken,
  TokenExtensionsConfig,
  TokenTemplate,
} from "@sdp/types";
import {
  CREATED_BY,
  type DemoWorld,
  demoAddress,
  ORGANIZATION_ID,
  PROJECT_ID,
} from "./demo-fixtures";
import type { DemoOpOf } from "./demo-ops";
import {
  DEMO_DEPLOY_MS,
  type DemoIssuedToken,
  demoAuditEvent,
  demoTransaction,
  findIssuedToken,
  fromUnits,
  newestFirstBy,
  newestFirstTokens,
  projectPublicMetadata,
  toUnits,
} from "./issuance-fixtures";

/*
 * The visitor's Issuance actions applied to the world, in the order they happened: a draft
 * created, a deploy submitted (it lands DEMO_DEPLOY_MS later, so the screens show it deploying
 * first), supply minted or burned, transfers paused, accounts frozen, authorities moved, the
 * control list changed, and the token's or its profile's fields edited. Each leaves the
 * transaction and activity rows the API would write.
 */

type IssuanceOp = DemoOpOf<
  | "iss-create"
  | "iss-deploy"
  | "iss-supply"
  | "iss-pause"
  | "iss-freeze"
  | "iss-authority"
  | "iss-list-add"
  | "iss-list-remove"
  | "iss-update"
  | "iss-profile"
>;

const iso = (ms: number) => new Date(ms).toISOString();

function walletKey(world: DemoWorld, walletId: string | null | undefined): string | null {
  if (!walletId) return null;
  return (
    Object.values(world.wallets).find(
      (wallet) => wallet.id === walletId || wallet.walletId === walletId
    )?.publicKey ?? null
  );
}

function accessControlOf(token: Pick<PublicToken, "requiresAllowlist" | "template">) {
  if (token.requiresAllowlist) return "allowlist";
  return token.template === "stablecoin" ? "blocklist" : "off";
}

function applyCreate(world: DemoWorld, op: DemoOpOf<"iss-create">) {
  const createdAt = iso(op.at);
  const metadata = op.metadata as IssuanceMetadata;
  const signerKey = walletKey(world, op.signer);
  const stablecoin = op.template === "stablecoin";
  const settings = (metadata.settings as { selected?: Record<string, unknown> } | undefined)
    ?.selected;
  const extensions: TokenExtensionsConfig = {};
  if (stablecoin || settings?.permanentDelegate) extensions.permanentDelegate = signerKey ?? "";
  if (stablecoin || settings?.pauseTransfers) extensions.pausable = { authority: signerKey ?? "" };
  const authorityWalletIds =
    ((metadata.custom as { customer?: { authorityWalletIds?: Record<string, string> } } | undefined)
      ?.customer?.authorityWalletIds as Record<string, string> | undefined) ?? {};

  const token: PublicToken = {
    id: op.id,
    projectId: PROJECT_ID,
    organizationId: ORGANIZATION_ID,
    signingCustodyWalletId: op.signer,
    mintAddress: null,
    mintAuthority: signerKey,
    metadataAuthority: signerKey,
    freezeAuthority: op.freezable ? signerKey : null,
    ablListAddress: null,
    name: op.name,
    symbol: op.symbol,
    decimals: op.decimals,
    description: op.description,
    uri: null,
    imageUrl: null,
    template: op.template as TokenTemplate,
    extensions: Object.keys(extensions).length > 0 ? extensions : null,
    totalSupply: "0",
    totalSupplyUpdatedAt: null,
    maxSupply: op.maxSupply,
    isMintable: true,
    isFreezable: op.freezable,
    requiresAllowlist: op.requiresAllowlist,
    status: "pending",
    deployedAt: null,
    createdBy: CREATED_BY,
    createdAt,
    updatedAt: createdAt,
  };
  const category = op.category as AssetCategory;
  const entry: DemoIssuedToken = {
    token,
    profile: {
      id: op.profile,
      organizationId: ORGANIZATION_ID,
      projectId: PROJECT_ID,
      tokenId: op.id,
      assetCategory: category,
      assetType: op.type,
      assetTypeVersion: 1,
      issuanceMetadata: metadata,
      publicMetadata: projectPublicMetadata(category, op.type, metadata),
      status: "active",
      createdBy: CREATED_BY,
      createdAt,
      updatedAt: createdAt,
    },
    transactions: [],
    audit: [
      demoAuditEvent({
        tokenId: op.id,
        action: "create",
        resourceType: "token",
        resourceId: op.id,
        createdAt,
        seed: `${op.id}-create`,
        metadata: { name: op.name, symbol: op.symbol, template: op.template },
      }),
    ],
    controlList: [],
    frozen: [],
    authorityWalletIds,
  };
  world.issuance.tokens.push(entry);
}

function applyDeploy(
  world: DemoWorld,
  entry: DemoIssuedToken,
  op: DemoOpOf<"iss-deploy">,
  nowMs: number
) {
  const landed = nowMs - op.at >= DEMO_DEPLOY_MS;
  const { token } = entry;
  const aclMode = accessControlOf(token);
  const signerKey = walletKey(world, op.signer) ?? token.mintAuthority;
  const authorityKey = (key: string) => walletKey(world, op.auth[key]) ?? signerKey;
  const mintAddress = demoAddress(`issuance-mint:${token.id}`);
  const ablListAddress = aclMode === "off" ? null : demoAddress(`issuance-acl:${token.id}`);
  entry.transactions.push(
    demoTransaction({
      tokenId: token.id,
      type: "deploy",
      status: landed ? "finalized" : "processing",
      params: {
        operation: "deploy",
        mintAddress: landed ? mintAddress : null,
        mintAuthority: signerKey,
        metadataAuthority: authorityKey("metadata"),
        freezeAuthority: token.isFreezable ? authorityKey("freeze") : null,
        authorityCustodyWalletIds: op.auth,
        ablListAddress: landed ? ablListAddress : null,
        aclMode,
        feePayment: "sponsored",
      },
      createdAt: iso(op.at),
      seed: op.tx,
    })
  );
  if (!landed) return;

  const deployedAt = iso(op.at + DEMO_DEPLOY_MS);
  token.mintAddress = mintAddress;
  token.deployedAt = deployedAt;
  token.updatedAt = deployedAt;
  token.status = "active";
  token.signingCustodyWalletId = op.signer ?? token.signingCustodyWalletId;
  token.mintAuthority = signerKey;
  token.metadataAuthority = authorityKey("metadata");
  token.freezeAuthority = token.isFreezable ? authorityKey("freeze") : null;
  token.ablListAddress = ablListAddress;
  token.totalSupplyUpdatedAt = deployedAt;
  if (token.extensions?.permanentDelegate !== undefined) {
    token.extensions = {
      ...token.extensions,
      permanentDelegate: authorityKey("permanentDelegate") ?? "",
    };
  }
  if (token.extensions?.pausable) {
    token.extensions = { ...token.extensions, pausable: { authority: signerKey ?? "" } };
  }
  entry.audit.push(
    demoAuditEvent({
      tokenId: token.id,
      action: "deploy",
      resourceType: "token",
      resourceId: token.id,
      createdAt: deployedAt,
      seed: op.tx,
      metadata: {
        template: token.template,
        aclMode,
        feePayment: "sponsored",
        mode: "execute",
        mintAddress,
        ablListAddress,
      },
    })
  );
}

function pushSettled(
  entry: DemoIssuedToken,
  op: { at: number; tx: string },
  type: Parameters<typeof demoTransaction>[0]["type"],
  params: Record<string, unknown>,
  audit: Record<string, unknown>
) {
  const createdAt = iso(op.at);
  entry.transactions.push(
    demoTransaction({
      tokenId: entry.token.id,
      type,
      status: "finalized",
      params,
      createdAt,
      seed: op.tx,
    })
  );
  entry.audit.push(
    demoAuditEvent({
      tokenId: entry.token.id,
      action: type,
      resourceType: "token_transaction",
      resourceId: `demo_ttx_${op.tx}`,
      createdAt,
      seed: op.tx,
      metadata: { mode: "execute", ...audit },
    })
  );
}

function applySupply(entry: DemoIssuedToken, op: DemoOpOf<"iss-supply">) {
  const { token } = entry;
  const delta = toUnits(op.amount, token.decimals);
  const supply = toUnits(token.totalSupply, token.decimals);
  const next = op.type === "mint" ? supply + delta : op.type === "seize" ? supply : supply - delta;
  token.totalSupply = fromUnits(next < 0n ? 0n : next, token.decimals);
  token.totalSupplyUpdatedAt = iso(op.at);
  token.updatedAt = iso(op.at);
  const memo = op.memo;
  const params =
    op.type === "mint"
      ? { destination: op.to, amount: op.amount, memo, tokenAccount: op.to }
      : op.type === "burn"
        ? { source: op.from, amount: op.amount, memo }
        : op.type === "seize"
          ? {
              source: op.from,
              destination: op.to,
              amount: op.amount,
              delegateAuthority: null,
              memo,
            }
          : { source: op.from, amount: op.amount, delegateAuthority: null, memo };
  pushSettled(entry, op, op.type, params, { ...params });
  if (op.type === "mint" && token.requiresAllowlist && op.to) {
    addToList(entry, `${op.tx}_allow`, op.at, op.to, null);
  }
}

function applyPause(entry: DemoIssuedToken, op: DemoOpOf<"iss-pause">) {
  entry.token.status = op.paused ? "paused" : "active";
  entry.token.updatedAt = iso(op.at);
  pushSettled(entry, op, op.paused ? "pause" : "unpause", { signature: null, slot: null }, {});
}

function applyFreeze(entry: DemoIssuedToken, op: DemoOpOf<"iss-freeze">) {
  const at = iso(op.at);
  if (op.frozen) {
    entry.frozen.unshift({
      id: `demo_frz_${op.tx}`,
      tokenId: entry.token.id,
      accountAddress: op.account,
      reason: op.reason,
      frozenAt: at,
      frozenBy: CREATED_BY,
      unfrozenAt: null,
      unfrozenBy: null,
    });
  } else {
    const current = entry.frozen.find(
      (row) => row.accountAddress === op.account && row.unfrozenAt === null
    );
    if (current) {
      current.unfrozenAt = at;
      current.unfrozenBy = CREATED_BY;
    }
  }
  pushSettled(
    entry,
    op,
    op.frozen ? "freeze" : "unfreeze",
    op.frozen
      ? { accountAddress: op.account, reason: op.reason, tokenAccountAddress: op.account }
      : { accountAddress: op.account },
    { accountAddress: op.account, tokenAccountAddress: op.account, reason: op.reason }
  );
}

function applyAuthority(entry: DemoIssuedToken, op: DemoOpOf<"iss-authority">) {
  const { token } = entry;
  const current =
    op.role === "mint"
      ? token.mintAuthority
      : op.role === "freeze"
        ? token.freezeAuthority
        : op.role === "metadata"
          ? (token.metadataAuthority ?? null)
          : (token.extensions?.permanentDelegate ?? null);
  if (op.role === "mint") token.mintAuthority = op.next;
  if (op.role === "freeze") token.freezeAuthority = op.next;
  if (op.role === "metadata") token.metadataAuthority = op.next;
  if (op.role === "permanentDelegate") {
    token.extensions = { ...token.extensions, permanentDelegate: op.next ?? undefined };
  }
  token.updatedAt = iso(op.at);
  pushSettled(
    entry,
    op,
    "update_authority",
    { role: op.role, currentAuthority: current, newAuthority: op.next },
    { role: op.role, newAuthority: op.next }
  );
}

function addToList(
  entry: DemoIssuedToken,
  entryId: string,
  at: number,
  address: string,
  label: string | null
) {
  if (entry.controlList.some((row) => row.address === address && row.status === "active")) return;
  const createdAt = iso(at);
  entry.controlList.unshift({
    id: entryId,
    tokenId: entry.token.id,
    address,
    label,
    status: "active",
    addedBy: CREATED_BY,
    createdAt,
    revokedAt: null,
  });
  const onChain = entry.token.ablListAddress !== null;
  entry.audit.push(
    demoAuditEvent({
      tokenId: entry.token.id,
      action: "create",
      resourceType: "token_allowlist",
      resourceId: entryId,
      createdAt,
      seed: entryId,
      metadata: {
        address,
        label,
        mode: onChain ? "on-chain" : "database",
        syncStatus: onChain ? "active" : "not_required",
      },
    })
  );
}

function applyListRemove(entry: DemoIssuedToken, op: DemoOpOf<"iss-list-remove">) {
  const row = entry.controlList.find((candidate) => candidate.id === op.entry);
  if (!row || row.status === "revoked") return;
  row.status = "revoked";
  row.revokedAt = iso(op.at);
  entry.audit.push(
    demoAuditEvent({
      tokenId: entry.token.id,
      action: "revoke",
      resourceType: "token_allowlist",
      resourceId: op.entry,
      createdAt: iso(op.at),
      seed: `${op.entry}-revoke-${op.at}`,
      metadata: {
        address: row.address,
        mode: entry.token.ablListAddress ? "on-chain" : "database",
      },
    })
  );
}

const PATCHABLE = [
  "name",
  "symbol",
  "decimals",
  "description",
  "uri",
  "imageUrl",
  "requiresAllowlist",
  "maxSupply",
  "signingCustodyWalletId",
] as const;

function applyUpdate(entry: DemoIssuedToken, op: DemoOpOf<"iss-update">) {
  const token = entry.token as unknown as Record<string, unknown>;
  const changed: Record<string, unknown> = {};
  for (const field of PATCHABLE) {
    if (field in op.patch && token[field] !== op.patch[field]) {
      token[field] = op.patch[field];
      changed[field] = op.patch[field];
    }
  }
  if (Object.keys(changed).length === 0) return;
  entry.token.updatedAt = iso(op.at);
  entry.audit.push(
    demoAuditEvent({
      tokenId: entry.token.id,
      action: "update",
      resourceType: "token",
      resourceId: entry.token.id,
      createdAt: iso(op.at),
      seed: `${entry.token.id}-update-${op.at}`,
      metadata: { ...changed, onChainMetadataUpdated: entry.token.mintAddress !== null },
    })
  );
}

function applyProfile(world: DemoWorld, op: DemoOpOf<"iss-profile">) {
  const entry = world.issuance.tokens.find((candidate) => candidate.profile.id === op.id);
  if (!entry) return;
  const { profile } = entry;
  if (op.category) profile.assetCategory = op.category;
  if (op.type) profile.assetType = op.type;
  if (op.metadata) {
    profile.issuanceMetadata = op.metadata as IssuanceMetadata;
    const ids = (
      op.metadata.custom as
        | { customer?: { authorityWalletIds?: Record<string, string> } }
        | undefined
    )?.customer?.authorityWalletIds;
    if (ids) entry.authorityWalletIds = ids;
  }
  profile.publicMetadata = projectPublicMetadata(
    profile.assetCategory,
    profile.assetType,
    profile.issuanceMetadata
  );
  profile.updatedAt = iso(op.at);
}

/** Applies one Issuance action; actions on a token the world doesn't hold do nothing. */
export function applyIssuanceOp(world: DemoWorld, op: IssuanceOp, nowMs: number): void {
  if (op.k === "iss-create") {
    applyCreate(world, op);
    return;
  }
  if (op.k === "iss-profile") {
    applyProfile(world, op);
    return;
  }
  const entry = findIssuedToken(world.issuance, op.id);
  if (!entry) return;
  switch (op.k) {
    case "iss-deploy":
      applyDeploy(world, entry, op, nowMs);
      break;
    case "iss-supply":
      applySupply(entry, op);
      break;
    case "iss-pause":
      applyPause(entry, op);
      break;
    case "iss-freeze":
      applyFreeze(entry, op);
      break;
    case "iss-authority":
      applyAuthority(entry, op);
      break;
    case "iss-list-add":
      addToList(entry, op.entry, op.at, op.address, op.label);
      break;
    case "iss-list-remove":
      applyListRemove(entry, op);
      break;
    case "iss-update":
      applyUpdate(entry, op);
      break;
  }
}

/** Every Issuance list back in newest-first order once the session's actions are in. */
export function sortIssuance(world: DemoWorld): void {
  newestFirstTokens(world.issuance.tokens);
  for (const entry of world.issuance.tokens) {
    newestFirstBy(entry.transactions);
    newestFirstBy(entry.audit);
    newestFirstBy(entry.controlList);
    entry.frozen.sort((left, right) => right.frozenAt.localeCompare(left.frozenAt));
  }
}

export function isIssuanceOp(op: { k: string }): op is IssuanceOp {
  return op.k.startsWith("iss-");
}
