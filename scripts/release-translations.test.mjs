import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { createCommitOnBranch } from "../.github/scripts/github-commit-on-branch.mjs";
import {
  applyTranslations,
  collectMissingTranslations,
  extractPlaceholderTokens,
  translateMissingEntries,
  validateCatalogs,
  validateTerminology,
} from "../.github/scripts/missing-translations.mjs";

const guidance = {
  default: {
    context: {
      product: "Solana Developer Platform",
      audience: "Web3 developers",
    },
    instructions: ["Translate meaning, not English word order."],
  },
  locales: {
    fr: {
      context: {
        localeName: "français (France)",
        convention: "Established Web3 terms are commonly retained in English.",
      },
      instructions: ["Address the user with vous."],
      terminology: [{ source: "token", preferred: "Token", avoid: "jeton" }],
      forbiddenTerms: [
        {
          label: "jeton / jetons",
          pattern: "\\bjetons?\\b",
          flags: "iu",
          preferred: "Token / Tokens",
        },
      ],
    },
  },
};

function writeJson(filePath, value) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, `${JSON.stringify(value, null, 2)}\n`);
}

function createFixture() {
  const messagesDir = fs.mkdtempSync(path.join(os.tmpdir(), "sdp-translations-"));
  writeJson(path.join(messagesDir, "en.json"), {
    Home: { title: "Hello {name}" },
  });
  writeJson(path.join(messagesDir, "en", "dashboard.json"), {
    Dashboard: { title: "Settings", save: "Save" },
  });
  writeJson(path.join(messagesDir, "fr.json"), {
    Home: { title: "Bonjour {name}" },
  });
  writeJson(path.join(messagesDir, "es", "dashboard.json"), {
    Dashboard: { title: "Ajustes", save: "Guardar" },
  });
  writeJson(path.join(messagesDir, "fr", "dashboard.json"), {
    Dashboard: { title: "Paramètres" },
  });
  return messagesDir;
}

test("discovers locale catalogs and reports missing nested keys", () => {
  const messagesDir = createFixture();
  const inventory = collectMissingTranslations({ messagesDir });

  assert.deepEqual(inventory.locales, ["es", "fr"]);
  assert.deepEqual(
    inventory.missing.map(({ locale, targetFile, key, source }) => ({
      locale,
      targetFile,
      key,
      source,
    })),
    [
      { locale: "es", targetFile: "es.json", key: "Home.title", source: "Hello {name}" },
      { locale: "fr", targetFile: "fr/dashboard.json", key: "Dashboard.save", source: "Save" },
    ]
  );
  assert.deepEqual(inventory.missing[1].context, {
    namespace: "Dashboard",
    nearby: [
      {
        key: "Dashboard.title",
        source: "Settings",
        translation: "Paramètres",
      },
    ],
  });
});

test("applies only generated leaves and validates the complete catalogs", () => {
  const messagesDir = createFixture();
  const inventory = collectMissingTranslations({ messagesDir });

  applyTranslations({
    messagesDir,
    translations: inventory.missing.map((entry) => ({
      ...entry,
      value: entry.locale === "es" ? "Hola {name}" : "Enregistrer",
    })),
  });

  assert.doesNotThrow(() => validateCatalogs({ messagesDir }));
  assert.equal(
    JSON.parse(fs.readFileSync(path.join(messagesDir, "fr.json"))).Home.title,
    "Bonjour {name}"
  );
  assert.equal(
    JSON.parse(fs.readFileSync(path.join(messagesDir, "es.json"))).Home.title,
    "Hola {name}"
  );
});

test("allows stale locale keys after a source string is removed", () => {
  const messagesDir = createFixture();
  const inventory = collectMissingTranslations({ messagesDir });

  applyTranslations({
    messagesDir,
    translations: inventory.missing.map((entry) => ({
      ...entry,
      value: entry.locale === "es" ? "Hola {name}" : "Enregistrer",
    })),
  });
  fs.writeFileSync(path.join(messagesDir, "en", "dashboard.json"), "{}\n");

  assert.doesNotThrow(() => validateCatalogs({ messagesDir }));
});

