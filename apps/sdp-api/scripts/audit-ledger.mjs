import { randomUUID } from "node:crypto";
import pg from "pg";

const { Client } = pg;

function usage() {
  return `Usage:
  pnpm --filter @sdp/api audit:ledger verify
  pnpm --filter @sdp/api audit:ledger checkpoint --operator <identity> --reason <reason> [--ticket <id>]

DATABASE_URL must be the ordinary API runtime connection, not a migration/admin connection.`;
}

function parseOptions(args) {
  const values = {};
  const allowed = new Set(["operator", "reason", "ticket"]);
  for (let index = 0; index < args.length; index += 2) {
    const option = args[index];
    const value = args[index + 1];
    if (!option?.startsWith("--") || !value || value.startsWith("--")) {
      throw new Error(`Invalid option near ${option ?? "end of command"}`);
    }
    const name = option.slice(2);
    if (!allowed.has(name) || Object.hasOwn(values, name)) {
      throw new Error(`Unknown or duplicate option: ${option}`);
    }
    values[name] = value;
  }
  return values;
}

async function inspect(client) {
  const integrity = await client.query(`
    SELECT valid, checked_entries, first_invalid_sequence,
           encode(head_hash, 'hex') AS head_hash
    FROM sdp_verify_audit_ledger()
  `);
  const protection = await client.query(`
    SELECT current_user AS runtime_role,
           role.rolsuper,
           role.rolbypassrls,
           ledger.relrowsecurity,
           ledger.relforcerowsecurity,
           owner.rolname AS table_owner,
           (
             SELECT count(*)::integer
             FROM pg_trigger
             WHERE tgrelid = ledger.oid
               AND tgname IN (
                 'audit_logs_seal_insert',
                 'audit_logs_reject_row_mutation',
                 'audit_logs_reject_truncate'
               )
               AND tgenabled <> 'D'
           ) AS enabled_security_triggers
    FROM pg_class AS ledger
    JOIN pg_roles AS role ON role.rolname = current_user
    JOIN pg_roles AS owner ON owner.oid = ledger.relowner
    WHERE ledger.oid = 'audit_logs'::regclass
  `);

  const result = integrity.rows[0];
  const posture = protection.rows[0];
  const runtimeRoleProtected = Boolean(
    posture &&
      !posture.rolsuper &&
      !posture.rolbypassrls &&
      posture.relrowsecurity &&
      posture.relforcerowsecurity &&
      posture.enabled_security_triggers === 3
  );

  return {
    valid: result?.valid === true,
    checkedEntries: Number(result?.checked_entries ?? 0),
    firstInvalidSequence: result?.first_invalid_sequence
      ? Number(result.first_invalid_sequence)
      : null,
    headHash: result?.head_hash ?? null,
    runtimeRoleProtected,
    runtimeRole: posture?.runtime_role ?? null,
    tableOwner: posture?.table_owner ?? null,
    superuser: posture?.rolsuper ?? null,
    bypassRls: posture?.rolbypassrls ?? null,
    rowSecurity: posture?.relrowsecurity ?? null,
    forceRowSecurity: posture?.relforcerowsecurity ?? null,
    enabledSecurityTriggers: posture?.enabled_security_triggers ?? 0,
  };
}

async function main() {
  const [command, ...args] = process.argv.slice(2);
  if (!command || !["verify", "checkpoint"].includes(command)) {
    throw new Error(usage());
  }

  const databaseUrl = process.env.DATABASE_URL?.trim();
  if (!databaseUrl) {
    throw new Error(`DATABASE_URL is required.\n\n${usage()}`);
  }

  const client = new Client({ connectionString: databaseUrl });
  await client.connect();
  try {
    if (command === "checkpoint") {
      const options = parseOptions(args);
      if (!options.operator?.trim() || !options.reason?.trim()) {
        throw new Error(`checkpoint requires --operator and --reason.\n\n${usage()}`);
      }

      const before = await inspect(client);
      if (!before.valid || !before.runtimeRoleProtected) {
        throw new Error(
          "Refusing to checkpoint an invalid ledger or through an unsafe database role"
        );
      }

      await client.query(
        `INSERT INTO audit_logs (
           id, action, resource_type, resource_id, metadata, status
         ) VALUES ($1, 'maintenance', 'audit_ledger', $2, $3, 'success')`,
        [
          `aud_${randomUUID()}`,
          options.ticket?.trim() || "operator_checkpoint",
          JSON.stringify({
            operator: options.operator.trim(),
            reason: options.reason.trim(),
            ticket: options.ticket?.trim() || null,
          }),
        ]
      );
    } else if (args.length > 0) {
      throw new Error(`verify does not accept options.\n\n${usage()}`);
    }

    const report = await inspect(client);
    console.log(JSON.stringify(report, null, 2));
    if (!report.valid || !report.runtimeRoleProtected) {
      process.exitCode = 1;
    }
  } finally {
    await client.end().catch(() => {});
  }
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
