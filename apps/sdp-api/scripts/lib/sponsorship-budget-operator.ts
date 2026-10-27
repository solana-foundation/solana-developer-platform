import { SDP_ENVIRONMENTS, type SdpEnvironment } from "@sdp/types/api-keys";
import { z } from "zod";

const MAX_REDIS_LUA_SAFE_LAMPORTS = BigInt(Number.MAX_SAFE_INTEGER);
const CANONICAL_NON_NEGATIVE_INTEGER = /^(0|[1-9][0-9]*)$/;

export interface SponsorshipPolicyLimitsBigInt {
  perTransactionLamports: bigint;
  hourlyLamports: bigint;
  dailyLamports: bigint;
}

export function parseLamportAmount(value: string | undefined, flagName: string): bigint {
  if (!value || !CANONICAL_NON_NEGATIVE_INTEGER.test(value)) {
    throw new Error(`--${flagName} must be a canonical non-negative integer`);
  }
  return BigInt(value);
}

export function parseSponsorshipPolicyLimits(input: {
  perTransactionLamports: string | undefined;
  hourlyLamports: string | undefined;
  dailyLamports: string | undefined;
}): SponsorshipPolicyLimitsBigInt {
  const limits = {
    perTransactionLamports: parseLamportAmount(input.perTransactionLamports, "per-tx-lamports"),
    hourlyLamports: parseLamportAmount(input.hourlyLamports, "hourly-lamports"),
    dailyLamports: parseLamportAmount(input.dailyLamports, "daily-lamports"),
  };
  if (limits.hourlyLamports < limits.perTransactionLamports) {
    throw new Error("--hourly-lamports must be at least --per-tx-lamports");
  }
  if (limits.dailyLamports < limits.hourlyLamports) {
    throw new Error("--daily-lamports must be at least --hourly-lamports");
  }
  return limits;
}

/** Convert only at the DB/Redis-Lua boundary, after all bigint validation. */
export function toRedisLuaSafePolicyLimits(limits: SponsorshipPolicyLimitsBigInt): {
  perTransactionLamports: number;
  hourlyLamports: number;
  dailyLamports: number;
} {
  for (const [name, value] of Object.entries(limits)) {
    if (value > MAX_REDIS_LUA_SAFE_LAMPORTS) {
      throw new Error(`${name} exceeds the Redis-Lua safe integer range`);
    }
  }
  return {
    perTransactionLamports: Number(limits.perTransactionLamports),
    hourlyLamports: Number(limits.hourlyLamports),
    dailyLamports: Number(limits.dailyLamports),
  };
}

export const SPONSORSHIP_BUDGET_COMMANDS = [
  "status",
  "set-project",
  "set-global",
  "kill",
  "resume",
] as const;

/** `preview` resolves the target and prints the change without writing; `apply` writes it. */
export const SPONSORSHIP_BUDGET_WRITE_MODES = ["preview", "apply"] as const;

export type SponsorshipBudgetWriteMode = (typeof SPONSORSHIP_BUDGET_WRITE_MODES)[number];

const requiredText = (flag: string) =>
  z
    .string({ error: `--${flag} is required` })
    .trim()
    .min(1, `--${flag} cannot be empty`)
    .max(500, `--${flag} must be at most 500 characters`);

const writeFlagsSchema = z.strictObject({
  environment: z.enum(SDP_ENVIRONMENTS, { error: "--environment must be sandbox or production" }),
  mode: z.enum(SPONSORSHIP_BUDGET_WRITE_MODES, { error: "--mode must be preview or apply" }),
  operator: requiredText("operator"),
  reason: requiredText("reason"),
});

const expectedVersionSchema = z
  .string()
  .regex(CANONICAL_NON_NEGATIVE_INTEGER, "--expected-version must be a non-negative integer")
  .transform(Number)
  .pipe(z.number().int().max(Number.MAX_SAFE_INTEGER))
  .optional();

const policyWriteFlagsSchema = writeFlagsSchema.extend({
  "per-tx-lamports": z.string().optional(),
  "hourly-lamports": z.string().optional(),
  "daily-lamports": z.string().optional(),
  enabled: z.enum(["true", "false"], { error: "--enabled must be true or false" }),
  "expected-version": expectedVersionSchema,
});

const sponsorshipBudgetCommandSchema = z.discriminatedUnion(
  "command",
  [
    z.strictObject({
      command: z.literal("status"),
      environment: z.enum(SDP_ENVIRONMENTS, {
        error: "--environment must be sandbox or production",
      }),
    }),
    policyWriteFlagsSchema.extend({
      command: z.literal("set-project"),
      "organization-id": requiredText("organization-id"),
    }),
    policyWriteFlagsSchema.extend({ command: z.literal("set-global") }),
    writeFlagsSchema.extend({ command: z.literal("kill") }),
    writeFlagsSchema.extend({
      command: z.literal("resume"),
      "expected-version": expectedVersionSchema,
    }),
  ],
  { error: `Usage: sponsorship:budget <${SPONSORSHIP_BUDGET_COMMANDS.join("|")}> [flags]` }
);

