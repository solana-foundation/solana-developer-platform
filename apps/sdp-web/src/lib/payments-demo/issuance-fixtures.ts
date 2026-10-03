import type {
  AssetAuditEvent,
  AssetCategory,
  AssetProfile,
  FrozenAccount,
  IssuanceMetadata,
  PublicToken,
  PublicTokenTransaction,
  TokenAllowlistEntry,
  TokenExtensionsConfig,
  TokenTemplate,
  TokenTransactionStatus,
  TokenTransactionType,
} from "@sdp/types";
import { getAssetTypeRegistryEntry } from "@sdp/types";
import {
  type Clock,
  CREATED_BY,
  DAY_MS,
  type DemoWallet,
  demoAddress,
  demoSignature,
  HOUR_MS,
  MINUTE_MS,
  ORGANIZATION_ID,
  PROJECT_ID,
} from "./demo-fixtures";

/*
 * Demo data for the Issuance screens: seven tokens, one in each state the screens show (live,
 * paused, draft, mid-deploy, a failed deploy), each with its asset profile, transactions,
 * activity, control list and frozen accounts. They sign with the Payments demo's wallets, so the
 * two modules read as one project. Timestamps are offsets from `now`; ids carry a `demo_`
 * prefix; addresses and signatures come from fixed seeds.
 */

/** Who the activity feed names for the team's own actions, the visitor's included. */
export const DEMO_TEAM_MEMBER = "Alex Morgan";

/** How long a demo deploy takes to land, from the moment it is submitted. */
export const DEMO_DEPLOY_MS = 8_000;

/** Why the seeded failed deploy failed, as the API reports it. */
export const DEMO_DEPLOY_FAILURE =
  "Deploy failed, not enough SOL to pay the network fee. Top up the signing wallet and retry.";

export interface DemoIssuedToken {
  token: PublicToken;
  profile: AssetProfile;
  /** Newest first, as the API lists them. */
  transactions: PublicTokenTransaction[];
  /** Newest first. */
  audit: AssetAuditEvent[];
  /** Active and revoked entries; the list shows the active ones. */
  controlList: TokenAllowlistEntry[];
  /** Every freeze; an account is frozen while its `unfrozenAt` is null. */
  frozen: FrozenAccount[];
  /** Wallet ids the draft assigned to each authority, as the create flow sends them. */
  authorityWalletIds: Record<string, string>;
}

export interface IssuanceWorld {
  /** Newest first. */
  tokens: DemoIssuedToken[];
}

type WalletKey = "treasury" | "payroll" | "settlement";

type DemoTokenState = "live" | "paused" | "draft" | "deploying" | "failed";

interface DemoTokenSpec {
  key: string;
  name: string;
  symbol: string;
  description: string;
  template: TokenTemplate;
  category: AssetCategory;
  assetType: string;
  decimals: number;
  state: DemoTokenState;
  createdDaysAgo: number;
  signer: WalletKey;
  maxSupply: string | null;
  requiresAllowlist: boolean;
  /** Permanent delegate and pause, which a stablecoin always has. */
  delegate: boolean;
  pausable: boolean;
  freezable: boolean;
  issuerName: string;
  website: string | null;
  pegCurrency: string | null;
  /** Mints after deploy, as [days ago, amount, holder index]; burns as negative amounts. */
  supplyMoves: ReadonlyArray<readonly [days: number, amount: string, holder: number]>;
  controlList: ReadonlyArray<readonly [holder: number, label: string, days: number]>;
  frozen: ReadonlyArray<readonly [holder: number, reason: string, days: number]>;
}

