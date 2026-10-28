import { SDP_ENVIRONMENTS } from "@sdp/types/api-keys";
import { closeDatabasePools, getDb } from "@/db/client";
import { runWithSystemDatabaseIdentity } from "@/db/identity";
import { getProcessEnv } from "@/lib/runtime-env";
import { runInEnvironmentClusterScope } from "@/runtime/cluster-scope-runs";
import { revokeSubscriptionAuthorityNow } from "@/services/payments/recurring-payments/authority-revocation";

/**
 * The operator's incident revoke (HOO-2339): pulls a wallet's per-mint token approval to the
 * Subscriptions program now, whatever recurring payments still use it. Runbook:
 * `docs/ops/subscription-authority-revoke.md`.
 */

const FLAGS = new Set([
  "organization-id",
  "project-id",
  "custody-wallet-id",
  "token",
  "operator",
  "reason",
  "ticket",
]);

function flags(): Map<string, string> {
  const result = new Map<string, string>();
  for (let index = 2; index < process.argv.length; index += 2) {
    const flag = process.argv[index];
    const value = process.argv[index + 1];
    if (!flag?.startsWith("--") || !FLAGS.has(flag.slice(2)) || !value || value.startsWith("--")) {
      throw new Error(`Invalid argument: ${flag ?? "(missing flag)"}`);
    }
    if (result.has(flag.slice(2))) throw new Error(`Duplicate argument: ${flag}`);
    result.set(flag.slice(2), value);
  }
  return result;
}

function required(args: Map<string, string>, name: string): string {
  const value = args.get(name)?.trim();
  if (!value) throw new Error(`--${name} is required`);
  return value;
}

async function main(): Promise<void> {
  const args = flags();
  const env = getProcessEnv();
  const organizationId = required(args, "organization-id");
  const projectId = required(args, "project-id");
  const project = await getDb(env)
    .prepare("SELECT environment FROM projects WHERE id = ? AND organization_id = ?")
    .bind(projectId, organizationId)
    .first<{ environment: string }>();
  const environment = SDP_ENVIRONMENTS.find((candidate) => candidate === project?.environment);
  if (environment === undefined) throw new Error("Project not found in that organization");

  const result = await runInEnvironmentClusterScope(environment, () =>
    revokeSubscriptionAuthorityNow(env, {
      organizationId,
      projectId,
      custodyWalletId: required(args, "custody-wallet-id"),
      token: required(args, "token"),
      incident: {
        operator: required(args, "operator"),
        reason: required(args, "reason"),
        ticket: required(args, "ticket"),
      },
    })
  );
  console.log(JSON.stringify(result, null, 2));
  if (result.outcome !== "revoked") process.exitCode = 2;
}

runWithSystemDatabaseIdentity("script:subscription-authority-revoke", main)
  .catch((error: unknown) => {
    console.error(error instanceof Error ? error.message : error);
    process.exitCode = 1;
  })
  .finally(closeDatabasePools);
