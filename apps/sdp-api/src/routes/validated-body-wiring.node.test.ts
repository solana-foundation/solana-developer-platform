import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

const routesRoot = path.resolve(import.meta.dirname);

interface ValidatedHandler {
  file: string;
  handler: string;
  validators: string[];
}

const HANDLER_DECLARATION =
  /(?:export const (\w+) = async|export async function (\w+))\s*\(\s*\n?\s*c:\s*(ValidatedBodyContext<typeof (\w+)>|ValidatedContext<\{([^}]+)\}>)/g;

const INLINE_HANDLER =
  /(?<!= )async \(\s*\n?\s*c:\s*(?:ValidatedBodyContext<typeof (\w+)>|ValidatedContext<\{([^}]+)\}>)/g;

const REGISTRATION_METHOD = /\.(?:get|post|patch|put|delete|all)\(/g;

function sourceFiles(directory: string): string[] {
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const entryPath = path.join(directory, entry.name);
    if (entry.isDirectory()) {
      return sourceFiles(entryPath);
    }
    if (!entry.isFile() || !entry.name.endsWith(".ts") || entry.name.includes(".test.")) {
      return [];
    }
    return [entryPath];
  });
}

/**
 * Maps a `ValidatedContext` target key to the route middleware that must
 * provide it.
 *
 * @param target - The validation target key (`json`, `query`, or `param`).
 * @param schema - The schema identifier named in the context type.
 * @returns The `validate*(schema` prefix the route chain must contain.
 */
function requiredValidator(target: string, schema: string): string {
  switch (target) {
    case "json":
      return `validateBody(${schema}`;
    case "query":
      return `validateQuery(${schema}`;
    case "param":
      return `validateParams(${schema}`;
    default:
      throw new Error(`Unknown validated target: ${target}`);
  }
}

/**
 * Derives the required `validate*` middleware calls from a handler's
 * `ValidatedBodyContext`/`ValidatedContext` annotation match groups.
 *
 * @param bodySchema - The schema name from a `ValidatedBodyContext<typeof X>` annotation.
 * @param targets - The `target: typeof schema` list from a `ValidatedContext<{...}>` annotation.
 * @returns The `validate*(schema` prefixes the registration chain must contain.
 */
function annotationValidators(
  bodySchema: string | undefined,
  targets: string | undefined
): string[] {
  const validators: string[] = [];
  if (bodySchema) {
    validators.push(requiredValidator("json", bodySchema));
  }
  if (targets) {
    for (const entry of targets.split(";")) {
      const pair = entry.match(/(\w+):\s*typeof (\w+)/);
      if (pair) {
        validators.push(requiredValidator(pair[1], pair[2]));
      }
    }
  }
  return validators;
}

function collectValidatedHandlers(): ValidatedHandler[] {
  const handlers: ValidatedHandler[] = [];
  for (const file of sourceFiles(routesRoot)) {
    const source = readFileSync(file, "utf8");
    for (const match of source.matchAll(HANDLER_DECLARATION)) {
      const handler = match[1] ?? match[2];
      const validators = annotationValidators(match[4], match[5]);
      if (validators.length > 0) {
        handlers.push({ file: path.relative(routesRoot, file), handler, validators });
      }
    }
  }
  return handlers;
}

interface InlineValidatedHandler {
  file: string;
  line: number;
  validators: string[];
  chain: string | null;
}

/**
 * Collects anonymous handlers declared inline inside a route registration —
 * `async (c: ValidatedBodyContext<...>) => {...}` — which have no exported
 * name for the registration scan to find. Their validator requirement is
 * checked against the enclosing registration chain in the same file.
 *
 * @returns One entry per inline annotated handler, with the chain slice from
 * the enclosing registration method up to the handler.
 */
function collectInlineHandlers(): InlineValidatedHandler[] {
  const handlers: InlineValidatedHandler[] = [];
  for (const file of sourceFiles(routesRoot)) {
    const source = readFileSync(file, "utf8");
    for (const match of source.matchAll(INLINE_HANDLER)) {
      const validators = annotationValidators(match[1], match[2]);
      if (validators.length === 0) {
        continue;
      }
      const before = source.slice(0, match.index);
      let lastMethodIndex = -1;
      for (const method of before.matchAll(REGISTRATION_METHOD)) {
        lastMethodIndex = method.index;
      }
      handlers.push({
        file: path.relative(routesRoot, file),
        line: before.split("\n").length,
        validators,
        chain: lastMethodIndex >= 0 ? source.slice(lastMethodIndex, match.index) : null,
      });
    }
  }
  return handlers;
}

/**
 * Finds every reference to `name` inside a route-registration file and
 * returns the middleware chain preceding each — the source slice from the
 * enclosing `.post(`/`.patch(`/… back to the reference.
 *
 * @param source - The route file's source with its import block removed.
 * @param name - The handler or extract-function identifier to locate.
 * @returns One chain slice per registration reference.
 */
function registrationChains(source: string, name: string): string[] {
  const chains: string[] = [];
  const reference = new RegExp(`\\b${name}\\b`, "g");
  for (const match of source.matchAll(reference)) {
    const preceding = source[match.index - 1];
    if (preceding === '"' || preceding === "'" || preceding === "/") {
      continue;
    }
    const before = source.slice(0, match.index);
    let lastMethodIndex = -1;
    for (const method of before.matchAll(REGISTRATION_METHOD)) {
      lastMethodIndex = method.index;
    }
    if (lastMethodIndex >= 0) {
      chains.push(source.slice(lastMethodIndex, match.index));
    }
  }
  return chains;
}

function stripImports(source: string): string {
  return source.replace(/^import[\s\S]*?from\s+"[^"]+";\n/gm, "");
}

describe("validated handler wiring", () => {
  const handlers = collectValidatedHandlers();

  it("finds the validated handler inventory", () => {
    expect(handlers.length).toBeGreaterThan(60);
  });

  const registrationFiles = sourceFiles(routesRoot)
    .map((file) => ({ file, source: readFileSync(file, "utf8") }))
    .filter(({ source }) => source.includes("new Hono<"))
    .map(({ file, source }) => ({
      file: path.relative(routesRoot, file),
      source: stripImports(source),
    }));

  it.each(handlers)("wires $handler with its declared validators", ({ handler, validators }) => {
    const chains = registrationFiles.flatMap(({ source }) => registrationChains(source, handler));
    expect(chains.length, `${handler} must appear in a route registration`).toBeGreaterThan(0);
    for (const chain of chains) {
      for (const validator of validators) {
        expect(chain, `${handler} chain must contain ${validator}`).toContain(validator);
      }
    }
  });

  const inlineHandlers = collectInlineHandlers();

  it("finds the inline handler inventory", () => {
    expect(inlineHandlers.length).toBeGreaterThan(1);
  });

  it.each(inlineHandlers)(
    "wires the inline handler at $file:$line with its declared validators",
    ({ file, line, validators, chain }) => {
      expect(chain, `${file}:${line} must sit inside a route registration`).not.toBeNull();
      for (const validator of validators) {
        expect(chain, `${file}:${line} chain must contain ${validator}`).toContain(validator);
      }
    }
  );
});