test("uses the Eve structured session API and preserves placeholders", async () => {
  const missing = [
    {
      locale: "fr",
      sourceFile: "en.json",
      targetFile: "fr.json",
      key: "Home.title",
      source: "Hello {name}",
      context: {
        namespace: "Home",
        nearby: [
          {
            key: "Home.subtitle",
            source: "Welcome",
            translation: "Bienvenue",
          },
        ],
      },
    },
  ];

  const result = await translateMissingEntries({
    missing,
    agentUrl: "https://translation.example.test",
    agentUsername: "test-user",
    agentPassword: "test-password",
    guidance,
    fetchImpl: async (url, options) => {
      if (url.endsWith("/eve/v1/session")) {
        assert.equal(
          options.headers.Authorization,
          `Basic ${Buffer.from("test-user:test-password").toString("base64")}`
        );
        const request = JSON.parse(options.body);
        assert.equal(request.outputSchema.properties.translations.minItems, 1);
        const message = JSON.parse(request.message);
        assert.deepEqual(message.guidance.context, {
          general: guidance.default.context,
          locale: guidance.locales.fr.context,
        });
        assert.deepEqual(message.guidance.instructions, {
          general: guidance.default.instructions,
          locale: guidance.locales.fr.instructions,
          terminology: guidance.locales.fr.terminology,
        });
        assert.equal("context" in message, false);
        assert.equal("instructions" in message, false);
        assert.equal("forbiddenTerms" in message.guidance.instructions, false);
        assert.equal(message.translations[0].context.nearby[0].translation, "Bienvenue");
        return {
          ok: true,
          status: 200,
          json: async () => ({ sessionId: "session-1" }),
        };
      }

      return {
        ok: true,
        status: 200,
        text: async () =>
          `${JSON.stringify({
            type: "result.completed",
            data: {
              result: {
                translations: [
                  { file: "en.json", key: "Home.title", translation: "Bonjour {name}" },
                ],
              },
            },
          })}\n`,
      };
    },
  });

  assert.equal(result.batches, 1);
  assert.equal(result.translations[0].value, "Bonjour {name}");
});

test("translates more than 500 keys in bounded batches", async () => {
  const missing = Array.from({ length: 501 }, (_, index) => ({
    locale: "fr",
    sourceFile: "en.json",
    targetFile: "fr.json",
    key: `Bulk.key${index}`,
    source: `Value ${index}`,
  }));
  const pendingBatches = [];

  const result = await translateMissingEntries({
    missing,
    agentUrl: "https://translation.example.test",
    agentUsername: "test-user",
    agentPassword: "test-password",
    batchSize: 50,
    maxRetries: 0,
    fetchImpl: async (url, options) => {
      if (url.endsWith("/eve/v1/session")) {
        const batch = JSON.parse(JSON.parse(options.body).message).translations;
        pendingBatches.push(batch);
        return {
          ok: true,
          status: 200,
          json: async () => ({ sessionId: `session-${pendingBatches.length}` }),
        };
      }

      const batch = pendingBatches.shift();
      return {
        ok: true,
        status: 200,
        text: async () =>
          `${JSON.stringify({
            type: "result.completed",
            data: {
              result: {
                translations: batch.map(({ file, key, source }) => ({
                  file,
                  key,
                  translation: source,
                })),
              },
            },
          })}\n`,
      };
    },
  });

  assert.equal(result.batches, 11);
  assert.equal(result.translations.length, 501);
});

test("returns when Eve completes a result without closing the stream", {
  timeout: 1_000,
}, async () => {
  const missing = [
    {
      locale: "fr",
      sourceFile: "en.json",
      targetFile: "fr.json",
      key: "Home.title",
      source: "Hello {name}",
    },
  ];
  let streamCancelled = false;
  const body = new ReadableStream({
    start(controller) {
      const event = new TextEncoder().encode(
        `${JSON.stringify({
          type: "result.completed",
          data: {
            result: {
              translations: [{ file: "en.json", key: "Home.title", translation: "Bonjour {name}" }],
            },
          },
        })}\n`
      );
      const midpoint = Math.floor(event.length / 2);
      controller.enqueue(event.slice(0, midpoint));
      controller.enqueue(event.slice(midpoint));
    },
    cancel() {
      streamCancelled = true;
    },
  });

  const result = await translateMissingEntries({
    missing,
    agentUrl: "https://translation.example.test",
    agentUsername: "test-user",
    agentPassword: "test-password",
    maxRetries: 0,
    fetchImpl: async (url) =>
      url.endsWith("/eve/v1/session")
        ? {
            ok: true,
            status: 200,
            json: async () => ({ sessionId: "session-1" }),
          }
        : {
            ok: true,
            status: 200,
            body,
            text: () => new Promise(() => {}),
          },
  });

  assert.equal(result.translations[0].value, "Bonjour {name}");
  assert.equal(streamCancelled, true);
});

