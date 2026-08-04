import { randomUUID } from "node:crypto";
import Redis from "ioredis";
import pg from "pg";

const { Client } = pg;
const EXTERNAL_CHECKPOINT_KEY = "cache:audit-ledger:checkpoint:v1";

const ADVANCE_CHECKPOINT_LUA = `
local current = redis.call('GET', KEYS[1])
if ARGV[1] == 'missing' then
  if current ~= false then
    return 0
  end
elseif current ~= ARGV[2] then
  return 0
end
redis.call('SET', KEYS[1], ARGV[3])
return 1
`;

function serializeCheckpoint(sequence, headHash) {
  return JSON.stringify({ sequence, headHash });
}

function parseCheckpoint(value) {
  if (value === null) return { sequence: 0, headHash: null };
  try {
    const parsed = JSON.parse(value);
    if (
      Number.isSafeInteger(parsed.sequence) &&
      parsed.sequence > 0 &&
      typeof parsed.headHash === "string" &&
      /^[0-9a-f]{64}$/.test(parsed.headHash)
    ) {
      return parsed;
    }
  } catch {
    // Invalid external state is represented by an impossible sequence below.
  }
  return { sequence: -1, headHash: null };
}

function usage() {
  return `Usage:
  pnpm --filter @sdp/api audit:ledger verify
  pnpm --filter @sdp/api audit:ledger checkpoint --operator <identity> --reason <reason> [--ticket <id>]

DATABASE_URL and REDIS_URL must identify the ordinary API runtime stores, not admin connections.`;
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

async function inspect(client, redis) {
  const externalCheckpoint = await redis.get(EXTERNAL_CHECKPOINT_KEY);
  const parsedCheckpoint = parseCheckpoint(externalCheckpoint);
  const integrity = await client.query(
    `
    SELECT valid, checked_entries, first_invalid_sequence,
           encode(head_hash, 'hex') AS head_hash,
           unresolved_critical_intents
    FROM sdp_verify_audit_ledger($1, $2)
  `,
    [parsedCheckpoint.sequence, parsedCheckpoint.headHash]
  );
  const protection = await client.query(`
    SELECT current_user AS runtime_role,
           role.rolsuper,
           role.rolbypassrls,
           ledger.relrowsecurity,
           ledger.relforcerowsecurity,
           anchors.relrowsecurity AS anchors_rowsecurity,
           anchors.relforcerowsecurity AS anchors_forcerowsecurity,
           owner.rolname AS table_owner,
           (
             SELECT count(*)::integer
             FROM pg_trigger
             WHERE tgrelid IN (ledger.oid, anchors.oid)
               AND tgname IN (
                 'audit_logs_seal_insert',
                 'audit_logs_anchor_insert',
                 'audit_logs_reject_row_mutation',
                 'audit_logs_reject_truncate',
                 'audit_ledger_anchors_reject_row_mutation',
                 'audit_ledger_anchors_reject_truncate'
               )
               AND tgenabled <> 'D'
           ) AS enabled_security_triggers
    FROM pg_class AS ledger
    CROSS JOIN pg_class AS anchors
    JOIN pg_roles AS role ON role.rolname = current_user
    JOIN pg_roles AS owner ON owner.oid = ledger.relowner
    WHERE ledger.oid = 'audit_logs'::regclass
      AND anchors.oid = 'audit_ledger_anchors'::regclass
  `);

  const result = integrity.rows[0];
  const posture = protection.rows[0];
  const runtimeRoleProtected = Boolean(
    posture &&
      !posture.rolsuper &&
      !posture.rolbypassrls &&
      posture.relrowsecurity &&
      posture.relforcerowsecurity &&
      posture.anchors_rowsecurity &&
      posture.anchors_forcerowsecurity &&
      posture.enabled_security_triggers === 6
  );
  const checkedEntries = Number(result?.checked_entries ?? 0);
  const headHash = result?.head_hash ?? null;
  const expectedCheckpoint =
    checkedEntries === 0 || headHash === null
      ? null
      : serializeCheckpoint(checkedEntries, headHash);
  const externalCheckpointMatches = externalCheckpoint === expectedCheckpoint;

  return {
    valid: result?.valid === true && externalCheckpointMatches,
    databaseLedgerValid: result?.valid === true,
    checkedEntries,
    firstInvalidSequence: result?.first_invalid_sequence
      ? Number(result.first_invalid_sequence)
      : null,
    headHash,
    unresolvedCriticalIntents: Number(result?.unresolved_critical_intents ?? 0),
    externalCheckpointMatches,
    externalCheckpoint,
    expectedCheckpoint,
    runtimeRoleProtected,
    runtimeRole: posture?.runtime_role ?? null,
    tableOwner: posture?.table_owner ?? null,
    superuser: posture?.rolsuper ?? null,
    bypassRls: posture?.rolbypassrls ?? null,
    rowSecurity: posture?.relrowsecurity ?? null,
    forceRowSecurity: posture?.relforcerowsecurity ?? null,
    anchorsRowSecurity: posture?.anchors_rowsecurity ?? null,
    anchorsForceRowSecurity: posture?.anchors_forcerowsecurity ?? null,
    enabledSecurityTriggers: posture?.enabled_security_triggers ?? 0,
  };
}

async function initializeExternalCheckpoint(redis, report) {
  if (report.externalCheckpointMatches) return;
  if (report.externalCheckpoint !== null || report.expectedCheckpoint === null) {
    throw new Error("Refusing to overwrite a divergent external audit-ledger checkpoint");
  }
  const initialized = await redis.set(EXTERNAL_CHECKPOINT_KEY, report.expectedCheckpoint, "NX");
  if (initialized !== "OK") {
    throw new Error("External audit-ledger checkpoint changed during initialization");
  }
}

async function appendCheckpoint(client, redis, options) {
  const before = await inspect(client, redis);
  if (!before.databaseLedgerValid || !before.runtimeRoleProtected) {
    throw new Error("Refusing to checkpoint an invalid ledger or through an unsafe database role");
  }
  await initializeExternalCheckpoint(redis, before);

  await client.query("BEGIN");
  try {
    const inserted = await client.query(
      `INSERT INTO audit_logs (
         id, action, resource_type, resource_id, metadata, status
       ) VALUES ($1, 'maintenance', 'audit_ledger', $2, $3, 'success')
       RETURNING ledger_sequence,
                 encode(previous_entry_hash, 'hex') AS previous_entry_hash,
                 encode(entry_hash, 'hex') AS entry_hash`,
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
    const row = inserted.rows[0];
    if (!row) {
      throw new Error("Checkpoint audit insert returned no sealed row");
    }
    const expected =
      Number(row.ledger_sequence) === 1
        ? null
        : serializeCheckpoint(Number(row.ledger_sequence) - 1, row.previous_entry_hash);
    const next = serializeCheckpoint(Number(row.ledger_sequence), row.entry_hash);
    const advanced = await redis.eval(
      ADVANCE_CHECKPOINT_LUA,
      1,
      EXTERNAL_CHECKPOINT_KEY,
      expected === null ? "missing" : "present",
      expected ?? "",
      next
    );
    if (advanced !== 1) {
      throw new Error("External audit-ledger checkpoint diverged during checkpoint write");
    }
    await client.query("COMMIT");
  } catch (error) {
    await client.query("ROLLBACK").catch(() => {});
    throw error;
  }
}

async function main() {
  const [command, ...args] = process.argv.slice(2);
  if (!command || !["verify", "checkpoint"].includes(command)) {
    throw new Error(usage());
  }

  const databaseUrl = process.env.DATABASE_URL?.trim();
  const redisUrl = process.env.REDIS_URL?.trim();
  if (!databaseUrl || !redisUrl) {
    throw new Error(`DATABASE_URL and REDIS_URL are required.\n\n${usage()}`);
  }

  const client = new Client({ connectionString: databaseUrl });
  const redis = new Redis(redisUrl, { maxRetriesPerRequest: 3 });
  await Promise.all([client.connect(), redis.ping()]);
  try {
    if (command === "checkpoint") {
      const options = parseOptions(args);
      if (!options.operator?.trim() || !options.reason?.trim()) {
        throw new Error(`checkpoint requires --operator and --reason.\n\n${usage()}`);
      }
      await appendCheckpoint(client, redis, options);
    } else if (args.length > 0) {
      throw new Error(`verify does not accept options.\n\n${usage()}`);
    }

    const report = await inspect(client, redis);
    console.log(JSON.stringify(report, null, 2));
    if (!report.valid || !report.runtimeRoleProtected) {
      process.exitCode = 1;
    }
  } finally {
    await Promise.allSettled([client.end(), redis.quit()]);
  }
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
