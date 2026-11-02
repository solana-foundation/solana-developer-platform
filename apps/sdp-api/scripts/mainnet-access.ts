/**
 * Operator corrections to an organization's mainnet access request (HOO-2427). The dashboard
 * request is one-time; an organization that declared the wrong jurisdiction, or wants to start
 * over, writes to the SDP alias and an operator runs this. Approval is not here: set
 * `enableProductionProject` in the organization's Clerk private metadata.
 *
 *   pnpm -C apps/sdp-api mainnet-access status --organization-id <id>
 *   pnpm -C apps/sdp-api mainnet-access set-country --organization-id <id> --country <CC> \
 *     --operator <you> --reason <why> --ticket <HOO-…>
 *   pnpm -C apps/sdp-api mainnet-access reset --organization-id <id> \
 *     --operator <you> --reason <why> --ticket <HOO-…>
 */
import { parseArgs } from "node:util";
import { z } from "zod";
import { closeDatabasePools, getDb } from "@/db/client";
import { runWithSystemDatabaseIdentity } from "@/db/identity";
import { getProcessEnv } from "@/lib/runtime-env";
import { closeAllRedisClients } from "@/runtime/kv-redis";
import {
  correctMainnetAccess,
  mainnetAccessCorrectionSchema,
  readMainnetAccessRow,
} from "@/services/mainnet-access.service";

const commandSchema = z.discriminatedUnion("operation", [
  z.object({ operation: z.literal("status"), organizationId: z.string().trim().min(1) }),
  ...mainnetAccessCorrectionSchema.options,
]);

function parseCommandLine(): z.infer<typeof commandSchema> {
  const { positionals, values } = parseArgs({
    args: process.argv.slice(2),
    allowPositionals: true,
    strict: true,
    options: {
      "organization-id": { type: "string" },
      country: { type: "string" },
      operator: { type: "string" },
      reason: { type: "string" },
      ticket: { type: "string" },
    },
  });
  if (positionals.length !== 1) {
    throw new Error("Usage: mainnet-access <status|set-country|reset> [flags]");
  }
  const input = {
    operation: positionals[0],
    organizationId: values["organization-id"],
    countryCode: values.country,
    operator: values.operator,
    reason: values.reason,
    ticket: values.ticket,
  };
  const parsed = commandSchema.safeParse(input);
  if (!parsed.success) throw new Error(z.prettifyError(parsed.error));
  return parsed.data;
}

async function main(): Promise<void> {
  const command = parseCommandLine();
  const env = getProcessEnv();
  const result =
    command.operation === "status"
      ? await readMainnetAccessRow(getDb(env), command.organizationId)
      : await correctMainnetAccess(env, command);
  console.log(JSON.stringify(result, null, 2));
}

runWithSystemDatabaseIdentity("script:mainnet-access", main)
  .catch((error: unknown) => {
    console.error(error instanceof Error ? error.message : error);
    process.exitCode = 1;
  })
  // The audit ledger's checkpoint store holds a Redis client open; close it so the script exits.
  .finally(() => Promise.all([closeDatabasePools(), closeAllRedisClients()]));
