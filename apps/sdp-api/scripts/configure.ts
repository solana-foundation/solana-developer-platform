/**
 * Terminal configurator for a self-hosted .env.
 *
 * Reuses the shared @sdp/env-config core (the same fields, defaults, secret
 * generation and validation the web configurator uses) and renders it as an
 * interactive prompt. Prompts and progress go to stderr; only the generated
 * .env is written to stdout, so operators can run:
 *
 *     docker run --rm -it <image> node configure.js > .env
 *
 * A non-interactive mode reads answers straight from the process environment,
 * which is convenient for scripted/CI provisioning.
 */
import { writeFileSync } from "node:fs";
import path from "node:path";
import * as readline from "node:readline/promises";
import { Writable } from "node:stream";
import { fileURLToPath } from "node:url";
import {
  autoSecretKeys,
  defaultValues,
  type EnvField,
  FIELDS,
  generateEnv,
  isFieldVisible,
  parseList,
  randomHex32,
  SECTIONS,
  type SelectOption,
  type Values,
  validateValues,
} from "@sdp/env-config";

/**
 * Build values from the process environment (non-interactive path).
 *
 * Starts from the field defaults, copies in any field whose key is present in
 * `env`, then fills every still-empty auto-secret with a fresh random value.
 * Pure apart from the secret RNG.
 */
export function collectFromEnv(env: Record<string, string | undefined>): Values {
  const values = defaultValues();
  for (const field of FIELDS) {
    const provided = env[field.key];
    if (provided !== undefined) values[field.key] = provided;
  }
  // An explicitly provided DATABASE_URL means an external database; switch modes
  // so generate emits DATABASE_URL instead of the bundled-Postgres defaults.
  if (typeof env.DATABASE_URL === "string" && env.DATABASE_URL !== "") {
    values.DATABASE_MODE = "external";
  }
  // Keep SIGNING_PROVIDERS and the default SIGNING_PROVIDER consistent for the
  // non-interactive path: derive the list from a bare provider, or pick the
  // first listed provider as the default when only the list was given.
  if (env.SIGNING_PROVIDERS === undefined) {
    values.SIGNING_PROVIDERS = values.SIGNING_PROVIDER || "local";
  } else if (env.SIGNING_PROVIDER === undefined) {
    const list = parseList(values.SIGNING_PROVIDERS);
    if (list.length > 0) {
      values.SIGNING_PROVIDER = list[0];
    }
  }
  for (const key of autoSecretKeys(values)) {
    if (!values[key]) values[key] = randomHex32();
  }
  return values;
}

/** Write a line to stderr (prompts/progress never touch stdout). */
function note(message: string): void {
  process.stderr.write(`${message}\n`);
}

type Asker = (query: string) => Promise<string>;

/**
 * Ask for a value without echoing the typed characters to the terminal.
 *
 * The prompt itself is written to stderr, then keystrokes are muted so secrets
 * never land in scrollback. The mute is always lifted afterwards, including on
 * the required/pattern re-ask path.
 */
type MaskedAsker = (query: string) => Promise<string>;

/** Raised when the operator aborts a prompt (EOF / Ctrl-D). */
class PromptAbortError extends Error {
  constructor() {
    super("Aborted.");
    this.name = "PromptAbortError";
  }
}

/** Resolve a select answer (1-based index or option value) to a stored value. */
async function promptSelect(
  field: EnvField,
  current: string,
  ask: Asker,
  values: Values
): Promise<string> {
  const options = (field.optionsWhen ? field.optionsWhen(values) : field.options) ?? [];
  // If the carried default is no longer a valid option, fall back to the first.
  const safeCurrent = options.some((o) => o.value === current)
    ? current
    : (options[0]?.value ?? current);
  note(field.label);
  if (field.help) note(field.help);
  options.forEach((opt, i) => {
    const marker = opt.value === safeCurrent ? " (default)" : "";
    note(`  ${i + 1}) ${opt.label}${marker}`);
  });

  for (;;) {
    const answer = (await ask("> ")).trim();
    if (answer === "") return safeCurrent;

    if (/^\d+$/.test(answer)) {
      const byIndex = Number.parseInt(answer, 10);
      if (byIndex >= 1 && byIndex <= options.length) {
        return options[byIndex - 1].value;
      }
    } else {
      const byValue = options.find((opt) => opt.value === answer);
      if (byValue) return byValue.value;
    }

    note(
      `Unknown option: ${answer} — enter a number 1-${options.length}, an option value, or blank.`
    );
  }
}

