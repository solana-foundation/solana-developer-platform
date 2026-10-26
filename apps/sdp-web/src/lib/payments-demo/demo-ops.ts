import { ASSET_CATEGORIES } from "@sdp/types/asset-profiles";
// biome-ignore lint/style/noRestrictedImports: recognises a provider id stored in the demo session; what the demo offers comes from the channel-capped flags (see demo-mode.ts)
import { RAMP_PROVIDERS } from "@sdp/types/provider-access";
import type { TokenTemplate } from "@sdp/types/tokens";
import { z } from "zod";

/*
 * What a visitor can do in demo mode, one record per action, in the order they happened. The
 * session keeps these (see demo-session.ts) and every demo read replays them over the fixtures
 * (see demo-replay.ts), so a contact added, a payment sent or a schedule activated shows up on
 * every screen until the page is reloaded. Times are epoch milliseconds; ids carry the
 * `demo_new_` prefix, so nothing about them can reach the real API.
 */

export const TOKEN_TEMPLATES = [
  "stablecoin",
  "rwa",
  "arcade",
  "tokenized-security",
  "custom",
] as const satisfies readonly TokenTemplate[];

const id = z.string().min(1).max(80);
const at = z.number().int().nonnegative();
const text = z.string().max(200);
const longText = z.string().max(600);

/** The token fields a PATCH can move: what the handler accepted, so replay never re-checks them. */
const tokenPatchSchema = z.object({
  signingCustodyWalletId: id.optional(),
  name: text.optional(),
  symbol: text.optional(),
  decimals: z.number().int().min(0).max(18).optional(),
  description: longText.nullable().optional(),
  uri: z.string().max(512).nullable().optional(),
  imageUrl: z.string().max(512).nullable().optional(),
  requiresAllowlist: z.boolean().optional(),
  maxSupply: text.nullable().optional(),
});

const demoOpSchema = z.discriminatedUnion("k", [
  z.object({
    k: z.literal("contact"),
    id,
    at,
    name: text,
    entity: z.enum(["individual", "business"]),
    ext: text.nullable(),
  }),
  z.object({ k: z.literal("contact-archive"), id, at }),
  z.object({ k: z.literal("address"), id, at, cp: id, address: text, label: text.nullable() }),
  z.object({
    k: z.literal("send"),
    id,
    at,
    wallet: id,
    to: text,
    token: text,
    amount: text,
    memo: text.nullable(),
  }),
  z.object({
    k: z.literal("batch"),
    id,
    at,
    wallet: id,
    token: text,
    ext: text.nullable(),
    /** Recipients as [counterpartyId, counterpartyAccountId, amount]. */
    to: z.array(z.tuple([id, id, text])).max(200),
  }),
  z.object({
    k: z.literal("ramp"),
    id,
    at,
    provider: z.enum(RAMP_PROVIDERS),
    dir: z.enum(["onramp", "offramp"]),
    cp: id,
    wallet: id,
    rail: text,
    fiat: text,
    fiatAmount: text,
    crypto: text,
    quote: id,
  }),
  /** An on-ramp's pay-in arrived (the sandbox simulation), or an off-ramp's crypto was sent. */
  z.object({ k: z.literal("ramp-paid"), id, at }),
  z.object({ k: z.literal("ramp-cancel"), id, at }),
  z.object({
    k: z.literal("request"),
    id,
    at,
    wallet: id,
    token: text,
    amount: text,
    expires: text.nullable(),
  }),
  z.object({
    k: z.literal("schedule"),
    id,
    at,
    wallet: id,
    cp: id,
    account: id,
    token: text,
    amount: text,
    period: z.number().int().positive(),
    first: text.nullable(),
  }),
  z.object({
    k: z.literal("schedule-action"),
    id,
    at,
    action: z.enum(["activate", "collect", "cancel", "resume"]),
  }),
  z.object({
    k: z.literal("schedule-update"),
    id,
    at,
    amount: text.optional(),
    token: text.optional(),
    period: z.number().int().positive().optional(),
    wallet: id.optional(),
    account: id.optional(),
  }),
  // Issuance: `id` is the token's. A draft keeps what the create flow sent, metadata included.
  z.object({
    k: z.literal("iss-create"),
    id,
    at,
    profile: id,
    name: text,
    symbol: text,
    description: longText.nullable(),
    decimals: z.number().int().min(0).max(18),
    template: z.enum(TOKEN_TEMPLATES),
    category: z.enum(ASSET_CATEGORIES),
    type: text,
    requiresAllowlist: z.boolean(),
    freezable: z.boolean(),
    maxSupply: text.nullable(),
    signer: id.nullable(),
    metadata: z.record(z.string(), z.unknown()),
  }),
  /** A deploy submitted; it lands DEMO_DEPLOY_MS later. `auth` maps authority to wallet id. */
  z.object({
    k: z.literal("iss-deploy"),
    id,
    at,
    tx: id,
    signer: id.nullable(),
    auth: z.record(z.string(), id),
  }),
  z.object({
    k: z.literal("iss-supply"),
    id,
    at,
    tx: id,
    type: z.enum(["mint", "burn", "seize", "force_burn"]),
    amount: text,
    from: text.nullable(),
    to: text.nullable(),
    memo: text.nullable(),
  }),
  z.object({ k: z.literal("iss-pause"), id, at, tx: id, paused: z.boolean() }),
  z.object({
    k: z.literal("iss-freeze"),
    id,
    at,
    tx: id,
    frozen: z.boolean(),
    account: text,
    reason: longText.nullable(),
  }),
  z.object({
    k: z.literal("iss-authority"),
    id,
    at,
    tx: id,
    role: z.enum(["mint", "freeze", "permanentDelegate", "metadata"]),
    next: text.nullable(),
  }),
  z.object({
    k: z.literal("iss-list-add"),
    id,
    at,
    entry: id,
    address: text,
    label: text.nullable(),
  }),
  z.object({ k: z.literal("iss-list-remove"), id, at, entry: id }),
  /** Token fields a PATCH changed, as the API accepts them. */
  z.object({ k: z.literal("iss-update"), id, at, patch: tokenPatchSchema }),
  /** An asset profile's PATCH; `id` is the profile's. */
  z.object({
    k: z.literal("iss-profile"),
    id,
    at,
    category: z.enum(ASSET_CATEGORIES).optional(),
    type: text.optional(),
    metadata: z.record(z.string(), z.unknown()).optional(),
  }),
]);

export type DemoOp = z.infer<typeof demoOpSchema>;
export type DemoOpKind = DemoOp["k"];
export type DemoOpOf<K extends DemoOpKind> = Extract<DemoOp, { k: K }>;

/** The session's log back from JSON, keeping only records that still read as actions. */
export function parseDemoOps(value: unknown): DemoOp[] {
  if (!Array.isArray(value)) return [];
  return value.flatMap((entry) => {
    const parsed = demoOpSchema.safeParse(entry);
    return parsed.success ? [parsed.data] : [];
  });
}

/** A fresh id for something created in demo mode, shaped like the real one it stands for. */
export function newDemoId(prefix: string): string {
  return `demo_new_${prefix}_${crypto.randomUUID().replaceAll("-", "").slice(0, 12)}`;
}
