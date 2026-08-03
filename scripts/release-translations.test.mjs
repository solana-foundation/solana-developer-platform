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
  validateTerminology,
} from "../.github/scripts/missing-translations.mjs";

const guidance = {
  default: {
    principles: ["Translate meaning, not English word order."],
  },
  locales: {
    fr: {
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
        assert.deepEqual(message.guidance.general, guidance.default);
        assert.deepEqual(message.guidance.locale, guidance.locales.fr);
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
