import fs from "node:fs";
import path from "node:path";

const LOCALE_NAME = /^[A-Za-z]{2,3}(?:[-_][A-Za-z0-9]+)*$/;

function isRecord(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function normalizeRelativePath(value) {
  return value.split(path.sep).join("/");
}

function readJson(filePath) {
  const value = JSON.parse(fs.readFileSync(filePath, "utf8"));
  if (!isRecord(value)) {
    throw new Error(`Expected a JSON object in ${filePath}`);
  }
  return value;
}

function writeJson(filePath, value) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, `${JSON.stringify(value, null, 2)}\n`);
}

function listJsonFiles(directory) {
  if (!fs.existsSync(directory)) {
    return [];
  }

  const files = [];
  for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
    const entryPath = path.join(directory, entry.name);
    if (entry.isDirectory()) {
      files.push(...listJsonFiles(entryPath));
    } else if (entry.isFile() && entry.name.endsWith(".json")) {
      files.push(entryPath);
    }
  }
  return files.sort();
}

function catalogFiles(messagesDir, locale) {
  const rootFile = path.join(messagesDir, `${locale}.json`);
  const localeDirectory = path.join(messagesDir, locale);
  return [...(fs.existsSync(rootFile) ? [rootFile] : []), ...listJsonFiles(localeDirectory)];
}

function relativeCatalogPath(messagesDir, filePath) {
  return normalizeRelativePath(path.relative(messagesDir, filePath));
}

function localeCatalogPath(sourceRelativePath, locale, sourceLocale) {
  if (sourceRelativePath === `${sourceLocale}.json`) {
    return `${locale}.json`;
  }

  return `${locale}/${sourceRelativePath.slice(`${sourceLocale}/`.length)}`;
}

function availableLocales(messagesDir, sourceLocale) {
  if (!fs.existsSync(messagesDir)) {
    return [];
  }

  const locales = new Set();
  for (const entry of fs.readdirSync(messagesDir, { withFileTypes: true })) {
    const locale = entry.isDirectory() ? entry.name : path.parse(entry.name).name;
    if (locale !== sourceLocale && LOCALE_NAME.test(locale)) {
      locales.add(locale);
    }
  }
  return [...locales].sort();
}

export function flattenCatalog(value, prefix = "", result = new Map()) {
  if (typeof value === "string") {
    result.set(prefix, value);
    return result;
  }

  if (!isRecord(value)) {
    throw new Error(`Catalog value at ${prefix || "<root>"} must be an object or string`);
  }

  for (const [key, child] of Object.entries(value)) {
    const childPrefix = prefix ? `${prefix}.${key}` : key;
    flattenCatalog(child, childPrefix, result);
  }
  return result;
}

function setCatalogValue(catalog, key, value) {
  const segments = key.split(".");
  let target = catalog;
  for (const segment of segments.slice(0, -1)) {
    const current = target[segment];
    if (current === undefined) {
      target[segment] = {};
    } else if (!isRecord(current)) {
      throw new Error(`Cannot add ${key}: ${segment} is not an object`);
    }
    target = target[segment];
  }

  const leaf = segments.at(-1);
  if (target[leaf] !== undefined) {
    throw new Error(`Refusing to overwrite existing translation ${key}`);
  }
  target[leaf] = value;
}

export function collectMissingTranslations({ messagesDir, sourceLocale = "en" }) {
  const sourceFiles = catalogFiles(messagesDir, sourceLocale);
  if (sourceFiles.length === 0) {
    throw new Error(`No ${sourceLocale} catalog found under ${messagesDir}`);
  }

  const locales = availableLocales(messagesDir, sourceLocale);
  const missing = [];

  for (const locale of locales) {
    for (const sourceFile of sourceFiles) {
      const sourceRelativePath = relativeCatalogPath(messagesDir, sourceFile);
      const targetRelativePath = localeCatalogPath(sourceRelativePath, locale, sourceLocale);
      const targetFile = path.join(messagesDir, targetRelativePath);
      const sourceCatalog = readJson(sourceFile);
      const targetCatalog = fs.existsSync(targetFile) ? readJson(targetFile) : {};
      const sourceLeaves = flattenCatalog(sourceCatalog);
      const targetLeaves = flattenCatalog(targetCatalog);

      for (const [key, source] of sourceLeaves) {
        if (!targetLeaves.has(key)) {
          missing.push({
            locale,
            sourceFile: sourceRelativePath,
            targetFile: targetRelativePath,
            key,
            source,
          });
        }
      }
    }
  }

  return {
    locales,
    sourceFiles: sourceFiles.map((file) => relativeCatalogPath(messagesDir, file)),
    missing,
  };
}

