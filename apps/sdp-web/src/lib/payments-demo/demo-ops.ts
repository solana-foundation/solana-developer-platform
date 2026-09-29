import { RAMP_PROVIDERS } from "@sdp/types";
import { z } from "zod";

/*
 * What a visitor can do in demo mode, one record per action, in the order they happened. The
 * session keeps these (see demo-session.ts) and every demo read replays them over the fixtures
 * (see demo-replay.ts), so a contact added, a payment sent or a schedule activated shows up on
 * every screen until the page is reloaded. Times are epoch milliseconds; ids carry the
 * `demo_new_` prefix, so nothing about them can reach the real API.
 */

const id = z.string().min(1).max(80);
const at = z.number().int().nonnegative();
const text = z.string().max(200);

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
    /** The ramp provider; sessions recorded before providers were named ran Lightspark. */
    provider: z.enum(RAMP_PROVIDERS).default("lightspark"),
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
  /** A contact accepted a ramp provider's agreements (BVNK asks before its first ramp). */
  z.object({ k: z.literal("consent"), id, at, provider: z.enum(RAMP_PROVIDERS) }),
  /** A ramp provider approved a contact's identity check (demo mode's Simulate verification). */
  z.object({ k: z.literal("verified"), id, at, provider: z.enum(RAMP_PROVIDERS) }),
  z.object({
    k: z.literal("payout-account"),
    id,
    at,
    cp: id,
    country: text,
    rail: text,
    fiat: text,
    bank: text.nullable(),
    last4: text.nullable(),
  }),
  z.object({
    k: z.literal("request"),
    id,
    at,
    wallet: id,
    token: text,
    amount: text,
    cp: id.nullable(),
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