const TOKEN_SPECS: readonly DemoTokenSpec[] = [
  {
    key: "vusd",
    name: "Veritas USD",
    symbol: "VUSD",
    description: "A dollar stablecoin, backed one to one by cash and short-term treasuries.",
    template: "stablecoin",
    category: "stablecoin",
    assetType: "fiat_backed",
    decimals: 6,
    state: "live",
    createdDaysAgo: 64,
    signer: "treasury",
    maxSupply: "5000000",
    requiresAllowlist: false,
    delegate: true,
    pausable: true,
    freezable: true,
    issuerName: "Veritas Finance",
    website: "https://veritas.example.com",
    pegCurrency: "USD",
    supplyMoves: [
      [58, "150000", 0],
      [41, "120000", 1],
      [22, "-20000", 1],
      [9, "45000", 2],
      [2, "-45000", 2],
    ],
    controlList: [
      [7, "Sanctioned exchange", 30],
      [8, "Disputed counterparty", 12],
    ],
    frozen: [[3, "Under compliance review", 5]],
  },
  {
    key: "eurh",
    name: "Euro Hoodies",
    symbol: "EURH",
    description: "A euro stablecoin for settlement between Hoodies entities.",
    template: "stablecoin",
    category: "stablecoin",
    assetType: "fiat_backed",
    decimals: 6,
    state: "live",
    createdDaysAgo: 172,
    signer: "settlement",
    maxSupply: null,
    requiresAllowlist: false,
    delegate: true,
    pausable: true,
    freezable: true,
    issuerName: "Hoodies BV",
    website: null,
    pegCurrency: "EUR",
    supplyMoves: [
      [170, "60000", 0],
      [96, "20000", 4],
    ],
    controlList: [],
    frozen: [],
  },
  {
    key: "mrdn",
    name: "Meridian Note",
    symbol: "MRDN",
    description: "A note held by approved investors only. Transfers are paused for the audit.",
    template: "custom",
    category: "generic",
    assetType: "generic",
    decimals: 2,
    state: "paused",
    createdDaysAgo: 139,
    signer: "payroll",
    maxSupply: "100000",
    requiresAllowlist: true,
    delegate: false,
    pausable: true,
    freezable: true,
    issuerName: "Meridian Capital",
    website: "https://meridian.example.com",
    pegCurrency: null,
    supplyMoves: [
      [136, "8000", 0],
      [80, "4000", 1],
    ],
    controlList: [
      [0, "Northwind Capital", 137],
      [1, "Kestrel Studio", 81],
      [5, "Lumen Partners", 40],
    ],
    frozen: [],
  },
  {
    key: "star",
    name: "Loyalty Stars",
    symbol: "STAR",
    description: "Points customers earn at checkout and spend on rewards.",
    template: "custom",
    category: "generic",
    assetType: "collectible",
    decimals: 0,
    state: "live",
    createdDaysAgo: 33,
    signer: "treasury",
    maxSupply: null,
    requiresAllowlist: false,
    delegate: false,
    pausable: false,
    freezable: false,
    issuerName: "Hoodies BV",
    website: null,
    pegCurrency: null,
    supplyMoves: [
      [30, "500000", 0],
      [6, "250000", 6],
    ],
    controlList: [],
    frozen: [],
  },
  {
    key: "acme",
    name: "Acme Points",
    symbol: "ACME",
    description: "Loyalty points, no cap.",
    template: "custom",
    category: "generic",
    assetType: "generic",
    decimals: 9,
    state: "draft",
    createdDaysAgo: 30,
    signer: "treasury",
    maxSupply: null,
    requiresAllowlist: false,
    delegate: false,
    pausable: false,
    freezable: false,
    issuerName: "Acme",
    website: null,
    pegCurrency: null,
    supplyMoves: [],
    controlList: [],
    frozen: [],
  },
  {
    key: "usdp",
    name: "USDP",
    symbol: "USDP",
    description: "A dollar stablecoin for partner payouts.",
    template: "stablecoin",
    category: "stablecoin",
    assetType: "fiat_backed",
    decimals: 6,
    state: "failed",
    createdDaysAgo: 94,
    signer: "payroll",
    maxSupply: "1000000",
    requiresAllowlist: false,
    delegate: true,
    pausable: true,
    freezable: true,
    issuerName: "Hoodies BV",
    website: null,
    pegCurrency: "USD",
    supplyMoves: [],
    controlList: [],
    frozen: [],
  },
  {
    key: "hdr",
    name: "Hoodies Demo Reserve",
    symbol: "HDR",
    description: "Reserve token for the Hoodies demo.",
    template: "stablecoin",
    category: "stablecoin",
    assetType: "fiat_backed",
    decimals: 6,
    state: "deploying",
    createdDaysAgo: 0,
    signer: "treasury",
    maxSupply: "5000000",
    requiresAllowlist: false,
    delegate: true,
    pausable: true,
    freezable: true,
    issuerName: "Hoodies BV",
    website: null,
    pegCurrency: "USD",
    supplyMoves: [],
    controlList: [],
    frozen: [],
  },
];

