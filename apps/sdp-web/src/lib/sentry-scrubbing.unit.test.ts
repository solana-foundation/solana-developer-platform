import { readdirSync, readFileSync } from "node:fs";
import { createServer } from "node:http";
import path from "node:path";
import { sentryScrubbingHooks } from "@sdp/redaction";
import * as Sentry from "@sentry/nextjs";
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

  it.each(SENTRY_INIT_FILES)(
    "%s registers the shared feedback hook on the client",
    (relativePath) => {
      // `beforeSendFeedback` is not an init option: the SDK only emits it as a
      // client hook and ignores its return value, so spreading the hooks object
      // alone leaves feedback events unscrubbed. Each init site must register it.
      const source = readAppFile(relativePath);

      expect(source).toContain('Sentry.getClient()?.on("beforeSendFeedback"');
      expect(source).toContain("sentryScrubbingHooks.beforeSendFeedback");
    }
  );

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

  it("scrubs a feedback event, which the SDK never feeds to beforeSend", () => {
    // Sentry.captureFeedback emits the `beforeSendFeedback` client hook before
    // capturing and ignores hook return values, so the hook must exist on the
    // shared object and scrub the event in place.
    expect(typeof sentryScrubbingHooks.beforeSendFeedback).toBe("function");

    const event = {
      type: "feedback",
      level: "info",
      contexts: {
        feedback: {
          contact_email: "jane.doe@example.com",
          message: "provider error: counterparty jane.doe@example.com",
          url: "https://dashboard.example.test/payments?owner=jane.doe@example.com",
        },
      },
    };

    const scrubbed = sentryScrubbingHooks.beforeSendFeedback(event);
    const serialized = JSON.stringify(scrubbed);

    expect(serialized).not.toContain("jane.doe@example.com");
    expect(scrubbed).toBe(event);
    expect(scrubbed?.contexts.feedback.contact_email).toBe("[REDACTED]");
    expect(scrubbed?.contexts.feedback.message).toBe(
      "provider error: counterparty [REDACTED_EMAIL]"
    );
  });

  it("scrubs a captured feedback event before the transport receives it", async () => {
    // End to end through the pinned SDK: init the way the app does, register
    // the hook the way every init site does, and read the feedback event off
    // the wire. This is the exploit path from the security finding — the
    // feedback widget's free-form message and contact fields reaching the
    // transport unredacted.
    const received: string[] = [];
    const server = createServer((request, response) => {
      const chunks: Buffer[] = [];
      request.on("data", (chunk: Buffer) => chunks.push(chunk));
      request.on("end", () => {
        received.push(Buffer.concat(chunks).toString("utf8"));
        response.writeHead(200).end();
      });
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("local sink did not bind");

    const sensitiveMessage = "provider error: counterparty jane.doe@example.com";

    Sentry.init({
      dsn: `http://public@127.0.0.1:${address.port}/1`,
      sendDefaultPii: false,
      sampleRate: 1,
      ...sentryScrubbingHooks,
    });
    const client = Sentry.getClient();
    if (!client) throw new Error("Sentry client did not initialize");
    // Registered conditionally only so a regression that removes the hook
    // fails on the wire assertions below (the raw delivery) instead of on a
    // TypeError at registration time.
    if (typeof sentryScrubbingHooks.beforeSendFeedback === "function") {
      client.on("beforeSendFeedback", sentryScrubbingHooks.beforeSendFeedback);
    }

    try {
      Sentry.captureFeedback({
        message: sensitiveMessage,
        name: "Jane Doe",
        email: "jane.doe@example.com",
        url: "https://dashboard.example.test/payments?owner=jane.doe@example.com",
      });
      if (!(await Sentry.flush(5000))) throw new Error("Sentry did not flush");
    } finally {
      server.close();
    }

    const feedbackEvent = received
      .flatMap((body) => body.split("\n"))
      .map((line): Record<string, unknown> | null => {
        try {
          return JSON.parse(line) as Record<string, unknown>;
        } catch {
          return null;
        }
      })
      .find(
        (value) =>
          value !== null &&
          value.type === "feedback" &&
          typeof value.contexts === "object" &&
          value.contexts !== null
      );
    if (!feedbackEvent)
      throw new Error(`no feedback event reached the sink: ${received.length} envelopes`);

    const serialized = JSON.stringify(feedbackEvent);
    expect(serialized).not.toContain("jane.doe@example.com");
    const feedback = (feedbackEvent.contexts as { feedback: Record<string, unknown> }).feedback;
    expect(feedback.contact_email).toBe("[REDACTED]");
    expect(feedback.message).toBe("provider error: counterparty [REDACTED_EMAIL]");
    expect(feedback.url).toBe("https://dashboard.example.test/payments?owner=[REDACTED_EMAIL]");
  });
});
