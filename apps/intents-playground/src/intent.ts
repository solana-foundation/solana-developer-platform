// The intent form's state, and the intent and plan request that it writes (`DESIGN.md`, 4.1).

import type { InterfaceDocument, ListedInterface, Wallet } from "@/api";
import { MINTS, shortAddress, VAULTS } from "@/known";

/// What the person typed into each input, by input name. An amount is a decimal.
export type FormValues = Record<string, string>;

export interface IntentOptions {
  verifyIntent: boolean;
  assertions: boolean;
  allowUnapproved: boolean;
}

/// An amount as a decimal, which the service converts to the base units of its mint.
export interface DecimalAmount {
  decimal: string;
}

/// The inputs as an intent writes them. An amount is a decimal. A required input that is empty is
/// left out, so that the service names it.
export function intentInputs(
  document: InterfaceDocument,
  values: FormValues
): Record<string, string | DecimalAmount | null> {
  const entries = document.inputs.flatMap((input): [string, string | DecimalAmount | null][] => {
    const text = (values[input.name] ?? "").trim();

    if (text === "") {
      return input.optional ? [[input.name, null]] : [];
    }

    return [[input.name, input.amountMint === null ? text : { decimal: text }]];
  });

  return Object.fromEntries(entries);
}

/// `solana.org/token.transfer@^1` for version `1.2.0`.
export function caretRange(id: string, version: string): string {
  return `${id}@^${version.split(".")[0]}`;
}

export function intentJson(
  listed: ListedInterface,
  document: InterfaceDocument,
  values: FormValues,
  implementation: { id: string; version: string } | null,
  options: IntentOptions
) {
  const changed = Object.entries(options).filter(([name, value]) =>
    name === "allowUnapproved" ? value : !value
  );

  return {
    spec: "sdp-intents@1.0",
    kind: "intent",
    interface: caretRange(listed.id ?? "", listed.shown ?? "1.0.0"),
    implementation:
      implementation === null ? null : caretRange(implementation.id, implementation.version),
    inputs: intentInputs(document, values),
    ...(changed.length > 0 ? { options: Object.fromEntries(changed) } : {}),
  };
}

/// What `prepare` returns: a compiled transaction, or the instructions alone.
export type Output = "transaction" | "instructions";

/// A plan's intents leave out `spec` and `kind`, which the plan states once.
export function planRequest(intent: object, feePayer: string, output: Output) {
  const { spec: _spec, kind: _kind, ...planned } = intent as Record<string, unknown>;

  return {
    spec: "sdp-intents@1.0",
    kind: "plan",
    payers: { fee: feePayer },
    ...(output === "instructions" ? { options: { output } } : {}),
    intents: [planned],
  };
}

/// A template with each `{inputs.x}` as the form shows the value: a wallet's name, a mint's symbol,
/// or the text typed.
export function renderTemplate(template: string, values: FormValues, wallets: Wallet[]): string {
  // An output is known only once a plan exists, so the template names it in words: the escrow mint.
  const named = template.replace(
    /\{outputs\.(\w+)\}/g,
    (_, name: string) => `the ${name.replace(/([A-Z])/g, " $1").toLowerCase()}`
  );

  return named.replace(/\{inputs\.(\w+)\}/g, (reference, name: string) => {
    const value = values[name]?.trim();

    if (value === undefined || value === "") {
      return reference;
    }

    const known =
      wallets.find((wallet) => wallet.address === value)?.name ??
      MINTS.find((mint) => mint.address === value)?.symbol ??
      VAULTS.find((vault) => vault.address === value)?.name;

    return known ?? (value.length > 30 ? shortAddress(value) : value);
  });
}
