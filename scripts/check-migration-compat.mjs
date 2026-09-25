import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { splitSqlStatements } from "../apps/sdp-api/scripts/lib/run-postgres-migrations.mjs";

export const MIGRATIONS_DIR = "apps/sdp-api/src/db/migrations/";
const SQL_DIR = `${MIGRATIONS_DIR}postgres/`;
const REPEATABLE_DIR = `${SQL_DIR}repeatable/`;
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
  String.raw`^DROP\s+(?:MATERIALIZED\s+)?(\w+)\s+(?:CONCURRENTLY\s+)?${IF_EXISTS}([\s\S]*)$`,
  "i"
);
const ADD_COLUMN = new RegExp(
  String.raw`^ADD\s+(?:COLUMN\s+)?(IF\s+NOT\s+EXISTS\s+)?(${NAME})`,
  "i"
);
const ADD_CONSTRAINT = new RegExp(String.raw`^ADD\s+CONSTRAINT\s+(${NAME})\s+([\s\S]*)$`, "i");
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
const CREATE_VIEW = new RegExp(
  String.raw`^CREATE\s+(?:OR\s+REPLACE\s+)?(?:TEMP(?:ORARY)?\s+|RECURSIVE\s+|MATERIALIZED\s+)*VIEW\s+${IF_EXISTS}(${NAME})`,
  "i"
);
const MAIN_VERB = /^(?:UPDATE|DELETE|INSERT|MERGE|TRUNCATE|SELECT|VALUES)\b/i;
const PLPGSQL_PREFIX =
  /^(?:DECLARE\b[\s\S]*?\bBEGIN\b|BEGIN\b|END\s+(?:IF|LOOP|CASE)\b|END\b|ELSE\b|ELSIF\b[\s\S]*?\bTHEN\b|IF\b[\s\S]*?\bTHEN\b|(?:FOR|FOREACH|WHILE)\b[\s\S]*?\bLOOP\b|LOOP\b|EXCEPTION\b|WHEN\b[\s\S]*?\bTHEN\b|PERFORM\b|RETURN\b)\s*/i;
const BRANCH = /\b(?:IF|ELSIF|ELSE|WHEN|LOOP|EXCEPTION)\b/i;

const normalize = (name) =>
  name
    .split(".")
    .pop()
    .replace(/^"(.*)"$/, "$1")
    .toLowerCase();

function scan(text, onChar) {
  let depth = 0;
  let quote = null;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (quote) {
      if (ch === quote) quote = null;
      continue;
    }
    if (ch === "'" || ch === '"') quote = ch;
    else if (ch === "(") depth++;
    else if (ch === ")") depth--;
    else if (onChar(ch, i, depth) === false) return;
  }
}

