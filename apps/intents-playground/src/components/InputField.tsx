import { useState } from "react";

import type { Input, Wallet } from "@/api";
import { amountDecimals, type FormValues } from "@/intent";
import { MINTS, VAULTS } from "@/known";

interface Props {
  input: Input;
  values: FormValues;
  wallets: Wallet[];
  onChange: (name: string, value: string) => void;
}

interface Choice {
  label: string;
  value: string;
}

/// The choices that an input offers: wallets for an address, known vaults for a vault, and symbols
/// for a mint. Any other value is typed.
function choices(input: Input, wallets: Wallet[]): Choice[] {
  if (input.type === "mint") {
    return MINTS.map((mint) => ({ label: mint.symbol, value: mint.address }));
  }

  if (input.type !== "address") {
    return [];
  }

  const known = input.name === "vault" ? VAULTS : wallets;

  return known.map((entry) => ({ label: entry.name, value: entry.address }));
}

export function InputField({ input, values, wallets, onChange }: Props) {
  const value = values[input.name] ?? "";
  const offered = choices(input, wallets);
  const typed = value !== "" && !offered.some((choice) => choice.value === value);
  const [custom, setCustom] = useState(typed);
  const showText = custom || typed;
  const decimals = input.amountMint === null ? null : amountDecimals(input, values);
  const unit =
    input.amountMint === null ? null : decimals === null ? "base units" : "decimal units";

  return (
    <div className="f-col">
      <label className="input-lbl" htmlFor={`input-${input.name}`}>
        {input.name}
        <span className="field-tags">
          {input.signer && <span className="type-pill">signer</span>}
          {input.optional && <span className="type-pill">optional</span>}
          <span className="type-pill">{input.type}</span>
        </span>
      </label>

      {offered.length > 0 ? (
        <div className="f-row">
          <select
            id={`input-${input.name}`}
            className="select"
            value={showText ? "other" : value}
            onChange={(event) => {
              const other = event.target.value === "other";
              setCustom(other);
              onChange(input.name, other ? "" : event.target.value);
            }}
          >
            {input.optional && <option value="">None</option>}
            {offered.map((choice) => (
              <option key={choice.value} value={choice.value}>
                {choice.label}
              </option>
            ))}
            <option value="other">Other address</option>
          </select>
          {showText && (
            <input
              className="input"
              value={value}
              placeholder="Base58 address"
              onChange={(event) => onChange(input.name, event.target.value)}
            />
          )}
        </div>
      ) : (
        <input
          id={`input-${input.name}`}
          className="input"
          value={value}
          placeholder={input.optional ? "Optional" : ""}
          onChange={(event) => onChange(input.name, event.target.value)}
        />
      )}

      {unit !== null && <div className="input-hint">In {unit}.</div>}
    </div>
  );
}
