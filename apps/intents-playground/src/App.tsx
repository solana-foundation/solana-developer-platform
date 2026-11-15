import { useMemo, useState } from "react";

import type { Input, InterfaceDocument, ListedImplementation, Wallet } from "@/api";
import { InterfacePage } from "@/components/InterfacePage";
import { RegistryTree } from "@/components/RegistryTree";
import { SidePanel, type Tab } from "@/components/SidePanel";
import { describe } from "@/errors";
import {
  type FormValues,
  type IntentOptions,
  intentInputs,
  intentJson,
  type Output,
  planRequest,
} from "@/intent";
import { MINTS, VAULTS } from "@/known";
import {
  useAdapterMode,
  useInterfaceForm,
  useMatches,
  useRefreshRing,
  useRegistry,
  useWallets,
} from "@/queries";

const DEFAULT_OPTIONS: IntentOptions = {
  verifyIntent: true,
  assertions: true,
  allowUnapproved: false,
};

export function App() {
  const registry = useRegistry();
  const wallets = useWallets();
  const localWallets = wallets.data ?? [];

  const [chosenInterface, setChosenInterface] = useState<string | null>(null);
  const [pinned, setPinned] = useState<string | null>(null);
  const [showUnapproved, setShowUnapproved] = useState(false);
  const [edits, setEdits] = useState<Record<string, FormValues>>({});
  const [chosenFeePayer, setChosenFeePayer] = useState<string | null>(null);
  const [options, setOptions] = useState(DEFAULT_OPTIONS);

  const [tab, setTab] = useState<Tab>("intent");
  const [tamper, setTamper] = useState(false);
  const [output, setOutput] = useState<Output>("transaction");
  const adapter = useAdapterMode();
  const refreshRing = useRefreshRing();

  const selectedInterface =
    chosenInterface ??
    registry.data?.interfaces.find((listed) => listed.shown !== null)?.address ??
    null;
  const listed =
    registry.data?.interfaces.find((entry) => entry.address === selectedInterface) ?? null;
  const interfaceId = listed?.id ?? null;
  const form = useInterfaceForm(interfaceId, listed?.shown ?? null);
  const document = form.data ?? null;

  // A builder cannot name its rent payer yet, so the treasury does not pay its own fees.
  const feePayer = chosenFeePayer ?? walletNamed(localWallets, "alice");
  // A new interface's form starts from defaults that work, and keeps what the user changed in it.
  const values = useMemo(
    () =>
      document === null ? {} : { ...defaults(document, localWallets), ...edits[interfaceId ?? ""] },
    [document, localWallets, edits, interfaceId]
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
  const selectedImplementation =
    registry.data?.implementations.find((implementation) => implementation.id === selected?.id) ??
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
  const payer = feePayer;
  const request = useMemo(
    () => planRequest(intent, payer, frozen ? "transaction" : output),
    [intent, payer, frozen, output]
  );
  const requestKey = JSON.stringify(request);

  const selectInterface = (address: string, implementation: string | null) => {
    setChosenInterface(address);
    setPinned(implementation);
  };
  const selectImplementation = (implementation: ListedImplementation) => {
    const interfaceAddress = registry.data?.interfaces.find(
      (entry) => entry.id === implementation.interface
    )?.address;
    if (interfaceAddress !== undefined) selectInterface(interfaceAddress, implementation.id);
    if (!implementation.approved) setShowUnapproved(true);
  };

  if (registry.data === undefined) {
    const failure = registry.error ?? wallets.error;

    return <Loading error={failure === null ? null : describe(failure)} />;
  }

  return (
    <div className="app">
      <RegistryTree
        registry={registry.data}
        selectedInterface={selectedInterface}
        selectedImplementation={selected?.id ?? null}
        showUnapproved={showUnapproved}
        onShowUnapproved={setShowUnapproved}
        onSelectInterface={(address) => selectInterface(address, null)}
        onSelectImplementation={selectImplementation}
      />
      <div className="content-wrap">
        <div className="content-card workspace">
          {listed !== null && document !== null ? (
            <InterfacePage
              listed={listed}
              document={document}
              values={values}
              wallets={localWallets}
              feePayer={payer}
              candidates={candidates}
              implementation={selectedImplementation}
              candidatesError={matches.error === null ? null : describe(matches.error)}
              selected={selected}
              onValue={(name, value) =>
                setEdits((previous) => ({
                  ...previous,
                  [interfaceId ?? ""]: { ...previous[interfaceId ?? ""], [name]: value },
                }))
              }
              onFeePayer={setChosenFeePayer}
              onSelect={(candidate) => setPinned(candidate.id)}
            />
          ) : (
            <div className="pc">Select an interface.</div>
          )}
          <SidePanel
            tab={tab}
            intent={intent}
            request={request}
            requestKey={requestKey}
            options={options}
            onOptions={setOptions}
            listed={listed}
            implementation={selectedImplementation}
            recipe={selected?.recipe ?? null}
            organizations={registry.data.organizations}
            output={output}
            onOutput={setOutput}
            tamper={tamper}
            malicious={adapter.data === true && adapter.variables === true}
            onMalicious={(on) => adapter.mutate(on)}
            ready={selected !== null && payer !== ""}
            onTab={setTab}
            onTamper={setTamper}
            onSent={refreshRing}
          />
          {adapter.isError && (
            <div className="callout callout-red">The Jupiter wrapper does not answer on :8791.</div>
          )}
        </div>
      </div>
    </div>
  );
}

function Loading({ error }: { error: string | null }) {
  return (
    <div className="app loading">
      <div className="card loading-card">
        <div className="section-title">Intents playground</div>
        {error === null ? (
          <div className="section-sub">Reading the registry…</div>
        ) : (
          <>
            <div className="callout callout-red error-text">{error}</div>
            <div className="section-sub">
              Start a surfnet, run <code>node intents/e2e/playground.mjs</code>, then start the
              service with its wallets, as <code>apps/intents-playground/README.md</code> shows.
            </div>
          </>
        )}
      </div>
    </div>
  );
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
