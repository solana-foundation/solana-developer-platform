// Rendered-Compose contract for the Asset Profiles self-hosted opt-in
// (SOLA9-604 / APE-866): the shipped infra/self-hosted/compose.yml must NOT
// turn Asset Profiles on by omission. An operator who leaves
// SDP_FLAG_ASSET_PROFILES out of .env — or boots with the configurator's
// generated .env, whose default is false — must render false for BOTH the api
// and web services, while an explicit true stays honored.
//
// Rendering is offline (`docker compose config` interpolates and validates
// without contacting a daemon); the .env file must exist because compose.yml
// declares it under env_file. Rendering needs only the docker CLI, so the
// contract skips with an explicit reason on machines without it instead of
// failing the shared `pnpm test:scripts` entry point for the other scripts.
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { cpSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const COMPOSE_FILE = path.join(repoRoot, "infra/self-hosted/compose.yml");
const ENV_EXAMPLE = path.join(repoRoot, "infra/self-hosted/.env.example");
const CONFIGURATOR_DIR = path.join(repoRoot, "packages/sdp-env-config");
const TSX = path.join(CONFIGURATOR_DIR, "node_modules/.bin/tsx");

let skipWithoutDocker = false;
try {
  execFileSync("docker", ["compose", "version"], { stdio: "ignore" });
} catch {
  skipWithoutDocker = "docker compose is not available on this machine";
}

// compose.yml fails closed on these before it renders anything.
const OPERATOR_SECRETS = [
  "POSTGRES_PASSWORD=contract-test-postgres-password",
  "API_KEY_PEPPER=contract-test-api-key-pepper",
  "CUSTODY_ENCRYPTION_KEY=contract-test-custody-key",
  "NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY=pk_test_contract",
  "CLERK_SECRET_KEY=sk_test_contract",
].join("\n");

/** Render compose.yml in a scratch project dir with the given .env body. */
function renderAssetProfilesFlag(envFileBody) {
  const dir = mkdtempSync(path.join(os.tmpdir(), "sdp-compose-contract-"));
  try {
    cpSync(COMPOSE_FILE, path.join(dir, "compose.yml"));
    writeFileSync(path.join(dir, ".env"), envFileBody);
    // Strip the ambient environment down to PATH/HOME so the interpolation can
    // only see what the .env under test provides.
    const stdout = execFileSync(
      "docker",
      ["compose", "-f", path.join(dir, "compose.yml"), "config", "--format", "json"],
      {
        cwd: dir,
        env: { PATH: process.env.PATH, HOME: process.env.HOME },
        encoding: "utf8",
        maxBuffer: 16 * 1024 * 1024,
      }
    );
    const config = JSON.parse(stdout);
    const services = config.services;
    return {
      api: services["sdp-api"].environment.SDP_FLAG_ASSET_PROFILES,
      web: services["sdp-web"].environment.SDP_FLAG_ASSET_PROFILES,
    };
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

/** The .env the configurator emits from untouched defaults. */
function generatedEnvBody() {
  const dir = mkdtempSync(path.join(os.tmpdir(), "sdp-compose-contract-gen-"));
  const generator = path.join(dir, "generate-env.mts");
  try {
    writeFileSync(
      generator,
      `import { defaultValues, generateEnv } from ${JSON.stringify(
        path.join(CONFIGURATOR_DIR, "src/index.ts")
      )};\nprocess.stdout.write(generateEnv(defaultValues()));\n`
    );
    return execFileSync(TSX, [generator], {
      cwd: CONFIGURATOR_DIR,
      env: { PATH: process.env.PATH, HOME: process.env.HOME },
      encoding: "utf8",
    });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

test("omitting SDP_FLAG_ASSET_PROFILES renders the opt-out for api and web", {
  skip: skipWithoutDocker,
}, () => {
  const rendered = renderAssetProfilesFlag(`${OPERATOR_SECRETS}\n`);
  assert.deepEqual(rendered, { api: "false", web: "false" });
});

test("the configurator's generated .env renders the opt-out for api and web", {
  skip: skipWithoutDocker,
}, () => {
  const generated = generatedEnvBody();
  assert.match(generated, /^SDP_FLAG_ASSET_PROFILES=false$/m);
  const rendered = renderAssetProfilesFlag(`${generated}\n${OPERATOR_SECRETS}\n`);
  assert.deepEqual(rendered, { api: "false", web: "false" });
});

test("the documented copy-.env.example setup renders the opt-out for api and web", {
  skip: skipWithoutDocker,
}, () => {
  // The self-hosting walkthrough tells operators to copy .env.example to .env
  // and fill in the blank secrets, so the example itself is the shipped
  // opt-in decision: it must carry the explicit false, and the stack it
  // renders must come up with Asset Profiles off for both services.
  const example = readFileSync(ENV_EXAMPLE, "utf8");
  assert.match(example, /^SDP_FLAG_ASSET_PROFILES=false$/m);
  // A real operator fills the blank POSTGRES_PASSWORD/app secrets in before
  // the stack boots; compose dotenv resolution is last-value-wins, so
  // appending them models exactly that.
  const rendered = renderAssetProfilesFlag(`${example}\n${OPERATOR_SECRETS}\n`);
  assert.deepEqual(rendered, { api: "false", web: "false" });
});

test("an explicit SDP_FLAG_ASSET_PROFILES=true opt-in stays honored for api and web", {
  skip: skipWithoutDocker,
}, () => {
  const rendered = renderAssetProfilesFlag(`${OPERATOR_SECRETS}\nSDP_FLAG_ASSET_PROFILES=true\n`);
  assert.deepEqual(rendered, { api: "true", web: "true" });
});
