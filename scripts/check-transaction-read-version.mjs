import { readdirSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import ts from "typescript";

const sourceRoots = ["apps", "packages"];
const versionOptionName = ["maxSupported", "TransactionVersion"].join("");

// These methods are application adapters around @sdp/rpc/solana.getTransaction,
// whose one RPC call supplies the shared version option. A new adapter must be
// reviewed here instead of silently bypassing the direct-call check.
const delegatedReads = new Map([
  ["apps/sdp-api/src/services/jobs/verify-ramp-deliveries.ts", "chain.getTransaction"],
  ["apps/sdp-api/src/services/jobs/reconcile-sponsorship-budgets.ts", "input.getTransaction"],
  ["apps/sdp-api/src/services/token.service.ts", "this.getTransaction"],
]);

function propertyName(node) {
  return ts.isIdentifier(node) || ts.isStringLiteral(node) ? node.text : null;
}

function hasSharedVersion(config) {
  if (config === undefined) return false;
  const options = ts.isArrayLiteralExpression(config) ? config.elements[1] : config;
  return (
    options !== undefined &&
    ts.isObjectLiteralExpression(options) &&
    options.properties.some(
      (property) =>
        ts.isPropertyAssignment(property) &&
        propertyName(property.name) === versionOptionName &&
        ts.isIdentifier(property.initializer) &&
        property.initializer.text === "MAX_SUPPORTED_TRANSACTION_VERSION"
    )
  );
}

/** Return source locations of transaction reads that omit or bypass the shared v1 policy. */
export function checkSource(source, path) {
  const file = ts.createSourceFile(path, source, ts.ScriptTarget.Latest, true);
  const violations = [];
  const production =
    !/\.(?:test|spec)\.[cm]?[jt]sx?$/.test(path) &&
    !path.includes("/src/test/") &&
    !path.includes("/__tests__/");
  function report(node, message) {
    const line = file.getLineAndCharacterOfPosition(node.getStart(file)).line + 1;
    violations.push(`${path}:${line}: ${message}`);
  }
  function visit(node) {
    if (
      ts.isPropertyAssignment(node) &&
      propertyName(node.name) === versionOptionName &&
      ts.isNumericLiteral(node.initializer) &&
      Number(node.initializer.text) === 0
    ) {
      report(node, "v0-only transaction read");
    }
    if (production && ts.isCallExpression(node)) {
      let config;
      if (
        ts.isPropertyAccessExpression(node.expression) &&
        ["getTransaction", "getParsedTransaction"].includes(node.expression.name.text) &&
        delegatedReads.get(path) !== node.expression.getText(file)
      ) {
        config = node.arguments[1];
        if (!hasSharedVersion(config)) {
          report(node, "transaction read must use MAX_SUPPORTED_TRANSACTION_VERSION");
        }
      } else if (ts.isIdentifier(node.expression)) {
        const methodIndex = node.arguments.findIndex(
          (argument, index) =>
            index < 2 && ts.isStringLiteral(argument) && argument.text === "getTransaction"
        );
        if (methodIndex !== -1) {
          config = node.arguments[methodIndex + 1];
          if (!hasSharedVersion(config)) {
            report(node, "transaction read must use MAX_SUPPORTED_TRANSACTION_VERSION");
          }
        }
      }
    }
    ts.forEachChild(node, visit);
  }
  visit(file);
  return violations;
}

function checkDirectory(directory, violations) {
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) {
      if (entry.name !== "node_modules" && entry.name !== "dist") {
        checkDirectory(path, violations);
      }
    } else if (/\.[cm]?[jt]sx?$/.test(entry.name)) {
      violations.push(...checkSource(readFileSync(path, "utf8"), path));
    }
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const violations = [];
  for (const root of sourceRoots) checkDirectory(root, violations);
  if (violations.length > 0) {
    console.error(`Transaction reads violate the v1 policy:\n${violations.join("\n")}`);
    process.exitCode = 1;
  } else {
    console.log("Transaction reads use the shared v1 policy");
  }
}
