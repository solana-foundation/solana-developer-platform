export type SectionId =
  | "basic"
  | "database"
  | "cache"
  | "rpc"
  | "clerk"
  | "signing"
  | "fee"
  | "secrets"
  | "advanced";

export type FieldKind = "text" | "url" | "password" | "secret" | "select" | "multiselect";

export type Values = Record<string, string>;

export interface SelectOption {
  value: string;
  label: string;
}

export interface EnvField {
  key: string;
  section: SectionId;
  kind: FieldKind;
  label: string;
  help?: string;
  /** Default emitted when the field is untouched. */
  defaultValue?: string;
  /** Required for a bootable .env (drives validation + UI marker). */
  required?: boolean;
  /** Options for kind: "select". */
  options?: SelectOption[];
  /**
   * Dynamic options for "select"/"multiselect", computed from current values.
   * When present it overrides `options` for both rendering and validation.
   */
  optionsWhen?: (v: Values) => SelectOption[];
  /** Validation pattern source; tested in validate.ts. */
  pattern?: RegExp;
  /** Visibility predicate over current values; absent ⇒ always visible. */
  visibleWhen?: (v: Values) => boolean;
  /**
   * When this predicate holds, `autoSecretKeys(values)` includes this field's key
   * so callers can fill it with a generated secret; otherwise it is treated as a
   * normal required input. Lets one field switch between generated and manual entry.
   */
  secretWhen?: (v: Values) => boolean;
  /** Encoding for an auto-generated secret; defaults to "hex". */
  secretEncoding?: "hex" | "base64";
  /** Computed from other values; hidden from the form, always emitted. */
  derive?: (values: Values) => string;
  /**
   * Emit this field even when `visibleWhen` hides it, for a setting the runtime
   * needs regardless of the choice that hides it from the form. Unlike `derive`,
   * the value still comes from input or an auto-generated secret.
   */
  alwaysEmit?: boolean;
}

export interface SectionMeta {
  id: SectionId;
  title: string;
  comment: string; // emitted as a `# ...` header in the .env
  advanced?: boolean; // collapsed by default in the UI
}
