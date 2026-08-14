// Per-action parameter validation for workflow rules.
//
// `actionParams` used to be an untyped string/number bag validated only at execution
// time, which meant a typo'd URL or a negative amount saved cleanly and then failed
// permanently hours later, on a trigger nobody was watching. Validating at save time
// turns those into a 400 the builder can show inline — and for `send_webhook` it is also
// where the SSRF rules first apply.

import { assertValidAddress } from "@sdp/solana/address";
import type { WorkflowActionType } from "@sdp/types";
import { z } from "zod";
import { checkWebhookUrlSyntax } from "@/services/workflows/webhook-url";

// Params are persisted as JSONB and re-read on every dispatch; caps keep a rule from
// becoming a multi-megabyte payload the engine re-parses per event.
const MAX_PARAM_KEYS = 20;
const MAX_PARAM_LENGTH = 2_000;

export const actionParamsShape = z
  .record(z.string().max(64), z.union([z.string().max(MAX_PARAM_LENGTH), z.number()]))
  .refine((value) => Object.keys(value).length <= MAX_PARAM_KEYS, {
    message: `At most ${MAX_PARAM_KEYS} parameters`,
  });

const address = (label: string) =>
  z.string().superRefine((value, ctx) => {
    try {
      assertValidAddress(value, label);
    } catch {
      ctx.addIssue({ code: "custom", message: `Not a valid Solana address: ${label}` });
    }
  });

// Base-unit conversion happens at execution time (it needs the token's decimals); here we
// only reject what can never be an amount.
const amount = z
  .string()
  .regex(/^\d+(\.\d+)?$/, "Amount must be a positive decimal number")
  .refine((value) => Number(value) > 0, "Amount must be greater than zero");

const webhookUrl = z.string().superRefine((value, ctx) => {
  const checked = checkWebhookUrlSyntax(value);
  if (checked.ok) {
    return;
  }
  const message =
    checked.reason === "INSECURE_SCHEME"
      ? "Webhook URL must use https"
      : checked.reason === "PRIVATE_HOST"
        ? "Webhook URL must point at a public host"
        : "Webhook URL is not a valid URL";
  ctx.addIssue({ code: "custom", message });
});

// Coerced up front so a numeric amount from JSON still meets the string rules.
const asString = z.union([z.string(), z.number()]).transform((value) => String(value));

// Every schema is strict: an unknown key is almost always a typo (`walletAddress` for
// `wallet`), and silently storing it produces a rule that fails only when it fires.
const ACTION_PARAM_SCHEMAS = {
  allowlist_add: z
    .object({ wallet: address("wallet").optional(), label: z.string().max(120).optional() })
    .strict(),
  allowlist_remove: z.object({ wallet: address("wallet").optional() }).strict(),
  send_webhook: z
    .object({ url: asString.pipe(webhookUrl), secret: z.string().min(8).max(200).optional() })
    .strict(),
  notify: z
    .object({
      audience: z.enum(["admins", "members"]).optional(),
      email: z.string().email().max(254).optional(),
      title: z.string().max(200).optional(),
      message: z.string().max(2_000).optional(),
    })
    .strict(),
  record: z.object({ note: z.string().max(1_000).optional() }).strict(),
  pause: z.object({}).strict(),
  unpause: z.object({}).strict(),
  freeze: z.object({ wallet: address("wallet").optional() }).strict(),
  unfreeze: z.object({ wallet: address("wallet").optional() }).strict(),
  mint: z.object({ wallet: address("wallet").optional(), amount: asString.pipe(amount) }).strict(),
  burn: z.object({ amount: asString.pipe(amount) }).strict(),
  force_burn: z
    .object({ source: address("source").optional(), amount: asString.pipe(amount) })
    .strict(),
  seize: z
    .object({
      source: address("source").optional(),
      destination: address("destination"),
      amount: asString.pipe(amount),
    })
    .strict(),
} as const satisfies Record<WorkflowActionType, z.ZodType>;

export type WorkflowActionParams = Record<string, string | number>;

export function validateActionParams(
  actionType: WorkflowActionType,
  params: WorkflowActionParams
): { ok: true } | { ok: false; errors: Record<string, string[]> } {
  const schema: z.ZodType = ACTION_PARAM_SCHEMAS[actionType];
  const parsed = schema.safeParse(params);
  return parsed.success
    ? { ok: true }
    : { ok: false, errors: z.flattenError(parsed.error).fieldErrors };
}

// Params whose value is a credential. Read paths return `hasSecret` instead of the value:
// the rule list is `tokens:read`, a strictly lower bar than the scope needed to set one,
// so returning it verbatim hands the outbound HMAC key to every reader.
const SECRET_PARAM_KEYS = new Set(["secret", "token", "apiKey", "password"]);

export function isSecretParamKey(key: string): boolean {
  return SECRET_PARAM_KEYS.has(key) || /secret|token|password|api[-_]?key/i.test(key);
}

export function redactActionParams(params: WorkflowActionParams): {
  params: WorkflowActionParams;
  hasSecret: boolean;
} {
  let hasSecret = false;
  const redacted: WorkflowActionParams = {};
  for (const [key, value] of Object.entries(params)) {
    if (isSecretParamKey(key)) {
      hasSecret = true;
      continue;
    }
    redacted[key] = value;
  }
  return { params: redacted, hasSecret };
}
