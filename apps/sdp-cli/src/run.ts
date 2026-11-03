import { readFile } from "node:fs/promises";
import { parseArgs } from "node:util";
import manifest from "#package";
import { prepareBinaryOutput, saveBinaryOutput } from "./binary-output";
import { type ApiResponse, requestApi } from "./client";
import {
  bodyFromFlags,
  type Command,
  commands,
  globalFlags,
  type Options,
  optionSchema,
  parseJsonObject,
  parserOptions,
  queryFromFlags,
} from "./commands";
import { type Config, resolveConfig } from "./config";
import { type JsonObject, type Operation, operationById } from "./contract";
import { CliError, usageError } from "./errors";
import { normalizePlacesArgs } from "./places-commands";
import { readWebhookInput } from "./webhook-input";

export interface Runtime {
  env: NodeJS.ProcessEnv;
  fetcher: typeof fetch;
  readStdin: () => Promise<string | Uint8Array>;
  stdout: (text: string) => void;
  stderr: (text: string) => void;
}

function usage(command: Command): string {
  const parameters = operationById(command.operationId).parameters.filter(
    (parameter) => parameter.location === "path"
  );
  return [
    `sdp ${command.words.join(" ")}`,
    ...parameters.map((parameter) =>
      parameter.name === "projectId" || parameter.name === "orgId"
        ? `[${parameter.name}]`
        : `<${parameter.name}>`
    ),
  ].join(" ");
}

function authorizationHelp(operation: Operation): string[] {
  const authorization = operation.authorization;
  switch (authorization.kind) {
    case "signup":
      return ["Requires a signed-in Clerk session with no active organization (SDP_TOKEN)."];
    case "webhook":
      return [
        "Requires captured provider signature headers (--headers); account credentials and tenant selectors are not sent.",
      ];
    case "public":
      return ["Public endpoint. Account credentials and tenant selectors are not sent."];
    case "payment-link":
      return [
        "The positional publicToken is the bearer credential. Account credentials and project selections are not sent.",
      ];
    case "session":
      return ["Requires a signed-in user’s Clerk session (SDP_TOKEN); API keys are not accepted."];
    case "membership":
      return ["Requires a Clerk session for your own organization membership (SDP_TOKEN)."];
    case "action": {
      const lines = [`Requires action: ${authorization.action}`];
      if (operation.sessionOnly)
        lines.push("Requires a Clerk session token for the active organization (SDP_TOKEN).");
      return lines;
    }
    default: {
      const exhaustive: never = authorization;
      throw new Error(`Unsupported authorization: ${exhaustive}`);
    }
  }
}

function help(prefix: readonly string[], command: Command | undefined): string {
  const matches = commands.filter((entry) =>
    prefix.every((word, index) => entry.words[index] === word)
  );
  const lines = ["SDP CLI", ""];
  if (command)
    lines.push(
      `Usage: ${usage(command)} [options]`,
      "",
      operationById(command.operationId).summary
    );
  else {
    lines.push("Usage: sdp <command> [options]", "", "Commands:");
    for (const entry of matches)
      lines.push(`  ${usage(entry)}  ${operationById(entry.operationId).summary}`);
  }
  if (command) {
    const operation = operationById(command.operationId);
    lines.push(operation.description, ...authorizationHelp(operation));
    if (
      operation.parameters.some(
        (parameter) =>
          parameter.location === "header" && parameter.name.toLowerCase() === "x-project-id"
      )
    ) {
      lines.push("Select a project with --project or SDP_PROJECT_ID for this request.");
    }
    if (
      operation.parameters.some(
        (parameter) =>
          parameter.location === "header" &&
          parameter.name.toLowerCase() === "idempotency-key" &&
          parameter.required
      )
    )
      lines.push(
        "Requires --idempotency-key for one logical operation; keep it when explicitly retrying the same request."
      );
    if (operation.returnsApiKeySecret)
      lines.push("The full key is printed to stdout once. Save the response securely.");
    if (operation.returnsPaymentLinkToken)
      lines.push(
        "The bearer payment-link token is printed to stdout. Share it only with the intended payer."
      );
    if (operation.returnsRampClientSecret)
      lines.push(
        "Provider checkout credentials may be printed to stdout. Save the response securely."
      );
    lines.push("", "Command options:");
    for (const [name, flag] of Object.entries(command.flags))
      lines.push(`  --${name}${flag.type === "string" ? " <value>" : ""}  ${flag.description}`);
  }
  lines.push("", "Global options:");
  for (const [name, flag] of Object.entries(globalFlags))
    lines.push(`  --${name}${flag.type === "string" ? " <value>" : ""}  ${flag.description}`);
  lines.push(
    "",
    "Project IDs: positional argument, --project, or SDP_PROJECT_ID. Organization IDs: positional argument, --organization, or SDP_ORGANIZATION_ID.",
    "Responses are JSON on stdout; errors are JSON on stderr. Exit codes: 0 success, 1 request failure, 2 usage."
  );
  return `${lines.join("\n")}\n`;
}

