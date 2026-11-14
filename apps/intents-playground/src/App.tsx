import { useEffect, useMemo, useState } from "react";

import {
  api,
  type Candidate,
  type Input,
  type InterfaceDocument,
  interfaceForm,
  type ListedImplementation,
  type Registry,
  ServiceError,
  type Wallet,
} from "@/api";
import { InterfacePage } from "@/components/InterfacePage";
import { RegistryTree } from "@/components/RegistryTree";
import { SidePanel, type Tab } from "@/components/SidePanel";
import {
  type FormValues,
  type IntentOptions,
  intentInputs,
  intentJson,
  type Output,
  planRequest,
} from "@/intent";
import { MINTS, VAULTS } from "@/known";

const DEFAULT_OPTIONS: IntentOptions = {
  verifyIntent: true,
  assertions: true,
  allowUnapproved: false,
};

export function App() {
  const [registry, setRegistry] = useState<Registry | null>(null);
  const [wallets, setWallets] = useState<Wallet[]>([]);
  const [loadError, setLoadError] = useState<string | null>(null);

  const [selectedInterface, setSelectedInterface] = useState<string | null>(null);
  const [document, setDocument] = useState<InterfaceDocument | null>(null);
  const [pinned, setPinned] = useState<string | null>(null);
  const [showUnapproved, setShowUnapproved] = useState(false);
  const [values, setValues] = useState<FormValues>({});
  const [feePayer, setFeePayer] = useState("");
  const [options, setOptions] = useState(DEFAULT_OPTIONS);

  const [candidates, setCandidates] = useState<Candidate[] | null>(null);
  const [candidatesError, setCandidatesError] = useState<string | null>(null);
  const [tab, setTab] = useState<Tab>("intent");
  const [tamper, setTamper] = useState(false);
  const [malicious, setMalicious] = useState(false);
  const [output, setOutput] = useState<Output>("transaction");
  const [lastSignature, setLastSignature] = useState<string | null>(null);
  const [adapterError, setAdapterError] = useState<string | null>(null);

  useEffect(() => {
    Promise.all([api.registry(), api.wallets()])
      .then(([loaded, localWallets]) => {
        setRegistry(loaded);
        setWallets(localWallets);
        // A builder cannot name its rent payer yet, so the treasury does not pay its own fees.
        setFeePayer(walletNamed(localWallets, "alice"));
        const first = loaded.interfaces.find((listed) => listed.shown !== null);
        if (first !== undefined) setSelectedInterface(first.address);
      })
      .catch((error: unknown) => setLoadError(describe(error)));
  }, []);

  const listed = registry?.interfaces.find((entry) => entry.address === selectedInterface) ?? null;
  const interfaceId = listed?.id ?? null;
  const interfaceVersion = listed?.shown ?? null;

  // A new interface's form starts from defaults that work, once its definition arrives.
  useEffect(() => {
    if (interfaceId === null || interfaceVersion === null) return;

    let current = true;
    setDocument(null);
    api
      .interfaceVersion(interfaceId, interfaceVersion)
      .then((published) => {
        if (!current) return;

        const form = interfaceForm(published.document);
        setDocument(form);
        setValues(defaults(form, wallets, interfaceId));
      })
      .catch((error: unknown) => current && setLoadError(describe(error)));

    return () => {
      current = false;
    };
  }, [interfaceId, interfaceVersion, wallets]);

  const inputsKey = document === null ? "" : JSON.stringify(intentInputs(document, values));

  useEffect(() => {
    if (interfaceId === null || interfaceVersion === null || inputsKey === "") return;

    let current = true;
    setCandidates(null);
    setCandidatesError(null);
    const timer = setTimeout(() => {
      const body = {
        inputs: JSON.parse(inputsKey),
        payers: { fee: feePayer },
        all: showUnapproved,
      };
      api
        .matches(interfaceId, interfaceVersion, body)
        .then((found) => current && setCandidates(found))
        .catch((error: unknown) => current && setCandidatesError(describe(error)));
    }, 250);

    return () => {
      current = false;
      clearTimeout(timer);
    };
  }, [interfaceId, interfaceVersion, inputsKey, feePayer, showUnapproved]);

  const selected =
    candidates?.find((candidate) => candidate.id === pinned) ??
    candidates?.find((candidate) => candidate.status === "applies") ??
    null;
  const selectedImplementation =
    registry?.implementations.find((implementation) => implementation.id === selected?.id) ?? null;
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
  // A shielded spend, and a flow of them, takes the spender as its fee payer.
  const spends = selected?.recipe === "shielded" || selected?.recipe === "flow";
  const frozen = spends || selected?.recipe === "remote transaction";
  const payer = spends ? spender(document, values) : feePayer;
  const request = useMemo(
    () => planRequest(intent, payer, frozen ? "transaction" : output),
    [intent, payer, frozen, output]
  );
  const requestKey = JSON.stringify(request);

  const selectInterface = (address: string, implementation: string | null) => {
    setSelectedInterface(address);
    setPinned(implementation);
  };
  const selectImplementation = (implementation: ListedImplementation) => {
    const interfaceAddress = registry?.interfaces.find(
      (entry) => entry.id === implementation.interface
    )?.address;
    if (interfaceAddress !== undefined) selectInterface(interfaceAddress, implementation.id);
    if (!implementation.approved) setShowUnapproved(true);
  };

  if (registry === null) {
    return <Loading error={loadError} />;
  }

  return (
    <div className="app">
      <RegistryTree
        registry={registry}
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
              wallets={wallets}
              feePayer={payer}
              feePayerFixed={spends}
              signature={lastSignature}
              candidates={candidates}
              candidatesError={candidatesError}
              selected={selected}
              options={options}
              onValue={(name, value) => setValues((previous) => ({ ...previous, [name]: value }))}
              onFeePayer={setFeePayer}
              onSelect={(candidate) => setPinned(candidate.id)}
              onOptions={setOptions}
            />
          ) : (
            <div className="pc">Select an interface.</div>
          )}
          <SidePanel
            tab={tab}
            intent={intent}
            request={request}
            requestKey={requestKey}
            implementation={selectedImplementation}
            recipe={selected?.recipe ?? null}
            organizations={registry.organizations}
            output={output}
            onOutput={setOutput}
            tamper={tamper}
            malicious={malicious}
            onMalicious={(on) => {
              api
                .adapterMode(on)
                .then((ok) => ok && setMalicious(on))
                .catch(() => setAdapterError("The Jupiter wrapper does not answer on :8791."));
            }}
            ready={selected !== null && payer !== ""}
            onTab={setTab}
            onTamper={setTamper}
            onSent={setLastSignature}
          />
          {adapterError !== null && <div className="callout callout-red">{adapterError}</div>}
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

