"use client";

import {
  autoSecretKeys,
  defaultValues,
  FIELDS,
  generateEnv,
  generateSecret,
  isFieldVisible,
  parseList,
  SECTIONS,
  type Values,
  validateValues,
} from "@sdp/env-config";
import { useEffect, useMemo, useState } from "react";
import { FieldRow, SectionBlock } from "./FieldRenderer";

/**
 * Seed defaults only. Secrets are filled on the client after mount (see useEffect)
 * so they match the server-rendered HTML during hydration and are never baked into
 * the statically prerendered page — each visitor gets their own unique values.
 */
function initialValues(): Values {
  return defaultValues();
}

const STYLES = `
.sdp-cfg {
  --cfg-ink: var(--launch-ink, #1a1a1a);
  --cfg-text: var(--launch-text, #44413c);
  --cfg-muted: var(--launch-muted, #8a857d);
  --cfg-border: var(--launch-border, #e4dfd6);
  --cfg-border-strong: var(--launch-border-strong, #cfc8bb);
  --cfg-bg: var(--launch-white, #ffffff);
  --cfg-surface: var(--launch-bg, #faf8f4);
  --cfg-accent: var(--launch-ink, #1a1a1a);
  --cfg-danger: #c0392b;
  color: var(--cfg-text);
  font-family: var(--font-sans, system-ui, -apple-system, "Segoe UI", sans-serif);
  font-size: 14px;
  line-height: 1.5;
}
.sdp-cfg * {
  box-sizing: border-box;
}
.sdp-cfg-layout {
  display: grid;
  grid-template-columns: 1fr;
  gap: 28px;
  align-items: start;
}
@media (min-width: 900px) {
  .sdp-cfg-layout {
    grid-template-columns: minmax(0, 1fr) minmax(0, 1fr);
  }
}
.sdp-cfg-form {
  display: flex;
  flex-direction: column;
  gap: 24px;
  min-width: 0;
}
.sdp-cfg-section {
  border: 1px solid var(--cfg-border);
  border-radius: 10px;
  background: var(--cfg-bg);
  padding: 16px 18px;
}
.sdp-cfg-section-title {
  margin: 0 0 14px;
  font-size: 15px;
  font-weight: 700;
  color: var(--cfg-ink);
  font-family: var(--font-abc-diatype, var(--font-sans, inherit));
}
.sdp-cfg-section-body {
  display: flex;
  flex-direction: column;
  gap: 16px;
}
.sdp-cfg-details > .sdp-cfg-section-body {
  margin-top: 14px;
}
.sdp-cfg-summary {
  cursor: pointer;
  font-size: 15px;
  font-weight: 700;
  color: var(--cfg-ink);
  font-family: var(--font-abc-diatype, var(--font-sans, inherit));
  list-style: revert;
}
.sdp-cfg-field {
  display: flex;
  flex-direction: column;
  gap: 6px;
}
.sdp-cfg-label {
  font-size: 13px;
  font-weight: 600;
  color: var(--cfg-ink);
}
.sdp-cfg-required {
  color: var(--cfg-danger);
}
.sdp-cfg-control {
  display: flex;
  gap: 8px;
  align-items: stretch;
}
.sdp-cfg-checks {
  flex: 1 1 auto;
  display: flex;
  flex-wrap: wrap;
  gap: 8px 16px;
  margin: 0;
  padding: 0;
  border: 0;
  min-width: 0;
}
.sdp-cfg-checks legend {
  padding: 0;
  margin-bottom: 6px;
}
.sdp-cfg-check {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  font-size: 14px;
  color: var(--cfg-ink);
}
.sdp-cfg-check input {
  accent-color: var(--cfg-accent);
}
.sdp-cfg-input {
  flex: 1 1 auto;
  min-width: 0;
  width: 100%;
  padding: 8px 10px;
  border: 1px solid var(--cfg-border-strong);
  border-radius: 8px;
  background: var(--cfg-bg);
  color: var(--cfg-ink);
  font-size: 14px;
  font-family: inherit;
}
.sdp-cfg-input:focus {
  outline: 2px solid var(--cfg-accent);
  outline-offset: 1px;
}
.sdp-cfg-input[aria-invalid="true"] {
  border-color: var(--cfg-danger);
}
.sdp-cfg-help {
  margin: 0;
  font-size: 12px;
  color: var(--cfg-muted);
}
.sdp-cfg-error {
  margin: 0;
  font-size: 12px;
  font-weight: 600;
  color: var(--cfg-danger);
}
.sdp-cfg-btn {
  flex: 0 0 auto;
  padding: 8px 14px;
  border-radius: 8px;
  border: 1px solid var(--cfg-border-strong);
  background: var(--cfg-bg);
  color: var(--cfg-ink);
  font-size: 13px;
  font-weight: 600;
  font-family: inherit;
  cursor: pointer;
}
.sdp-cfg-btn:hover:not(:disabled) {
  border-color: var(--cfg-ink);
}
.sdp-cfg-btn:disabled {
  opacity: 0.5;
  cursor: not-allowed;
}
.sdp-cfg-btn-primary {
  background: var(--cfg-ink);
  color: var(--cfg-bg);
  border-color: var(--cfg-ink);
}
.sdp-cfg-preview {
  position: sticky;
  top: 16px;
  display: flex;
  flex-direction: column;
  gap: 12px;
  min-width: 0;
}
.sdp-cfg-preview-head {
  display: flex;
  flex-wrap: wrap;
  gap: 8px;
  align-items: center;
}
.sdp-cfg-preview-title {
  margin: 0;
  margin-right: auto;
  font-size: 15px;
  font-weight: 700;
  color: var(--cfg-ink);
  font-family: var(--font-abc-diatype, var(--font-sans, inherit));
}
.sdp-cfg-pre {
  margin: 0;
  max-height: 70vh;
  overflow: auto;
  padding: 14px 16px;
  border: 1px solid var(--cfg-border);
  border-radius: 10px;
  background: var(--cfg-surface);
  color: var(--cfg-ink);
  font-family: var(--font-berkeley-mono, ui-monospace, SFMono-Regular, Menlo, monospace);
  font-size: 12.5px;
  line-height: 1.6;
  white-space: pre;
  tab-size: 2;
}
.sdp-cfg-note {
  margin: 0;
  font-size: 12px;
  color: var(--cfg-danger);
}
.sdp-cfg-hint {
  margin: 0;
  font-size: 12px;
  color: var(--cfg-muted);
}
.sdp-cfg-hint code {
  padding: 1px 5px;
  border-radius: 4px;
  background: var(--cfg-surface);
  border: 1px solid var(--cfg-border);
  font-family: var(--font-berkeley-mono, ui-monospace, SFMono-Regular, Menlo, monospace);
  font-size: 11.5px;
}
`;

