import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import {
  applyTranslations,
  collectMissingTranslations,
  extractPlaceholderTokens,
  translateMissingEntries,
  validateCatalogs,
} from "../.github/scripts/missing-translations.mjs";

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
    Dashboard: { save: "Save" },
  });
  writeJson(path.join(messagesDir, "fr.json"), {
    Home: { title: "Bonjour {name}" },
  });
  writeJson(path.join(messagesDir, "es", "dashboard.json"), {
    Dashboard: { save: "Guardar" },
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
    },
  ];

  const result = await translateMissingEntries({
    missing,
    agentUrl: "https://translation.example.test",
    agentUsername: "test-user",
    agentPassword: "test-password",
    fetchImpl: async (url, options) => {
      if (url.endsWith("/eve/v1/session")) {
        assert.equal(
          options.headers.Authorization,
          `Basic ${Buffer.from("test-user:test-password").toString("base64")}`
        );
        const request = JSON.parse(options.body);
        assert.equal(request.outputSchema.properties.translations.minItems, 1);
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

test("preserves ICU selectors and markup while allowing translated branch text", () => {
  const source = "<Link>{count, plural, one {# item} other {# items}}</Link>";
  const translation = "<Link>{count, plural, one {# article} other {# articles}}</Link>";
  const changedSelector = "<Link>{count, plural, one {# article}}</Link>";

  assert.deepEqual(extractPlaceholderTokens(source), extractPlaceholderTokens(translation));
  assert.notDeepEqual(extractPlaceholderTokens(source), extractPlaceholderTokens(changedSelector));
});