test("cancels the stream when Eve reports a failure", { timeout: 1_000 }, async () => {
  const missing = [
    {
      locale: "fr",
      sourceFile: "en.json",
      targetFile: "fr.json",
      key: "Home.title",
      source: "Hello {name}",
    },
  ];
  let streamCancelled = false;
  const body = new ReadableStream({
    start(controller) {
      controller.enqueue(
        new TextEncoder().encode(
          `${JSON.stringify({
            type: "turn.failed",
            data: { message: "model unavailable" },
          })}\n`
        )
      );
    },
    cancel() {
      streamCancelled = true;
    },
  });

  await assert.rejects(
    translateMissingEntries({
      missing,
      agentUrl: "https://translation.example.test",
      agentUsername: "test-user",
      agentPassword: "test-password",
      maxRetries: 0,
      fetchImpl: async (url) =>
        url.endsWith("/eve/v1/session")
          ? {
              ok: true,
              status: 200,
              json: async () => ({ sessionId: "session-1" }),
            }
          : {
              ok: true,
              status: 200,
              body,
            },
    }),
    /Translation agent failed: model unavailable/
  );
  assert.equal(streamCancelled, true);
});

test("rejects an Eve result that changes placeholders", async () => {
  await assert.rejects(
    translateMissingEntries({
      missing: [
        {
          locale: "fr",
          sourceFile: "en.json",
          targetFile: "fr.json",
          key: "Home.title",
          source: "Hello {name}",
        },
      ],
      agentUrl: "https://translation.example.test",
      agentUsername: "test-user",
      agentPassword: "test-password",
      fetchImpl: async (url) =>
        url.endsWith("/eve/v1/session")
          ? {
              ok: true,
              status: 200,
              json: async () => ({ sessionId: "session-1" }),
            }
          : {
              ok: true,
              status: 200,
              text: async () =>
                `${JSON.stringify({
                  type: "result.completed",
                  data: {
                    result: {
                      translations: [
                        { file: "en.json", key: "Home.title", translation: "Bonjour" },
                      ],
                    },
                  },
                })}\n`,
            },
    }),
    /changed placeholders/
  );
});

test("rejects locale-specific literal terminology from Eve", async () => {
  await assert.rejects(
    translateMissingEntries({
      missing: [
        {
          locale: "fr",
          sourceFile: "en.json",
          targetFile: "fr.json",
          key: "Home.token",
          source: "Token",
        },
      ],
      guidance,
      agentUrl: "https://translation.example.test",
      agentUsername: "test-user",
      agentPassword: "test-password",
      maxRetries: 0,
      fetchImpl: async (url) =>
        url.endsWith("/eve/v1/session")
          ? {
              ok: true,
              status: 200,
              json: async () => ({ sessionId: "session-1" }),
            }
          : {
              ok: true,
              status: 200,
              text: async () =>
                `${JSON.stringify({
                  type: "result.completed",
                  data: {
                    result: {
                      translations: [{ file: "en.json", key: "Home.token", translation: "Jeton" }],
                    },
                  },
                })}\n`,
            },
    }),
    /use Token \/ Tokens/
  );
});