function validateCatalogFile({ sourceFile, targetFile, locale, targetRelativePath }) {
  const sourceCatalog = readJson(sourceFile);
  const targetCatalog = fs.existsSync(targetFile) ? readJson(targetFile) : {};
  const sourceLeaves = flattenCatalog(sourceCatalog);
  const targetLeaves = flattenCatalog(targetCatalog);
  const errors = [];

  for (const key of sourceLeaves.keys()) {
    if (!targetLeaves.has(key)) {
      errors.push(`${locale}/${targetRelativePath}: missing ${key}`);
    }
  }

  for (const [key, source] of sourceLeaves) {
    const translation = targetLeaves.get(key);
    if (translation !== undefined) {
      const sourceTokens = extractPlaceholderTokens(source);
      const translationTokens = extractPlaceholderTokens(translation);
      if (sourceTokens.join("\u0000") !== translationTokens.join("\u0000")) {
        errors.push(`${locale}/${targetRelativePath}: placeholder mismatch for ${key}`);
      }
    }
  }

  return errors;
}

export function validateCatalogs({ messagesDir, sourceLocale = "en" }) {
  const sourceFiles = catalogFiles(messagesDir, sourceLocale);
  const locales = availableLocales(messagesDir, sourceLocale);
  const errors = [];

  for (const locale of locales) {
    for (const sourceFile of sourceFiles) {
      const sourceRelativePath = relativeCatalogPath(messagesDir, sourceFile);
      const targetRelativePath = localeCatalogPath(sourceRelativePath, locale, sourceLocale);
      errors.push(
        ...validateCatalogFile({
          sourceFile,
          targetFile: path.join(messagesDir, targetRelativePath),
          locale,
          targetRelativePath,
        })
      );
    }
  }

  if (errors.length > 0) {
    throw new Error(`Translation validation failed:\n${errors.join("\n")}`);
  }
}

