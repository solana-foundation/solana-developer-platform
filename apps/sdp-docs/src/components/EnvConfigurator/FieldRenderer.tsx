"use client";

import type { EnvField } from "@sdp/env-config";

export interface FieldRowProps {
  field: EnvField;
  value: string;
  error?: string;
  onChange: (key: string, value: string) => void;
  onRegenerate: (key: string) => void;
}

export function FieldRow({ field, value, error, onChange, onRegenerate }: FieldRowProps) {
  const id = `sdp-cfg-${field.key}`;
  const errorId = error ? `${id}-error` : undefined;
  const helpId = field.help ? `${id}-help` : undefined;
  const describedBy = [helpId, errorId].filter(Boolean).join(" ") || undefined;

  const isSecret = field.kind === "secret";
  const inputType = field.kind === "password" || field.kind === "secret" ? "password" : "text";

  return (
    <div className="sdp-cfg-field">
      <label className="sdp-cfg-label" htmlFor={id}>
        {field.label}
        {field.required ? (
          <span aria-hidden="true" className="sdp-cfg-required">
            {" *"}
          </span>
        ) : null}
      </label>

      <div className="sdp-cfg-control">
        {field.kind === "select" ? (
          <select
            aria-describedby={describedBy}
            aria-invalid={error ? true : undefined}
            className="sdp-cfg-input"
            id={id}
            onChange={(e) => onChange(field.key, e.target.value)}
            value={value}
          >
            {field.options?.map((opt) => (
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
