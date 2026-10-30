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
import { COUNTRY_CODES } from "@sdp/types/countries";
import { z } from "zod";
import { closeDatabasePools, getDb } from "@/db/client";
import { runWithSystemDatabaseIdentity } from "@/db/identity";
import { getProcessEnv } from "@/lib/runtime-env";
import { closeAllRedisClients } from "@/runtime/kv-redis";
import { correctMainnetAccess, readMainnetAccessRow } from "@/services/mainnet-access.service";

const organizationId = z.string().trim().min(1);
const audit = {
  operator: z.string().trim().min(1).max(128),
  reason: z.string().trim().min(1).max(500),
  ticket: z.string().trim().min(1).max(128),
};

const argsSchema = z.discriminatedUnion("command", [
  z.strictObject({ command: z.literal("status"), "organization-id": organizationId }),
  z.strictObject({
    command: z.literal("set-country"),
    "organization-id": organizationId,
    country: z.string().trim().toUpperCase().pipe(z.enum(COUNTRY_CODES)),
    ...audit,
  }),
  z.strictObject({ command: z.literal("reset"), "organization-id": organizationId, ...audit }),
]);

function parseCommandLine(): z.infer<typeof argsSchema> {
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
  const parsed = argsSchema.safeParse({ command: positionals[0], ...values });
  if (!parsed.success) throw new Error(z.prettifyError(parsed.error));
  return parsed.data;
}

async function main(): Promise<void> {
  const args = parseCommandLine();
  const env = getProcessEnv();
  if (args.command === "status") {
    const row = await readMainnetAccessRow(getDb(env), args["organization-id"]);
    console.log(JSON.stringify(row, null, 2));
    return;
  }
  const result = await correctMainnetAccess(
    env,
    args.command === "set-country"
      ? {
          operation: "set-country",
          organizationId: args["organization-id"],
          countryCode: args.country,
          operator: args.operator,
          reason: args.reason,
          ticket: args.ticket,
        }
      : {
          operation: "reset",
          organizationId: args["organization-id"],
          operator: args.operator,
          reason: args.reason,
          ticket: args.ticket,
        }
  );
  console.log(JSON.stringify(result, null, 2));
}

runWithSystemDatabaseIdentity("script:mainnet-access", main)
  .catch((error: unknown) => {
    console.error(error instanceof Error ? error.message : error);
    process.exitCode = 1;
  })
  // The audit ledger's checkpoint store holds a Redis client open; close it so the script exits.
  .finally(() => Promise.all([closeDatabasePools(), closeAllRedisClients()]));
