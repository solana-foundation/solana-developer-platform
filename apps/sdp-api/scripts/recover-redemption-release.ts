import { closeDatabasePools } from "@/db/client";
import { runWithSystemDatabaseIdentity } from "@/db/identity";
import { getProcessEnv } from "@/lib/runtime-env";
import { runInEnvironmentClusterScope } from "@/runtime/cluster-scope-runs";
import { closeAllRedisClients } from "@/runtime/kv-redis";
import {
  parseRedemptionReleaseRecoveryArgs,
  recoverCurrentRedemptionRelease,
} from "@/services/earn/redemption-release-recovery";

async function main(): Promise<void> {
  const input = parseRedemptionReleaseRecoveryArgs(process.argv.slice(2));
  const result = await runInEnvironmentClusterScope(input.environment, () =>
    recoverCurrentRedemptionRelease(getProcessEnv(), input)
  );
  console.log(JSON.stringify(result));
}

runWithSystemDatabaseIdentity("script:recover-redemption-release", main)
  .catch((error: unknown) => {
    console.error(error instanceof Error ? error.message : error);
    process.exitCode = 1;
  })
  .finally(() => Promise.all([closeDatabasePools(), closeAllRedisClients()]));