/**
 * Resolve raw multiselect tokens (1-based indices or option values) to option
 * values, preserving order and dropping duplicates. Returns the first
 * unrecognized token as an error rather than silently dropping it.
 */
export function resolveMultiSelectTokens(
  tokens: string[],
  options: SelectOption[]
): { values: string[] } | { error: string } {
  const resolved: string[] = [];
  for (const tok of tokens) {
    if (/^\d+$/.test(tok)) {
      const idx = Number.parseInt(tok, 10);
      if (idx >= 1 && idx <= options.length) {
        resolved.push(options[idx - 1].value);
        continue;
      }
    } else if (options.some((o) => o.value === tok)) {
      resolved.push(tok);
      continue;
    }
    return { error: tok };
  }
  return { values: [...new Set(resolved)] };
}

/** Resolve a multiselect answer (comma-separated indices or values) to a stored list. */
async function promptMultiSelect(
  field: EnvField,
  current: string,
  ask: Asker,
  values: Values
): Promise<string> {
  const options = (field.optionsWhen ? field.optionsWhen(values) : field.options) ?? [];
  const currentList = parseList(current);
  note(`${field.label}${field.required ? " *" : ""}`);
  if (field.help) note(field.help);
  options.forEach((opt, i) => {
    const marker = currentList.includes(opt.value) ? " (selected)" : "";
    note(`  ${i + 1}) ${opt.label}${marker}`);
  });
  note("Enter comma-separated numbers or values (blank keeps current).");

  for (;;) {
    const answer = (await ask("> ")).trim();
    if (answer === "") {
      if (field.required && currentList.length === 0) {
        note(`${field.label} is required.`);
        continue;
      }
      return currentList.join(",");
    }

    const tokens = answer
      .split(",")
      .map((t) => t.trim())
      .filter(Boolean);
    const result = resolveMultiSelectTokens(tokens, options);
    if ("error" in result) {
      note(`Unknown option: ${result.error} — enter numbers 1-${options.length} or option values.`);
      continue;
    }
    const unique = result.values;
    if (field.required && unique.length === 0) {
      note(`${field.label} is required.`);
      continue;
    }
    return unique.join(",");
  }
}

/** Prompt a text/url/password field, re-asking on pattern or required violations. */
async function promptText(
  field: EnvField,
  current: string,
  ask: Asker,
  askMasked: MaskedAsker
): Promise<string> {
  const label = `${field.label}${field.required ? " *" : ""}`;
  if (field.help) note(field.help);
  // Never echo a current secret back into the prompt suffix.
  const suffix = current && field.kind !== "password" ? ` [${current}]` : "";
  // Secrets are masked; everything else keeps normal echo.
  const prompt = field.kind === "password" ? askMasked : ask;

  for (;;) {
    const answer = (await prompt(`${label}${suffix}: `)).trim();
    const value = answer === "" ? current : answer;

    if (answer !== "" && field.pattern && !field.pattern.test(answer)) {
      note(`Invalid value for ${field.label} — does not match the expected format.`);
      continue;
    }
    if (field.required && value === "") {
      note(`${field.label} is required.`);
      continue;
    }
    return value;
  }
}

/** Prompt a single visible field and return its resolved value. */
async function promptField(
  field: EnvField,
  current: string,
  ask: Asker,
  askMasked: MaskedAsker,
  values: Values
): Promise<string> {
  if (field.kind === "secret" || (field.secretWhen?.(values) ?? false)) {
    note(`${field.label}: generated`);
    return randomHex32();
  }
  if (field.kind === "multiselect") return promptMultiSelect(field, current, ask, values);
  if (field.kind === "select") return promptSelect(field, current, ask, values);
  return promptText(field, current, ask, askMasked);
}

