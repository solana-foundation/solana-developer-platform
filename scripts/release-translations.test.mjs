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

test("requires the model to preserve placeholders and return every requested key", async () => {
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
    apiKey: "test-key",
    baseUrl: "https://llm.example.test/v1",
    model: "test-model",
    fetchImpl: async () => ({
      ok: true,
      status: 200,
      json: async () => ({
        choices: [
          {
            message: {
              content: `\`\`\`text
${JSON.stringify({
  translations: [{ file: "en.json", key: "Home.title", translation: "Bonjour {name}" }],
})}
\`\`\``,
            },
          },
        ],
      }),
    }),
  });

  assert.equal(result.batches, 1);
  assert.equal(result.translations[0].value, "Bonjour {name}");
});

test("rejects a provider response that changes placeholders", async () => {
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
      apiKey: "test-key",
      baseUrl: "https://llm.example.test/v1",
      model: "test-model",
      fetchImpl: async () => ({
        ok: true,
        status: 200,
        json: async () => ({
          choices: [
            {
              message: {
                content: JSON.stringify({
                  translations: [{ file: "en.json", key: "Home.title", translation: "Bonjour" }],
                }),
              },
            },
          ],
        }),
      }),
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
