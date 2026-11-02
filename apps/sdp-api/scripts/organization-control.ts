import { parseArgs } from "node:util";
import { z } from "zod";
import { closeDatabasePools } from "@/db/client";
import { runWithSystemDatabaseIdentity } from "@/db/identity";
import { getProcessEnv } from "@/lib/runtime-env";
import { closeAllRedisClients } from "@/runtime/kv-redis";
import {
  changeOrganizationControl,
  getOrganizationControl,
  organizationControlChangeSchema,
} from "@/services/organization-control";

async function main(): Promise<void> {
  const operation = z.enum(["status", "suspend", "resume"]).parse(process.argv[2]);
  const { values, tokens } = parseArgs({
    args: process.argv.slice(3),
    strict: true,
    allowPositionals: false,
    tokens: true,
    options: {
      "organization-id": { type: "string" },
      operator: { type: "string" },
      reason: { type: "string" },
      ticket: { type: "string" },
      "expected-version": { type: "string" },
    },
  });
  const names = tokens.map((token) => {
    if (token.kind !== "option") throw new Error("Only named options are accepted");
    return token.name;
  });
  if (new Set(names).size !== names.length) throw new Error("Duplicate argument");
  const organizationId = z
    .string()
    .regex(/^[A-Za-z0-9_-]{1,64}$/)
    .parse(values["organization-id"]);
  const env = getProcessEnv();
  if (operation === "status") {
    if (names.length !== 1) throw new Error("status accepts only --organization-id");
    console.log(JSON.stringify(await getOrganizationControl(env, organizationId), null, 2));
    return;
  }
  const change: Record<string, unknown> = {
    organizationId,
    operation,
    operator: values.operator,
    reason: values.reason,
    ticket: values.ticket,
  };
  const version = values["expected-version"];
  if (version !== undefined) {
    if (!/^[0-9]{1,10}$/.test(version)) throw new Error("Invalid --expected-version");
    change.expectedVersion = Number(version);
  }
  console.log(
    JSON.stringify(
      await changeOrganizationControl(env, organizationControlChangeSchema.parse(change)),
      null,
      2
    )
  );
}

runWithSystemDatabaseIdentity("script:organization-control", main)
  .catch((error: unknown) => {
    console.error(error instanceof Error ? error.message : "Organization control failed");
    process.exitCode = 1;
  })
  .finally(async () => {
    await Promise.all([closeDatabasePools(), closeAllRedisClients()]);
  });
