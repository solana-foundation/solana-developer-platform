/**
 * Routine operator work run by the sdp-<env>-backoffice-ops Cloud Run job
 * (`scripts/backoffice-ops.ts`, dispatched by `.github/workflows/backoffice-mainnet-access.yml`),
 * kept apart from `incident-ops` so it never fires the incident page. Only what is allowlisted
 * here runs.
 *
 * Its output reaches the workflow's step summary, which is public (the repository is public), so
 * it returns only outcomes: never the requester, an email, the jurisdiction or the use case.
 */
import { parseArgs } from "node:util";
import { z } from "zod";
import { getDb } from "@/db/client";
import {
  correctMainnetAccess,
  mainnetAccessCorrectionSchema,
  readMainnetAccessRow,
} from "@/services/mainnet-access.service";
import type { Env } from "@/types/env";

const USAGE =
  "Usage: backoffice-ops mainnet-access <status|reset|set-country> --organization-id <id> [flags]";

const commandSchema = z.discriminatedUnion("operation", [
  z.object({ operation: z.literal("status"), organizationId: z.string().trim().min(1) }),
  ...mainnetAccessCorrectionSchema.options,
]);

export type BackofficeCommand = z.infer<typeof commandSchema>;

/**
 * The command from `argv` (tool, action, flags). Throws with the usage line on anything not
 * allowlisted, so the job never runs an unknown tool or action.
 */
export function parseBackofficeCommand(argv: readonly string[]): BackofficeCommand {
  const { positionals, values } = parseArgs({
    args: [...argv],
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
  const [tool, operation, ...rest] = positionals;
  if (tool !== "mainnet-access" || rest.length > 0) throw new Error(USAGE);
  const parsed = commandSchema.safeParse({
    operation,
    organizationId: values["organization-id"],
    countryCode: values.country,
    operator: values.operator,
    reason: values.reason,
    ticket: values.ticket,
  });
  if (!parsed.success) throw new Error(`${USAGE}\n${z.prettifyError(parsed.error)}`);
  return parsed.data;
}

/**
 * What the run prints: outcomes only, safe for a public log. Strict, so a field that is not named
 * here (a requester, an email, a jurisdiction) fails the run instead of reaching the log.
 */
const backofficeOutcomeSchema = z.discriminatedUnion("operation", [
  z.strictObject({
    organizationId: z.string(),
    operation: z.literal("status"),
    requested: z.boolean(),
    requestedAt: z.string().nullable(),
    notified: z.boolean().nullable(),
    termsVersion: z.string().nullable(),
  }),
  z.strictObject({
    organizationId: z.string(),
    operation: z.enum(["reset", "set-country"]),
    requested: z.boolean(),
    operatorEmail: z.enum(["sent", "not_configured"]),
  }),
]);

export type BackofficeOutcome = z.infer<typeof backofficeOutcomeSchema>;

/** Runs one allowlisted command and returns what may be printed. */
export async function runBackofficeCommand(
  env: Env,
  command: BackofficeCommand
): Promise<BackofficeOutcome> {
  if (command.operation === "status") {
    const row = await readMainnetAccessRow(getDb(env), command.organizationId);
    return backofficeOutcomeSchema.parse({
      organizationId: command.organizationId,
      operation: "status",
      requested: row !== null,
      requestedAt: row?.requested_at ?? null,
      notified: row ? row.notified_at !== null : null,
      termsVersion: row?.terms_version ?? null,
    });
  }
  const result = await correctMainnetAccess(env, command);
  return backofficeOutcomeSchema.parse({
    organizationId: command.organizationId,
    operation: command.operation,
    requested: result.request !== null,
    operatorEmail: result.operatorEmail,
  });
}
