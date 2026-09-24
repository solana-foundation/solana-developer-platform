// Pure helpers for the public-docs idempotency integrity check.
//
// Invariant: every public docs example that performs a POST against an
// endpoint whose OpenAPI contract consumes an Idempotency-Key must show that
// header in the example. A public example that omits the replay fence teaches
// callers to copy the unsafe path: an unchanged retry after a lost response is
// then treated as a brand new value-moving operation (SOLA9-368).
//
// The endpoint set is derived from the generated public OpenAPI document
// (apps/sdp-api/generated/openapi.json) instead of a hand-maintained route
// list, so newly published idempotency-consuming operations are picked up
// automatically when the docs artifacts are regenerated.

const API_URL = /https:\/\/[^\s'"\\)`]+/g;
const POST_HINT =
  /-X\s+POST\b|method\s*:\s*["']POST["']|requests\.post\s*\(|\.post\s*\(|\.POST\s*\(/i;
// Covers curl `-H "Idempotency-Key: value"`, JSON-style
// `"Idempotency-Key": "value"`, and Java `.header("Idempotency-Key", value)`.
const IDEMPOTENCY_HEADER = /Idempotency-Key["']?\s*[:=,]/i;

function stripQueryString(url) {
  const queryStart = url.search(/[?#]/);
  return queryStart === -1 ? url : url.slice(0, queryStart);
}

function pathToSegments(pathname) {
  return pathname.replace(/\/+$/, "").split("/").filter(Boolean);
}

/**
 * Matches a concrete example path (for example
 * `/v1/issuance/tokens/tok_abc123/freeze`) against an OpenAPI path template
 * (for example `/v1/issuance/tokens/{tokenId}/freeze`).
 */
export function examplePathMatchesTemplate(examplePath, templatePath) {
  const example = pathToSegments(examplePath);
  const template = pathToSegments(templatePath);
  if (example.length !== template.length) return false;
  return template.every(
    (segment, index) =>
      segment === example[index] || (/^\{.*\}$/.test(segment) && example[index] !== "")
  );
}

/**
 * Collects the POST paths of an OpenAPI document whose contract consumes an
 * `Idempotency-Key` header, whether the parameter is declared at the
 * path-item or operation level. Header name comparison is case-insensitive.
 */
export function extractIdempotencyPostPaths(openApiDocument) {
  const paths = new Set();
  const pathItems = openApiDocument?.paths ?? {};
  for (const [routePath, pathItem] of Object.entries(pathItems)) {
    if (!pathItem || typeof pathItem !== "object") continue;
    const operation = pathItem.post;
    if (!operation || typeof operation !== "object") continue;
    const parameters = [
      ...(Array.isArray(pathItem.parameters) ? pathItem.parameters : []),
      ...(Array.isArray(operation.parameters) ? operation.parameters : []),
    ];
    const consumesIdempotency = parameters.some(
      (parameter) =>
        parameter &&
        typeof parameter === "object" &&
        parameter.in === "header" &&
        typeof parameter.name === "string" &&
        parameter.name.toLowerCase() === "idempotency-key"
    );
    if (consumesIdempotency) paths.add(routePath);
  }
  return paths;
}

/**
 * Extracts fenced code blocks from MDX/Markdown source with their starting
 * line numbers (1-indexed) and info-string language.
 */
export function extractCodeBlocks(source) {
  const blocks = [];
  const lines = source.split("\n");
  let current = null;
  for (let index = 0; index < lines.length; index++) {
    const line = lines[index];
    const openingFence = current === null ? line.match(/^[ \t]*```(.*)$/) : null;
    if (openingFence) {
      current = {
        language: openingFence[1].trim().split(/\s+/)[0]?.toLowerCase() ?? "",
        contentLines: [],
        line: index + 1,
      };
      continue;
    }
    if (current !== null && /^[ \t]*```/.test(line)) {
      blocks.push({
        language: current.language,
        content: current.contentLines.join("\n"),
        line: current.line,
      });
      current = null;
      continue;
    }
    if (current !== null) current.contentLines.push(line);
  }
  return blocks;
}

function exampleRequestPaths(block) {
  const found = [];
  for (const match of block.content.matchAll(API_URL)) {
    let pathname;
    try {
      pathname = new URL(match[0]).pathname;
    } catch {
      continue;
    }
    found.push(stripQueryString(pathname));
  }
  return found;
}

/**
 * Finds public docs examples that POST to an idempotency-consuming endpoint
 * without showing the Idempotency-Key header.
 *
 * @param {{
 *   files: Array<{ path: string, source: string }>,
 *   idempotencyPostPaths: Set<string>,
 * }} input
 * @returns {Array<{ file: string, line: number, endpoint: string }>}
 */
export function findMissingIdempotencyKeyExamples({ files, idempotencyPostPaths }) {
  const violations = [];
  for (const file of files) {
    for (const block of extractCodeBlocks(file.source)) {
      if (!POST_HINT.test(block.content)) continue;
      if (IDEMPOTENCY_HEADER.test(block.content)) continue;
      for (const pathname of exampleRequestPaths(block)) {
        for (const template of idempotencyPostPaths) {
          if (!examplePathMatchesTemplate(pathname, template)) continue;
          violations.push({ file: file.path, line: block.line, endpoint: template });
          break;
        }
      }
    }
  }
  return violations;
}
