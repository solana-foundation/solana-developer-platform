import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { splitSqlStatements } from "../apps/sdp-api/scripts/lib/run-postgres-migrations.mjs";

export const MIGRATIONS_DIR = "apps/sdp-api/src/db/migrations/";
const SQL_DIR = `${MIGRATIONS_DIR}postgres/`;
const BREAKING_DIRECTIVE = /^--\s*sdp:migration-compat:\s*breaking\s*$/m;
const SQL_NAME = String.raw`(?:"[^"]+"|[^\s".(]+)`;
const ALTER_TABLE_PREFIX = new RegExp(
  String.raw`^ALTER\s+TABLE\s+(?:IF\s+EXISTS\s+)?(?:ONLY\s+)?${SQL_NAME}(?:\.${SQL_NAME})*\s*\*?\s*`,
  "i"
);

const matches = (pattern) => (text) => pattern.test(text);

const STATEMENT_RULES = [
  [matches(/^DROP\s+TABLE\b/i), "drops a table"],
  [matches(/^(?:WITH\b[\s\S]*?\b)?(?:DELETE|TRUNCATE|UPDATE|MERGE)\b/i), "rewrites rows"],
  [matches(/^(?:WITH\b[\s\S]*?\b)?INSERT\b[\s\S]*\bDO\s+UPDATE\b/i), "rewrites rows"],
];

const ALTER_ACTION_RULES = [
  [matches(/^DROP\s+(?:COLUMN\s+)?(?:IF\s+EXISTS\s+)?(?!CONSTRAINT\b)\S/i), "drops a column"],
  [matches(/^RENAME\b/i), "renames a table or column"],
  [matches(/^ALTER\s+(?:COLUMN\s+)?\S+\s+(?:SET\s+DATA\s+)?TYPE\b/i), "changes a column type"],
  [
    matches(/^ALTER\s+(?:COLUMN\s+)?\S+\s+SET\s+NOT\s+NULL\b/i),
    "makes an existing column NOT NULL",
  ],
  [
    (action) =>
      /^ADD\b/i.test(action) &&
      /\bNOT\s+NULL\b/i.test(action) &&
      !/\b(?:DEFAULT|GENERATED|PRIMARY\s+KEY)\b/i.test(action),
    "adds a NOT NULL column without a DEFAULT",
  ],
];

function splitTopLevel(text) {
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
    } else if (ch === "," && depth === 0) {
      parts.push(text.slice(start, i).trim());
      start = i + 1;
    }
  }
  parts.push(text.slice(start).trim());
  return parts.filter(Boolean);
}

export function findBreakingStatements(sql) {
  const findings = [];
  for (const statement of splitSqlStatements(sql)) {
    const summary = statement.replace(/\s+/g, " ").slice(0, 100);
    const alter = statement.match(ALTER_TABLE_PREFIX);
    if (alter) {
      for (const action of splitTopLevel(statement.slice(alter[0].length))) {
        const rule = ALTER_ACTION_RULES.find(([applies]) => applies(action));
        if (rule) findings.push(`${rule[1]}: ${summary}`);
      }
      continue;
    }
    const rule = STATEMENT_RULES.find(([applies]) => applies(statement));
    if (rule) findings.push(`${rule[1]}: ${summary}`);
  }
  return findings;
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
          "Expand first: add before use, stop using before drop. If this contraction is intended, " +
          "add `-- sdp:migration-compat: breaking` and ship it in a PR that touches only the migrations directory."
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