/// The first signer input. A shielded spend consumes its notes, so it pays the fee.
function spender(document: InterfaceDocument | null, values: FormValues): string {
  const signer = document?.inputs.find((input) => input.signer);

  return signer === undefined ? "" : (values[signer.name] ?? "");
}

function walletNamed(wallets: Wallet[], name: string): string {
  return wallets.find((wallet) => wallet.name === name)?.address ?? wallets[0]?.address ?? "";
}

/// A first intent that works: the treasury sends one unit of USDC to bob, or deposits it in a vault.
/// A private intent sends SOL, because the wallets shield only SOL.
function defaults(document: InterfaceDocument, wallets: Wallet[], interfaceId: string): FormValues {
  const mint = interfaceId.startsWith("solana.org/private.") ? MINTS[0] : MINTS[1];
  const value = (input: Input): string => {
    if (input.optional) return "";
    if (input.type === "mint") return mint?.address ?? "";
    if (input.type === "address" && input.name === "vault") return VAULTS[0]?.address ?? "";
    if (input.type === "address") return walletNamed(wallets, input.signer ? "treasury" : "bob");

    return "1";
  };

  return Object.fromEntries(document.inputs.map((input) => [input.name, value(input)]));
}

/// A service error with its findings or its program logs.
function describe(error: unknown): string {
  if (!(error instanceof ServiceError)) {
    return error instanceof Error ? error.message : String(error);
  }

  const details = error.details as { rendered?: string; logs?: string[] } | null;
  const extra = details?.rendered ?? details?.logs?.slice(-8).join("\n");

  return extra === undefined ? error.message : `${error.message}\n\n${extra}`;
}
