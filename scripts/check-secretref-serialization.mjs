/**
 * Forbids revealed `SecretRef` material from reaching a serializer, a logger, or
 * a string.
 *
 * `SecretRef<T>` (packages/sdp-helius-rings/src/secrets.ts) wraps viewing keys,
 * nullifier keys and proof internals. Its `toJSON()`/`toString()` overrides
 * already return "[REDACTED]", so passing a *wrapped* secret to
 * `JSON.stringify` or a log call is safe by construction — the plan's original
 * wording ("forbid JSON.stringify on any value typed SecretRef<*>") targets a
 * pattern that cannot actually leak.
 *
 * The pattern that leaks is `reveal()`. Once unwrapped, the value is an ordinary
 * string or Uint8Array with no redaction behaviour at all, and the wrapper's
 * whole purpose is gone. So this check follows the intent rather than the letter
 * and flags reveal() results flowing into:
 *
 *   1. JSON.stringify / JSON.stringify-like serialization
 *   2. a logger or console call
 *   3. a template literal or String()
 *
 * "Flowing into" covers the direct call and one indirection: identifiers
 * assigned a reveal() result (or an alias of one) are tracked per file and
 * flagged at the same sinks. Aliasing is deliberately direct-only — a value
 * that passed through another call (a hash, an encryptor) is considered
 * transformed and is the sanctioned way to log.
 *
 * It also flags `JSON.stringify` applied directly to a `SecretRef` construction,
 * which is harmless at runtime but always means the author misunderstood the
 * wrapper.
 *
 * `reveal("test")` inside test files is the sanctioned path — `RevealScope`
 * includes "test" precisely so tests can assert on real values — so test files
 * are exempt.
 *
 * This is a standalone script rather than a lint rule because the repo lints
 * with Biome, which has no custom-rule authoring mechanism in use here, and the
 * established convention for bespoke static checks is scripts/check-*.mjs with a
 * sibling .test.mjs (see check-module-boundaries.mjs, check-env-contract.mjs).
 */

import { readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import ts from "typescript";

/** Methods that write somewhere a human or a log sink can read. */
const LOG_METHODS = new Set([
  "log",
  "info",
  "warn",
  "error",
  "debug",
  "trace",
  "fatal",
  "captureException",
  "captureMessage",
]);

const SCAN_ROOTS = ["apps", "packages"];

/** Files that legitimately handle raw secret material. */
const EXEMPT_SUFFIXES = [
  "packages/sdp-helius-rings/src/secrets.ts",
  "scripts/check-secretref-serialization.mjs",
];

function isTestFile(relativePath) {
  return (
    /\.(test|spec)\.(ts|tsx|mts)$/.test(relativePath) || /(^|\/)(test|tests)\//.test(relativePath)
  );
}

function isExempt(relativePath) {
  return EXEMPT_SUFFIXES.some((suffix) => relativePath.endsWith(suffix));
}

/** True when `node` is a `<something>.reveal(...)` call. */
function isRevealCall(node) {
  return (
    ts.isCallExpression(node) &&
    ts.isPropertyAccessExpression(node.expression) &&
    node.expression.name.text === "reveal"
  );
}

/** True when `node` is `JSON.stringify(...)`. */
function isJsonStringifyCall(node) {
  return (
    ts.isCallExpression(node) &&
    ts.isPropertyAccessExpression(node.expression) &&
    node.expression.name.text === "stringify" &&
    ts.isIdentifier(node.expression.expression) &&
    node.expression.expression.text === "JSON"
  );
}

/** True when `node` is a `<obj>.info(...)`-style call onto a log-ish method. */
function isLogCall(node) {
  return (
    ts.isCallExpression(node) &&
    ts.isPropertyAccessExpression(node.expression) &&
    LOG_METHODS.has(node.expression.name.text)
  );
}

/** True when `node` is `String(...)`. */
function isStringCoercionCall(node) {
  return (
    ts.isCallExpression(node) &&
    ts.isIdentifier(node.expression) &&
    node.expression.text === "String"
  );
}

/** True when `node` is `new SecretRef(...)`. */
function isSecretRefConstruction(node) {
  return (
    ts.isNewExpression(node) &&
    ts.isIdentifier(node.expression) &&
    node.expression.text === "SecretRef"
  );
}

/** Strips wrappers that do not change what a value is. */
function unwrapExpression(node) {
  while (
    ts.isParenthesizedExpression(node) ||
    ts.isAwaitExpression(node) ||
    ts.isAsExpression(node) ||
    ts.isNonNullExpression(node) ||
    ts.isSatisfiesExpression(node)
  ) {
    node = node.expression;
  }
  return node;
}

/**
 * Names bound to a reveal() result in this file, direct aliases included
 * (`const v = ref.reveal(...)`, `w = v`). Name-based and file-scoped — a
 * same-named variable elsewhere in the file is treated as tainted too, which
 * errs toward flagging.
 */
function collectRevealedAliases(sourceFile) {
  const aliases = new Set();
  const taintsFrom = (initializer) => {
    const value = unwrapExpression(initializer);
    return isRevealCall(value) || (ts.isIdentifier(value) && aliases.has(value.text));
  };

  let changed = true;
  while (changed) {
    changed = false;
    const visit = (node) => {
      let name = null;
      if (ts.isVariableDeclaration(node) && ts.isIdentifier(node.name) && node.initializer) {
        if (taintsFrom(node.initializer)) name = node.name.text;
      } else if (
        ts.isBinaryExpression(node) &&
        node.operatorToken.kind === ts.SyntaxKind.EqualsToken &&
        ts.isIdentifier(node.left)
      ) {
        if (taintsFrom(node.right)) name = node.left.text;
      }
      if (name && !aliases.has(name)) {
        aliases.add(name);
        changed = true;
      }
      ts.forEachChild(node, visit);
    };
    ts.forEachChild(sourceFile, visit);
  }
  return aliases;
}

/** Walks `root` (inclusive) looking for any node satisfying `predicate`. */
function containsNode(root, predicate) {
  let found = false;
  const visit = (node) => {
    if (found) return;
    if (predicate(node)) {
      found = true;
      return;
    }
    ts.forEachChild(node, visit);
  };
  visit(root);
  return found;
}

function lineOf(sourceFile, node) {
  return sourceFile.getLineAndCharacterOfPosition(node.getStart(sourceFile)).line + 1;
}

/** True when any argument of a call contains a revealed value. */
function hasRevealedArgument(node, isRevealedValue) {
  return node.arguments.some((argument) => containsNode(argument, isRevealedValue));
}

/**
 * The rules. Each takes a node and returns the violation message for it, or
 * null. Kept as separate small functions rather than one branching visitor so
 * adding a rule does not push the walker past the repo's complexity ceiling.
 */
const RULES = [
  function serialization(node, isRevealedValue) {
    if (!isJsonStringifyCall(node)) return null;
    const [argument] = node.arguments;
    if (!argument) return null;
    if (containsNode(argument, isRevealedValue)) {
      return "JSON.stringify() receives a revealed SecretRef. Serialize the wrapper, or a hash of the value, not reveal().";
    }
    if (containsNode(argument, isSecretRefConstruction)) {
      return 'JSON.stringify() receives a SecretRef. It serializes to "[REDACTED]" and carries no information — drop the call.';
    }
    return null;
  },

  function logging(node, isRevealedValue) {
    if (!isLogCall(node) || !hasRevealedArgument(node, isRevealedValue)) return null;
    return `${node.expression.name.text}() receives a revealed SecretRef. Log an identifier or a hash, never the material.`;
  },

  function stringCoercion(node, isRevealedValue) {
    if (!isStringCoercionCall(node) || !hasRevealedArgument(node, isRevealedValue)) return null;
    return 'String() receives a revealed SecretRef. Coerce the wrapper instead — it yields "[REDACTED]".';
  },

  function interpolation(node, isRevealedValue) {
    if (!ts.isTemplateExpression(node)) return null;
    const interpolatesReveal = node.templateSpans.some((span) =>
      containsNode(span.expression, isRevealedValue)
    );
    if (!interpolatesReveal) return null;
    return 'Template literal interpolates a revealed SecretRef. Interpolate the wrapper instead — it yields "[REDACTED]".';
  },
];

/**
 * Returns violation strings for one file's source text. Exported so the sibling
 * test can drive it without touching the filesystem.
 */
export function findSecretRefViolations(sourceText, relativePath) {
  const violations = [];
  const sourceFile = ts.createSourceFile(
    relativePath,
    sourceText,
    ts.ScriptTarget.Latest,
    /* setParentNodes */ true,
    relativePath.endsWith(".tsx") ? ts.ScriptKind.TSX : ts.ScriptKind.TS
  );

  const aliases = collectRevealedAliases(sourceFile);
  const isRevealedValue = (node) => {
    if (isRevealCall(node)) return true;
    if (!ts.isIdentifier(node) || !aliases.has(node.text)) return false;
    // A same-named property (`obj.v`, `{ v: x }`) is not the variable.
    const parent = node.parent;
    if (parent && ts.isPropertyAccessExpression(parent) && parent.name === node) return false;
    if (parent && ts.isPropertyAssignment(parent) && parent.name === node) return false;
    return true;
  };

  const visit = (node) => {
    for (const rule of RULES) {
      const message = rule(node, isRevealedValue);
      if (message) {
        violations.push(`${relativePath}:${lineOf(sourceFile, node)}: ${message}`);
      }
    }
    ts.forEachChild(node, visit);
  };

  ts.forEachChild(sourceFile, visit);
  return violations;
}

function collectSourceFiles(repositoryRoot) {
  const files = [];

  for (const root of SCAN_ROOTS) {
    const absoluteRoot = path.join(repositoryRoot, root);
    let entries;
    try {
      if (!statSync(absoluteRoot).isDirectory()) continue;
      entries = readdirSync(absoluteRoot, { recursive: true, encoding: "utf8" });
    } catch {
      continue;
    }

    for (const entry of entries) {
      if (!/\.(ts|tsx|mts)$/.test(entry)) continue;
      if (/(^|\/)(node_modules|dist|build|\.next|\.turbo)(\/|$)/.test(entry)) continue;
      if (entry.endsWith(".d.ts")) continue;

      const relativePath = path.posix.join(root, entry.split(path.sep).join("/"));
      if (isTestFile(relativePath) || isExempt(relativePath)) continue;
      files.push(relativePath);
    }
  }

  return files.sort();
}

export function checkSecretRefSerialization(repositoryRoot) {
  const violations = [];

  for (const relativePath of collectSourceFiles(repositoryRoot)) {
    const sourceText = readFileSync(path.join(repositoryRoot, relativePath), "utf8");
    // Cheap prefilter: parsing every file in the monorepo to find a handful of
    // reveal() calls is wasted work.
    if (!sourceText.includes("reveal(") && !sourceText.includes("SecretRef")) continue;
    violations.push(...findSecretRefViolations(sourceText, relativePath));
  }

  return violations;
}

const isMainModule = process.argv[1] === fileURLToPath(import.meta.url);
if (isMainModule) {
  const repositoryRoot = path.resolve(
    process.argv[2] ?? path.dirname(fileURLToPath(import.meta.url)),
    ".."
  );
  const violations = checkSecretRefSerialization(repositoryRoot);

  if (violations.length > 0) {
    console.error("SecretRef serialization violations:\n");
    console.error(violations.map((violation) => `- ${violation}`).join("\n"));
    process.exitCode = 1;
  } else {
    console.log("SecretRef serialization check passed.");
  }
}
