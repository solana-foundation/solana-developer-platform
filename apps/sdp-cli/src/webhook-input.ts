import { readFile } from "node:fs/promises";
import { z } from "zod";
import type { Command, Options } from "./commands";
import type { Operation } from "./contract";
import { usageError } from "./errors";

const flags = {
  body: {
    type: "string",
    description: "Required original signed payload: @file or - for stdin; bytes are sent unchanged",
  },
  headers: {
    type: "string",
    description:
      "Required captured signature headers: JSON object, @file, or - for stdin; prefer a file",
  },
} as const;
export const webhookCommands: readonly Command[] = [
  { words: ["webhooks", "clerk", "deliver"], operationId: "receiveClerkWebhook", flags },
  {
    words: ["webhooks", "ramps", "sandbox", "deliver"],
    // biome-ignore lint/security/noSecrets: canonical OpenAPI operation ID, not a credential.
    operationId: "receiveSandboxRampWebhook",
    flags,
  },
  {
    words: ["webhooks", "ramps", "production", "deliver"],
    // biome-ignore lint/security/noSecrets: canonical OpenAPI operation ID, not a credential.
    operationId: "receiveProductionRampWebhook",
    flags,
  },
];
export const webhookOptionFields = { body: z.string().optional(), headers: z.string().optional() };

async function inputBytes(
  source: string,
  readStdin: () => Promise<string | Uint8Array>
): Promise<Uint8Array> {
  if (source === "-") {
    const input = await readStdin();
    return typeof input === "string" ? new TextEncoder().encode(input) : input;
  }
  if (!source.startsWith("@")) usageError("--body requires @file or - for stdin.");
  try {
    return await readFile(source.slice(1));
  } catch {
    return usageError("Could not read the webhook input file.");
  }
}
function text(bytes: Uint8Array): string {
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    return usageError("Webhook headers must be UTF-8 JSON.");
  }
}
const headerValues = z.record(
  z.string(),
  z
    .string()
    .min(1)
    .regex(/^[\x20-\x7e]+$/)
);
export async function readWebhookInput(
  operation: Operation,
  options: Options,
  readStdin: () => Promise<string | Uint8Array>
): Promise<{ rawBody: Uint8Array; headers: Record<string, string> }> {
  if (operation.rawBody === null) throw new Error("Missing webhook raw-body contract");
  if (options.body === undefined || options.headers === undefined)
    usageError("Webhook delivery requires --body @file|- and --headers JSON|@file|-.");
  if (options.body === "-" && options.headers === "-")
    usageError("Only one webhook input can use stdin.");
  const rawBody = await inputBytes(options.body, readStdin);
  if (rawBody.byteLength === 0 || rawBody.byteLength > operation.rawBody.maxBytes)
    usageError(`Webhook body must contain 1–${operation.rawBody.maxBytes} bytes.`);
  const headerText =
    options.headers.startsWith("@") || options.headers === "-"
      ? text(await inputBytes(options.headers, readStdin))
      : options.headers;
  let headers: Record<string, string>;
  try {
    headers = headerValues.parse(JSON.parse(headerText));
  } catch {
    return usageError(
      "--headers must be a JSON object of nonempty ASCII header values without control characters."
    );
  }
  const entries = Object.entries(headers).map(
    ([name, value]) => [name.toLowerCase(), value] as const
  );
  if (new Set(entries.map(([name]) => name)).size !== entries.length)
    usageError("Webhook headers contain duplicate names with different casing.");
  return { rawBody, headers: Object.fromEntries(entries) };
}
