import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { sentryDataCollection } from "@sdp/redaction/sentry";
import type * as Sentry from "@sentry/nextjs";
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

type SdkDataCollection = NonNullable<Parameters<typeof Sentry.init>[0]["dataCollection"]>;

type EverySetting<T> = T extends readonly unknown[]
  ? T
  : T extends object
    ? { [K in keyof T]-?: EverySetting<NonNullable<T[K]>> }
    : T;

const SENTRY_INIT_FILES = [
  "sentry.server.config.ts",
  "sentry.edge.config.ts",
  "src/instrumentation-client.ts",
];

describe("Sentry initialization", () => {
  it.each(SENTRY_INIT_FILES)(
    "%s spreads the shared scrubbing hooks and switches off data collection",
    (relativePath) => {
      const source = readAppFile(relativePath);

      expect(source).toContain("...sentryScrubbingHooks");
      expect(source).toContain("dataCollection: sentryDataCollection");
    }
  );

  it("switches off every data collection category the installed SDK offers", () => {
    // Typed against the installed SDK, so a category a future release adds
    // fails the typecheck until it is set. `frameContextLines` counts source
    // lines around a stack frame and is not collected data.
    const settings: EverySetting<Omit<SdkDataCollection, "frameContextLines">> =
      sentryDataCollection;

    expect(settings).toEqual({
      userInfo: false,
      cookies: false,
      httpHeaders: false,
      httpBodies: [],
      urlQueryParams: false,
      graphQL: { document: false, variables: false },
      genAI: { inputs: false, outputs: false },
      mcp: { inputs: false, outputs: false },
      databaseQueryData: false,
      queues: false,
      stackFrameVariables: false,
    });
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
});
