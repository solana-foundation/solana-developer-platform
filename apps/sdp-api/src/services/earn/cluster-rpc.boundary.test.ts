import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { describe, expect, it } from "vitest";

/**
 * Structural tests over Earn's source: every Earn read and send reaches Solana
 * through `services/earn/cluster-rpc.ts`, the named cluster's managed pool, and
 * nothing in Earn picks an endpoint from a URL in env. A source grep is the honest
 * tool: a stray `createRpc(env, { rpcUrl })` type-checks and runs, and on a
 * deployment whose process default serves devnet it reads devnet for mainnet work.
 */

const API_SRC = join(import.meta.dirname, "../..");
const REPO = join(API_SRC, "../../..");

function sourceFilesUnder(directory: string): string[] {
  return readdirSync(directory).flatMap((entry) => {
    const path = join(directory, entry);
    if (statSync(path).isDirectory()) return sourceFilesUnder(path);
    return path.endsWith(".ts") && !path.endsWith(".test.ts") ? [path] : [];
  });
}

/** Earn's runtime code in the API, the cron and job entry points included. */
const EARN_API_FILES = [
  ...sourceFilesUnder(join(API_SRC, "services/earn")),
  ...sourceFilesUnder(join(API_SRC, "routes/earn")),
  ...readdirSync(join(API_SRC, "cron"))
    .filter((file) => file.startsWith("earn-") && !file.includes(".test."))
    .map((file) => join(API_SRC, "cron", file)),
  join(API_SRC, "services/earn-provider-registry.ts"),
  join(API_SRC, "services/jobs/detect-orphaned-earn-split-swaps.ts"),
  join(API_SRC, "services/jobs/reconcile-earn-vault-movements.ts"),
  // Operator-run catalogue inventories read the chain like the catalogue sync does.
  ...readdirSync(join(API_SRC, "../scripts"))
    .filter((file) => file.startsWith("inventory-") && file.endsWith("-catalogue.ts"))
    .map((file) => join(API_SRC, "../scripts", file)),
];

/** The catalogue package, whose shelf reads must take the caller's endpoint. */
const EARN_PACKAGE_FILES = sourceFilesUnder(join(REPO, "packages/sdp-earn/src"));

const DOOR = join(API_SRC, "services/earn/cluster-rpc.ts");

/** Names imported from `moduleName` by `import { ... } from "<moduleName>"`. */
function importedNames(body: string, moduleName: string): string[] {
  const escaped = moduleName.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const statements = body.matchAll(
    new RegExp(`import\\s+(?:type\\s+)?\\{([^}]*)\\}\\s*from\\s*["']${escaped}["']`, "g")
  );
  return [...statements].flatMap(([, names = ""]) =>
    names
      .split(",")
      .map(
        (name) =>
          name
            .trim()
            .replace(/^type\s+/, "")
            .split(/\s+as\s+/)[0]
      )
      .filter(Boolean)
  );
}

function importsModule(body: string, moduleName: string): boolean {
  const escaped = moduleName.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return new RegExp(`from\\s*["']${escaped}["']`).test(body);
}

/** Property reads of a process-level endpoint or network selector, never prose. */
const PROCESS_ENDPOINT_READ =
  /\.(SOLANA_RPC_URL|SOLANA_DEVNET_RPC_URL|SOLANA_MAINNET_RPC_URL|SOLANA_NETWORK)\b/;

function offenders(files: readonly string[], offends: (body: string) => boolean): string[] {
  return files
    .filter((file) => offends(readFileSync(file, "utf8")))
    .map((file) => relative(REPO, file));
}

describe("Earn's cluster RPC boundary", () => {
  it("covers the files it claims to", () => {
    expect(EARN_API_FILES).toContain(DOOR);
    expect(EARN_API_FILES.length).toBeGreaterThan(20);
    expect(EARN_PACKAGE_FILES.length).toBeGreaterThan(10);
  });

  it("builds no client from a URL anywhere in Earn", () => {
    const urlClients = new Set([
      "createRpc",
      "createRpcFromTransport",
      "createRpcForSdk",
      "createClusterRpc",
    ]);
    expect(
      offenders(EARN_API_FILES, (body) =>
        importedNames(body, "@sdp/rpc/solana").some((name) => urlClients.has(name))
      )
    ).toEqual([]);
  });

  it("never resolves an endpoint through @sdp/rpc/config", () => {
    expect(offenders(EARN_API_FILES, (body) => importsModule(body, "@sdp/rpc/config"))).toEqual([]);
  });

  it("reaches the door only through services/earn/cluster-rpc.ts", () => {
    expect(
      offenders(
        EARN_API_FILES.filter((file) => file !== DOOR),
        (body) => importsModule(body, "@sdp/rpc/factory")
      )
    ).toEqual([]);
  });

  it("never reads a process-level endpoint or network from env", () => {
    expect(
      offenders([...EARN_API_FILES, ...EARN_PACKAGE_FILES], (body) =>
        PROCESS_ENDPOINT_READ.test(body)
      )
    ).toEqual([]);
  });

  it("still detects a real offence, so the guards are not vacuous", () => {
    expect(
      importedNames(
        'import {\n  createRpc,\n  type SolanaRpc,\n} from "@sdp/rpc/solana";',
        "@sdp/rpc/solana"
      )
    ).toEqual(["createRpc", "SolanaRpc"]);
    expect(
      importsModule('import { resolveClusterRpcUrl } from "@sdp/rpc/config";', "@sdp/rpc/config")
    ).toBe(true);
    expect(PROCESS_ENDPOINT_READ.test("const url = ctx.env.SOLANA_RPC_URL ?? '';")).toBe(true);
    expect(PROCESS_ENDPOINT_READ.test("// reads `SOLANA_RPC_URL` in prose")).toBe(false);
  });
});