/** Addresses the seeded mints, control lists and freezes point at. */
export function holderAddress(tokenKey: string, index: number): string {
  return demoAddress(`issuance-holder:${tokenKey}:${index}`);
}

const DEMO_HOLDER_COUNT = 9;

/** Every address that holds a seeded token, so a mint or burn can find a token account. */
export function demoHolderAddresses(tokenKey: string): string[] {
  return Array.from({ length: DEMO_HOLDER_COUNT }, (_, index) => holderAddress(tokenKey, index));
}

/** Base units, for supply arithmetic that never loses a digit. */
export function toUnits(amount: string, decimals: number): bigint {
  const negative = amount.startsWith("-");
  const [whole = "0", fraction = ""] = (negative ? amount.slice(1) : amount).split(".");
  const units =
    BigInt(whole || "0") * 10n ** BigInt(decimals) +
    BigInt(fraction.padEnd(decimals, "0").slice(0, decimals) || "0");
  return negative ? -units : units;
}

/** A base-unit amount back as the API's decimal string, trailing zeros dropped. */
export function fromUnits(units: bigint, decimals: number): string {
  const scale = 10n ** BigInt(decimals);
  const negative = units < 0n;
  const magnitude = negative ? -units : units;
  const whole = magnitude / scale;
  const fraction = (magnitude % scale).toString().padStart(decimals, "0").replace(/0+$/, "");
  return `${negative ? "-" : ""}${whole}${fraction ? `.${fraction}` : ""}`;
}

export function demoTokenId(key: string): string {
  return `demo_tok_${key}`;
}

/**
 * The public projection the API caches on an asset profile: the fields the issuer published,
 * or the asset type's defaults when it chose none.
 */
export function projectPublicMetadata(
  category: AssetCategory,
  assetType: string,
  metadata: IssuanceMetadata
): Record<string, unknown> {
  const chosen = metadata.visibility?.public;
  const paths =
    Array.isArray(chosen) && chosen.length > 0
      ? chosen
      : (getAssetTypeRegistryEntry(category, assetType)?.publicProjection ?? []);
  const projected: Record<string, unknown> = {};
  for (const path of paths) {
    const [group, field] = String(path).split(".");
    const section = group ? (metadata as Record<string, unknown>)[group] : undefined;
    if (field && section && typeof section === "object") {
      const value = (section as Record<string, unknown>)[field];
      if (value !== undefined && value !== null && value !== "") {
        projected[group as string] = {
          ...((projected[group as string] as Record<string, unknown>) ?? {}),
          [field]: value,
        };
      }
    }
  }
  return projected;
}

function accessControlOf(spec: Pick<DemoTokenSpec, "requiresAllowlist" | "template">) {
  if (spec.requiresAllowlist) return "allowlist";
  return spec.template === "stablecoin" ? "blocklist" : "off";
}

function extensionsOf(spec: DemoTokenSpec, authority: string): TokenExtensionsConfig | null {
  const extensions: TokenExtensionsConfig = {};
  if (spec.delegate) extensions.permanentDelegate = authority;
  if (spec.pausable) extensions.pausable = { authority };
  return Object.keys(extensions).length > 0 ? extensions : null;
}

interface TransactionDraft {
  tokenId: string;
  type: TokenTransactionType;
  status: TokenTransactionStatus;
  params: Record<string, unknown>;
  createdAt: string;
  seed: string;
  error?: string | null;
}

/** A transaction row as the API lists it, settled unless it says otherwise. */
export function demoTransaction(draft: TransactionDraft): PublicTokenTransaction {
  const settled = draft.status === "confirmed" || draft.status === "finalized";
  return {
    id: `demo_ttx_${draft.seed}`,
    tokenId: draft.tokenId,
    organizationId: ORGANIZATION_ID,
    type: draft.type,
    status: draft.status,
    idempotencyKey: null,
    idempotencyFingerprint: null,
    signature: settled ? demoSignature(`issuance-tx:${draft.seed}`) : null,
    serializedTx: null,
    params: draft.params,
    slot: settled ? 348_000_000 + (hashSeed(draft.seed) % 900_000) : null,
    blockTime: settled ? draft.createdAt : null,
    fee: settled ? 5000 : null,
    error: draft.error ?? null,
    initiatedByKeyId: null,
    createdAt: draft.createdAt,
    updatedAt: draft.createdAt,
  };
}