function splitTopLevel(text, separator = ",") {
  const parts = [];
  let start = 0;
  scan(text, (ch, i, depth) => {
    if (ch === separator && depth === 0) {
      parts.push(text.slice(start, i).trim());
      start = i + 1;
    }
  });
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

function topLevelKeyword(text, keyword, from = 0) {
  const pattern = new RegExp(String.raw`^${keyword}\b`, "i");
  let found = -1;
  scan(text, (ch, i, depth) => {
    if (i < from || depth !== 0 || !/\s/.test(text[i - 1] ?? " ")) return true;
    if (pattern.test(text.slice(i))) {
      found = i;
      return false;
    }
    return true;
  });
  return found;
}

function unwrapCte(statement) {
  if (!/^WITH\b/i.test(statement)) return { ctes: [], main: statement };
  let split = -1;
  scan(statement, (ch, i, depth) => {
    if (
      i >= 4 &&
      depth === 0 &&
      /\s/.test(statement[i - 1]) &&
      MAIN_VERB.test(statement.slice(i))
    ) {
      split = i;
      return false;
    }
    return true;
  });
  if (split === -1) return { ctes: [], main: statement };
  return { ctes: topLevelGroups(statement.slice(0, split)), main: statement.slice(split) };
}

function dollarBody(statement) {
  const open = statement.match(/\$[A-Za-z_]?[A-Za-z0-9_]*\$/);
  if (!open) return null;
  const start = open.index + open[0].length;
  const end = statement.indexOf(open[0], start);
  return end === -1 ? statement.slice(start) : statement.slice(start, end);
}

function plpgsqlStatements(body) {
  const out = [];
  let branch = 0;
  let handler = false;
  for (const fragment of splitSqlStatements(body)) {
    let current = fragment;
    let previous;
    do {
      previous = current;
      current = current.replace(PLPGSQL_PREFIX, "").trim();
    } while (current && current !== previous);
    const control = fragment.slice(0, fragment.length - current.length);
    if (BRANCH.test(control)) branch++;
    if (/\bEXCEPTION\b/i.test(control)) handler = true;
    if (current) out.push({ text: current, branch, handler });
  }
  const guarded = handler;
  return out.map((entry) => ({ ...entry, guarded }));
}

function innerStatements(statement, index) {
  const inner = plpgsqlStatements(dollarBody(statement) ?? "");
  return inner.map(({ text, branch, handler, guarded }, k) => [
    text,
    index + (k + 1) / (inner.length + 1),
    { block: index, branch, handler, guarded },
  ]);
}

const TOP = { block: "top", branch: 0, handler: false, guarded: false };

function dropTargets(rest) {
  return splitTopLevel(rest.replace(/\b(?:CASCADE|RESTRICT)\s*$/i, "")).map((part) =>
    normalize(
      part
        .replace(/\s+ON\s+[\s\S]*$/i, "")
        .replace(/\(.*$/s, "")
        .trim()
    )
  );
}

function collectAdditions(statements) {
  const created = new Map();
  const newTables = new Map();
  const newColumns = new Map();
  const remember = (name, entry) => {
    if (!created.has(name)) created.set(name, []);
    created.get(name).push(entry);
  };
  const rememberAction = (table, action, index) => {
    const constraint = action.match(ADD_CONSTRAINT);
    const column = !constraint && action.match(ADD_COLUMN);
    if (constraint) {
      remember(normalize(constraint[1]), { index, certain: true });
    } else if (column) {
      if (!newColumns.has(table)) newColumns.set(table, new Map());
      newColumns.get(table).set(normalize(column[2]), {
        certain: !column[1],
        notNull: /\bNOT\s+NULL\b/i.test(action) || /\bPRIMARY\s+KEY\b/i.test(action),
      });
    }
  };
  const visit = (statement, index, scope = TOP) => {
    const create = statement.match(CREATE);
    if (create) {
      const name = normalize(create[3]);
      const certain = !create[2];
      remember(name, { index, certain });
      if (create[1].toUpperCase() === "TABLE" && certain && !newTables.has(name)) {
        newTables.set(name, { index, ...scope });
      }
      return;
    }
    const alter = statement.match(ALTER_TABLE);
    if (alter) {
      const table = normalize(alter[1]);
      for (const action of splitTopLevel(statement.slice(alter[0].length))) {
        rememberAction(table, action, index);
      }
      return;
    }
    if (/^DO\b/i.test(statement)) {
      for (const [inner, position, innerScope] of innerStatements(statement, index)) {
        visit(inner, position, innerScope);
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
  if (entry.branch === 0 && !entry.guarded) return true;
  return (
    entry.block === scope.block && entry.branch === scope.branch && entry.handler === scope.handler
  );
}

function recreated(context, name, index) {
  return (context.created.get(name) ?? []).some((entry) => entry.certain || entry.index > index);
}

function constraintFinding(definition, table, context, newTable) {
  const kind = definition.match(/^(UNIQUE|FOREIGN\s+KEY|EXCLUDE)\b/i)?.[1];
  if (!kind || newTable) return null;
  if (/^EXCLUDE/i.test(kind)) return "adds an exclusion constraint on an existing table";
  const columns = splitTopLevel(topLevelGroups(definition)[0] ?? "").map(normalize);
  const added = context.newColumns.get(table) ?? new Map();
  if (columns.length > 0 && columns.every((column) => added.get(column)?.certain)) return null;
  return /^UNIQUE/i.test(kind)
    ? "adds a unique constraint over existing columns"
    : "adds a foreign key over existing columns";
}

function alterActionFindings(action, table, statementAddsConstraint, newTable, index, context) {
  const added = context.newColumns.get(table) ?? new Map();
  const isNew = (column) => added.get(column)?.certain ?? false;

  const dropConstraint = action.match(DROP_CONSTRAINT);
  if (dropConstraint) {
    return recreated(context, normalize(dropConstraint[1]), index) || statementAddsConstraint
      ? null
      : "drops a constraint";
  }
  const dropColumn = action.match(DROP_COLUMN);
  if (dropColumn) return isNew(normalize(dropColumn[1])) ? null : "drops a column";
  if (/^RENAME\b/i.test(action)) return "renames a table or column";

  const alterColumn = action.match(ALTER_COLUMN);
  if (alterColumn) {
    const column = normalize(alterColumn[1]);
    const change = alterColumn[2];
    if (/^DROP\s+DEFAULT\b/i.test(change)) {
      const fresh = added.get(column);
      return fresh?.certain && !fresh.notNull
        ? null
        : "removes a default the previous image relies on";
    }
    if (isNew(column) || newTable) return null;
    if (/^(?:SET\s+DATA\s+)?TYPE\b/i.test(change)) return "changes a column type";
    if (/^SET\s+NOT\s+NULL\b/i.test(change)) return "makes an existing column NOT NULL";
    return null;
  }

  const constraint = action.match(ADD_CONSTRAINT);
  if (constraint) return constraintFinding(constraint[2], table, context, newTable);

  if (
    ADD_COLUMN.test(action) &&
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

  if (scope !== TOP && /^EXECUTE\b(?!\s+(?:FUNCTION|PROCEDURE)\b)/i.test(main)) {
    findings.push("runs dynamic SQL that cannot be checked");
    return findings;
  }

  const alter = main.match(ALTER_TABLE);
  if (alter) {
    const table = normalize(alter[1]);
    const actions = splitTopLevel(main.slice(alter[0].length));
    const addsConstraint = actions.some((action) => ADD_CONSTRAINT.test(action));
    for (const action of actions) {
      const finding = alterActionFindings(
        action,
        table,
        addsConstraint,
        isNewTable(table),
        index,
        context
      );
      if (finding) findings.push(finding);
    }
    return findings;
  }

  const drop = main.match(DROP);
  if (drop) {
    const kind = drop[1].toLowerCase();
    for (const name of dropTargets(drop[2])) {
      const safe = kind === "table" ? isNewTable(name) : recreated(context, name, index);
      if (!safe) findings.push(`drops a ${kind}`);
    }
    return findings;
  }

  if (rewritesRows(main, context, isNewTable)) {
    findings.push("rewrites rows");
    return findings;
  }

  if (/^DO\b/i.test(main)) {
    for (const [inner, position, innerScope] of innerStatements(main, index)) {
      findings.push(...statementFindings(inner, position, context, innerScope));
    }
  }
  return findings;
}

function rewritesRows(main, context, isNewTable) {
  const update = main.match(UPDATE);
  if (update) {
    const table = normalize(update[1]);
    const targets = splitTopLevel(update[2].split(/\b(?:FROM|WHERE|RETURNING)\b/i)[0]).map(
      (assignment) => normalize(assignment.split("=")[0].trim())
    );
    const added = context.newColumns.get(table) ?? new Map();
    return (
      !isNewTable(table) && !targets.every((column) => column === "updated_at" || added.has(column))
    );
  }
  const rowTarget = main.match(ROW_TARGET);
  if (!rowTarget) return false;
  const rewrites = !/^INSERT\b/i.test(main) || /\bDO\s+UPDATE\b/i.test(main);
  return rewrites && !isNewTable(normalize(rowTarget[1]));
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

export function viewColumns(sql) {
  const columns = new Map();
  for (const statement of splitSqlStatements(sql)) {
    const view = statement.match(CREATE_VIEW);
    if (!view) continue;
    const as = topLevelKeyword(statement, "AS", view[0].length);
    if (as === -1) continue;
    const body = statement.slice(as + 2).trim();
    const { main } = unwrapCte(body);
    const select = main.match(/^SELECT\s+(?:DISTINCT\s+)?/i);
    if (!select) continue;
    const from = topLevelKeyword(main, "FROM", select[0].length);
    const list = main.slice(select[0].length, from === -1 ? undefined : from);
    const names = splitTopLevel(list).map((item) => {
      const alias = item.match(/\s+AS\s+(\S+)$/i) ?? item.match(/\)\s+(\w+)$/);
      return normalize(alias ? alias[1] : item.replace(/^[\s\S]*?([^\s.()]+)$/, "$1"));
    });
    columns.set(normalize(view[1]), names);
  }
  return columns;
}

export function findRemovedViewColumns(baseSql, headSql) {
  const before = viewColumns(baseSql);
  const after = viewColumns(headSql);
  const findings = [];
  for (const [view, columns] of before) {
    const current = new Set(after.get(view) ?? []);
    if (!after.has(view)) {
      findings.push(`drops the repeatable view ${view}`);
      continue;
    }
    for (const column of columns) {
      if (!current.has(column)) findings.push(`removes column ${column} from view ${view}`);
    }
  }
  return findings;
}

export function checkMigrationChange(changedFiles, readFile, readBase = () => null) {
  const outside = changedFiles.filter((file) => !file.startsWith(MIGRATIONS_DIR));
  const violations = [];

  for (const file of changedFiles) {
    if (!file.startsWith(SQL_DIR) || !file.endsWith(".sql")) continue;
    const sql = readFile(file);
    const findings = sql === null ? [] : findBreakingStatements(sql);
    if (file.startsWith(REPEATABLE_DIR)) {
      const base = readBase(file);
      if (base !== null) findings.push(...findRemovedViewColumns(base, sql ?? ""));
    }
    if (findings.length === 0) continue;

    if (sql === null || !BREAKING_DIRECTIVE.test(sql)) {
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
  const git = (args) =>
    execFileSync("git", args, { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] });
  const changedFiles = git(["diff", "--name-only", `${base}...HEAD`])
    .split("\n")
    .filter(Boolean);
  const mergeBase = git(["merge-base", base, "HEAD"]).trim();
  const violations = checkMigrationChange(
    changedFiles,
    (file) => (existsSync(file) ? readFileSync(file, "utf8") : null),
    (file) => {
      try {
        return git(["show", `${mergeBase}:${file}`]);
      } catch {
        return null;
      }
    }
  );

  if (violations.length > 0) {
    console.error(violations.join("\n\n"));
    process.exit(1);
  }
  console.log(`Migration compatibility policy passed (${changedFiles.length} changed files).`);
}
