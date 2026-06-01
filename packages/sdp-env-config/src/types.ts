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

export type FieldKind = "text" | "url" | "password" | "secret" | "select";

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
  /** Validation pattern source; tested in validate.ts. */
  pattern?: RegExp;
  /** Visibility predicate over current values; absent ⇒ always visible. */
  visibleWhen?: (v: Values) => boolean;
  /** Computed from other values; hidden from the form, always emitted. */
  derive?: (values: Values) => string;
}

export interface SectionMeta {
  id: SectionId;
  title: string;
  comment: string; // emitted as a `# ...` header in the .env
  advanced?: boolean; // collapsed by default in the UI
}
