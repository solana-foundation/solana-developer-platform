import { readdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import ts from "typescript";

const scriptDirectory = import.meta.dirname;
const webDirectory = path.resolve(scriptDirectory, "..");
const sourceDirectory = path.join(webDirectory, "src");
const baselinePath = path.join(webDirectory, "src/i18n/ui-copy-baseline.json");
const exemptionsPath = path.join(webDirectory, "src/i18n/ui-copy-exemptions.json");
const userFacingAttributeNames = new Set(["alt", "aria-label", "placeholder", "title"]);
const userFacingPropertyNames = new Set(["description", "label", "placeholder", "title"]);
const nonCopyPropertyNames = new Set(["className", "href", "id", "key", "value"]);
const sourceExtensions = new Set([".ts", ".tsx"]);

function isUserFacingText(value) {
  const trimmed = value.trim();
  if (/^[A-Za-z][A-Za-z0-9]*(?:\.[A-Za-z][A-Za-z0-9]*)+$/.test(trimmed)) return false;
  return /[A-Za-z]{2,}/.test(trimmed);
}

function literalText(node) {
  if (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node)) return node.text;
  return undefined;
}

function isNonCopyLiteral(node) {
  if (ts.isBinaryExpression(node.parent) || ts.isCaseClause(node.parent)) return true;
  if (
    ts.isPropertyAssignment(node.parent) &&
    propertyName(node.parent.name) === "label" &&
    ts.isObjectLiteralExpression(node.parent.parent)
  ) {
    const protocolIdentifier = node.parent.parent.properties.find(
      (property) =>
        ts.isPropertyAssignment(property) && ["key", "value"].includes(propertyName(property.name))
    );
    if (protocolIdentifier && literalText(protocolIdentifier.initializer) === literalText(node)) {
      return true;
    }
  }
  return (
    ts.isPropertyAssignment(node.parent) && nonCopyPropertyNames.has(propertyName(node.parent.name))
  );
}

function literalTexts(node) {
  const values = [];

  function visit(current) {
    const value = literalText(current);
    if (value !== undefined && !isNonCopyLiteral(current)) {
      values.push(value);
      return;
    }

    if (ts.isCallExpression(current) && isTranslationCall(current)) {
      return;
    }

    if (
      ts.isJsxElement(current) ||
      ts.isJsxFragment(current) ||
      ts.isJsxSelfClosingElement(current)
    ) {
      return;
    }

    if (ts.isPropertyAssignment(current) && nonCopyPropertyNames.has(propertyName(current.name))) {
      return;
    }

    if (ts.isTemplateExpression(current)) {
      const staticText = [
        current.head.text,
        ...current.templateSpans.map((span) => span.literal.text),
      ].join("");
      if (isUserFacingText(staticText)) values.push(current.getText());
      return;
    }

    ts.forEachChild(current, visit);
  }

  visit(node);
  return values;
}

function propertyName(node) {
  if (ts.isIdentifier(node) || ts.isStringLiteral(node)) return node.text;
  return undefined;
}

function isTranslationCall(node) {
  return ts.isIdentifier(node.expression) && ["t", "translate"].includes(node.expression.text);
}

async function collectSourceFiles(directory) {
  const entries = await readdir(directory, { withFileTypes: true });
  const files = await Promise.all(
    entries.map(async (entry) => {
      const entryPath = path.join(directory, entry.name);
      if (entry.isDirectory()) {
        if (entry.name === "api" || entry.name === "i18n") return [];
        return collectSourceFiles(entryPath);
      }
      if (!sourceExtensions.has(path.extname(entry.name)) || entry.name.includes(".test."))
        return [];
      return [entryPath];
    })
  );
  return files.flat();
}

function candidateId(filePath, sourceFile, node, value) {
  const { line, character } = sourceFile.getLineAndCharacterOfPosition(node.getStart(sourceFile));
  return `${path.relative(webDirectory, filePath)}:${line + 1}:${character + 1}:${value}`;
}

function isToastCall(node) {
  if (ts.isIdentifier(node.expression)) return node.expression.text === "toast";
  return (
    ts.isPropertyAccessExpression(node.expression) &&
    node.expression.expression.getText() === "toast"
  );
}

