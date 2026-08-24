import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { describe, expect, it } from "vitest";

const sourceRoot = join(process.cwd(), "src");

function sourceFiles(directory: string): string[] {
  return readdirSync(directory).flatMap((entry) => {
    const path = join(directory, entry);
    if (statSync(path).isDirectory()) {
      return sourceFiles(path);
    }
    return path.endsWith(".ts") && !path.endsWith(".test.ts") ? [path] : [];
  });
}

describe("tenant data-access boundary", () => {
  it("keeps raw TokenService construction out of authenticated issuance handlers", () => {
    const handlers = sourceFiles(join(sourceRoot, "routes", "issuance", "handlers"));
    const violations = handlers
      .filter((path) => !path.endsWith(join("handlers", "metadata.ts")))
      .filter((path) => readFileSync(path, "utf8").includes("new TokenService("))
      .map((path) => relative(sourceRoot, path));

    expect(violations).toEqual([]);
  });

  it("keeps system repository factories in explicit public, webhook, and job paths", () => {
    const allowedPrefixes = [
      "routes/pay.ts",
      "routes/issuance/handlers/metadata.ts",
      "routes/webhooks/",
      "services/jobs/",
      "db/repositories/index.ts",
      "db/repositories/repository-factory.ts",
    ];
    const violations = sourceFiles(sourceRoot)
      .filter((path) => readFileSync(path, "utf8").match(/createSystem[A-Z]\w+Repository/))
      .map((path) => relative(sourceRoot, path))
      .filter((path) => !allowedPrefixes.some((prefix) => path.startsWith(prefix)));

    expect(violations).toEqual([]);
  });

  it("keeps system database-identity grants in registered entry points", () => {
    // Each of these files is an explicit cross-tenant surface: HTTP auth
    // resolution, public endpoints, webhook/cron/job entry points, and ops
    // scripts. Granting the system identity anywhere else would silently
    // widen the database tenant boundary — extend this registry deliberately.
    const allowedPrefixes = [
      "db/index.ts",
      "db/identity.ts",
      "db/operator-access.ts",
      "cron/runner.ts",
      "job.ts",
      "middleware/auth.ts",
      "middleware/clerk-auth.ts",
      "middleware/session-auth.ts",
      "middleware/database-identity.ts",
      "routes/issuance/index.ts",
      "routes/members/index.ts",
      // BOLA guard: must see every organization's ledger rows to 404 a
      // foreign withdrawal ref before any provider call.
      "routes/earn/handlers/program.ts",
    ];
    const violations = sourceFiles(sourceRoot)
      .filter((path) => readFileSync(path, "utf8").includes("runWithSystemDatabaseIdentity"))
      .map((path) => relative(sourceRoot, path))
      .filter((path) => !allowedPrefixes.some((prefix) => path.startsWith(prefix)));

    expect(violations).toEqual([]);
  });

  it("keeps the audited operator bypass out of application code", () => {
    // runWithOperatorDatabaseAccess is break-glass tooling for operational
    // scripts; nothing in the request/worker paths may import it.
    const violations = sourceFiles(sourceRoot)
      .filter((path) => readFileSync(path, "utf8").includes("runWithOperatorDatabaseAccess"))
      .map((path) => relative(sourceRoot, path))
      .filter((path) => path !== join("db", "operator-access.ts"));

    expect(violations).toEqual([]);
  });

  it("keeps the test-only default database identity out of production code", () => {
    const violations = sourceFiles(sourceRoot)
      .filter((path) => readFileSync(path, "utf8").includes("setDefaultDatabaseIdentityForTesting"))
      .map((path) => relative(sourceRoot, path))
      .filter((path) => !path.startsWith("test/") && path !== join("db", "identity.ts"));

    expect(violations).toEqual([]);
  });

  it("requires transactional payment repositories to receive a tenant scope", () => {
    const allowedSystemFactory = join(sourceRoot, "db", "repositories", "repository-factory.ts");
    const violations = sourceFiles(sourceRoot)
      .filter((path) => path !== allowedSystemFactory)
      .flatMap((path) => {
        const source = readFileSync(path, "utf8");
        const calls = source.matchAll(/createPostgresPaymentsRepository\(([^)]*)\)/g);
        return Array.from(calls)
          .filter((match) => !match[1]?.includes(","))
          .map(() => relative(sourceRoot, path));
      });

    expect(violations).toEqual([]);
  });

  it("requires authenticated custody handlers to construct scoped signing services", () => {
    const violations = sourceFiles(join(sourceRoot, "routes", "custody", "handlers")).flatMap(
      (path) => {
        const source = readFileSync(path, "utf8");
        const calls = source.matchAll(/createSigningService\(([^)]*)\)/g);
        return Array.from(calls)
          .filter((match) => !match[1]?.includes(","))
          .map(() => relative(sourceRoot, path));
      }
    );

    expect(violations).toEqual([]);
  });
});
