"use client";

import { type EnvField, parseList, type Values } from "@sdp/env-config";

export interface FieldRowProps {
  field: EnvField;
  value: string;
  values: Values;
  error?: string;
  onChange: (key: string, value: string) => void;
  onRegenerate: (key: string) => void;
}

export function FieldRow({ field, value, values, error, onChange, onRegenerate }: FieldRowProps) {
  const id = `sdp-cfg-${field.key}`;
  const errorId = error ? `${id}-error` : undefined;
  const helpId = field.help ? `${id}-help` : undefined;
  const describedBy = [helpId, errorId].filter(Boolean).join(" ") || undefined;

  // A field is auto-managed when `secretWhen` resolves true: the value is
  // generated for the operator (e.g. POSTGRES_PASSWORD in auto-mode), so the
  // input is display-only and is changed via Regenerate, not typing.
  const isAutoManaged = field.secretWhen?.(values) ?? false;
  const isSecret = field.kind === "secret" || isAutoManaged;
  const inputType = field.kind === "password" || field.kind === "secret" ? "password" : "text";
  const options = field.optionsWhen ? field.optionsWhen(values) : (field.options ?? []);
  const selected = field.kind === "multiselect" ? parseList(value) : [];

  return (
    <div className="sdp-cfg-field">
      {field.kind !== "multiselect" ? (
        <label className="sdp-cfg-label" htmlFor={id}>
          {field.label}
          {field.required ? (
            <span aria-hidden="true" className="sdp-cfg-required">
              {" *"}
            </span>
          ) : null}
        </label>
      ) : null}

      <div className="sdp-cfg-control">
        {field.kind === "multiselect" ? (
          <fieldset aria-describedby={describedBy} className="sdp-cfg-checks">
            <legend className="sdp-cfg-label">
              {field.label}
              {field.required ? (
                <span aria-hidden="true" className="sdp-cfg-required">
                  {" *"}
                </span>
              ) : null}
            </legend>
            {options.map((opt) => (
              <label className="sdp-cfg-check" key={opt.value}>
                <input
                  checked={selected.includes(opt.value)}
                  onChange={(e) => {
                    const next = e.target.checked
                      ? [...selected, opt.value]
                      : selected.filter((s) => s !== opt.value);
                    onChange(field.key, next.join(","));
                  }}
                  type="checkbox"
                />
                {opt.label}
              </label>
            ))}
          </fieldset>
        ) : field.kind === "select" ? (
          <select
            aria-describedby={describedBy}
            aria-invalid={error ? true : undefined}
            className="sdp-cfg-input"
            id={id}
            onChange={(e) => onChange(field.key, e.target.value)}
            value={value}
          >
            {options.map((opt) => (
              <option key={opt.value} value={opt.value}>
                {opt.label}
              </option>
            ))}
          </select>
        ) : (
          <input
            aria-describedby={describedBy}
            aria-invalid={error ? true : undefined}
            className="sdp-cfg-input"
            id={id}
            onChange={(e) => onChange(field.key, e.target.value)}
            placeholder={field.defaultValue}
            readOnly={isAutoManaged}
            type={inputType}
            value={value}
          />
        )}

        {isSecret ? (
          <button
            className="sdp-cfg-btn sdp-cfg-btn-secondary"
            onClick={() => onRegenerate(field.key)}
            type="button"
          >
            Regenerate
          </button>
        ) : null}
      </div>

      {field.help ? (
        <p className="sdp-cfg-help" id={helpId}>
          {field.help}
        </p>
      ) : null}

      {error ? (
        <p className="sdp-cfg-error" id={errorId} role="alert">
          {error}
        </p>
      ) : null}
    </div>
  );
}

export interface SectionBlockProps {
  title: string;
  advanced?: boolean;
  fields: EnvField[];
  values: Record<string, string>;
  errors: Record<string, string>;
  onChange: (key: string, value: string) => void;
  onRegenerate: (key: string) => void;
}

export function SectionBlock({
  title,
  advanced,
  fields,
  values,
  errors,
  onChange,
  onRegenerate,
}: SectionBlockProps) {
  if (fields.length === 0) return null;

  const rows = fields.map((field) => (
    <FieldRow
      error={errors[field.key]}
      field={field}
      key={field.key}
      onChange={onChange}
      onRegenerate={onRegenerate}
      value={values[field.key] ?? ""}
      values={values}
    />
  ));

  if (advanced) {
    return (
      <section className="sdp-cfg-section">
        <details className="sdp-cfg-details">
          <summary className="sdp-cfg-summary">{title}</summary>
          <div className="sdp-cfg-section-body">{rows}</div>
        </details>
      </section>
    );
  }

  return (
    <section className="sdp-cfg-section">
      <h3 className="sdp-cfg-section-title">{title}</h3>
      <div className="sdp-cfg-section-body">{rows}</div>
    </section>
  );
}