function addLiteralCandidates(candidates, filePath, sourceFile, node, valueNode) {
  for (const value of literalTexts(valueNode)) {
    if (isUserFacingText(value)) candidates.add(candidateId(filePath, sourceFile, node, value));
  }
}

function collectJsxTextCandidate(candidates, filePath, sourceFile, node) {
  if (!ts.isJsxText(node) || !isUserFacingText(node.text)) return;
  candidates.add(candidateId(filePath, sourceFile, node, node.text.trim().replace(/\s+/g, " ")));
}

function collectJsxAttributeCandidates(candidates, filePath, sourceFile, node) {
  if (
    !ts.isJsxAttribute(node) ||
    !userFacingAttributeNames.has(node.name.text) ||
    !node.initializer
  ) {
    return;
  }
  addLiteralCandidates(candidates, filePath, sourceFile, node, node.initializer);
}

function collectPropertyCandidates(candidates, filePath, sourceFile, node) {
  if (!ts.isPropertyAssignment(node) || !userFacingPropertyNames.has(propertyName(node.name))) {
    return;
  }
  addLiteralCandidates(candidates, filePath, sourceFile, node, node.initializer);
}

function collectJsxExpressionCandidates(candidates, filePath, sourceFile, node) {
  if (
    !ts.isJsxExpression(node) ||
    !(ts.isJsxElement(node.parent) || ts.isJsxFragment(node.parent)) ||
    !node.expression
  ) {
    return;
  }
  addLiteralCandidates(candidates, filePath, sourceFile, node, node.expression);
}

function collectToastCandidates(candidates, filePath, sourceFile, node) {
  if (!ts.isCallExpression(node) || !isToastCall(node)) return;
  for (const argument of node.arguments) {
    if (ts.isObjectLiteralExpression(argument)) {
      for (const property of argument.properties) {
        if (
          ts.isPropertyAssignment(property) &&
          userFacingPropertyNames.has(propertyName(property.name))
        ) {
          addLiteralCandidates(candidates, filePath, sourceFile, node, property.initializer);
        }
      }
      continue;
    }
    addLiteralCandidates(candidates, filePath, sourceFile, node, argument);
  }
}

function collectCandidates(filePath, source) {
  const sourceFile = ts.createSourceFile(filePath, source, ts.ScriptTarget.Latest, true);
  const candidates = new Set();

  function visit(node) {
    collectJsxTextCandidate(candidates, filePath, sourceFile, node);
    collectJsxAttributeCandidates(candidates, filePath, sourceFile, node);
    collectPropertyCandidates(candidates, filePath, sourceFile, node);
    collectJsxExpressionCandidates(candidates, filePath, sourceFile, node);
    collectToastCandidates(candidates, filePath, sourceFile, node);

    ts.forEachChild(node, visit);
  }

  visit(sourceFile);
  return candidates;
}

const files = await collectSourceFiles(sourceDirectory);
const candidates = new Set();
for (const filePath of files) {
  for (const candidate of collectCandidates(filePath, await readFile(filePath, "utf8"))) {
    candidates.add(candidate);
  }
}

const current = [...candidates].sort();
if (process.argv.includes("--write")) {
  await writeFile(baselinePath, `${JSON.stringify(current, null, 2)}\n`);
  console.log(`Recorded ${current.length} existing UI copy candidates.`);
  process.exit(0);
}

const strict = process.argv.includes("--strict");
const approvedEntries = JSON.parse(await readFile(strict ? exemptionsPath : baselinePath, "utf8"));
const approved = new Set(
  approvedEntries.map((entry) => (typeof entry === "string" ? entry : entry.candidate))
);
const unapprovedCandidates = current.filter((candidate) => !approved.has(candidate));
if (unapprovedCandidates.length > 0) {
  console.error(
    strict
      ? "Unapproved hard-coded UI copy must use the i18n catalog or be explicitly exempted:"
      : "New hard-coded UI copy must use the i18n catalog:"
  );
  for (const candidate of unapprovedCandidates) console.error(`- ${candidate}`);
  process.exit(1);
}

console.log(
  strict
    ? "Strict UI copy audit passed (all candidates are catalog-backed or explicitly exempted)."
    : `UI copy audit passed (${current.length} legacy candidates tracked).`
);