export function extractPlaceholderTokens(value) {
  const tokens = [];

  function findClosingBrace(text, start) {
    let depth = 0;
    for (let index = start; index < text.length; index += 1) {
      if (text[index] === "{") {
        depth += 1;
      } else if (text[index] === "}") {
        depth -= 1;
        if (depth === 0) {
          return index;
        }
      }
    }
    throw new Error(`Unclosed ICU expression in catalog value: ${value}`);
  }

  function splitTopLevel(content) {
    const parts = [];
    let start = 0;
    let depth = 0;
    for (let index = 0; index < content.length; index += 1) {
      if (content[index] === "{") {
        depth += 1;
      } else if (content[index] === "}") {
        depth -= 1;
      } else if (content[index] === "," && depth === 0) {
        parts.push(content.slice(start, index).trim());
        start = index + 1;
      }
    }
    parts.push(content.slice(start).trim());
    return parts;
  }

  function scan(text) {
    for (let index = 0; index < text.length; index += 1) {
      if (text[index] !== "{") {
        continue;
      }
      const end = findClosingBrace(text, index);
      addExpression(text.slice(index + 1, end));
      index = end;
    }
  }

  function addExpression(content) {
    const parts = splitTopLevel(content);
    const name = parts[0];
    if (!name) {
      throw new Error(`Empty ICU expression in catalog value: ${value}`);
    }
    tokens.push(`placeholder:${name}`);

    if (parts.length < 2) {
      return;
    }

    const type = parts[1];
    tokens.push(`format:${type}`);
    if (!["plural", "select", "selectordinal"].includes(type)) {
      tokens.push(`format-style:${parts.slice(2).join(",")}`);
      scan(parts.slice(2).join(","));
      return;
    }

    const options = parts.slice(2).join(",");
    for (let index = 0; index < options.length; index += 1) {
      if (/\s/.test(options[index])) {
        continue;
      }
      const selectorStart = index;
      while (index < options.length && !/\s|\{/.test(options[index])) {
        index += 1;
      }
      const selector = options.slice(selectorStart, index);
      while (index < options.length && /\s/.test(options[index])) {
        index += 1;
      }
      if (options[index] !== "{") {
        throw new Error(`Malformed ICU option in catalog value: ${value}`);
      }
      const branchEnd = findClosingBrace(options, index);
      tokens.push(`selector:${selector}`);
      scan(options.slice(index + 1, branchEnd));
      index = branchEnd;
    }
  }

  tokens.push(...[...value.matchAll(/<\/?[A-Za-z][^>]*>/g)].map(([tag]) => `markup:${tag}`));
  scan(value);
  return tokens.sort();
}

function validateAgentTranslations(entries, translations) {
  const expected = new Map(
    entries.map((entry) => [`${entry.sourceFile}\u0000${entry.key}`, entry])
  );
  const seen = new Set();
  const result = [];

  for (const translation of translations) {
    if (!isRecord(translation)) {
      throw new Error("Translation agent returned a non-object item");
    }

    const { file, key, translation: value } = translation;
    const entry = expected.get(`${file}\u0000${key}`);
    if (!entry) {
      throw new Error(`Translation agent returned an unexpected key: ${file}:${key}`);
    }
    if (seen.has(`${file}\u0000${key}`)) {
      throw new Error(`Translation agent returned a duplicate key: ${file}:${key}`);
    }
    if (typeof value !== "string" || value.trim() === "") {
      throw new Error(`Translation agent returned an empty translation: ${file}:${key}`);
    }

    const sourceTokens = extractPlaceholderTokens(entry.source);
    const translationTokens = extractPlaceholderTokens(value);
    if (sourceTokens.join("\u0000") !== translationTokens.join("\u0000")) {
      throw new Error(`Translation agent changed placeholders: ${file}:${key}`);
    }

    seen.add(`${file}\u0000${key}`);
    result.push({ ...entry, value });
  }

  if (seen.size !== expected.size) {
    const missing = [...expected.keys()].filter((key) => !seen.has(key));
    throw new Error(`Translation agent omitted keys: ${missing.join(", ")}`);
  }

  return result;
}

function translationOutputSchema(entries) {
  return {
    type: "object",
    additionalProperties: false,
    properties: {
      translations: {
        type: "array",
        minItems: entries.length,
        maxItems: entries.length,
        items: {
          type: "object",
          additionalProperties: false,
          properties: {
            file: {
              type: "string",
              enum: [...new Set(entries.map((entry) => entry.sourceFile))],
            },
            key: {
              type: "string",
              enum: [...new Set(entries.map((entry) => entry.key))],
            },
            translation: { type: "string", minLength: 1 },
          },
          required: ["file", "key", "translation"],
        },
      },
    },
    required: ["translations"],
  };
}

function parseAgentEvent(line) {
  let event;
  try {
    event = JSON.parse(line);
  } catch {
    return undefined;
  }
  if (!isRecord(event)) {
    return undefined;
  }

  if (event.type === "session.failed" || event.type === "turn.failed") {
    throw new Error(`Translation agent failed: ${event.data?.message ?? "unknown error"}`);
  }
  if (event.type !== "result.completed") {
    return undefined;
  }

  const translations = event.data?.result?.translations;
  if (!Array.isArray(translations)) {
    throw new Error("Translation agent returned no structured translations");
  }
  return translations;
}

function parseAgentResult(body) {
  let completed;
  for (const line of body
    .split(/\r?\n/)
    .map((value) => value.trim())
    .filter(Boolean)) {
    const translations = parseAgentEvent(line);
    if (translations !== undefined) {
      completed = translations;
    }
  }
  if (completed === undefined) {
    throw new Error("Translation agent returned no structured translations");
  }
  return completed;
}

async function readAgentResult(stream) {
  if (!stream.body || typeof stream.body.getReader !== "function") {
    return parseAgentResult(await stream.text());
  }

  const reader = stream.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";

  try {
    while (true) {
      const { done, value } = await reader.read();
      buffer += decoder.decode(value, { stream: !done });

      let newlineIndex = buffer.indexOf("\n");
      while (newlineIndex !== -1) {
        const line = buffer.slice(0, newlineIndex).trim();
        buffer = buffer.slice(newlineIndex + 1);
        newlineIndex = buffer.indexOf("\n");
        if (!line) {
          continue;
        }

        const translations = parseAgentEvent(line);
        if (translations !== undefined) {
          await reader.cancel().catch(() => {});
          return translations;
        }
      }

      if (done) {
        const translations = parseAgentEvent(buffer.trim());
        if (translations !== undefined) {
          return translations;
        }
        break;
      }
    }
  } catch (error) {
    await reader.cancel().catch(() => {});
    throw error;
  } finally {
    reader.releaseLock();
  }

  throw new Error("Translation agent returned no structured translations");
}

async function requestTranslations({
  locale,
  entries,
  agentUrl,
  agentUsername,
  agentPassword,
  fetchImpl = fetch,
  maxRetries = 2,
}) {
  const endpoint = agentUrl.replace(/\/$/, "");
  const authorization = `Basic ${Buffer.from(`${agentUsername}:${agentPassword}`).toString("base64")}`;
  const body = {
    message: JSON.stringify({
      targetLocale: locale,
      translations: entries.map(({ sourceFile, key, source }) => ({
        file: sourceFile,
        key,
        source,
      })),
      outputShape: [{ file: "same file", key: "same key", translation: "translated value" }],
    }),
    outputSchema: translationOutputSchema(entries),
  };

  for (let attempt = 0; attempt <= maxRetries; attempt += 1) {
    try {
      const response = await fetchImpl(`${endpoint}/eve/v1/session`, {
        method: "POST",
        headers: {
          Authorization: authorization,
          "Content-Type": "application/json",
        },
        body: JSON.stringify(body),
      });

      if (!response.ok) {
        throw new Error(`Translation agent returned HTTP ${response.status}`);
      }

      const session = await response.json();
      if (typeof session?.sessionId !== "string") {
        throw new Error("Translation agent did not return a session id");
      }

      const stream = await fetchImpl(
        `${endpoint}/eve/v1/session/${encodeURIComponent(session.sessionId)}/stream`,
        {
          headers: {
            Accept: "application/x-ndjson",
            Authorization: authorization,
          },
        }
      );
      if (!stream.ok) {
        throw new Error(`Translation agent stream returned HTTP ${stream.status}`);
      }

      return validateAgentTranslations(entries, await readAgentResult(stream));
    } catch (error) {
      if (attempt >= maxRetries) {
        throw error;
      }
      await new Promise((resolve) => setTimeout(resolve, 250 * 2 ** attempt));
    }
  }

  throw new Error("Translation agent request failed");
}

export async function translateMissingEntries({
  missing,
  agentUrl,
  agentUsername,
  agentPassword,
  maxKeys = 500,
  batchSize = 50,
  maxRetries = 2,
  fetchImpl = fetch,
}) {
  if (missing.length === 0) {
    return { translations: [], batches: 0 };
  }
  if (!agentUrl) {
    throw new Error("TRANSLATION_AGENT_URL is required when translations are missing");
  }
  if (!agentUsername || !agentPassword) {
    throw new Error(
      "TRANSLATION_AGENT_USERNAME and TRANSLATION_AGENT_PASSWORD are required when translations are missing"
    );
  }
  if (!Number.isInteger(maxKeys) || maxKeys < 1) {
    throw new Error("Translation budget must be a positive integer");
  }
  if (!Number.isInteger(batchSize) || batchSize < 1) {
    throw new Error("Translation batch size must be a positive integer");
  }
  if (!Number.isInteger(maxRetries) || maxRetries < 0) {
    throw new Error("Translation retry count must be a non-negative integer");
  }
  if (missing.length > maxKeys) {
    throw new Error(
      `Translation budget exceeded: ${missing.length} keys requested, maximum is ${maxKeys}`
    );
  }

  const translations = [];
  let batches = 0;
  const byLocale = new Map();
  for (const entry of missing) {
    const entries = byLocale.get(entry.locale) ?? [];
    entries.push(entry);
    byLocale.set(entry.locale, entries);
  }

  for (const [locale, localeEntries] of byLocale) {
    for (let index = 0; index < localeEntries.length; index += batchSize) {
      const batch = localeEntries.slice(index, index + batchSize);
      translations.push(
        ...(await requestTranslations({
          locale,
          entries: batch,
          agentUrl,
          agentUsername,
          agentPassword,
          fetchImpl,
          maxRetries,
        }))
      );
      batches += 1;
    }
  }

  return { translations, batches };
}

export function applyTranslations({ messagesDir, translations }) {
  const byFile = new Map();
  for (const translation of translations) {
    const entries = byFile.get(translation.targetFile) ?? [];
    entries.push(translation);
    byFile.set(translation.targetFile, entries);
  }

  for (const [targetRelativePath, entries] of byFile) {
    const targetFile = path.join(messagesDir, targetRelativePath);
    const catalog = fs.existsSync(targetFile) ? readJson(targetFile) : {};
    for (const entry of entries) {
      setCatalogValue(catalog, entry.key, entry.value);
    }
    writeJson(targetFile, catalog);
  }
}

export function agentHost(agentUrl) {
  if (!agentUrl) {
    return "not configured";
  }
  try {
    return new URL(agentUrl).host;
  } catch {
    return "configured endpoint";
  }
}