/**
 * The policy version a write is bound to. An apply always names the version the
 * operator (or the workflow's preview) read; a preview may omit it and reports
 * the current version instead.
 */
export type SponsorshipWriteVersion =
  | { mode: "preview"; expectedVersion: number | null }
  | { mode: "apply"; expectedVersion: number };

export interface SponsorshipPolicyWrite {
  enabled: boolean;
  perTransactionLamports: number;
  hourlyLamports: number;
  dailyLamports: number;
}

interface SponsorshipOperatorAttribution {
  environment: SdpEnvironment;
  operator: string;
  reason: string;
}

export type SponsorshipBudgetCommand =
  | { command: "status"; environment: SdpEnvironment }
  | ({
      command: "set-project";
      organizationId: string;
    } & SponsorshipOperatorAttribution &
      SponsorshipPolicyWrite &
      SponsorshipWriteVersion)
  | ({ command: "set-global" } & SponsorshipOperatorAttribution &
      SponsorshipPolicyWrite &
      SponsorshipWriteVersion)
  | ({ command: "kill" } & SponsorshipOperatorAttribution &
      ({ mode: "preview" } | { mode: "apply" }))
  | ({ command: "resume" } & SponsorshipOperatorAttribution & SponsorshipWriteVersion);

/**
 * Bind a write to the version it was computed from. An apply without one is
 * refused: it could overwrite a change (a breaker trip in particular) that its
 * operator never saw.
 *
 * @param mode - Whether the write previews or applies.
 * @param expectedVersion - The version given with `--expected-version`, if any.
 * @returns The mode and version, with the version required for an apply.
 */
function writeVersion(
  mode: SponsorshipBudgetWriteMode,
  expectedVersion: number | undefined
): SponsorshipWriteVersion {
  if (mode === "preview") {
    return { mode, expectedVersion: expectedVersion === undefined ? null : expectedVersion };
  }
  if (expectedVersion === undefined) {
    throw new Error(
      "--expected-version is required with --mode apply (0 when the policy does not exist yet)"
    );
  }
  return { mode, expectedVersion };
}

/**
 * Parse the operator CLI's command and flags. Every write names its environment,
 * mode, operator and reason; every apply that can enable sponsorship also names the
 * policy version its preview read, so it refuses to overwrite a change it did
 * not see (a breaker trip in particular). `kill` takes no version: disabling is
 * always safe to apply over a concurrent change.
 *
 * @param input - The positional command and the `--flag value` pairs.
 * @param input.command - The positional command, or undefined when none was given.
 * @param input.flags - Flag values keyed by flag name without the leading dashes.
 * @returns The validated command.
 */
export function parseSponsorshipBudgetCommand(input: {
  command: string | undefined;
  flags: Record<string, string>;
}): SponsorshipBudgetCommand {
  const parsed = sponsorshipBudgetCommandSchema.safeParse({
    ...input.flags,
    command: input.command,
  });
  if (!parsed.success) {
    throw new Error(parsed.error.issues.map((issue) => issue.message).join("; "));
  }
  const args = parsed.data;
  const environment = args.environment;
  switch (args.command) {
    case "status":
      return { command: "status", environment };
    case "kill":
      return {
        command: "kill",
        environment,
        mode: args.mode,
        operator: args.operator,
        reason: args.reason,
      };
    case "resume":
      return {
        command: "resume",
        environment,
        operator: args.operator,
        reason: args.reason,
        ...writeVersion(args.mode, args["expected-version"]),
      };
    case "set-project":
    case "set-global": {
      const write = {
        environment,
        operator: args.operator,
        reason: args.reason,
        enabled: args.enabled === "true",
        ...writeVersion(args.mode, args["expected-version"]),
        ...toRedisLuaSafePolicyLimits(
          parseSponsorshipPolicyLimits({
            perTransactionLamports: args["per-tx-lamports"],
            hourlyLamports: args["hourly-lamports"],
            dailyLamports: args["daily-lamports"],
          })
        ),
      };
      return args.command === "set-project"
        ? {
            ...write,
            command: "set-project",
            organizationId: args["organization-id"],
          }
        : { ...write, command: args.command };
    }
    default: {
      const unreachable: never = args;
      throw new Error(`Unknown sponsorship budget command: ${JSON.stringify(unreachable)}`);
    }
  }
}

export function isPolicyControlInSync(
  policy: { version: number; enabled: boolean },
  control: { version: number; enabled: boolean } | null
): boolean {
  return control?.version === policy.version && control.enabled === policy.enabled;
}
