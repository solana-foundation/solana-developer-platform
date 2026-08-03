import { closeDatabasePools, getDb } from "../src/db";
import {
  SponsorshipBudgetRepository,
  type SponsorshipBudgetScopeType,
  type SponsorshipNetwork,
} from "../src/db/repositories/sponsorship-budget.repository";
import { getProcessEnv } from "../src/lib/runtime-env";
import { SponsorshipBudgetRedis } from "../src/runtime/sponsorship-budget-redis";

function readArg(name: string): string | undefined {
  const index = process.argv.indexOf(`--${name}`);
  return index === -1 ? undefined : process.argv[index + 1]?.trim();
}

function requireArg(name: string): string {
  const value = readArg(name);
  if (!value) throw new Error(`--${name} is required`);
  return value;
}

function parseNetwork(): SponsorshipNetwork {
  const value = requireArg("network");
  if (value !== "devnet" && value !== "mainnet") {
    throw new Error("--network must be devnet or mainnet");
  }
  return value;
}

function parseScope(): SponsorshipBudgetScopeType {
  const value = readArg("scope") ?? "global";
  if (value !== "global" && value !== "organization" && value !== "project") {
    throw new Error("--scope must be global, organization, or project");
  }
  return value;
}

function parseLamports(name: string): number {
  const value = Number(requireArg(name));
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new Error(`--${name} must be a non-negative safe integer`);
  }
  return value;
}

async function persistGlobalEnabled(enabled: boolean) {
  const env = getProcessEnv();
  const repository = new SponsorshipBudgetRepository(getDb(env));
  const network = parseNetwork();
  const current = (await repository.listPolicies(network)).find(
    (policy) => policy.scopeType === "global" && policy.scopeId === null
  );
  if (!current) throw new Error("No matching policy exists; use `set` with explicit limits first");
  const policy = await repository.upsertPolicy({
    network,
    scopeType: "global",
    scopeId: null,
    enabled,
    perTransactionLamports: current.perTransactionLamports,
    hourlyLamports: current.hourlyLamports,
    dailyLamports: current.dailyLamports,
    operator: requireArg("operator"),
    reason: requireArg("reason"),
  });
  await new SponsorshipBudgetRedis(env).syncPolicy(policy);
  console.log(JSON.stringify(policy, null, 2));
}

async function main() {
  const command = process.argv[2];
  const env = getProcessEnv();
  const repository = new SponsorshipBudgetRepository(getDb(env));

  if (command === "status") {
    const networkValue = readArg("network");
    if (networkValue && networkValue !== "devnet" && networkValue !== "mainnet") {
      throw new Error("--network must be devnet or mainnet");
    }
    const policies = await repository.listPolicies(networkValue as SponsorshipNetwork | undefined);
    const redis = new SponsorshipBudgetRedis(env);
    const status = await Promise.all(
      policies.map(async (policy) => {
        const control = await redis.getPolicyControl(policy);
        return {
          ...policy,
          redisControl: control,
          inSync: control?.version === policy.version && control.enabled === policy.enabled,
        };
      })
    );
    console.log(JSON.stringify(status, null, 2));
    if (status.some((policy) => !policy.inSync)) process.exitCode = 2;
    return;
  }
  if (command === "kill") {
    await persistGlobalEnabled(false);
    return;
  }
  if (command === "resume") {
    await persistGlobalEnabled(true);
    return;
  }
  if (command !== "set") {
    throw new Error("Usage: sponsorship:budget <status|set|kill|resume> [flags]");
  }

  const network = parseNetwork();
  const scopeType = parseScope();
  const scopeId = scopeType === "global" ? null : (readArg("scope-id") ?? null);
  const enabledArg = readArg("enabled") ?? "true";
  if (enabledArg !== "true" && enabledArg !== "false") {
    throw new Error("--enabled must be true or false");
  }
  const policy = await repository.upsertPolicy({
    network,
    scopeType,
    scopeId,
    enabled: enabledArg === "true",
    perTransactionLamports: parseLamports("per-tx-lamports"),
    hourlyLamports: parseLamports("hourly-lamports"),
    dailyLamports: parseLamports("daily-lamports"),
    operator: requireArg("operator"),
    reason: requireArg("reason"),
  });
  await new SponsorshipBudgetRedis(env).syncPolicy(policy);
  console.log(JSON.stringify(policy, null, 2));
}

main()
  .catch((error) => {
    console.error(error instanceof Error ? error.message : error);
    process.exitCode = 1;
  })
  .finally(closeDatabasePools);
