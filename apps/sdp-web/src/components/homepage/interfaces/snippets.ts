import { DEFAULT_SDP_API_URL } from "@sdp/types";

/**
 * The three calls the Interfaces section shows, one per way of working. They are real requests
 * against the public SDP API (apps/sdp-api/src/openapi/paths), with shortened placeholder values;
 * they are code, not copy, so they stay out of the message catalog.
 */

export type InterfaceMode = "execute" | "prepare" | "dashboard";

/** A run of code: plain text, the shell prompt, a JSON key, or a highlighted status value. */
export type CodeToken = string | { kind: "prompt" | "key" | "value"; text: string };
export type CodeLine = readonly CodeToken[];

export type InterfaceSnippet = {
  mode: InterfaceMode;
  method: "GET" | "POST";
  /** The path as the API reference writes it, shown in the card's head. */
  path: string;
  /** The request as typed in a wide terminal. */
  request: readonly CodeLine[];
  /** The same request set for a phone: one flag a line, the body broken out. */
  narrowRequest: readonly CodeLine[];
  /** An excerpt of the 200 response body. */
  response: readonly CodeLine[];
};

const API = DEFAULT_SDP_API_URL;
const PROMPT: CodeToken = { kind: "prompt", text: "$" };
const AUTH = '-H "Authorization: Bearer sk_test_…"';
const JSON_TYPE = '-H "Content-Type: application/json"';

const key = (text: string): CodeToken => ({ kind: "key", text: `"${text}"` });
const value = (text: string): CodeToken => ({ kind: "value", text: `"${text}"` });

export const INTERFACE_SNIPPETS: readonly InterfaceSnippet[] = [
  {
    mode: "execute",
    method: "POST",
    path: "/v1/payments/transfers",
    request: [
      [PROMPT, ` curl -X POST ${API}/v1/payments/transfers \\`],
      [`    ${AUTH} \\`],
      [`    ${JSON_TYPE} \\`],
      [`    -d '{"sourceCustodyWalletId":"cwlt_…","token":"USDC",`],
      [`         "amount":"24800.00","destination":"7xKX…gAsU"}'`],
    ],
    narrowRequest: [
      [PROMPT, " curl -X POST \\"],
      [`  ${API}/v1/payments/transfers \\`],
      [`  ${AUTH} \\`],
      [`  ${JSON_TYPE} \\`],
      ["  -d '{"],
      ["    ", key("sourceCustodyWalletId"), ': "cwlt_…",'],
      ["    ", key("destination"), ': "7xKX…gAsU",'],
      ["    ", key("token"), ': "USDC",'],
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
    mode: "prepare",
    method: "POST",
    path: "/v1/payments/subscriptions/{subscriptionId}/prepare-collection",
    request: [
      [PROMPT, " curl -X POST \\"],
      [`    ${API}/v1/payments/subscriptions/psub_71c/prepare-collection \\`],
      [`    ${AUTH} \\`],
      [`    ${JSON_TYPE} \\`],
      [`    -d '{"receiverTokenAccount":"9WzD…AWWM"}'`],
    ],
    narrowRequest: [
      [PROMPT, " curl -X POST \\"],
      [`  ${API}/v1/payments/subscriptions/psub_71c/prepare-collection \\`],
      [`  ${AUTH} \\`],
      [`  ${JSON_TYPE} \\`],
      ["  -d '{"],
      ["    ", key("receiverTokenAccount"), ': "9WzD…AWWM"'],
      ["  }'"],
    ],
    response: [
      ["{"],
      ["  ", key("data"), ": {"],
      ["    ", key("preparedTransaction"), ": {"],
      ["      ", key("serialized"), ": ", value("AQAB…3kx9"), ","],
      ["      ", key("requiredSigners"), ': ["7xKX…gAsU"]'],
      ["    }"],
      ["  }"],
      ["}"],
    ],
  },
  {
    mode: "dashboard",
    method: "GET",
    path: "/v1/wallets/approval-requests",
    request: [
      [PROMPT, ` curl -G ${API}/v1/wallets/approval-requests \\`],
      [`    ${AUTH} \\`],
      ["    -d status=pending"],
    ],
    narrowRequest: [
      [PROMPT, " curl -G \\"],
      [`  ${API}/v1/wallets/approval-requests \\`],
      ["  -d status=pending \\"],
      [`  ${AUTH}`],
    ],
    response: [
      ["{"],
      ["  ", key("data"), ": {"],
      ["    ", key("approvalRequests"), ": [{"],
      ["      ", key("id"), ': "appr_71c",'],
      ["      ", key("status"), ": ", value("pending"), ","],
      [
        "      ",
        key("operation"),
        ": { ",
        key("amount"),
        ': "24800.00", ',
        key("asset"),
        ': "USDC" },',
      ],
      ["      ", key("policyEvaluation"), ": { ", key("decision"), ': "approval_required" }'],
      ["    }]"],
      ["  }"],
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
