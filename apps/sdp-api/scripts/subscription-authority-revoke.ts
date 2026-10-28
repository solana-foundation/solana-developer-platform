import { SDP_ENVIRONMENTS } from "@sdp/types/api-keys";
import { z } from "zod";
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

const argsSchema = z
  .object({
    "organization-id": z.string().trim().min(1),
    "project-id": z.string().trim().min(1),
    "custody-wallet-id": z.string().trim().min(1),
    token: z.string().trim().min(1),
    operator: z.string().trim().min(1),
    reason: z.string().trim().min(1),
    ticket: z.string().trim().min(1),
  })
  .strict();

const projectSchema = z.object({ environment: z.enum(SDP_ENVIRONMENTS) });

/** `--flag value` pairs from argv, each named once, parsed with {@link argsSchema}. */
function parseArgs(argv: readonly string[]): z.infer<typeof argsSchema> {
  const pairs = new Map<string, string>();
  for (let index = 0; index < argv.length; index += 2) {
    const flag = argv[index];
    const value = argv[index + 1];
    if (!flag?.startsWith("--") || value === undefined || value.startsWith("--")) {
      throw new Error(`Invalid argument: ${flag ?? "(missing flag)"}`);
    }
    if (pairs.has(flag.slice(2))) throw new Error(`Duplicate argument: ${flag}`);
    pairs.set(flag.slice(2), value);
  }
  return argsSchema.parse(Object.fromEntries(pairs));
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  const env = getProcessEnv();
  const project = await getDb(env)
    .prepare("SELECT environment FROM projects WHERE id = ? AND organization_id = ?")
    .bind(args["project-id"], args["organization-id"])
    .first<unknown>();
  if (project === null) throw new Error("Project not found in that organization");
  const { environment } = projectSchema.parse(project);

  const result = await runInEnvironmentClusterScope(environment, () =>
    revokeSubscriptionAuthorityNow(env, {
      organizationId: args["organization-id"],
      projectId: args["project-id"],
      custodyWalletId: args["custody-wallet-id"],
      token: args.token,
      incident: { operator: args.operator, reason: args.reason, ticket: args.ticket },
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
