import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import process from "node:process";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const ts = require("typescript");

const FILE_WARN_THRESHOLD = 400;
const FILE_FAIL_THRESHOLD = 600;
const FUNCTION_LINES_WARN_THRESHOLD = 80;
const FUNCTION_LINES_FAIL_THRESHOLD = 120;
const COMPLEXITY_WARN_THRESHOLD = 15;
const COMPLEXITY_FAIL_THRESHOLD = 20;
const DEFAULT_BASE_REF = process.env.STRUCTURAL_CHECK_BASE ?? "origin/main";
const ROOT = process.cwd();

const FUNCTION_KINDS = new Set([
  ts.SyntaxKind.FunctionDeclaration,
  ts.SyntaxKind.FunctionExpression,
  ts.SyntaxKind.ArrowFunction,
  ts.SyntaxKind.MethodDeclaration,
  ts.SyntaxKind.GetAccessor,
  ts.SyntaxKind.SetAccessor,
  ts.SyntaxKind.Constructor,
]);

const DECISION_KINDS = new Set([
  ts.SyntaxKind.IfStatement,
  ts.SyntaxKind.ForStatement,
  ts.SyntaxKind.ForInStatement,
  ts.SyntaxKind.ForOfStatement,
  ts.SyntaxKind.WhileStatement,
  ts.SyntaxKind.DoStatement,
  ts.SyntaxKind.CaseClause,
  ts.SyntaxKind.CatchClause,
  ts.SyntaxKind.ConditionalExpression,
]);

function parseArgs(argv) {
  const args = { base: DEFAULT_BASE_REF, files: [] };

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--base") {
      args.base = argv[index + 1] ?? DEFAULT_BASE_REF;
      index += 1;
      continue;
    }

    if (arg.startsWith("--base=")) {
      args.base = arg.slice("--base=".length) || DEFAULT_BASE_REF;
      continue;
    }

    if (arg === "--files") {
      args.files = argv.slice(index + 1);
      break;
    }
  }

  return args;
}

function parseChangedEntries(output) {
  return output
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => {
      const parts = line.split("\t");
      const status = parts[0] ?? "";

      if (status.startsWith("R")) {
        return {
          status,
          basePath: parts[1] ?? null,
          currentPath: parts[2] ?? null,
        };
      }

      if (status === "D") {
        return {
          status,
          basePath: parts[1] ?? null,
          currentPath: null,
        };
      }

      if (status === "A") {
        return {
          status,
          basePath: null,
          currentPath: parts[1] ?? null,
        };
      }

      return {
        status,
        basePath: parts[1] ?? null,
        currentPath: parts[1] ?? null,
      };
    });
}

function getChangedEntries(baseRef) {
  const output = execFileSync(
    "git",
    ["diff", "--name-status", "--find-renames", `${baseRef}...HEAD`],
    { cwd: ROOT, encoding: "utf8" }
  );

  return parseChangedEntries(output);
}

function isProductionSourcePath(filePath) {
  if (!filePath || (!filePath.startsWith("apps/") && !filePath.startsWith("packages/"))) {
    return false;
  }

  if (!/\.(ts|tsx|js|jsx)$/.test(filePath) || filePath.endsWith(".d.ts")) {
    return false;
  }

  const normalized = filePath.replaceAll("\\", "/");
  if (
    normalized.includes("/__tests__/") ||
    normalized.includes("/test/") ||
    normalized.includes("/openapi/") ||
    normalized.includes(".test.")
  ) {
    return false;
  }

  return true;
}

function isProductionSource(filePath) {
  return isProductionSourcePath(filePath) && fs.existsSync(path.join(ROOT, filePath));
}

function getFunctionName(node) {
  if (node.name && ts.isIdentifier(node.name)) {
    return node.name.text;
  }

  if (node.name && ts.isStringLiteral(node.name)) {
    return node.name.text;
  }

  if (ts.isConstructorDeclaration(node)) {
    return "constructor";
  }

  const parent = node.parent;
  if (parent && ts.isVariableDeclaration(parent) && ts.isIdentifier(parent.name)) {
    return parent.name.text;
  }

  if (parent && ts.isPropertyAssignment(parent)) {
    const name = parent.name;
    if (ts.isIdentifier(name) || ts.isStringLiteral(name)) {
      return name.text;
    }
  }

  return "<anonymous>";
}

function getFunctionComplexity(node) {
  let complexity = 1;

  function visit(current) {
    if (current !== node && FUNCTION_KINDS.has(current.kind)) {
      return;
    }

    if (DECISION_KINDS.has(current.kind)) {
      complexity += 1;
    }

    if (ts.isBinaryExpression(current)) {
      const operator = current.operatorToken.kind;
      if (
        operator === ts.SyntaxKind.AmpersandAmpersandToken ||
        operator === ts.SyntaxKind.BarBarToken ||
        operator === ts.SyntaxKind.QuestionQuestionToken
      ) {
        complexity += 1;
      }
    }

    ts.forEachChild(current, visit);
  }

  visit(node.body ?? node);
  return complexity;
}

