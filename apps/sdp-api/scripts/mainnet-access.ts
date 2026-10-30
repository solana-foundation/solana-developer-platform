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
import { COUNTRY_CODES, type CountryCode } from "@sdp/types/countries";
import { closeDatabasePools, getDb } from "@/db/client";
import { runWithSystemDatabaseIdentity } from "@/db/identity";
import { getProcessEnv } from "@/lib/runtime-env";
import { correctMainnetAccess, readMainnetAccessRow } from "@/services/mainnet-access.service";

const COMMANDS = ["status", "set-country", "reset"] as const;
type Command = (typeof COMMANDS)[number];

function flags(): Map<string, string> {
  const result = new Map<string, string>();
  const allowed = new Set(["organization-id", "country", "operator", "reason", "ticket"]);
  for (let index = 3; index < process.argv.length; index += 2) {
    const flag = process.argv[index];
    const value = process.argv[index + 1];
    if (
      !flag?.startsWith("--") ||
      !allowed.has(flag.slice(2)) ||
      !value ||
      value.startsWith("--")
    ) {
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

function countryArg(args: Map<string, string>): CountryCode {
  const country = required(args, "country").toUpperCase();
  const code = COUNTRY_CODES.find((candidate) => candidate === country);
  if (!code)
    throw new Error("--country must be an ISO 3166-1 alpha-2 code from @sdp/types/countries");
  return code;
}

async function main(): Promise<void> {
  const command = process.argv[2] as Command;
  if (!COMMANDS.includes(command)) {
    throw new Error(`Usage: mainnet-access <${COMMANDS.join("|")}> [flags]`);
  }
  const args = flags();
  const env = getProcessEnv();
  const organizationId = required(args, "organization-id");
  if (command === "status") {
    if (args.size !== 1) throw new Error("status accepts only --organization-id");
    console.log(JSON.stringify(await readMainnetAccessRow(getDb(env), organizationId), null, 2));
    return;
  }
  const result = await correctMainnetAccess(env, {
    organizationId,
    operation: command,
    countryCode: command === "set-country" ? countryArg(args) : undefined,
    operator: required(args, "operator"),
    reason: required(args, "reason"),
    ticket: required(args, "ticket"),
  });
  console.log(JSON.stringify(result, null, 2));
}

runWithSystemDatabaseIdentity("script:mainnet-access", main)
  .catch((error: unknown) => {
    console.error(error instanceof Error ? error.message : error);
    process.exitCode = 1;
  })
  .finally(closeDatabasePools);
