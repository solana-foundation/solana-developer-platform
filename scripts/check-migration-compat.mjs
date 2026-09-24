import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { splitSqlStatements } from "../apps/sdp-api/scripts/lib/run-postgres-migrations.mjs";

export const MIGRATIONS_DIR = "apps/sdp-api/src/db/migrations/";
const SQL_DIR = `${MIGRATIONS_DIR}postgres/`;
const BREAKING_DIRECTIVE = /^--\s*sdp:migration-compat:\s*breaking\s*$/m;

const RULES = [
  [/^DROP\s+TABLE\b/i, "drops a table"],
  [/^ALTER\s+TABLE\b[\s\S]*\bDROP\s+COLUMN\b/i, "drops a column"],
  [/^ALTER\s+TABLE\b[\s\S]*\bRENAME\b/i, "renames a table or column"],
  [/^ALTER\s+TABLE\b[\s\S]*\bALTER\s+COLUMN\b[\s\S]*\bTYPE\b/i, "changes a column type"],
  [/^ALTER\s+TABLE\b[\s\S]*\bSET\s+NOT\s+NULL\b/i, "makes an existing column NOT NULL"],
  [
    /^ALTER\s+TABLE\b[\s\S]*\bADD\s+COLUMN\b(?![\s\S]*\bDEFAULT\b)[\s\S]*\bNOT\s+NULL\b/i,
    "adds a NOT NULL column without a DEFAULT",
  ],
  [/^(?:DELETE|TRUNCATE|UPDATE)\b/i, "rewrites rows"],
];

export function findBreakingStatements(sql) {
  return splitSqlStatements(sql).flatMap((statement) => {
    const rule = RULES.find(([pattern]) => pattern.test(statement));
    return rule ? [`${rule[1]}: ${statement.replace(/\s+/g, " ").slice(0, 100)}`] : [];
  });
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
