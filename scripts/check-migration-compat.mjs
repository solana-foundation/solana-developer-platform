import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { splitSqlStatements } from "../apps/sdp-api/scripts/lib/run-postgres-migrations.mjs";

export const MIGRATIONS_DIR = "apps/sdp-api/src/db/migrations/";
const SQL_DIR = `${MIGRATIONS_DIR}postgres/`;
const BREAKING_DIRECTIVE = /^--\s*sdp:migration-compat:\s*breaking\s*$/m;
const NAME = String.raw`(?:"[^"]+"|[^\s".(),;]+)(?:\.(?:"[^"]+"|[^\s".(),;]+))*`;
const IF_EXISTS = String.raw`(?:IF\s+(?:NOT\s+)?EXISTS\s+)?`;
const ALTER_TABLE = new RegExp(
  String.raw`^ALTER\s+TABLE\s+${IF_EXISTS}(?:ONLY\s+)?(${NAME})\s*\*?\s*`,
  "i"
);
const CREATE = new RegExp(
  String.raw`^CREATE\s+(?:OR\s+REPLACE\s+)?(?:UNIQUE\s+|TEMP(?:ORARY)?\s+|UNLOGGED\s+|MATERIALIZED\s+)*(\w+)\s+(?:CONCURRENTLY\s+)?(IF\s+NOT\s+EXISTS\s+)?(${NAME})`,
  "i"
);
const DROP = new RegExp(
  String.raw`^DROP\s+(?:MATERIALIZED\s+)?(\w+)\s+(?:CONCURRENTLY\s+)?${IF_EXISTS}(${NAME})`,
  "i"
);
const ADD_COLUMN = new RegExp(String.raw`^ADD\s+(?:COLUMN\s+)?${IF_EXISTS}(${NAME})`, "i");
const ADD_CONSTRAINT = new RegExp(String.raw`^ADD\s+CONSTRAINT\s+(${NAME})`, "i");
const DROP_COLUMN = new RegExp(
  String.raw`^DROP\s+(?:COLUMN\s+)?${IF_EXISTS}(?!CONSTRAINT\b)(${NAME})`,
  "i"
);
const DROP_CONSTRAINT = new RegExp(String.raw`^DROP\s+CONSTRAINT\s+${IF_EXISTS}(${NAME})`, "i");
const ALTER_COLUMN = new RegExp(String.raw`^ALTER\s+(?:COLUMN\s+)?(${NAME})\s+(.*)$`, "is");
const UPDATE = new RegExp(
  String.raw`^UPDATE\s+(?:ONLY\s+)?(${NAME})(?:\s+(?:AS\s+)?(?!SET\b)\w+)?\s+SET\s+(.*)$`,
  "is"
);
const ROW_TARGET = new RegExp(
  String.raw`^(?:DELETE\s+FROM|TRUNCATE(?:\s+TABLE)?(?:\s+ONLY)?|MERGE\s+INTO|INSERT\s+INTO)\s+(?:ONLY\s+)?(${NAME})`,
  "i"
);
const MAIN_VERB = /^(?:UPDATE|DELETE|INSERT|MERGE|TRUNCATE|SELECT|VALUES)\b/i;
const PLPGSQL_PREFIX =
  /^(?:DECLARE\b[\s\S]*?\bBEGIN\b|BEGIN\b|END\s+(?:IF|LOOP|CASE)\b|END\b|ELSE\b|ELSIF\b[\s\S]*?\bTHEN\b|IF\b[\s\S]*?\bTHEN\b|(?:FOR|FOREACH|WHILE)\b[\s\S]*?\bLOOP\b|LOOP\b|EXCEPTION\b|WHEN\b[\s\S]*?\bTHEN\b|PERFORM\b|RETURN\b)\s*/i;

const normalize = (name) =>
  name
    .split(".")
    .pop()
    .replace(/^"(.*)"$/, "$1")
    .toLowerCase();

function splitTopLevel(text, separator = ",") {
  const parts = [];
  let depth = 0;
  let quote = null;
  let start = 0;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (quote) {
      if (ch === quote) quote = null;
    } else if (ch === "'" || ch === '"') {
      quote = ch;
    } else if (ch === "(") {
      depth++;
    } else if (ch === ")") {
      depth--;
    } else if (ch === separator && depth === 0) {
      parts.push(text.slice(start, i).trim());
      start = i + 1;
    }
  }
  parts.push(text.slice(start).trim());
  return parts.filter(Boolean);
}

function topLevelGroups(text) {
  const groups = [];
  let depth = 0;
  let quote = null;
  let start = -1;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (quote) {
      if (ch === quote) quote = null;
    } else if (ch === "'" || ch === '"') {
      quote = ch;
    } else if (ch === "(") {
      if (depth === 0) start = i + 1;
      depth++;
    } else if (ch === ")") {
      depth--;
      if (depth === 0 && start !== -1) groups.push(text.slice(start, i));
    }
  }
  return groups;
}

