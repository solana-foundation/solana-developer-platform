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
// Relative request targets quoted in examples (single quotes, double quotes, or
// template literals), for example `sdpAdmin.post(`/v1/issuance/tokens/${id}/unfreeze`)`.
// Protocol-relative `//host` paths are not request targets in examples.
const RELATIVE_PATH = /(?<=["'`])\/(?!\/)[^\s'"`\\),]+/g;
const POST_HINT =
  /-X\s+POST\b|method\s*:\s*["']POST["']|requests\.post\s*\(|\.post\s*\(|\.POST\s*\(/i;
// Covers curl `-H "Idempotency-Key: value"`, JSON-style
// `"Idempotency-Key": "value"`, Java `.header("Idempotency-Key", value)`, and
// the docs client wrapper's `{ idempotencyKey }` option.
const IDEMPOTENCY_HEADER = /(?:Idempotency-Key|idempotencyKey)["']?\s*[:=,]/i;
// Lines that begin a separate request inside a shared code block: new shell
// commands and new statements (curl, await, const / let / var declarations,
// direct or assigned fetch / client.post calls). Comment lines are not
// boundaries: they label the request that follows them.
const REQUEST_START =
  /^(?:curl\b|await\b|(?:const|let|var)\b|fetch\s*\(|[\w$][\w$\s]*=\s*(?:await\s+)?(?:fetch\s*\(|[\w$.]*\.(?:post|request)\s*\(|[\w$][\w$.]*\.newBuilder)|[\w$.]*\.(?:post|request)\s*\()/;
const COMMENT_LINE = /^\s*(?:#|\/\/)/;
// Request targets assigned to a variable, whether declared
// (`const url = "https://api.solana.com/v1/payments/transfer-batches";`) or
// reassigned before the request call (`url = "/v1/payments/transfers";`). The
// value must be a plain quoted string (absolute URL or relative path). Matched
// per line so a comment can prefix the declaration inside a shared chunk and a
// reassignment replaces the target the request call resolves to.
const URL_VARIABLE_ASSIGNMENT =
  /^\s*(?:(?:const|let|var)\s+)?([\w$]+)\s*=\s*(["'`])([^'"`]*)\2;?\s*(?:\/\/.*)?$/;
// A request call whose first argument is a bare identifier, for example
// `fetch(url, { ... })` or `client.post(url, { ... })`.
const REQUEST_CALL_TARGET = /\b(?:fetch|post|request)\s*\(\s*([\w$]+)/g;

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

function requestTargetPath(value) {
  if (!value) return null;
  if (/^https?:\/\//i.test(value)) {
    try {
      return stripQueryString(new URL(value).pathname);
    } catch {
      return null;
    }
  }
  return value.startsWith("/") ? stripQueryString(value) : null;
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
  for (const match of block.content.matchAll(RELATIVE_PATH)) {
    found.push(stripQueryString(match[0]));
  }
  return found;
}

/**
 * Splits a fenced block into individual requests. Multi-command blocks (for
 * example a pause/unpause pair in one fence) are checked one request at a
 * time, so a header on one request cannot mask a missing header on another.
 * Comment lines attach to the request that follows them. Returns each request
 * with its 0-based line offset inside the block.
 */
export function splitBlockIntoRequests(content) {
  const requests = [];
  let current = null;
  const flush = () => {
    if (current !== null) requests.push(current);
    current = null;
  };
  for (const [index, line] of content.split("\n").entries()) {
    if (line.trim() === "") {
      flush();
      continue;
    }
    const isComment = COMMENT_LINE.test(line);
    if (!isComment && current !== null && current.hasRequest && REQUEST_START.test(line)) {
      flush();
    }
    if (current === null) current = { content: [], line: index, hasRequest: false };
    current.content.push(line);
    if (!isComment) current.hasRequest = true;
  }
  flush();
  return requests.map(({ content: lines, line }) => ({
    content: lines.join("\n"),
    line,
  }));
}

/**
 * Checks every request of one fenced block against the idempotency-consuming
 * endpoints and reports the ones missing the Idempotency-Key header.
 */
function checkBlock({ file, block, idempotencyPostPaths, report }) {
  // Request targets can be assigned to a variable before the request call
  // (`const url = "..."; await fetch(url, { method: "POST" })`), which splits
  // the URL and the POST across two chunks. Track the assignments per block,
  // line by line, so the request chunk is still checked against the endpoint
  // it posts to and a reassignment resolves to the new target instead of a
  // stale one.
  const urlVariables = new Map();
  for (const request of splitBlockIntoRequests(block.content)) {
    for (const line of request.content.split("\n")) {
      const assignment = line.match(URL_VARIABLE_ASSIGNMENT);
      if (!assignment) continue;
      const target = requestTargetPath(assignment[3]);
      if (target) urlVariables.set(assignment[1], target);
    }
    if (!POST_HINT.test(request.content)) continue;
    if (IDEMPOTENCY_HEADER.test(request.content)) continue;
    const pathnames = exampleRequestPaths(request);
    for (const match of request.content.matchAll(REQUEST_CALL_TARGET)) {
      const declared = urlVariables.get(match[1]);
      if (declared) pathnames.push(declared);
    }
    for (const pathname of pathnames) {
      for (const template of idempotencyPostPaths) {
        if (!examplePathMatchesTemplate(pathname, template)) continue;
        report(file, block.line + 1 + request.line, template);
        break;
      }
    }
  }
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
  const seen = new Set();
  const report = (file, line, endpoint) => {
    const key = `${file}:${line}:${endpoint}`;
    if (seen.has(key)) return;
    seen.add(key);
    violations.push({ file, line, endpoint });
  };
  for (const file of files) {
    for (const block of extractCodeBlocks(file.source)) {
      checkBlock({ file: file.path, block, idempotencyPostPaths, report });
    }
  }
  return violations;
}