async function requestBody(
  command: Command,
  options: Options,
  runtime: Runtime
): Promise<JsonObject | null> {
  let body = bodyFromFlags(command, options);
  if (options.data !== undefined) {
    if (body !== null && Object.keys(body).length > 0)
      usageError("Use --data or individual body flags.");
    const source = options.data;
    let text: string;
    if (source === "-") {
      const input = await runtime.readStdin();
      try {
        text =
          typeof input === "string"
            ? input
            : new TextDecoder("utf-8", { fatal: true }).decode(input);
      } catch {
        usageError("Stdin must contain UTF-8 JSON.");
      }
    } else if (source.startsWith("@")) {
      try {
        text = await readFile(source.slice(1), "utf8");
      } catch {
        usageError("Could not read the --data file.");
      }
    } else text = source;
    body = parseJsonObject(text, "--data");
  }
  if (command.words.at(-1) === "update" && body !== null && Object.keys(body).length === 0)
    usageError("Provide at least one field to update.");
  return body;
}

function requestPath(command: Command, config: Config, trailing: string[]): Record<string, string> {
  const parameters = operationById(command.operationId).parameters.filter(
    (parameter) => parameter.location === "path"
  );
  if (trailing.length > parameters.length) usageError(`Usage: ${usage(command)}`);
  const defaults: Readonly<Record<string, string | undefined>> = {
    projectId: config.projectId,
    orgId: config.organizationId,
  };
  return Object.fromEntries(
    parameters.map((parameter, index) => {
      const value = trailing[index] ?? defaults[parameter.name];
      if (value === undefined) {
        if (Object.hasOwn(defaults, parameter.name))
          usageError(
            `Provide ${parameter.name} positionally or select it with --project / --organization or the matching environment variable.`
          );
        usageError(`Provide ${parameter.name} as a positional argument.`);
      }
      return [parameter.name, value];
    })
  );
}

function parseOptions(args: string[]): { options: Options; positionals: string[] } {
  try {
    const parsed = parseArgs({
      args: normalizePlacesArgs(args),
      options: parserOptions(),
      allowPositionals: true,
      strict: true,
    });
    return { options: optionSchema.parse(parsed.values), positionals: parsed.positionals };
  } catch {
    usageError("Invalid arguments. Run sdp --help for supported commands and options.");
  }
}

async function writeResponse(
  response: ApiResponse,
  outputPath: string | null,
  options: Options,
  runtime: Runtime
): Promise<void> {
  const result = response.body;
  if (result instanceof Uint8Array) {
    if (outputPath === null) throw new Error("Missing binary output destination");
    const saved = await saveBinaryOutput(outputPath, result);
    runtime.stdout(`${JSON.stringify(saved, null, options.compact ? 0 : 2)}\n`);
  } else if (result !== null || options["include-headers"]) {
    const output = options["include-headers"] ? response : result;
    runtime.stdout(`${JSON.stringify(output, null, options.compact ? 0 : 2)}\n`);
  }
}

/** Run without process globals so callers can test the same entry point as the binary. */
export async function runCli(args: string[], runtime: Runtime): Promise<number> {
  try {
    const { options, positionals } = parseOptions(args);
    if (options.version) {
      runtime.stdout(`${manifest.version}\n`);
      return 0;
    }
    const command = commands.find((entry) =>
      entry.words.every((word, index) => positionals[index] === word)
    );
    if (
      options.help ||
      positionals.length === 0 ||
      commands.some(
        (entry) =>
          positionals.length < entry.words.length &&
          positionals.every((word, index) => entry.words[index] === word)
      )
    ) {
      const prefix = command ? command.words : positionals;
      const validPrefix = commands.some((entry) =>
        prefix.every((word, index) => entry.words[index] === word)
      );
      if (!validPrefix) usageError("Unknown command. Run sdp --help.");
      runtime.stdout(help(prefix, command));
      return 0;
    }
    if (!command) usageError("Unknown command. Run sdp --help.");
    for (const name of Object.keys(options)) {
      if (!(name in globalFlags) && !(name in command.flags))
        usageError(`--${name} is not supported by this command.`);
    }
    const trailing = positionals.slice(command.words.length);
    const operation = operationById(command.operationId);
    const config = resolveConfig(options, runtime.env, operation.authorization);
    const path = requestPath(command, config, trailing);
    const query = queryFromFlags(command, options);
    const body = await requestBody(command, options, runtime);
    const webhook =
      operation.authorization.kind === "webhook"
        ? await readWebhookInput(operation, options, runtime.readStdin)
        : undefined;
    const outputPath = await prepareBinaryOutput(operation, options.output);
    const response = await requestApi(
      config,
      {
        operation,
        path,
        query,
        body,
        rawBody: webhook?.rawBody,
        webhookHeaders: webhook?.headers,
        idempotencyKey: options["idempotency-key"],
        ifNoneMatch: options["if-none-match"],
      },
      runtime.fetcher
    );
    await writeResponse(response, outputPath, options, runtime);
    return 0;
  } catch (cause) {
    const error =
      cause instanceof CliError
        ? cause
        : new CliError(
            cause instanceof Error ? cause.message : "Unexpected CLI failure.",
            "CLI_ERROR",
            2
          );
    const errorPayload: JsonObject = {
      code: error.code,
      message: error.message,
      status: error.status,
      requestId: error.requestId,
    };
    if (error.details !== undefined) errorPayload.details = error.details;
    runtime.stderr(`${JSON.stringify({ error: errorPayload })}\n`);
    return error.exitCode;
  }
}