function unwrapCte(statement) {
  if (!/^WITH\b/i.test(statement)) return { ctes: [], main: statement };
  let depth = 0;
  let quote = null;
  for (let i = 4; i < statement.length; i++) {
    const ch = statement[i];
    if (quote) {
      if (ch === quote) quote = null;
    } else if (ch === "'" || ch === '"') {
      quote = ch;
    } else if (ch === "(") {
      depth++;
    } else if (ch === ")") {
      depth--;
    } else if (depth === 0 && /\s/.test(statement[i - 1]) && MAIN_VERB.test(statement.slice(i))) {
      return { ctes: topLevelGroups(statement.slice(0, i)), main: statement.slice(i) };
    }
  }
  return { ctes: [], main: statement };
}

function dollarBody(statement) {
  const open = statement.match(/\$[A-Za-z_]?[A-Za-z0-9_]*\$/);
  if (!open) return null;
  const start = open.index + open[0].length;
  const end = statement.indexOf(open[0], start);
  return end === -1 ? statement.slice(start) : statement.slice(start, end);
}

const BRANCH = /\b(?:IF|ELSIF|ELSE|WHEN|LOOP|EXCEPTION)\b/i;

function plpgsqlStatements(body) {
  const out = [];
  let branch = 0;
  for (const fragment of splitSqlStatements(body)) {
    let current = fragment;
    let previous;
    do {
      previous = current;
      current = current.replace(PLPGSQL_PREFIX, "").trim();
    } while (current && current !== previous);
    if (BRANCH.test(fragment.slice(0, fragment.length - current.length))) branch++;
    if (current) out.push({ text: current, branch });
  }
  return out;
}

function innerStatements(statement, index) {
  const inner = plpgsqlStatements(dollarBody(statement) ?? "");
  return inner.map(({ text, branch }, k) => [
    text,
    index + (k + 1) / (inner.length + 1),
    { block: index, branch },
  ]);
}

const TOP = { block: "top", branch: 0 };

function collectAdditions(statements) {
  const created = new Set();
  const newTables = new Map();
  const newColumns = new Map();
  const addColumn = (table, column) => {
    if (!newColumns.has(table)) newColumns.set(table, new Set());
    newColumns.get(table).add(column);
  };
  const visit = (statement, index, scope = TOP) => {
    const create = statement.match(CREATE);
    if (create) {
      const name = normalize(create[3]);
      created.add(name);
      if (create[1].toUpperCase() === "TABLE" && !create[2] && !newTables.has(name)) {
        newTables.set(name, { index, ...scope });
      }
      return;
    }
    const alter = statement.match(ALTER_TABLE);
    if (alter) {
      const table = normalize(alter[1]);
      for (const action of splitTopLevel(statement.slice(alter[0].length))) {
        const constraint = action.match(ADD_CONSTRAINT);
        const column = !constraint && action.match(ADD_COLUMN);
        if (constraint) created.add(normalize(constraint[1]));
        else if (column) addColumn(table, normalize(column[1]));
      }
      return;
    }
    if (/^DO\b/i.test(statement)) {
      for (const [inner, position, scope] of innerStatements(statement, index)) {
        visit(inner, position, scope);
      }
    }
  };
  statements.forEach((statement, index) => {
    visit(statement, index);
  });
  return { created, newTables, newColumns };
}

function tableIsNew(context, table, index, scope) {
  const entry = context.newTables.get(table);
  if (entry === undefined || entry.index >= index) return false;
  return entry.branch === 0 || (entry.block === scope.block && entry.branch === scope.branch);
}

function alterActionFindings(action, table, replacesConstraint, newTable, context) {
  const isNew = (column) => context.newColumns.get(table)?.has(column) ?? false;
  const dropConstraint = action.match(DROP_CONSTRAINT);
  if (dropConstraint) {
    return context.created.has(normalize(dropConstraint[1])) || replacesConstraint
      ? null
      : "drops a constraint";
  }
  const dropColumn = action.match(DROP_COLUMN);
  if (dropColumn) return isNew(normalize(dropColumn[1])) ? null : "drops a column";
  if (/^RENAME\b/i.test(action)) return "renames a table or column";
  const alterColumn = action.match(ALTER_COLUMN);
  if (alterColumn && !isNew(normalize(alterColumn[1]))) {
    if (/^(?:SET\s+DATA\s+)?TYPE\b/i.test(alterColumn[2])) return "changes a column type";
    if (/^SET\s+NOT\s+NULL\b/i.test(alterColumn[2])) return "makes an existing column NOT NULL";
  }
  if (
    ADD_COLUMN.test(action) &&
    !ADD_CONSTRAINT.test(action) &&
    !newTable &&
    /\bNOT\s+NULL\b/i.test(action) &&
    !/\b(?:DEFAULT|GENERATED|PRIMARY\s+KEY)\b/i.test(action)
  ) {
    return "adds a NOT NULL column without a DEFAULT";
  }
  return null;
}

