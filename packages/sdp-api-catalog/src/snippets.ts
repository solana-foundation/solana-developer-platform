/** The languages a refresh playground writes its call in, cURL first as the design does. */
export const SNIPPET_LANGUAGES = ["curl", "ts", "py"] as const;

export type SnippetLanguage = (typeof SNIPPET_LANGUAGES)[number];

/** `apiKey` sends the key from `SDP_API_KEY` as a bearer token; `none` is a public route. */
export const SNIPPET_AUTH_MODES = ["apiKey", "none"] as const;

export type SnippetAuth = (typeof SNIPPET_AUTH_MODES)[number];

export interface SnippetRequest {
  method: string;
  /** The full URL, host and resolved path. */
  url: string;
  /** The JSON body, or null for a call without one. */
  body: unknown | null;
  auth: SnippetAuth;
}

const API_KEY_VARIABLE = "SDP_API_KEY";

/** Every write carries its own Idempotency-Key, so a retried call runs once (HOO-1918). */
function isWrite(method: string): boolean {
  return method.toUpperCase() !== "GET";
}

/** JSON with every line after the first pushed in by `indent`, to sit inside a call. */
function nestedJson(value: unknown, indent: string): string {
  return JSON.stringify(value, null, 2).replace(/\n/g, `\n${indent}`);
}

/** A Python literal: JSON's true/false/null read as True/False/None there. */
function pythonLiteral(value: unknown, depth = 0): string {
  const pad = "  ".repeat(depth + 1);
  const close = "  ".repeat(depth);
  if (value === null || value === undefined) return "None";
  if (value === true) return "True";
  if (value === false) return "False";
  if (typeof value === "number") return String(value);
  if (typeof value === "string") return JSON.stringify(value);
  if (Array.isArray(value)) {
    if (value.length === 0) return "[]";
    return `[\n${value.map((item) => `${pad}${pythonLiteral(item, depth + 1)}`).join(",\n")}\n${close}]`;
  }
  const entries = Object.entries(value as Record<string, unknown>);
  if (entries.length === 0) return "{}";
  return `{\n${entries
    .map(([key, item]) => `${pad}${JSON.stringify(key)}: ${pythonLiteral(item, depth + 1)}`)
    .join(",\n")}\n${close}}`;
}

/**
 * A shell word in single quotes, so a query string's `&` stays part of the URL. A single quote
 * inside would end the string, so it is closed and reopened around an escaped one.
 */
function shellQuote(value: string): string {
  return `'${value.replace(/'/g, "'\\''")}'`;
}

function curlSnippet({ method, url, body, auth }: SnippetRequest): string {
  const lines = [`curl ${method === "GET" ? "" : `-X ${method} `}${shellQuote(url)}`];
  if (auth === "apiKey") lines.push(`  -H "Authorization: Bearer $${API_KEY_VARIABLE}"`);
  if (isWrite(method)) lines.push('  -H "Idempotency-Key: $(uuidgen)"');
  if (body !== null) {
    lines.push(
      '  -H "Content-Type: application/json"',
      `  -d ${shellQuote(nestedJson(body, "  "))}`
    );
  }
  return lines.join(" \\\n");
}

function typeScriptSnippet({ method, url, body, auth }: SnippetRequest): string {
  const headers: string[] = [];
  if (auth === "apiKey") {
    headers.push(`    Authorization: \`Bearer \${process.env.${API_KEY_VARIABLE}}\``);
  }
  if (isWrite(method)) headers.push('    "Idempotency-Key": crypto.randomUUID()');
  if (body !== null) headers.push('    "Content-Type": "application/json"');
  const options = [`  method: "${method}"`];
  if (headers.length > 0) options.push(["  headers: {", headers.join(",\n"), "  }"].join("\n"));
  if (body !== null) options.push(`  body: JSON.stringify(${nestedJson(body, "  ")})`);
  return [`const res = await fetch(${JSON.stringify(url)}, {`, options.join(",\n"), "});"].join(
    "\n"
  );
}

function pythonSnippet({ method, url, body, auth }: SnippetRequest): string {
  const headers: string[] = [];
  if (auth === "apiKey")
    headers.push(`"Authorization": f"Bearer {os.environ['${API_KEY_VARIABLE}']}"`);
  if (isWrite(method)) headers.push('"Idempotency-Key": str(uuid.uuid4())');
  const args = [JSON.stringify(url)];
  if (headers.length > 0) args.push(`headers={${headers.join(", ")}}`);
  if (body !== null) args.push(`json=${pythonLiteral(body).replace(/\n/g, "\n  ")}`);
  const modules = ["requests"];
  if (auth === "apiKey") modules.unshift("os");
  if (isWrite(method)) modules.push("uuid");
  return [
    `import ${modules.join(", ")}`,
    "",
    `r = requests.${method.toLowerCase()}(${args.join(",\n  ")})`,
  ].join("\n");
}

/**
 * The call written out in each language, the key read from `SDP_API_KEY` so a copied snippet
 * never carries one.
 *
 * @param request - The method, full URL and JSON body of the call.
 * @returns The snippet for each of {@link SNIPPET_LANGUAGES}.
 */
export function buildSnippets(request: SnippetRequest): Record<SnippetLanguage, string> {
  return {
    curl: curlSnippet(request),
    ts: typeScriptSnippet(request),
    py: pythonSnippet(request),
  };
}
