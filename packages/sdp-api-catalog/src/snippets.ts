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
  /**
   * Whether the route declares an `Idempotency-Key` header, so the call sends one. A route
   * without it ignores the header, and a retry under the same key runs again.
   */
  takesIdempotencyKey: boolean;
}

const API_KEY_VARIABLE = "SDP_API_KEY";

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

/**
 * A keyed call mints its Idempotency-Key once, before the call, so a retry of the same request
 * sends the same key; a key minted inside the call would make every retry a new request that
 * the API runs again (SOLA9-876).
 */
const RETRY_KEY_COMMENT = "Reuse this key when you retry this request.";

function curlSnippet({ method, url, body, auth, takesIdempotencyKey }: SnippetRequest): string {
  const lines = [`curl ${method === "GET" ? "" : `-X ${method} `}${shellQuote(url)}`];
  if (auth === "apiKey") lines.push(`  -H "Authorization: Bearer $${API_KEY_VARIABLE}"`);
  if (takesIdempotencyKey) lines.push('  -H "Idempotency-Key: $IDEMPOTENCY_KEY"');
  if (body !== null) {
    lines.push(
      '  -H "Content-Type: application/json"',
      `  -d ${shellQuote(nestedJson(body, "  "))}`
    );
  }
  const call = lines.join(" \\\n");
  // No `#` comment line: interactive zsh, the macOS default, runs it as a command.
  return takesIdempotencyKey ? `IDEMPOTENCY_KEY=$(uuidgen)\n${call}` : call;
}

function typeScriptSnippet({
  method,
  url,
  body,
  auth,
  takesIdempotencyKey,
}: SnippetRequest): string {
  const headers: string[] = [];
  if (auth === "apiKey") {
    headers.push(`    Authorization: \`Bearer \${process.env.${API_KEY_VARIABLE}}\``);
  }
  if (takesIdempotencyKey) headers.push('    "Idempotency-Key": idempotencyKey');
  if (body !== null) headers.push('    "Content-Type": "application/json"');
  const options = [`  method: "${method}"`];
  if (headers.length > 0) options.push(["  headers: {", headers.join(",\n"), "  }"].join("\n"));
  if (body !== null) options.push(`  body: JSON.stringify(${nestedJson(body, "  ")})`);
  const keyLines = takesIdempotencyKey
    ? [`// ${RETRY_KEY_COMMENT}`, "const idempotencyKey = crypto.randomUUID();"]
    : [];
  return [
    ...keyLines,
    `const res = await fetch(${JSON.stringify(url)}, {`,
    options.join(",\n"),
    "});",
  ].join("\n");
}

function pythonSnippet({ method, url, body, auth, takesIdempotencyKey }: SnippetRequest): string {
  const headers: string[] = [];
  if (auth === "apiKey")
    headers.push(`"Authorization": f"Bearer {os.environ['${API_KEY_VARIABLE}']}"`);
  if (takesIdempotencyKey) headers.push('"Idempotency-Key": idempotency_key');
  const args = [JSON.stringify(url)];
  if (headers.length > 0) args.push(`headers={${headers.join(", ")}}`);
  if (body !== null) args.push(`json=${pythonLiteral(body).replace(/\n/g, "\n  ")}`);
  const modules = ["requests"];
  if (auth === "apiKey") modules.unshift("os");
  if (takesIdempotencyKey) modules.push("uuid");
  return [
    `import ${modules.join(", ")}`,
    "",
    ...(takesIdempotencyKey
      ? [`# ${RETRY_KEY_COMMENT}`, "idempotency_key = str(uuid.uuid4())"]
      : []),
    `r = requests.${method.toLowerCase()}(${args.join(",\n  ")})`,
  ].join("\n");
}

/**
 * The call written out in each language, the key read from `SDP_API_KEY` so a copied snippet
 * never carries one.
 *
 * @param request - The method, full URL and JSON body of the call, and how its route takes it.
 * @returns The snippet for each of {@link SNIPPET_LANGUAGES}.
 */
export function buildSnippets(request: SnippetRequest): Record<SnippetLanguage, string> {
  return {
    curl: curlSnippet(request),
    ts: typeScriptSnippet(request),
    py: pythonSnippet(request),
  };
}
