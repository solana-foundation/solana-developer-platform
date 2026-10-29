import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { describe, expect, it } from "vitest";

/**
 * Structural tests over Earn's source: every Earn read and send reaches Solana
 * through the open cluster scope's managed pool (`createClusterRpc()`), provider
 * packages get that pool's URLs only from `services/earn/cluster-rpc.ts`, and
 * nothing in Earn picks an endpoint from a URL in env. Requests and services take
 * their environment and cluster from that scope too, never from the request
 * context or a lookup of their own (ADR 0007). A source grep is the honest tool:
 * a stray `createRpc(env, { rpcUrl })` type-checks and runs, and on a deployment
 * whose process default serves devnet it reads devnet for mainnet work.
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

/**
 * Earn's request and service code. Every entry point opens a cluster scope first (the project
 * middleware, a cron registration), so this code reads its environment and cluster from it. The
 * global catalogue sync is outside: it opens one scope per lane.
 */
const EARN_SCOPED_FILES = [
  ...sourceFilesUnder(join(API_SRC, "services/earn")),
  ...sourceFilesUnder(join(API_SRC, "routes/earn")),
];

/** The catalogue package, whose shelf reads must take the caller's endpoint. */
const EARN_PACKAGE_FILES = sourceFilesUnder(join(REPO, "packages/sdp-earn/src"));

/** The RPC package, which must keep no export of the transitional Earn door. */
const RPC_PACKAGE_FILES = sourceFilesUnder(join(REPO, "packages/sdp-rpc/src"));

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

/** An export of the transitional Earn door that named a cluster (deleted by HOO-1881). */
const EARN_DOOR_EXPORT =
  /\bexport\b[^\n]*\b(createEarnClusterRpc|EarnClusterRpcOptions|optionalClusterScope)\b/;

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
    expect(EARN_SCOPED_FILES).toContain(join(API_SRC, "routes/earn/handlers/vault.ts"));
    expect(EARN_PACKAGE_FILES.length).toBeGreaterThan(10);
    expect(RPC_PACKAGE_FILES).toContain(join(REPO, "packages/sdp-rpc/src/factory.ts"));
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

  it("imports the URL helpers only in services/earn/cluster-rpc.ts", () => {
    expect(
      offenders(
        EARN_API_FILES.filter((file) => file !== DOOR),
        (body) =>
          importedNames(body, "@sdp/rpc/factory").some((name) => name !== "createClusterRpc")
      )
    ).toEqual([]);
  });

  it("reads the environment and cluster from the open scope", () => {
    // The project middleware sets the request's environment and opens a scope with the same
    // facts; reading `c` instead threads it through every layer again.
    expect(
      offenders(EARN_SCOPED_FILES, (body) =>
        importedNames(body, "@/lib/sdp-environment").includes("resolveSdpEnvironment")
      )
    ).toEqual([]);
    // Deriving a cluster from an environment is the scope's job (`currentClusterScope().cluster`).
    expect(
      offenders(
        EARN_SCOPED_FILES,
        (body) =>
          importedNames(body, "@sdp/types/well-known-tokens").includes(
            "CLUSTER_BY_SDP_ENVIRONMENT"
          ) || /\bearnClusterFor\b/.test(body)
      )
    ).toEqual([]);
  });

  it("leaves no Earn-only door in @sdp/rpc", () => {
    expect(offenders(RPC_PACKAGE_FILES, (body) => EARN_DOOR_EXPORT.test(body))).toEqual([]);
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
    expect(
      importedNames(
        'import { resolveSdpEnvironment } from "@/lib/sdp-environment";',
        "@/lib/sdp-environment"
      )
    ).toEqual(["resolveSdpEnvironment"]);
    expect(EARN_DOOR_EXPORT.test("export function optionalClusterScope(): ClusterScope {")).toBe(
      true
    );
  });
});
