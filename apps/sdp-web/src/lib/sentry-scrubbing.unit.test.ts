import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { sentryScrubbingHooks } from "@sdp/redaction";
import { describe, expect, it } from "vitest";

const APP_ROOT = path.resolve(__dirname, "../..");

function readAppFile(relativePath: string): string {
  return readFileSync(path.join(APP_ROOT, relativePath), "utf8");
}

function listSourceFiles(directory: string): string[] {
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const entryPath = path.join(directory, entry.name);
    if (entry.isDirectory()) {
      return entry.name === "node_modules" || entry.name === ".next"
        ? []
        : listSourceFiles(entryPath);
    }
    return /\.(ts|tsx)$/.test(entry.name) && !entry.name.includes(".test.") ? [entryPath] : [];
  });
}

const SENTRY_INIT_FILES = [
  "sentry.server.config.ts",
  "sentry.edge.config.ts",
  "src/instrumentation-client.ts",
];

describe("Sentry initialization", () => {
  it.each(SENTRY_INIT_FILES)("%s spreads the shared scrubbing hooks", (relativePath) => {
    const source = readAppFile(relativePath);

    expect(source).toContain("...sentryScrubbingHooks");
    expect(source).toContain("sendDefaultPii: false");
  });

  it("has no other Sentry.init call site that could ship unscrubbed events", () => {
    // A new runtime (a future worker or instrumentation entry) is the realistic
    // way scrubbing gets bypassed: `Sentry.init` without the hooks is a sink
    // with no denylist, and nothing else in the build would complain.
    const initFiles = [path.join(APP_ROOT, "src"), APP_ROOT]
      .flatMap((directory) =>
        directory === APP_ROOT
          ? readdirSync(directory, { withFileTypes: true })
              .filter((entry) => entry.isFile() && /\.(ts|tsx)$/.test(entry.name))
              .map((entry) => path.join(directory, entry.name))
          : listSourceFiles(directory)
      )
      .filter((filePath) => readFileSync(filePath, "utf8").includes("Sentry.init("));

    expect(initFiles.map((filePath) => path.relative(APP_ROOT, filePath)).sort()).toEqual(
      [...SENTRY_INIT_FILES].sort()
    );
  });
});

describe("SentryUserContext", () => {
  it("identifies the session by opaque id, with no email or display name", () => {
    const source = readAppFile("src/components/sentry-user-context.tsx");

    expect(source).toContain("Sentry.setUser({ id: userId })");
    expect(source).not.toContain("emailAddress");
    expect(source).not.toContain("useUser");
  });

  it("does not let the feedback widget reuse a Sentry user email", () => {
    // Matched as a config key, so the comment explaining its absence can stay.
    expect(readAppFile("src/instrumentation-client.ts")).not.toContain("useSentryUser:");
  });
});

describe("sentryScrubbingHooks in the browser bundle", () => {
  it("scrubs a dashboard error event carrying counterparty data", () => {
    // The dashboard renders counterparty names and bank details, so a client
    // error can close over them via component props or a fetch breadcrumb.
    const event = sentryScrubbingHooks.beforeSend({
      event_id: "evt_1",
      user: { id: "user_1" },
      request: { url: "/dashboard/counterparties/cp_1?email=jane.doe%40example.com" },
      extra: {
        counterpartyId: "cp_1",
        displayName: "Jane Doe",
        identity: { firstName: "Jane", phone: "+15551234567" },
        details: { accountNumber: "000123456789" },
      },
      breadcrumbs: [{ category: "fetch", data: { email: "jane.doe@example.com" } }],
    });

    const serialized = JSON.stringify(event);
    expect(serialized).not.toContain("jane.doe");
    expect(serialized).not.toContain("Jane");
    expect(serialized).not.toContain("+15551234567");
    expect(serialized).not.toContain("000123456789");
    expect(event?.user.id).toBe("user_1");
    expect(serialized).toContain("cp_1");
  });
});
