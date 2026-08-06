import { randomUUID } from "node:crypto";
import Redis from "ioredis";
import pg from "pg";

const { Client } = pg;
const EXTERNAL_CHECKPOINT_KEY = "cache:audit-ledger:checkpoint:v1";
const AUDIT_LEDGER_SESSION_LOCK_KEY = "sdp:audit-ledger:external-checkpoint";

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

const RESTORE_ROLLED_BACK_CHECKPOINT_LUA = `
if redis.call('GET', KEYS[1]) ~= ARGV[1] then
  return 0
end
if ARGV[2] == 'missing' then
  redis.call('DEL', KEYS[1])
else
  redis.call('SET', KEYS[1], ARGV[3])
end
return 1
`;

function serializeCheckpoint(sequence, headHash) {
  return JSON.stringify({ sequence, headHash });
}

function serializePendingCheckpoint(previousCheckpoint, nextCheckpoint) {
  return JSON.stringify({
    pending: true,
    previous: previousCheckpoint ? JSON.parse(previousCheckpoint) : null,
    next: JSON.parse(nextCheckpoint),
  });
}

function parseCheckpoint(value) {
  if (value === null) return { sequence: 0, headHash: null };
  try {
    const parsed = JSON.parse(value);
    if (
      !("pending" in parsed) &&
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

function validCheckpoint(value) {
  return (
    value &&
    typeof value === "object" &&
    Number.isSafeInteger(value.sequence) &&
    value.sequence > 0 &&
    typeof value.headHash === "string" &&
    /^[0-9a-f]{64}$/.test(value.headHash)
  );
}

function parsePendingCheckpoint(value) {
  if (value === null) return null;
  try {
    const parsed = JSON.parse(value);
    if (
      parsed.pending === true &&
      (parsed.previous === null || validCheckpoint(parsed.previous)) &&
      validCheckpoint(parsed.next) &&
      parsed.next.sequence === (parsed.previous?.sequence ?? 0) + 1
    ) {
      return parsed;
    }
  } catch {
    // Malformed external state remains fail-closed.
  }
  return null;
}

async function finalizeCommittedPendingCheckpoint(client, redis) {
  const external = await redis.get(EXTERNAL_CHECKPOINT_KEY);
  const pending = parsePendingCheckpoint(external);
  if (!pending) return;

  const result = await client.query(`
    SELECT ledger.ledger_sequence,
           encode(ledger.previous_entry_hash, 'hex') AS previous_entry_hash,
           encode(ledger.entry_hash, 'hex') AS entry_hash,
           ledger.entry_hash = sdp_audit_log_hash(
             ledger.ledger_sequence, ledger.id, ledger.organization_id,
             ledger.user_id, ledger.api_key_id, ledger.action,
             ledger.resource_type, ledger.resource_id, ledger.metadata,
             ledger.ip_address, ledger.user_agent, ledger.request_id,
             ledger.status, ledger.created_at, ledger.previous_entry_hash
           ) AS entry_hash_valid,
           anchor.entry_hash = ledger.entry_hash AS anchor_matches
    FROM audit_logs AS ledger
    LEFT JOIN audit_ledger_anchors AS anchor
      ON anchor.ledger_sequence = ledger.ledger_sequence
    ORDER BY ledger.ledger_sequence DESC
    LIMIT 1
  `);
  const head = result.rows[0];
  const predecessorMatches =
    head &&
    (pending.previous === null
      ? Number(head.ledger_sequence) === 1 && head.previous_entry_hash === null
      : pending.previous.sequence === Number(head.ledger_sequence) - 1 &&
        pending.previous.headHash === head.previous_entry_hash);
  const nextMatches =
    head &&
    pending.next.sequence === Number(head.ledger_sequence) &&
    pending.next.headHash === head.entry_hash;
  if (!predecessorMatches || !nextMatches || !head.entry_hash_valid || !head.anchor_matches) {
    throw new Error("Pending audit checkpoint does not match the valid committed ledger head");
  }

  const next = serializeCheckpoint(pending.next.sequence, pending.next.headHash);
  const advanced = await redis.eval(
    ADVANCE_CHECKPOINT_LUA,
    1,
    EXTERNAL_CHECKPOINT_KEY,
    "present",
    external,
    next
  );
  if (advanced !== 1 && (await redis.get(EXTERNAL_CHECKPOINT_KEY)) !== next) {
    throw new Error("Committed pending audit checkpoint could not be finalized");
  }
}

function usage() {
  return `Usage:
  pnpm --filter @sdp/api audit:ledger verify
  pnpm --filter @sdp/api audit:ledger checkpoint --operator <identity> --reason <reason> [--ticket <id>]
  pnpm --filter @sdp/api audit:ledger bootstrap --expected-sequence <n> --expected-head-hash <sha256> --operator <identity> --reason <reason> [--ticket <id>]

DATABASE_URL and REDIS_URL must identify the ordinary API runtime stores, not admin connections.`;
}

function parseOptions(args, allowed) {
  const values = {};
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

async function inspect(client, redis, approvedCheckpoint) {
  const externalCheckpoint =
    approvedCheckpoint === undefined
      ? await redis.get(EXTERNAL_CHECKPOINT_KEY)
      : approvedCheckpoint;
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
                 'audit_ledger_anchors_reject_direct_insert',
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
      posture.enabled_security_triggers === 7
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

async function appendCheckpoint(client, redis, options) {
  // biome-ignore lint/security/noSecrets: parameterized PostgreSQL function call.
  await client.query("SELECT pg_advisory_lock(hashtext($1))", [AUDIT_LEDGER_SESSION_LOCK_KEY]);
  let transactionOpen = false;
  let rollbackCheckpoint = null;
  try {
    await finalizeCommittedPendingCheckpoint(client, redis);
    const before = await inspect(client, redis);
    if (!before.databaseLedgerValid || !before.runtimeRoleProtected) {
      throw new Error(
        "Refusing to checkpoint an invalid ledger or through an unsafe database role"
      );
    }
    await client.query("BEGIN");
    transactionOpen = true;
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
    const pending = serializePendingCheckpoint(expected, next);
    // Establish evidence of the next sealed row before committing PostgreSQL.
    // A verifier that races the commit sees `pending` and fails closed, so a
    // privileged tail deletion cannot restore agreement with the predecessor.
    const witnessed = await redis.eval(
      ADVANCE_CHECKPOINT_LUA,
      1,
      EXTERNAL_CHECKPOINT_KEY,
      expected === null ? "missing" : "present",
      expected ?? "",
      pending
    );
    if (witnessed !== 1) {
      throw new Error("External audit-ledger pending witness was not established");
    }
    rollbackCheckpoint = { expected, pending };
    await client.query("COMMIT");
    transactionOpen = false;

    const advanced = await redis.eval(
      ADVANCE_CHECKPOINT_LUA,
      1,
      EXTERNAL_CHECKPOINT_KEY,
      "present",
      pending,
      next
    );
    if (advanced !== 1) {
      throw new Error(
        "External audit-ledger checkpoint did not advance after committed checkpoint write"
      );
    }
  } catch (error) {
    let rollbackConfirmed = false;
    if (transactionOpen) {
      try {
        await client.query("ROLLBACK");
        transactionOpen = false;
        rollbackConfirmed = true;
      } catch {
        // An ambiguous transaction outcome must leave the witness fail-closed.
      }
    }
    if (rollbackConfirmed && rollbackCheckpoint) {
      const { expected, pending } = rollbackCheckpoint;
      const restored = await redis.eval(
        RESTORE_ROLLED_BACK_CHECKPOINT_LUA,
        1,
        EXTERNAL_CHECKPOINT_KEY,
        pending,
        expected === null ? "missing" : "present",
        expected ?? ""
      );
      const current = await redis.get(EXTERNAL_CHECKPOINT_KEY);
      if (restored !== 1 && current !== expected) {
        throw new AggregateError(
          [error, new Error("External pending witness could not be restored after rollback")],
          "Audit checkpoint transaction rolled back but external recovery failed"
        );
      }
    }
    throw error;
  } finally {
    await client
      // biome-ignore lint/security/noSecrets: parameterized PostgreSQL function call.
      .query("SELECT pg_advisory_unlock(hashtext($1))", [AUDIT_LEDGER_SESSION_LOCK_KEY])
      .catch(() => {});
  }
}

async function bootstrapExternalCheckpoint(client, redis, options) {
  if (!/^\d+$/.test(options.expectedSequence ?? "")) {
    throw new Error("bootstrap requires a positive decimal --expected-sequence");
  }
  const expectedSequence = Number(options.expectedSequence);
  if (!Number.isSafeInteger(expectedSequence) || expectedSequence < 1) {
    throw new Error("bootstrap --expected-sequence is outside the supported range");
  }
  if (!/^[0-9a-f]{64}$/.test(options.expectedHeadHash ?? "")) {
    throw new Error("bootstrap requires a lowercase SHA-256 --expected-head-hash");
  }

  const approvedCheckpoint = serializeCheckpoint(expectedSequence, options.expectedHeadHash);
  // biome-ignore lint/security/noSecrets: parameterized PostgreSQL function call.
  await client.query("SELECT pg_advisory_lock(hashtext($1))", [AUDIT_LEDGER_SESSION_LOCK_KEY]);
  try {
    if ((await redis.get(EXTERNAL_CHECKPOINT_KEY)) !== null) {
      throw new Error("Refusing to bootstrap an audit ledger that already has a checkpoint");
    }
    // The expected values are supplied from the protected deployment approval,
    // never derived here from the database being trusted. Passing them through
    // the full verifier proves the sealed chain and anchors end at that exact
    // independently reviewed head.
    const report = await inspect(client, redis, approvedCheckpoint);
    if (
      !report.databaseLedgerValid ||
      !report.runtimeRoleProtected ||
      !report.externalCheckpointMatches ||
      report.checkedEntries !== expectedSequence ||
      report.headHash !== options.expectedHeadHash
    ) {
      throw new Error("Approved bootstrap checkpoint does not match a valid protected ledger");
    }

    const initialized = await redis.set(EXTERNAL_CHECKPOINT_KEY, approvedCheckpoint, "NX");
    if (initialized !== "OK") {
      throw new Error("External audit-ledger checkpoint changed during bootstrap");
    }
  } finally {
    await client
      // biome-ignore lint/security/noSecrets: parameterized PostgreSQL function call.
      .query("SELECT pg_advisory_unlock(hashtext($1))", [AUDIT_LEDGER_SESSION_LOCK_KEY])
      .catch(() => {});
  }
}

async function main() {
  const [command, ...args] = process.argv.slice(2);
  if (!command || !["verify", "checkpoint", "bootstrap"].includes(command)) {
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
      const options = parseOptions(args, new Set(["operator", "reason", "ticket"]));
      if (!options.operator?.trim() || !options.reason?.trim()) {
        throw new Error(`checkpoint requires --operator and --reason.\n\n${usage()}`);
      }
      await appendCheckpoint(client, redis, options);
    } else if (command === "bootstrap") {
      const options = parseOptions(
        args,
        new Set(["operator", "reason", "ticket", "expected-sequence", "expected-head-hash"])
      );
      if (!options.operator?.trim() || !options.reason?.trim()) {
        throw new Error(`bootstrap requires --operator and --reason.\n\n${usage()}`);
      }
      await bootstrapExternalCheckpoint(client, redis, {
        ...options,
        expectedSequence: options["expected-sequence"],
        expectedHeadHash: options["expected-head-hash"],
      });
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