/** Run the interactive prompt loop, returning the collected values. */
async function collectInteractively(): Promise<Values> {
  // While muted, readline's per-keystroke echo is dropped so typed secrets
  // never reach the terminal. We give readline a thin proxy over stderr that
  // honors the flag; the prompt text is written straight to stderr beforehand.
  let muted = false;
  const stderr = process.stderr;
  const output = new Writable({
    write(chunk, encoding, callback) {
      if (muted) {
        callback();
        return;
      }
      stderr.write(chunk, encoding, callback);
    },
  });
  // Mirror the underlying TTY traits so readline's line editing sizes correctly.
  const ttyOutput = output as Writable & {
    isTTY?: boolean;
    columns?: number;
    rows?: number;
  };
  ttyOutput.isTTY = stderr.isTTY;
  ttyOutput.columns = stderr.columns;
  ttyOutput.rows = stderr.rows;

  // `terminal: true` echoes per keystroke (stderr is a TTY under `docker run
  // -it`), which is what the mute above suppresses for masked prompts.
  const rl = readline.createInterface({
    input: process.stdin,
    output,
    terminal: true,
  });

  // readline rejects question() when the stream ends (EOF / Ctrl-D); surface
  // that as a clean abort the caller can report without a stack trace.
  const ask: Asker = async (query) => {
    try {
      return await rl.question(query);
    } catch {
      throw new PromptAbortError();
    }
  };
  const askMasked: MaskedAsker = async (query) => {
    // Show the prompt, then mute keystroke echo for the typed secret.
    stderr.write(query);
    muted = true;
    try {
      return await ask("");
    } finally {
      muted = false;
      stderr.write("\n");
    }
  };

  const values = defaultValues();
  let currentSection: string | undefined;

  try {
    for (const field of FIELDS) {
      // Derived fields are computed from other answers and emitted by generate;
      // never prompt for them.
      if (field.derive) continue;
      if (!isFieldVisible(field, values)) continue;

      if (field.section !== currentSection) {
        currentSection = field.section;
        const meta = SECTIONS.find((s) => s.id === field.section);
        if (meta) note(`\n# ${meta.title}`);
      }

      values[field.key] = await promptField(field, values[field.key] ?? "", ask, askMasked, values);
    }
  } finally {
    rl.close();
  }

  // Fill any auto-secret the prompt loop skipped, including an always-emitted
  // field hidden by the current answers (e.g. POSTGRES_PASSWORD with an external
  // database), which compose still requires.
  for (const key of autoSecretKeys(values)) {
    if (!values[key]) values[key] = randomHex32();
  }
  return values;
}

/** True when answers should be read from the environment rather than prompted. */
function isNonInteractive(argv: string[]): boolean {
  return (
    argv.includes("--non-interactive") ||
    Boolean(process.env.SDP_CONFIGURE_NONINTERACTIVE) ||
    !process.stdin.isTTY
  );
}

/** Path passed via `--out <path>`, or undefined to write to stdout. */
export function getOutPath(argv: string[]): string | undefined {
  const i = argv.indexOf("--out");
  return i >= 0 ? argv[i + 1] : undefined;
}

async function main(): Promise<void> {
  const argv = process.argv.slice(2);
  const outPath = getOutPath(argv);

  const values = isNonInteractive(argv)
    ? collectFromEnv(process.env)
    : await collectInteractively();

  const errors = validateValues(values);
  const entries = Object.entries(errors);
  if (entries.length > 0) {
    note("\nConfiguration is incomplete:");
    for (const [key, message] of entries) note(`  ${key}: ${message}`);
    process.exit(1);
  }

  const env = generateEnv(values);
  // With --out the CLI writes the file itself, so interactive prompts (stderr)
  // and the result never share a stream — unlike `… > .env`, which a TTY merges.
  if (outPath) {
    writeFileSync(outPath, env);
    note(`\n.env written to ${outPath}`);
  } else {
    process.stdout.write(env);
    note("\n.env written to stdout.");
  }
}

const invokedPath = process.argv[1];
if (invokedPath && path.resolve(invokedPath) === fileURLToPath(import.meta.url)) {
  main().catch((err) => {
    // A prompt abort (EOF / Ctrl-D) is an expected exit, not a crash: report it
    // without a stack trace. Anything else is a real error.
    if (err instanceof PromptAbortError) {
      note("Aborted.");
    } else {
      note(String(err instanceof Error ? (err.stack ?? err.message) : err));
    }
    process.exit(1);
  });
}