export function EnvConfigurator() {
  const [values, setValues] = useState<Values>(initialValues);
  const [copied, setCopied] = useState(false);

  // Generate secrets in the browser after mount: keeps them out of the prerendered
  // HTML (unique per visitor) and avoids a hydration mismatch on the secret inputs.
  useEffect(() => {
    setValues((prev) => {
      const next = { ...prev };
      for (const key of autoSecretKeys(prev)) {
        next[key] = generateSecret(key);
      }
      return next;
    });
  }, []);

  const errors = useMemo(() => validateValues(values), [values]);
  const env = useMemo(() => generateEnv(values), [values]);
  const hasErrors = Object.keys(errors).length > 0;

  // Any edit invalidates a prior "Copied" confirmation.
  // biome-ignore lint/correctness/useExhaustiveDependencies: reset is keyed on env changing
  useEffect(() => setCopied(false), [env]);

  function setValue(key: string, value: string) {
    setValues((prev) => {
      const next = { ...prev, [key]: value };
      // Switching the Postgres password mode resets the value: manual clears it
      // for typed entry; auto fills a fresh generated secret.
      if (key === "POSTGRES_PASSWORD_MODE") {
        next.POSTGRES_PASSWORD = value === "manual" ? "" : generateSecret("POSTGRES_PASSWORD");
      }
      // An external database hides the bundled-Postgres password fields, but
      // compose still requires POSTGRES_PASSWORD. Ensure one exists so the .env
      // stays bootable even if manual mode had cleared it before the switch.
      if (key === "DATABASE_MODE" && value !== "bundled" && !next.POSTGRES_PASSWORD) {
        next.POSTGRES_PASSWORD = generateSecret("POSTGRES_PASSWORD");
      }
      // Keep the default provider valid: if it drops out of the selected set,
      // fall back to the first selected provider.
      if (key === "SIGNING_PROVIDERS") {
        const selected = parseList(value);
        if (!selected.includes(next.SIGNING_PROVIDER)) {
          next.SIGNING_PROVIDER = selected[0] ?? "";
        }
      }
      return next;
    });
  }

  function regenerate(key: string) {
    setValues((prev) => ({ ...prev, [key]: generateSecret(key) }));
  }

  function downloadEnv() {
    const blob = new Blob([env], { type: "application/octet-stream" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = ".env";
    document.body.appendChild(a);
    a.click();
    a.remove();
    URL.revokeObjectURL(url);
  }

  function copyEnv() {
    navigator.clipboard
      ?.writeText(env)
      .then(() => setCopied(true))
      .catch(() => setCopied(false));
  }

  return (
    <div className="sdp-cfg">
      {/* biome-ignore lint/security/noDangerouslySetInnerHtml: static, component-scoped stylesheet with no user input */}
      <style dangerouslySetInnerHTML={{ __html: STYLES }} />

      <div className="sdp-cfg-layout">
        <div className="sdp-cfg-form">
          {SECTIONS.map((section) => {
            const fields = FIELDS.filter(
              (f) => f.section === section.id && !f.derive && isFieldVisible(f, values)
            );
            return (
              <SectionBlock
                advanced={section.advanced}
                errors={errors}
                fields={fields}
                key={section.id}
                onChange={setValue}
                onRegenerate={regenerate}
                title={section.title}
                values={values}
              />
            );
          })}
        </div>

        <div className="sdp-cfg-preview">
          <div className="sdp-cfg-preview-head">
            <h3 className="sdp-cfg-preview-title">.env preview</h3>
            <button
              className="sdp-cfg-btn sdp-cfg-btn-primary"
              disabled={hasErrors}
              onClick={downloadEnv}
              type="button"
            >
              Download .env
            </button>
            <button className="sdp-cfg-btn" onClick={copyEnv} type="button">
              {copied ? "Copied" : "Copy"}
            </button>
          </div>
          {hasErrors ? (
            <p className="sdp-cfg-note">Fill required fields before downloading.</p>
          ) : null}
          <p className="sdp-cfg-hint">
            Save it as <code>.env</code> next to your <code>compose.yml</code>. Some browsers drop
            the leading dot — rename the downloaded file to <code>.env</code> if needed.
          </p>
          <pre className="sdp-cfg-pre">{env}</pre>
        </div>
      </div>
    </div>
  );
}

export default EnvConfigurator;

// Re-export field renderers for consumers / tests.
export { FieldRow, SectionBlock };
