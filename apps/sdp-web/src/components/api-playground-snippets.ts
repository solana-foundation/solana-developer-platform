/** The languages a refresh playground writes its call in, cURL first as the design does. */
export const SNIPPET_LANGUAGES = ["curl", "ts", "py"] as const;

export type SnippetLanguage = (typeof SNIPPET_LANGUAGES)[number];

export interface SnippetRequest {
  method: string;
  /** The full URL, host and resolved path. */
  url: string;
  /** The JSON body, or null for a call without one. */
  body: unknown | null;
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

function curlSnippet({ method, url, body }: SnippetRequest): string {
  const lines = [
    `curl ${method === "GET" ? "" : `-X ${method} `}${url} \\`,
    `  -H "Authorization: Bearer $${API_KEY_VARIABLE}"`,
  ];
  if (body !== null) {
    lines[lines.length - 1] += " \\";
    // A single quote inside the body would end the shell string, so it is closed and reopened.
    const json = nestedJson(body, "  ").replace(/'/g, "'\\''");
    lines.push('  -H "Content-Type: application/json" \\', `  -d '${json}'`);
  }
  return lines.join("\n");
}

function typeScriptSnippet({ method, url, body }: SnippetRequest): string {
  const headers = [`    Authorization: \`Bearer \${process.env.${API_KEY_VARIABLE}}\``];
  if (body !== null) headers.push('    "Content-Type": "application/json"');
  const lines = [
    `const res = await fetch(${JSON.stringify(url)}, {`,
    `  method: "${method}",`,
    "  headers: {",
    headers.join(",\n"),
    body === null ? "  }" : "  },",
  ];
  if (body !== null) lines.push(`  body: JSON.stringify(${nestedJson(body, "  ")})`);
  lines.push("});");
  return lines.join("\n");
}

function pythonSnippet({ method, url, body }: SnippetRequest): string {
  const call = [
    `r = requests.${method.toLowerCase()}(${JSON.stringify(url)},`,
    `  headers={"Authorization": f"Bearer {os.environ['${API_KEY_VARIABLE}']}"}`,
  ];
  if (body !== null) {
    call[call.length - 1] += ",";
    call.push(`  json=${pythonLiteral(body).replace(/\n/g, "\n  ")}`);
  }
  return ["import os, requests", "", `${call.join("\n")})`].join("\n");
}

/**
 * The call written out in each language, the key read from `SDP_API_KEY` so a copied snippet
 * never carries one.
 */
export function buildSnippets(request: SnippetRequest): Record<SnippetLanguage, string> {
  return {
    curl: curlSnippet(request),
    ts: typeScriptSnippet(request),
    py: pythonSnippet(request),
  };
}