function hashSeed(seed: string): number {
  let state = 0x811c9dc5;
  for (let index = 0; index < seed.length; index += 1) {
    state = Math.imul(state ^ seed.charCodeAt(index), 0x01000193) >>> 0;
  }
  return state;
}

interface AuditDraft {
  tokenId: string;
  action: string;
  resourceType: string;
  resourceId: string | null;
  createdAt: string;
  seed: string;
  metadata: Record<string, unknown>;
  status?: "success" | "failure";
  actorType?: "user" | "system";
}

/** An activity row as the token's audit feed lists it. */
export function demoAuditEvent(draft: AuditDraft): AssetAuditEvent {
  const actorType = draft.actorType ?? "user";
  return {
    id: `demo_aud_${draft.seed}`,
    action: draft.action,
    resourceType: draft.resourceType,
    resourceId: draft.resourceId,
    actorType,
    actorLabel: actorType === "system" ? "SDP" : DEMO_TEAM_MEMBER,
    status: draft.status ?? "success",
    createdAt: draft.createdAt,
    metadata: { tokenId: draft.tokenId, ...draft.metadata },
  };
}

export function newestFirstBy<T extends { createdAt: string }>(rows: T[]): T[] {
  return rows.sort((left, right) => right.createdAt.localeCompare(left.createdAt));
}

/** The rows a token's history leaves, collected as its seeds are laid down. */
interface History {
  transactions: PublicTokenTransaction[];
  audit: AssetAuditEvent[];
}

/** One settled operation: its transaction row and its activity row. */
function seedOperation(
  history: History,
  tokenId: string,
  type: TokenTransactionType,
  createdAt: string,
  seed: string,
  params: Record<string, unknown>,
  audit: Record<string, unknown>
) {
  history.transactions.push(
    demoTransaction({ tokenId, type, status: "finalized", params, createdAt, seed })
  );
  history.audit.push(
    demoAuditEvent({
      tokenId,
      action: type,
      resourceType: "token_transaction",
      resourceId: `demo_ttx_${seed}`,
      createdAt,
      seed,
      metadata: audit,
    })
  );
}

interface SeedContext {
  spec: DemoTokenSpec;
  id: string;
  signerKey: string;
  aclMode: string;
  clock: Clock;
  history: History;
}

function seedDeploy(
  context: SeedContext,
  deployedAt: string,
  mintAddress: string,
  walletIds: Record<string, string>
) {
  const { spec, id, signerKey, aclMode, history } = context;
  const ablListAddress = aclMode === "off" ? null : demoAddress(`issuance-acl:${spec.key}`);
  history.transactions.push(
    demoTransaction({
      tokenId: id,
      type: "deploy",
      status: "finalized",
      params: {
        operation: "deploy",
        mintAddress,
        mintAuthority: signerKey,
        metadataAuthority: signerKey,
        freezeAuthority: spec.freezable ? signerKey : null,
        authorityCustodyWalletIds: walletIds,
        ablListAddress,
        aclMode,
        feePayment: "sponsored",
      },
      createdAt: deployedAt,
      seed: `${spec.key}-deploy`,
    })
  );
  history.audit.push(
    demoAuditEvent({
      tokenId: id,
      action: "deploy",
      resourceType: "token",
      resourceId: id,
      createdAt: deployedAt,
      seed: `${spec.key}-deploy`,
      metadata: { template: spec.template, aclMode, feePayment: "sponsored", mintAddress },
    })
  );
}

/** The seeded mints and burns; returns the supply they leave, in base units. */
function seedSupply(context: SeedContext): bigint {
  const { spec, id, clock, history } = context;
  let supply = 0n;
  spec.supplyMoves.forEach(([days, amount, holder], index) => {
    const createdAt = clock.ago(days * DAY_MS + (index + 1) * 37 * MINUTE_MS);
    const burn = amount.startsWith("-");
    const value = burn ? amount.slice(1) : amount;
    const address = holderAddress(spec.key, holder);
    supply += toUnits(amount, spec.decimals);
    const params = burn
      ? { source: address, amount: value, memo: null }
      : { destination: address, amount: value, memo: null, tokenAccount: address };
    const audit = burn
      ? { source: address, amount: value, mode: "execute" }
      : { destination: address, amount: value, mode: "execute" };
    seedOperation(
      history,
      id,
      burn ? "burn" : "mint",
      createdAt,
      `${spec.key}-supply-${index}`,
      params,
      audit
    );
  });
  return supply;
}

