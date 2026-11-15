// What the workspace shows: the interface and implementation that the person chose, and the intent
// and plan request that the form writes. `App` renders them.

import { useMemo, useState } from "react";

import type {
  Input,
  InterfaceDocument,
  ListedImplementation,
  ListedInterface,
  Registry,
  Wallet,
} from "@/api";
import {
  type FormValues,
  type IntentOptions,
  intentInputs,
  intentJson,
  type Output,
  planRequest,
} from "@/intent";
import { MINTS, VAULTS } from "@/known";
import { useInterfaceForm, useMatches } from "@/queries";

/// The interface that the person chose, or the first one that has a version.
export function useSelection(registry: Registry | undefined) {
  const [chosenInterface, setChosenInterface] = useState<string | null>(null);
  const [pinned, setPinned] = useState<string | null>(null);
  const [showUnapproved, setShowUnapproved] = useState(false);

  const selectedInterface =
    chosenInterface ??
    registry?.interfaces.find((listed) => listed.shown !== null)?.address ??
    null;
  const listed = registry?.interfaces.find((entry) => entry.address === selectedInterface) ?? null;

  const selectInterface = (address: string, implementation: string | null) => {
    setChosenInterface(address);
    setPinned(implementation);
  };
  const selectImplementation = (implementation: ListedImplementation) => {
    const interfaceAddress = registry?.interfaces.find(
      (entry) => entry.id === implementation.interface
    )?.address;
    if (interfaceAddress !== undefined) selectInterface(interfaceAddress, implementation.id);
    if (!implementation.approved) setShowUnapproved(true);
  };

  return {
    selectedInterface,
    listed,
    pinned,
    setPinned,
    showUnapproved,
    setShowUnapproved,
    selectInterface,
    selectImplementation,
  };
}

/// What the form of `listed` holds, the implementations that fit it, and the plan request.
export function useIntentRequest(
  listed: ListedInterface | null,
  wallets: Wallet[],
  pinned: string | null,
  showUnapproved: boolean,
  options: IntentOptions,
  output: Output
) {
  const [edits, setEdits] = useState<Record<string, FormValues>>({});
  const [chosenFeePayer, setChosenFeePayer] = useState<string | null>(null);
  const interfaceId = listed?.id ?? null;
  const document = useInterfaceForm(interfaceId, listed?.shown ?? null).data ?? null;

  // A builder cannot name its rent payer yet, so the treasury does not pay its own fees.
  const feePayer = chosenFeePayer ?? walletNamed(wallets, "alice");
  // A new interface's form starts from defaults that work, and keeps what the user changed in it.
  const values = useMemo(
    () =>
      document === null ? {} : { ...defaults(document, wallets), ...edits[interfaceId ?? ""] },
    [document, wallets, edits, interfaceId]
  );

  const matches = useMatches(
    interfaceId,
    listed?.shown ?? null,
    document === null
      ? null
      : { inputs: intentInputs(document, values), payers: { fee: feePayer }, all: showUnapproved }
  );
  const candidates = matches.data ?? null;
  const selected =
    candidates?.find((candidate) => candidate.id === pinned) ??
    candidates?.find((candidate) => candidate.status === "applies") ??
    null;

  const intent = useMemo(
    () =>
      listed === null || document === null
        ? {}
        : intentJson(listed, document, values, selected, {
            ...options,
            allowUnapproved: selected?.approved === false,
          }),
    [listed, document, values, selected, options]
  );
  const frozen = selected?.recipe === "remote transaction";
  const request = useMemo(
    () => planRequest(intent, feePayer, frozen ? "transaction" : output),
    [intent, feePayer, frozen, output]
  );

  const setValue = (name: string, value: string) =>
    setEdits((previous) => ({
      ...previous,
      [interfaceId ?? ""]: { ...previous[interfaceId ?? ""], [name]: value },
    }));

  return {
    document,
    values,
    setValue,
    feePayer,
    setFeePayer: setChosenFeePayer,
    matches,
    candidates,
    selected,
    intent,
    request,
  };
}

function walletNamed(wallets: Wallet[], name: string): string {
  return wallets.find((wallet) => wallet.name === name)?.address ?? wallets[0]?.address ?? "";
}

/// A first intent that works: the treasury sends one unit of USDC to bob, or deposits it in a vault.
function defaults(document: InterfaceDocument, wallets: Wallet[]): FormValues {
  const value = (input: Input): string => {
    if (input.optional) return "";
    if (input.type === "mint") return MINTS[1]?.address ?? "";
    if (input.type === "address" && input.name === "vault") return VAULTS[0]?.address ?? "";
    if (input.type === "address") return walletNamed(wallets, input.signer ? "treasury" : "bob");

    return "1";
  };

  return Object.fromEntries(document.inputs.map((input) => [input.name, value(input)]));
}
