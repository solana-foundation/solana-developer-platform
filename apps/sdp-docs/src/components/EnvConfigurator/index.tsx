"use client";

import {
  autoSecretKeys,
  defaultValues,
  FIELDS,
  generateEnv,
  generateLocalSignerKeypair,
  generateSecret,
  isFieldVisible,
  parseList,
  SECTIONS,
  type SectionId,
  type Values,
  validateValues,
} from "@sdp/env-config";
import { useCallback, useEffect, useMemo, useState } from "react";
import { SectionBlock } from "./FieldRenderer";

type StepId = "start" | "runtime" | "auth" | "signing" | "review";

interface ConfigStep {
  id: StepId;
  label: string;
  title: string;
  description: string;
  sections: SectionId[];
}

const CONFIG_STEPS: ConfigStep[] = [
  {
    id: "start",
    label: "Start",
    title: "Before you start",
    description: "Gather the few pieces a devnet self-hosted stack needs before you download .env.",
    sections: [],
  },
  {
    id: "runtime",
    label: "Runtime",
    title: "Runtime defaults",
    description: "Keep bundled Postgres and Redis for the first run, then point SDP at devnet.",
    sections: ["basic", "database", "cache", "rpc", "advanced"],
  },
  {
    id: "auth",
    label: "Auth",
    title: "Clerk authentication",
    description: "Connect your Clerk development app so the dashboard can create users and orgs.",
    sections: ["clerk"],
  },
  {
    id: "signing",
    label: "Signing",
    title: "Local devnet signing",
    description: "Generate a local signer for devnet and keep native fee payment enabled.",
    sections: ["signing", "fee", "secrets"],
  },
  {
    id: "review",
    label: "Review",
    title: "Review and download",
    description: "Copy or download the finished .env, then start the compose stack.",
    sections: [],
  },
];

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
  --cfg-success: #1f7a4d;
  color: var(--cfg-text);
  font-family: var(--font-sans, system-ui, -apple-system, "Segoe UI", sans-serif);
  font-size: 14px;
  line-height: 1.5;
}
.sdp-cfg * {
  box-sizing: border-box;
}
.sdp-cfg-shell {
  display: grid;
  grid-template-columns: 1fr;
  gap: 20px;
  align-items: start;
}
@media (min-width: 900px) {
  .sdp-cfg-shell {
    grid-template-columns: 220px minmax(0, 1fr);
  }
}
.sdp-cfg-steps {
  display: grid;
  gap: 8px;
  position: sticky;
  top: 16px;
}
@media (max-width: 899px) {
  .sdp-cfg-steps {
    position: static;
    grid-template-columns: repeat(5, minmax(0, 1fr));
    overflow-x: auto;
  }
}
.sdp-cfg-step {
  display: grid;
  grid-template-columns: auto minmax(0, 1fr) auto;
  gap: 10px;
  align-items: center;
  width: 100%;
  padding: 10px;
  border: 1px solid var(--cfg-border);
  border-radius: 8px;
  background: var(--cfg-bg);
  color: var(--cfg-text);
  font: inherit;
  text-align: left;
  cursor: pointer;
}
.sdp-cfg-step[aria-current="step"] {
  border-color: var(--cfg-ink);
  color: var(--cfg-ink);
}
.sdp-cfg-step-index {
  display: grid;
  place-items: center;
  width: 24px;
  height: 24px;
  border-radius: 999px;
  background: var(--cfg-surface);
  color: var(--cfg-ink);
  font-size: 12px;
  font-weight: 700;
}
.sdp-cfg-step[aria-current="step"] .sdp-cfg-step-index {
  background: var(--cfg-ink);
  color: var(--cfg-bg);
}
.sdp-cfg-step-label {
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  font-size: 13px;
  font-weight: 700;
}
.sdp-cfg-step-errors {
  color: var(--cfg-danger);
  font-size: 12px;
  font-weight: 700;
}
.sdp-cfg-panel {
  min-width: 0;
  border: 1px solid var(--cfg-border);
  border-radius: 10px;
  background: var(--cfg-bg);
  padding: 20px;
}
.sdp-cfg-panel-head {
  display: flex;
  flex-wrap: wrap;
  gap: 10px 16px;
  align-items: flex-start;
  justify-content: space-between;
  margin-bottom: 20px;
}
.sdp-cfg-kicker {
  margin: 0 0 4px;
  color: var(--cfg-muted);
  font-size: 12px;
  font-weight: 700;
  text-transform: uppercase;
}
.sdp-cfg-panel-title {
  margin: 0;
  color: var(--cfg-ink);
  font-family: var(--font-abc-diatype, var(--font-sans, inherit));
  font-size: 22px;
  line-height: 1.2;
}
.sdp-cfg-panel-description {
  max-width: 680px;
  margin: 6px 0 0;
  color: var(--cfg-text);
}
.sdp-cfg-progress {
  color: var(--cfg-muted);
  font-size: 13px;
  font-weight: 700;
}
.sdp-cfg-form {
  display: flex;
  flex-direction: column;
  gap: 18px;
  min-width: 0;
}
.sdp-cfg-section {
  border: 1px solid var(--cfg-border);
  border-radius: 8px;
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
@media (max-width: 560px) {
  .sdp-cfg-control {
    flex-direction: column;
  }
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
.sdp-cfg-actions {
  display: flex;
  flex-wrap: wrap;
  gap: 10px;
  align-items: center;
  justify-content: space-between;
  margin-top: 22px;
  padding-top: 18px;
  border-top: 1px solid var(--cfg-border);
}
.sdp-cfg-actions-group {
  display: flex;
  flex-wrap: wrap;
  gap: 10px;
  align-items: center;
}
.sdp-cfg-box {
  border: 1px solid var(--cfg-border);
  border-radius: 8px;
  background: var(--cfg-surface);
  padding: 14px 16px;
}
.sdp-cfg-box h3,
.sdp-cfg-box h4 {
  margin: 0 0 8px;
  color: var(--cfg-ink);
  font-size: 15px;
}
.sdp-cfg-box p {
  margin: 0;
}
.sdp-cfg-box p + p,
.sdp-cfg-box ul + p {
  margin-top: 10px;
}
.sdp-cfg-box ul {
  margin: 0;
  padding-left: 18px;
}
.sdp-cfg-box li + li {
  margin-top: 6px;
}
.sdp-cfg-status {
  display: flex;
  flex-wrap: wrap;
  gap: 10px;
  align-items: center;
  justify-content: space-between;
}
.sdp-cfg-code {
  overflow-wrap: anywhere;
  font-family: var(--font-berkeley-mono, ui-monospace, SFMono-Regular, Menlo, monospace);
  font-size: 12px;
}
.sdp-cfg-note {
  margin: 0;
  font-size: 12px;
  color: var(--cfg-danger);
}
.sdp-cfg-ok {
  margin: 0;
  font-size: 12px;
  font-weight: 700;
  color: var(--cfg-success);
}
.sdp-cfg-hint {
  margin: 0;
  font-size: 12px;
  color: var(--cfg-muted);
}
.sdp-cfg-hint code,
.sdp-cfg-box code {
  padding: 1px 5px;
  border-radius: 4px;
  background: var(--cfg-bg);
  border: 1px solid var(--cfg-border);
  font-family: var(--font-berkeley-mono, ui-monospace, SFMono-Regular, Menlo, monospace);
  font-size: 11.5px;
}
.sdp-cfg-pre {
  margin: 12px 0 0;
  max-height: 58vh;
  overflow: auto;
  padding: 14px 16px;
  border: 1px solid var(--cfg-border);
  border-radius: 8px;
  background: var(--cfg-surface);
  color: var(--cfg-ink);
  font-family: var(--font-berkeley-mono, ui-monospace, SFMono-Regular, Menlo, monospace);
  font-size: 12.5px;
  line-height: 1.6;
  white-space: pre;
  tab-size: 2;
}
`;

export function EnvConfigurator() {
  const [values, setValues] = useState<Values>(initialValues);
  const [copied, setCopied] = useState(false);
  const [activeStepId, setActiveStepId] = useState<StepId>("start");
  const [localSignerPublicKey, setLocalSignerPublicKey] = useState("");
  const [localSignerError, setLocalSignerError] = useState("");
  const [localSignerGenerating, setLocalSignerGenerating] = useState(false);
  const [localSignerAttempted, setLocalSignerAttempted] = useState(false);

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
  const activeStepIndex = CONFIG_STEPS.findIndex((step) => step.id === activeStepId);
  const activeStep = CONFIG_STEPS[activeStepIndex] ?? CONFIG_STEPS[0];
  const localSigningSelected = parseList(values.SIGNING_PROVIDERS).includes("local");

  const generateLocalSigner = useCallback(async () => {
    setLocalSignerAttempted(true);
    setLocalSignerGenerating(true);
    setLocalSignerError("");
    try {
      const keypair = await generateLocalSignerKeypair();
      setLocalSignerPublicKey(keypair.publicKey);
      setValues((prev) => ({ ...prev, CUSTODY_PRIVATE_KEY: keypair.privateKey }));
    } catch {
      setLocalSignerError(
        "This browser could not generate an Ed25519 keypair. Paste a base58 devnet key instead."
      );
    } finally {
      setLocalSignerGenerating(false);
    }
  }, []);

  useEffect(() => {
    if (localSigningSelected && !values.CUSTODY_PRIVATE_KEY && !localSignerAttempted) {
      void generateLocalSigner();
    }
  }, [localSigningSelected, values.CUSTODY_PRIVATE_KEY, localSignerAttempted, generateLocalSigner]);

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

    if (key === "CUSTODY_PRIVATE_KEY") {
      setLocalSignerPublicKey("");
      setLocalSignerError("");
    }
  }

  function regenerate(key: string) {
    if (key === "CUSTODY_PRIVATE_KEY") {
      void generateLocalSigner();
      return;
    }
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

  function errorCountForStep(step: ConfigStep): number {
    if (step.id === "review") return Object.keys(errors).length;
    if (step.sections.length === 0) return 0;
    const visibleKeys = new Set(
      FIELDS.filter(
        (field) =>
          step.sections.includes(field.section) &&
          !field.derive &&
          (isFieldVisible(field, values) || field.alwaysEmit)
      ).map((field) => field.key)
    );
    return Object.keys(errors).filter((key) => visibleKeys.has(key)).length;
  }

  function renderFieldSections(step: ConfigStep) {
    return step.sections.map((sectionId) => {
      const section = SECTIONS.find((item) => item.id === sectionId);
      if (!section) return null;
      const fields = FIELDS.filter(
        (field) => field.section === section.id && !field.derive && isFieldVisible(field, values)
      );
      if (fields.length === 0) return null;
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
    });
  }

  function goPrevious() {
    setActiveStepId(CONFIG_STEPS[Math.max(0, activeStepIndex - 1)].id);
  }

  function goNext() {
    setActiveStepId(CONFIG_STEPS[Math.min(CONFIG_STEPS.length - 1, activeStepIndex + 1)].id);
  }

  return (
    <div className="sdp-cfg">
      {/* biome-ignore lint/security/noDangerouslySetInnerHtml: static, component-scoped stylesheet with no user input */}
      <style dangerouslySetInnerHTML={{ __html: STYLES }} />

      <div className="sdp-cfg-shell">
        <nav aria-label="Configurator steps" className="sdp-cfg-steps">
          {CONFIG_STEPS.map((step, index) => {
            const stepErrors = errorCountForStep(step);
            return (
              <button
                aria-current={step.id === activeStepId ? "step" : undefined}
                className="sdp-cfg-step"
                key={step.id}
                onClick={() => setActiveStepId(step.id)}
                type="button"
              >
                <span className="sdp-cfg-step-index">{index + 1}</span>
                <span className="sdp-cfg-step-label">{step.label}</span>
                {stepErrors > 0 ? <span className="sdp-cfg-step-errors">{stepErrors}</span> : null}
              </button>
            );
          })}
        </nav>

        <section className="sdp-cfg-panel">
          <div className="sdp-cfg-panel-head">
            <div>
              <p className="sdp-cfg-kicker">Step {activeStepIndex + 1}</p>
              <h3 className="sdp-cfg-panel-title">{activeStep.title}</h3>
              <p className="sdp-cfg-panel-description">{activeStep.description}</p>
            </div>
            <span className="sdp-cfg-progress">
              {activeStepIndex + 1} / {CONFIG_STEPS.length}
            </span>
          </div>

          {activeStep.id === "start" ? (
            <div className="sdp-cfg-form">
              <div className="sdp-cfg-box">
                <h3>Bring these with you</h3>
                <ul>
                  <li>Docker Engine and Docker Compose v2 on the host.</li>
                  <li>
                    A Clerk development app with API keys and a JWT template named{" "}
                    <code>sdp-api</code>.
                  </li>
                  <li>
                    A devnet RPC endpoint. A dedicated RPC key is more reliable than the public
                    endpoint.
                  </li>
                  <li>
                    The release assets installed into <code>~/sdp</code> with{" "}
                    <code>compose.yml</code> present.
                  </li>
                </ul>
              </div>
              <div className="sdp-cfg-box">
                <h3>Devnet default</h3>
                <p>
                  This wizard starts with bundled Postgres, bundled Redis, local signing, native fee
                  payment, and localhost service URLs. That path is meant for the first self-hosted
                  devnet deployment.
                </p>
              </div>
            </div>
          ) : null}

          {activeStep.id === "signing" && localSigningSelected ? (
            <div className="sdp-cfg-form">
              <div className="sdp-cfg-box sdp-cfg-status">
                <div>
                  <h4>Generated local signer</h4>
                  {localSignerPublicKey ? (
                    <p>
                      Fund this devnet address for transaction fees:{" "}
                      <span className="sdp-cfg-code">{localSignerPublicKey}</span>
                    </p>
                  ) : (
                    <p>
                      {localSignerGenerating
                        ? "Generating a local Ed25519 signer in this browser."
                        : "Paste a base58 keypair or regenerate one here."}
                    </p>
                  )}
                  {localSignerError ? <p className="sdp-cfg-note">{localSignerError}</p> : null}
                </div>
                <button
                  className="sdp-cfg-btn"
                  disabled={localSignerGenerating}
                  onClick={() => void generateLocalSigner()}
                  type="button"
                >
                  {localSignerGenerating ? "Generating" : "Regenerate signer"}
                </button>
              </div>
              {renderFieldSections(activeStep)}
            </div>
          ) : null}

          {activeStep.id !== "start" &&
          activeStep.id !== "review" &&
          activeStep.id !== "signing" ? (
            <div className="sdp-cfg-form">{renderFieldSections(activeStep)}</div>
          ) : null}

          {activeStep.id === "signing" && !localSigningSelected ? (
            <div className="sdp-cfg-form">{renderFieldSections(activeStep)}</div>
          ) : null}

          {activeStep.id === "review" ? (
            <div className="sdp-cfg-form">
              <div className="sdp-cfg-box">
                <h3>{hasErrors ? "Resolve required fields" : "Ready to run"}</h3>
                {hasErrors ? (
                  <ul>
                    {Object.entries(errors).map(([key, message]) => (
                      <li key={key}>
                        <span className="sdp-cfg-code">{key}</span>: {message}
                      </li>
                    ))}
                  </ul>
                ) : (
                  <p className="sdp-cfg-ok">
                    Save this file as <code>.env</code> next to <code>compose.yml</code>.
                  </p>
                )}
              </div>
              <div className="sdp-cfg-box">
                <h3>Next commands</h3>
                <pre className="sdp-cfg-pre">{`cd ~/sdp
docker compose up -d
docker compose ps
curl http://localhost:8787/health`}</pre>
              </div>
              <div className="sdp-cfg-box">
                <div className="sdp-cfg-status">
                  <h3>.env preview</h3>
                  <div className="sdp-cfg-actions-group">
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
                </div>
                {hasErrors ? (
                  <p className="sdp-cfg-note">Fill required fields before downloading.</p>
                ) : null}
                <p className="sdp-cfg-hint">
                  Some browsers drop the leading dot — rename the downloaded file to{" "}
                  <code>.env</code> if needed.
                </p>
                <pre className="sdp-cfg-pre">{env}</pre>
              </div>
            </div>
          ) : null}

          <div className="sdp-cfg-actions">
            <button
              className="sdp-cfg-btn"
              disabled={activeStepIndex === 0}
              onClick={goPrevious}
              type="button"
            >
              Back
            </button>
            <div className="sdp-cfg-actions-group">
              {activeStep.id !== "review" ? (
                <button className="sdp-cfg-btn sdp-cfg-btn-primary" onClick={goNext} type="button">
                  Continue
                </button>
              ) : (
                <button
                  className="sdp-cfg-btn sdp-cfg-btn-primary"
                  disabled={hasErrors}
                  onClick={downloadEnv}
                  type="button"
                >
                  Download .env
                </button>
              )}
            </div>
          </div>
        </section>
      </div>
    </div>
  );
}

export default EnvConfigurator;

// Re-export field renderers for consumers / tests.
export { FieldRow, SectionBlock } from "./FieldRenderer";