function seedControlList(context: SeedContext): TokenAllowlistEntry[] {
  const { spec, id, clock, history } = context;
  return spec.controlList.map(([holder, label, days], index) => {
    const createdAt = clock.ago(days * DAY_MS + index * 11 * MINUTE_MS);
    const entryId = `demo_tal_${spec.key}_${index}`;
    const address = holderAddress(spec.key, holder);
    history.audit.push(
      demoAuditEvent({
        tokenId: id,
        action: "create",
        resourceType: "token_allowlist",
        resourceId: entryId,
        createdAt,
        seed: `${spec.key}-acl-${index}`,
        metadata: { address, label, mode: "on-chain", syncStatus: "active" },
      })
    );
    return {
      id: entryId,
      tokenId: id,
      address,
      label,
      status: "active",
      addedBy: CREATED_BY,
      createdAt,
      revokedAt: null,
    } satisfies TokenAllowlistEntry;
  });
}

function seedFrozen(context: SeedContext): FrozenAccount[] {
  const { spec, id, clock, history } = context;
  return spec.frozen.map(([holder, reason, days], index) => {
    const frozenAt = clock.ago(days * DAY_MS + index * 13 * MINUTE_MS);
    const accountAddress = holderAddress(spec.key, holder);
    seedOperation(
      history,
      id,
      "freeze",
      frozenAt,
      `${spec.key}-freeze-${index}`,
      { accountAddress, reason, tokenAccountAddress: accountAddress },
      { accountAddress, tokenAccountAddress: accountAddress, reason }
    );
    return {
      id: `demo_frz_${spec.key}_${index}`,
      tokenId: id,
      accountAddress,
      reason,
      frozenAt,
      frozenBy: CREATED_BY,
      unfrozenAt: null,
      unfrozenBy: null,
    } satisfies FrozenAccount;
  });
}

/** The deploy that failed, or the one still in flight, of a token with no mint yet. */
function seedDeployAttempt(context: SeedContext) {
  const { spec, id, aclMode, clock, history } = context;
  const failed = spec.state === "failed";
  const createdAt = failed
    ? clock.ago(spec.createdDaysAgo * DAY_MS - HOUR_MS)
    : clock.ago(2 * MINUTE_MS);
  const seed = `${spec.key}-deploy`;
  history.transactions.push(
    demoTransaction({
      tokenId: id,
      type: "deploy",
      status: failed ? "failed" : "processing",
      params: { operation: "deploy", feePayment: "wallet", aclMode },
      createdAt,
      seed,
      error: failed ? DEMO_DEPLOY_FAILURE : null,
    })
  );
  if (!failed) return;
  history.audit.push(
    demoAuditEvent({
      tokenId: id,
      action: "deploy",
      resourceType: "token",
      resourceId: id,
      createdAt,
      seed,
      status: "failure",
      metadata: { aclMode, feePayment: "wallet", error: DEMO_DEPLOY_FAILURE },
    })
  );
}

function seededMetadata(spec: DemoTokenSpec, aclMode: string, walletIds: Record<string, string>) {
  return {
    asset: {
      name: spec.name,
      description: spec.description,
      issuerName: spec.issuerName,
      ...(spec.website ? { website: spec.website } : {}),
      ...(spec.pegCurrency ? { pegCurrency: spec.pegCurrency } : {}),
    },
    compliance: { accessControl: aclMode },
    chain: { decimals: spec.decimals },
    custom: { customer: { authorityWalletIds: walletIds } },
  } as IssuanceMetadata;
}

function seededWalletIds(spec: DemoTokenSpec, walletId: string): Record<string, string> {
  return {
    "mint-authority": walletId,
    "metadata-authority": walletId,
    ...(spec.freezable ? { "freeze-authority": walletId } : {}),
    ...(spec.delegate ? { "permanent-delegate": walletId } : {}),
  };
}

