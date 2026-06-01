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
import path from "node:path";
import * as readline from "node:readline/promises";
import { fileURLToPath } from "node:url";
import {
  autoSecretKeys,
  defaultValues,
  type EnvField,
  FIELDS,
  generateEnv,
  isFieldVisible,
  randomHex32,
  SECTIONS,
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
  for (const key of autoSecretKeys()) {
    if (!values[key]) values[key] = randomHex32();
  }
  return values;
}

/** Write a line to stderr (prompts/progress never touch stdout). */
function note(message: string): void {
  process.stderr.write(`${message}\n`);
}

type Asker = (query: string) => Promise<string>;

/** Resolve a select answer (1-based index or option value) to a stored value. */
async function promptSelect(field: EnvField, current: string, ask: Asker): Promise<string> {
  const options = field.options ?? [];
  note(field.label);
  options.forEach((opt, i) => {
    const marker = opt.value === current ? " (default)" : "";
    note(`  ${i + 1}) ${opt.label}${marker}`);
  });

  const answer = (await ask("> ")).trim();
  if (answer === "") return current;

  if (/^\d+$/.test(answer)) {
    const byIndex = Number.parseInt(answer, 10);
    if (byIndex >= 1 && byIndex <= options.length) {
      return options[byIndex - 1].value;
    }
  }

  const byValue = options.find((opt) => opt.value === answer);
  if (byValue) return byValue.value;

  note(`Unknown option: ${answer} — keeping ${current || "(empty)"}`);
  return current;
}

/** Prompt a text/url/password field, re-asking on pattern or required violations. */
async function promptText(field: EnvField, current: string, ask: Asker): Promise<string> {
  const label = `${field.label}${field.required ? " *" : ""}`;
  if (field.help) note(field.help);
  const suffix = current ? ` [${current}]` : "";

  for (;;) {
    const answer = (await ask(`${label}${suffix}: `)).trim();
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
async function promptField(field: EnvField, current: string, ask: Asker): Promise<string> {
  if (field.kind === "secret") {
    note(`${field.label}: generated`);
    return randomHex32();
  }
  if (field.kind === "select") return promptSelect(field, current, ask);
  return promptText(field, current, ask);
}

/** Run the interactive prompt loop, returning the collected values. */
async function collectInteractively(): Promise<Values> {
  const rl = readline.createInterface({ input: process.stdin, output: process.stderr });
  const ask: Asker = (query) => rl.question(query);
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

      values[field.key] = await promptField(field, values[field.key] ?? "", ask);
    }
  } finally {
    rl.close();
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

async function main(): Promise<void> {
  const values = isNonInteractive(process.argv.slice(2))
    ? collectFromEnv(process.env)
    : await collectInteractively();

  const errors = validateValues(values);
  const entries = Object.entries(errors);
  if (entries.length > 0) {
    note("\nConfiguration is incomplete:");
    for (const [key, message] of entries) note(`  ${key}: ${message}`);
    process.exit(1);
  }

  process.stdout.write(generateEnv(values));
  note("\n.env written to stdout.");
}

const invokedPath = process.argv[1];
if (invokedPath && path.resolve(invokedPath) === fileURLToPath(import.meta.url)) {
  main().catch((err) => {
    note(String(err instanceof Error ? (err.stack ?? err.message) : err));
    process.exit(1);
  });
}
