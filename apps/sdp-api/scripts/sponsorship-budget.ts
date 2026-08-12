import { closeDatabasePools, getDb } from "../src/db";
import {
  SponsorshipBudgetRepository,
  type SponsorshipNetwork,
} from "../src/db/repositories/sponsorship-budget.repository";
import { getProcessEnv } from "../src/lib/runtime-env";
import { SponsorshipBudgetRedis } from "../src/runtime/sponsorship-budget-redis";
import {
  isPolicyControlInSync,
  parseSponsorshipNetwork,
  parseSponsorshipPolicyLimits,
  parseSponsorshipScope,
  toRedisLuaSafePolicyLimits,
} from "../src/services/sponsorship-budget-operator";

function readArg(name: string): string | undefined {
  const index = process.argv.indexOf(`--${name}`);
  if (index === -1) return undefined;
  const value = process.argv[index + 1];
  if (value === undefined || value.startsWith("--")) {
    throw new Error(`--${name} requires a value`);
  }
  return value;
}

function requireArg(name: string): string {
  const value = readArg(name);
  if (!value) throw new Error(`--${name} is required`);
  return value;
}

function parseNetwork(): SponsorshipNetwork {
  return parseSponsorshipNetwork(readArg("network"));
}

async function persistGlobalEnabled(enabled: boolean) {
  const env = getProcessEnv();
  const repository = new SponsorshipBudgetRepository(getDb(env));
  const network = parseNetwork();
  const policy = await repository.setPolicyEnabled({
    network,
    scopeType: "global",
    scopeId: null,
    enabled,
    operator: requireArg("operator"),
    reason: requireArg("reason"),
  });
  if (!policy) {
    const current = (await repository.listPolicies(network)).find(
      (candidate) => candidate.scopeType === "global" && candidate.scopeId === null
    );
    if (!current) {
      throw new Error("No matching policy exists; use `set` with explicit limits first");
    }
    console.log(JSON.stringify(current, null, 2));
    return;
  }
  await new SponsorshipBudgetRedis(env).syncPolicy(policy);
  console.log(JSON.stringify(policy, null, 2));
}

async function main() {
  const command = process.argv[2];
  const env = getProcessEnv();
  const repository = new SponsorshipBudgetRepository(getDb(env));

  if (command === "status") {
    const network = parseNetwork();
    const policies = await repository.listPolicies(network);
    const redis = new SponsorshipBudgetRedis(env);
    const status = await Promise.all(
      policies.map(async (policy) => {
        const control = await redis.getPolicyControl(policy);
        return {
          ...policy,
          redisControl: control,
          inSync: isPolicyControlInSync(policy, control),
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
  const { scopeType, scopeId } = parseSponsorshipScope(readArg("scope"), readArg("scope-id"));
  const enabledArg = readArg("enabled") ?? "true";
  if (enabledArg !== "true" && enabledArg !== "false") {
    throw new Error("--enabled must be true or false");
  }
  const limits = toRedisLuaSafePolicyLimits(
    parseSponsorshipPolicyLimits({
      perTransactionLamports: readArg("per-tx-lamports"),
      hourlyLamports: readArg("hourly-lamports"),
      dailyLamports: readArg("daily-lamports"),
    })
  );
  const policy = await repository.upsertPolicy({
    network,
    scopeType,
    scopeId,
    enabled: enabledArg === "true",
    ...limits,
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