function buildToken(
  spec: DemoTokenSpec,
  wallets: Record<string, DemoWallet>,
  clock: Clock
): DemoIssuedToken {
  const signer = wallets[spec.signer];
  const signerKey = signer?.publicKey ?? demoAddress(`wallet:${spec.signer}`);
  const walletId = signer?.id ?? `demo_cwlt_${spec.signer}`;
  const id = demoTokenId(spec.key);
  const createdAt =
    spec.state === "deploying" ? clock.ago(6 * MINUTE_MS) : clock.ago(spec.createdDaysAgo * DAY_MS);
  const deployed = spec.state === "live" || spec.state === "paused";
  const deployedAt = deployed ? clock.ago(spec.createdDaysAgo * DAY_MS - 2 * HOUR_MS) : null;
  const mintAddress = deployed ? demoAddress(`issuance-mint:${spec.key}`) : null;
  const aclMode = accessControlOf(spec);
  const walletIds = seededWalletIds(spec, walletId);
  const history: History = { transactions: [], audit: [] };
  const context: SeedContext = { spec, id, signerKey, aclMode, clock, history };

  history.audit.push(
    demoAuditEvent({
      tokenId: id,
      action: "create",
      resourceType: "token",
      resourceId: id,
      createdAt,
      seed: `${spec.key}-create`,
      metadata: { name: spec.name, symbol: spec.symbol, template: spec.template },
    })
  );
  if (deployedAt && mintAddress) seedDeploy(context, deployedAt, mintAddress, walletIds);
  const supply = seedSupply(context);
  const controlList = seedControlList(context);
  const frozen = seedFrozen(context);
  if (spec.state === "paused") {
    seedOperation(
      history,
      id,
      "pause",
      clock.ago(4 * DAY_MS),
      `${spec.key}-pause`,
      {},
      { mode: "execute" }
    );
  }
  if (spec.state === "failed" || spec.state === "deploying") seedDeployAttempt(context);

  const issuanceMetadata = seededMetadata(spec, aclMode, walletIds);
  const token: PublicToken = {
    id,
    projectId: PROJECT_ID,
    organizationId: ORGANIZATION_ID,
    signingCustodyWalletId: signer?.id ?? null,
    mintAddress,
    mintAuthority: signerKey,
    metadataAuthority: signerKey,
    freezeAuthority: spec.freezable ? signerKey : null,
    ablListAddress: deployed && aclMode !== "off" ? demoAddress(`issuance-acl:${spec.key}`) : null,
    name: spec.name,
    symbol: spec.symbol,
    decimals: spec.decimals,
    description: spec.description,
    uri: null,
    imageUrl: null,
    template: spec.template,
    extensions: extensionsOf(spec, signerKey),
    totalSupply: fromUnits(supply, spec.decimals),
    totalSupplyUpdatedAt: deployed ? clock.ago(10 * MINUTE_MS) : null,
    maxSupply: spec.maxSupply,
    isMintable: true,
    isFreezable: spec.freezable,
    requiresAllowlist: spec.requiresAllowlist,
    status: spec.state === "paused" ? "paused" : deployed ? "active" : "pending",
    deployedAt,
    createdBy: CREATED_BY,
    createdAt,
    updatedAt: deployedAt ?? createdAt,
  };

  return {
    token,
    profile: {
      id: `demo_asset_profile_${spec.key}`,
      organizationId: ORGANIZATION_ID,
      projectId: PROJECT_ID,
      tokenId: id,
      assetCategory: spec.category,
      assetType: spec.assetType,
      assetTypeVersion: 1,
      issuanceMetadata,
      publicMetadata: projectPublicMetadata(spec.category, spec.assetType, issuanceMetadata),
      status: "active",
      createdBy: CREATED_BY,
      createdAt,
      updatedAt: createdAt,
    },
    transactions: newestFirstBy(history.transactions),
    audit: newestFirstBy(history.audit),
    controlList: newestFirstBy(controlList),
    frozen: frozen.sort((left, right) => right.frozenAt.localeCompare(left.frozenAt)),
    authorityWalletIds: walletIds,
  };
}

/** The seeded Issuance world, signing with the given Payments demo wallets. */
export function buildIssuanceWorld(
  wallets: Record<string, DemoWallet>,
  clock: Clock
): IssuanceWorld {
  return {
    tokens: newestFirstTokens(TOKEN_SPECS.map((spec) => buildToken(spec, wallets, clock))),
  };
}

export function newestFirstTokens(tokens: DemoIssuedToken[]): DemoIssuedToken[] {
  return tokens.sort((left, right) => right.token.createdAt.localeCompare(left.token.createdAt));
}

export function findIssuedToken(world: IssuanceWorld, id: string): DemoIssuedToken | undefined {
  return world.tokens.find((entry) => entry.token.id === id);
}