test("feeds validation failures back to Eve before retrying a batch", async () => {
  const sessionMessages = [];
  let streams = 0;
  const result = await translateMissingEntries({
    missing: [
      {
        locale: "fr",
        sourceFile: "en.json",
        targetFile: "fr.json",
        key: "Home.token",
        source: "Token",
      },
    ],
    guidance,
    agentUrl: "https://translation.example.test",
    agentUsername: "test-user",
    agentPassword: "test-password",
    maxRetries: 1,
    fetchImpl: async (url, options) => {
      if (url.endsWith("/eve/v1/session")) {
        sessionMessages.push(JSON.parse(JSON.parse(options.body).message));
        return {
          ok: true,
          status: 200,
          json: async () => ({ sessionId: `session-${sessionMessages.length}` }),
        };
      }

      streams += 1;
      return {
        ok: true,
        status: 200,
        text: async () =>
          `${JSON.stringify({
            type: "result.completed",
            data: {
              result: {
                translations: [
                  {
                    file: "en.json",
                    key: "Home.token",
                    translation: streams === 1 ? "Jeton" : "Token",
                  },
                ],
              },
            },
          })}\n`,
      };
    },
  });

  assert.equal(result.translations[0].value, "Token");
  assert.equal("retryFeedback" in sessionMessages[0], false);
  assert.match(sessionMessages[1].retryFeedback.reason, /jeton \/ jetons/);
  assert.match(sessionMessages[1].retryFeedback.instruction, /Regenerate the full batch/);
});

test("validates approved locale terminology independently", () => {
  assert.doesNotThrow(() =>
    validateTerminology({
      locale: "fr",
      entries: [{ key: "Home.token", value: "Créer un Token" }],
      guidance,
    })
  );
  assert.throws(
    () =>
      validateTerminology({
        locale: "fr",
        entries: [{ key: "Home.token", value: "Créer un jeton" }],
        guidance,
      }),
    /jeton \/ jetons/
  );
});

test("preserves ICU selectors and markup while allowing translated branch text", () => {
  const source = "<Link>{count, plural, one {# item} other {# items}}</Link>";
  const translation = "<Link>{count, plural, one {# article} other {# articles}}</Link>";
  const changedSelector = "<Link>{count, plural, one {# article}}</Link>";

  assert.deepEqual(extractPlaceholderTokens(source), extractPlaceholderTokens(translation));
  assert.notDeepEqual(extractPlaceholderTokens(source), extractPlaceholderTokens(changedSelector));
});

test("creates translation commits through GitHub without overriding the app identity", async () => {
  let request;
  const encodedContents = Buffer.from('{"test":true}').toString("base64");
  const commit = await createCommitOnBranch({
    repository: "solana-foundation/solana-developer-platform",
    branch: "codex/release-main",
    expectedHeadOid: "abc123",
    headline: "chore(i18n): translate missing release strings",
    additions: [{ path: "apps/sdp-web/messages/fr.json", contents: encodedContents }],
    token: "test-token",
    fetchImpl: async (url, options) => {
      request = { url, options };
      return {
        ok: true,
        status: 200,
        text: async () =>
          JSON.stringify({
            data: {
              createCommitOnBranch: {
                commit: { oid: "def456", url: "https://github.test/commit/def456" },
              },
            },
          }),
      };
    },
  });

  assert.equal(commit.oid, "def456");
  assert.equal(request.url, "https://api.github.com/graphql");
  assert.equal(request.options.headers.Authorization, "Bearer test-token");
  const input = JSON.parse(request.options.body).variables.input;
  assert.deepEqual(input, {
    branch: {
      repositoryNameWithOwner: "solana-foundation/solana-developer-platform",
      branchName: "codex/release-main",
    },
    expectedHeadOid: "abc123",
    message: { headline: "chore(i18n): translate missing release strings" },
    fileChanges: {
      additions: [{ path: "apps/sdp-web/messages/fr.json", contents: encodedContents }],
    },
  });
  assert.equal("author" in input, false);
  assert.equal("committer" in input, false);
});

test("surfaces GraphQL commit errors returned with HTTP 200", async () => {
  await assert.rejects(
    createCommitOnBranch({
      repository: "solana-foundation/solana-developer-platform",
      branch: "codex/release-main",
      expectedHeadOid: "stale-head",
      headline: "chore(i18n): translate missing release strings",
      additions: [],
      token: "test-token",
      fetchImpl: async () => ({
        ok: true,
        status: 200,
        text: async () => JSON.stringify({ errors: [{ message: "Expected head oid mismatch" }] }),
      }),
    }),
    /Expected head oid mismatch/
  );
});

test("translation workflow does not push a locally created commit", () => {
  const workflow = fs.readFileSync(
    path.resolve(import.meta.dirname, "../.github/workflows/release-please.yml"),
    "utf8"
  );

  assert.doesNotMatch(workflow, /git push origin HEAD:codex\/release-main/);
});
