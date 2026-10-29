import { isMovementId, MOVEMENTS, type MovementId } from "@sdp/types/movements";
import { closeDatabasePools } from "@/db/client";
import { runWithSystemDatabaseIdentity } from "@/db/identity";
import { getProcessEnv } from "@/lib/runtime-env";
import {
  changeProjectMovementControl,
  getProjectMovementControl,
} from "@/services/project-movement-control";

function flags(): Map<string, string> {
  const result = new Map<string, string>();
  const allowed = new Set([
    "organization-id",
    "project-id",
    "movement",
    "operator",
    "reason",
    "ticket",
    "expected-version",
  ]);
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

function movementArg(args: Map<string, string>): MovementId {
  const movement = required(args, "movement");
  if (!isMovementId(movement) || MOVEMENTS[movement].kind !== "start") {
    throw new Error("--movement must name a start in MOVEMENTS");
  }
  return movement;
}

async function main(): Promise<void> {
  const command = process.argv[2];
  if (command !== "status" && command !== "disable" && command !== "enable") {
    throw new Error("Usage: movement:control <status|disable|enable> [flags]");
  }
  const args = flags();
  const env = getProcessEnv();
  const scope = {
    organizationId: required(args, "organization-id"),
    projectId: required(args, "project-id"),
  };
  if (command === "status") {
    if (args.size !== 2) throw new Error("status accepts only project and organization ids");
    console.log(JSON.stringify(await getProjectMovementControl(env, scope), null, 2));
    return;
  }
  const movement = movementArg(args);
  const operator = required(args, "operator");
  const reason = required(args, "reason");
  const ticket = required(args, "ticket");
  const versionText = args.get("expected-version");
  if (command === "disable" && versionText !== undefined) {
    throw new Error("disable does not accept --expected-version");
  }
  const expectedVersion = versionText === undefined ? undefined : Number(versionText);
  if (command === "enable" && (!Number.isSafeInteger(expectedVersion) || expectedVersion < 0)) {
    throw new Error("enable requires a non-negative integer --expected-version");
  }
  console.log(
    JSON.stringify(
      await changeProjectMovementControl(env, {
        ...scope,
        movement,
        operation: command,
        operator,
        reason,
        ticket,
        expectedVersion,
      }),
      null,
      2
    )
  );
}

runWithSystemDatabaseIdentity("script:project-movement-control", main)
  .catch((error: unknown) => {
    console.error(error instanceof Error ? error.message : error);
    process.exitCode = 1;
  })
  .finally(closeDatabasePools);