function inspectSourceText(filePath, text) {
  const lineCount = text.split(/\r?\n/).length;
  const extension = path.extname(filePath);
  const scriptKind =
    extension === ".tsx"
      ? ts.ScriptKind.TSX
      : extension === ".jsx"
        ? ts.ScriptKind.JSX
        : extension === ".js"
          ? ts.ScriptKind.JS
          : ts.ScriptKind.TS;
  const sourceFile = ts.createSourceFile(
    filePath,
    text,
    ts.ScriptTarget.Latest,
    true,
    scriptKind
  );

  const warnings = [];
  const failures = [];

  if (lineCount > FILE_FAIL_THRESHOLD) {
    failures.push(`file has ${lineCount} lines (limit ${FILE_FAIL_THRESHOLD})`);
  } else if (lineCount > FILE_WARN_THRESHOLD) {
    warnings.push(`file has ${lineCount} lines (warn ${FILE_WARN_THRESHOLD})`);
  }

  function walk(node) {
    if (FUNCTION_KINDS.has(node.kind) && node.body) {
      const start = sourceFile.getLineAndCharacterOfPosition(node.getStart(sourceFile));
      const end = sourceFile.getLineAndCharacterOfPosition(node.end);
      const lines = end.line - start.line + 1;
      const complexity = getFunctionComplexity(node);
      const label = `${getFunctionName(node)} @ ${filePath}:${start.line + 1}`;

      if (lines > FUNCTION_LINES_FAIL_THRESHOLD) {
        failures.push(`${label} has ${lines} lines (limit ${FUNCTION_LINES_FAIL_THRESHOLD})`);
      } else if (lines > FUNCTION_LINES_WARN_THRESHOLD) {
        warnings.push(`${label} has ${lines} lines (warn ${FUNCTION_LINES_WARN_THRESHOLD})`);
      }

      if (complexity > COMPLEXITY_FAIL_THRESHOLD) {
        failures.push(
          `${label} has complexity ${complexity} (limit ${COMPLEXITY_FAIL_THRESHOLD})`
        );
      } else if (complexity > COMPLEXITY_WARN_THRESHOLD) {
        warnings.push(
          `${label} has complexity ${complexity} (warn ${COMPLEXITY_WARN_THRESHOLD})`
        );
      }
    }

    ts.forEachChild(node, walk);
  }

  walk(sourceFile);

  return {
    filePath,
    lineCount,
    warnings,
    failures,
  };
}

function inspectFile(filePath) {
  return inspectSourceText(filePath, fs.readFileSync(path.join(ROOT, filePath), "utf8"));
}

function inspectBaseFile(baseRef, filePath) {
  return inspectSourceText(
    filePath,
    execFileSync("git", ["show", `${baseRef}:${filePath}`], {
      cwd: ROOT,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    })
  );
}

function formatResults(results) {
  const warnings = results.flatMap((result) =>
    result.warnings.map((message) => `WARN  ${message}`)
  );
  const failures = results.flatMap((result) =>
    result.failures.map((message) => `FAIL  ${message}`)
  );

  return { warnings, failures };
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  const changedEntries =
    args.files.length > 0
      ? args.files.map((filePath) => ({
          status: "M",
          basePath: filePath,
          currentPath: filePath,
        }))
      : getChangedEntries(args.base);
  const sourceFiles = [
    ...new Set(changedEntries.map((entry) => entry.currentPath).filter(isProductionSource)),
  ].sort();
  const baselineFiles = [
    ...new Set(changedEntries.map((entry) => entry.basePath).filter(isProductionSourcePath)),
  ].sort();

  if (sourceFiles.length === 0) {
    console.log(`Structural check: no matching production source files changed against ${args.base}.`);
    return;
  }

  const results = sourceFiles.map(inspectFile);
  const { warnings, failures } = formatResults(results);
  const baselineResults = baselineFiles.flatMap((filePath) => {
    try {
      return [inspectBaseFile(args.base, filePath)];
    } catch {
      return [];
    }
  });
  const { failures: baselineFailures } = formatResults(baselineResults);

  console.log(
    `Structural check inspected ${sourceFiles.length} file${sourceFiles.length === 1 ? "" : "s"} against ${args.base}.`
  );

  for (const message of warnings) {
    console.log(message);
  }

  for (const message of failures) {
    console.log(message);
  }

  if (failures.length > 0) {
    if (baselineFailures.length === 0 || failures.length > baselineFailures.length) {
      process.exitCode = 1;
      return;
    }

    console.log(
      `Structural ratchet passed: current branch has ${failures.length} failure${failures.length === 1 ? "" : "s"} vs ${baselineFailures.length} on ${args.base}.`
    );
  }
}

main();
