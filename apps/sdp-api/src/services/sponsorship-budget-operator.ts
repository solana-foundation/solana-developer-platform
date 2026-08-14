import type {
  SponsorshipBudgetScopeType,
  SponsorshipNetwork,
} from "@/db/repositories/sponsorship-budget.repository";

const MAX_REDIS_LUA_SAFE_LAMPORTS = BigInt(Number.MAX_SAFE_INTEGER);

export interface SponsorshipPolicyLimitsBigInt {
  perTransactionLamports: bigint;
  hourlyLamports: bigint;
  dailyLamports: bigint;
}

export function parseLamportAmount(value: string | undefined, flagName: string): bigint {
  if (!value || !/^(0|[1-9][0-9]*)$/.test(value)) {
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

export function parseSponsorshipNetwork(value: string | undefined): SponsorshipNetwork {
  if (value !== "devnet" && value !== "mainnet") {
    throw new Error("--network is required and must be devnet or mainnet");
  }
  return value;
}

export function parseSponsorshipScope(
  scopeValue: string | undefined,
  scopeIdValue: string | undefined
): { scopeType: SponsorshipBudgetScopeType; scopeId: string | null } {
  const scopeType = scopeValue ?? "global";
  if (scopeType !== "global" && scopeType !== "organization" && scopeType !== "project") {
    throw new Error("--scope must be global, organization, or project");
  }
  if (scopeType === "global") {
    if (scopeIdValue !== undefined) throw new Error("--scope-id is not valid for global scope");
    return { scopeType, scopeId: null };
  }
  if (scopeIdValue === "") throw new Error("--scope-id cannot be empty when provided");
  return { scopeType, scopeId: scopeIdValue ?? null };
}

export function isPolicyControlInSync(
  policy: { version: number; enabled: boolean },
  control: { version: number; enabled: boolean } | null
): boolean {
  return control?.version === policy.version && control.enabled === policy.enabled;
}
