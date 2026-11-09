import { DEFAULT_SDP_API_URL } from "@sdp/types/site";
import { WELL_KNOWN_TOKENS } from "@sdp/types/well-known-tokens";
import type { GatedSurface } from "@/components/homepage/release-gate";

/**
 * The two calls the Interfaces section shows, one per way of working. They are real requests
 * against the public SDP API (apps/sdp-api/src/openapi/paths), with shortened placeholder values;
 * they are code, not copy, so they stay out of the message catalog.
 */

export type InterfaceMode = "api" | "dashboard";

/** A run of code: plain text, the shell prompt, a JSON key, or a highlighted status value. */
export type CodeToken = string | { kind: "prompt" | "key" | "value"; text: string };
export type CodeLine = readonly CodeToken[];

export type InterfaceSnippet = {
  mode: InterfaceMode;
  method: "GET" | "POST";
  /** The path as the API reference writes it, shown in the card's head. */
  path: string;
  /** The surface whose module serves `path`, when a release channel can hold it back. */
  gate?: GatedSurface;
  /** The request as typed in a wide terminal. */
  request: readonly CodeLine[];
  /** The same request set for a phone: one flag a line, the body broken out. */
  narrowRequest: readonly CodeLine[];
  /** An excerpt of the 200 response body. */
  response: readonly CodeLine[];
};

const API = DEFAULT_SDP_API_URL;
const PROMPT: CodeToken = { kind: "prompt", text: "$" };
/** Keys are `sf_<key id>_<secret>` (apps/sdp-api/src/lib/api-key-format.ts). */
const AUTH = '-H "Authorization: Bearer sf_…"';
const JSON_TYPE = '-H "Content-Type: application/json"';
/** A transfer moves money, so the API refuses one without a key (IDEMPOTENCY_REQUIRED_ROUTES). */
const IDEMPOTENCY = '-H "Idempotency-Key: payment-invoice-1234"';
const USDC = WELL_KNOWN_TOKENS.USDC.symbol;

const key = (text: string): CodeToken => ({ kind: "key", text: `"${text}"` });
const value = (text: string): CodeToken => ({ kind: "value", text: `"${text}"` });

export const INTERFACE_SNIPPETS: readonly InterfaceSnippet[] = [
  {
    mode: "api",
    method: "POST",
    path: "/v1/payments/transfers/execute",
    request: [
      [PROMPT, ` curl -X POST ${API}/v1/payments/transfers/execute \\`],
      [`    ${AUTH} \\`],
      [`    ${IDEMPOTENCY} \\`],
      [`    ${JSON_TYPE} \\`],
      [`    -d '{"sourceCustodyWalletId":"cwlt_…","token":"${USDC}",`],
      [`         "amount":"24800.00","destination":"7xKX…gAsU"}'`],
    ],
    narrowRequest: [
      [PROMPT, " curl -X POST \\"],
      [`  ${API}/v1/payments/transfers/execute \\`],
      [`  ${AUTH} \\`],
      [`  ${IDEMPOTENCY} \\`],
      [`  ${JSON_TYPE} \\`],
      ["  -d '{"],
      ["    ", key("sourceCustodyWalletId"), ': "cwlt_…",'],
      ["    ", key("destination"), ': "7xKX…gAsU",'],
      ["    ", key("token"), `: "${USDC}",`],
      ["    ", key("amount"), ': "24800.00"'],
      ["  }'"],
    ],
    response: [
      ["{"],
      ["  ", key("data"), ": {"],
      ["    ", key("transfer"), ": {"],
      ["      ", key("id"), ': "xfr_9f2c",'],
      ["      ", key("status"), ": ", value("confirmed"), ","],
      ["      ", key("slot"), ": 291044476"],
      ["    }"],
      ["  }"],
      ["}"],
    ],
  },
  {
  {
    mode: "dashboard",
    method: "GET",
    path: "/v1/payments/transfers",
    request: [
      [PROMPT, ` curl -G ${API}/v1/payments/transfers \\`],
      [`    ${AUTH} \\`],
      ["    -d status=pending"],
    ],
    narrowRequest: [
      [PROMPT, " curl -G \\"],
      [`  ${API}/v1/payments/transfers \\`],
      ["  -d status=pending \\"],
      [`  ${AUTH}`],
    ],
    response: [
      ["{"],
      ["  ", key("data"), ": [{"],
      ["    ", key("id"), ': "xfr_71c",'],
      ["    ", key("status"), ": ", value("pending"), ","],
      ["    ", key("token"), `: "${USDC}",`],
      ["    ", key("amount"), ': "24800.00"'],
      ["  }],"],
      ["  ", key("meta"), ": { ", key("total"), ": 1, ", key("hasMore"), ": false }"],
      ["}"],
    ],
  },
];

/** The plain text of a line, as a terminal would show it. */
export function lineText(line: CodeLine): string {
  return line.map((token) => (typeof token === "string" ? token : token.text)).join("");
}

/**
 * The fewest answer lines that keep the card one height whichever call it shows: room for the
 * longest request and answer together, less this request.
 */
export function responseRows(
  snippets: readonly InterfaceSnippet[],
  pick: (snippet: InterfaceSnippet) => readonly CodeLine[],
  snippet: InterfaceSnippet
): number {
  const most = Math.max(...snippets.map((each) => pick(each).length + each.response.length));
  return most - pick(snippet).length;
}