function statementFindings(statement, index, context, scope = TOP) {
  const findings = [];
  const { ctes, main } = unwrapCte(statement);
  for (const cte of ctes) findings.push(...statementFindings(cte.trim(), index, context, scope));
  const isNewTable = (table) => tableIsNew(context, table, index, scope);

  const alter = main.match(ALTER_TABLE);
  if (alter) {
    const table = normalize(alter[1]);
    const actions = splitTopLevel(main.slice(alter[0].length));
    const replacesConstraint = actions.some((action) => ADD_CONSTRAINT.test(action));
    for (const action of actions) {
      const finding = alterActionFindings(
        action,
        table,
        replacesConstraint,
        isNewTable(table),
        context
      );
      if (finding) findings.push(finding);
    }
    return findings;
  }

  const drop = main.match(DROP);
  if (drop) {
    const kind = drop[1].toLowerCase();
    const name = normalize(drop[2]);
    const recreated = kind === "table" ? isNewTable(name) : context.created.has(name);
    if (!recreated) findings.push(`drops a ${kind}`);
    return findings;
  }

  const update = main.match(UPDATE);
  if (update) {
    const table = normalize(update[1]);
    const targets = splitTopLevel(update[2].split(/\b(?:FROM|WHERE|RETURNING)\b/i)[0]).map(
      (assignment) => normalize(assignment.split("=")[0].trim())
    );
    const allowed = context.newColumns.get(table) ?? new Set();
    if (
      !isNewTable(table) &&
      !targets.every((column) => column === "updated_at" || allowed.has(column))
    ) {
      findings.push("rewrites rows");
    }
    return findings;
  }

  const rowTarget = main.match(ROW_TARGET);
  if (rowTarget) {
    const isInsert = /^INSERT\b/i.test(main);
    const rewrites = !isInsert || /\bDO\s+UPDATE\b/i.test(main);
    if (rewrites && !isNewTable(normalize(rowTarget[1]))) findings.push("rewrites rows");
    return findings;
  }

  if (/^DO\b/i.test(main)) {
    for (const [inner, position, innerScope] of innerStatements(main, index)) {
      findings.push(...statementFindings(inner, position, context, innerScope));
    }
  }
  return findings;
}

export function findBreakingStatements(sql) {
  const statements = splitSqlStatements(sql);
  const context = collectAdditions(statements);
  return statements.flatMap((statement, index) =>
    statementFindings(statement, index, context).map(
      (finding) => `${finding}: ${statement.replace(/\s+/g, " ").slice(0, 100)}`
    )
  );
}

export function checkMigrationChange(changedFiles, readFile) {
  const outside = changedFiles.filter((file) => !file.startsWith(MIGRATIONS_DIR));
  const violations = [];

  for (const file of changedFiles) {
    if (!file.startsWith(SQL_DIR) || !file.endsWith(".sql")) continue;
    const sql = readFile(file);
    if (sql === null) continue;
    const findings = findBreakingStatements(sql);
    if (findings.length === 0) continue;

    if (!BREAKING_DIRECTIVE.test(sql)) {
      violations.push(
        `${file}: the previous image cannot run against this schema, so a traffic rollback would break:\n  ${findings.join("\n  ")}\n` +
          "Expand first: add before use, stop using before drop, backfill only columns this file adds. " +
          "If this contraction is intended, add `-- sdp:migration-compat: breaking` and ship it in a PR that touches only the migrations directory."
      );
    } else if (outside.length > 0) {
      violations.push(
        `${file} is marked breaking, so the PR must change nothing outside ${MIGRATIONS_DIR}; found ${outside.join(", ")}.`
      );
    }
  }

  return violations;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const base = process.env.MIGRATION_COMPAT_BASE_REF || "origin/main";
  const changedFiles = execFileSync("git", ["diff", "--name-only", `${base}...HEAD`], {
    encoding: "utf8",
  })
    .split("\n")
    .filter(Boolean);
  const violations = checkMigrationChange(changedFiles, (file) =>
    existsSync(file) ? readFileSync(file, "utf8") : null
  );

  if (violations.length > 0) {
    console.error(violations.join("\n\n"));
    process.exit(1);
  }
  console.log(`Migration compatibility policy passed (${changedFiles.length} changed files).`);
}
