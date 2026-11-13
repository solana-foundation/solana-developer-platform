import { useEffect, useMemo, useState } from "react";

import {
  api,
  type Candidate,
  type Input,
  type InterfaceDocument,
  type ListedImplementation,
  type Registry,
  ServiceError,
  type Wallet,
} from "@/api";
import { InterfacePage } from "@/components/InterfacePage";
import { RegistryTree } from "@/components/RegistryTree";
import { type PlanState, SidePanel, type Tab } from "@/components/SidePanel";
import {
  type FormValues,
  type IntentOptions,
  intentInputs,
  intentJson,
  planRequest,
} from "@/intent";
import { MINTS, VAULTS } from "@/known";

const NO_PLAN: PlanState = { plan: null, error: null, verified: null, signature: null, busy: null };
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
  const [pinned, setPinned] = useState<string | null>(null);
  const [showUnapproved, setShowUnapproved] = useState(false);
  const [values, setValues] = useState<FormValues>({});
  const [feePayer, setFeePayer] = useState("");
  const [options, setOptions] = useState(DEFAULT_OPTIONS);

  const [candidates, setCandidates] = useState<Candidate[] | null>(null);
  const [candidatesError, setCandidatesError] = useState<string | null>(null);
  const [tab, setTab] = useState<Tab>("intent");
  const [tamper, setTamper] = useState(false);
  const [planState, setPlanState] = useState(NO_PLAN);

  useEffect(() => {
    Promise.all([api.registry(), api.wallets()])
      .then(([loaded, localWallets]) => {
        setRegistry(loaded);
        setWallets(localWallets);
        // A builder cannot name its rent payer yet, so the treasury does not pay its own fees.
        setFeePayer(walletNamed(localWallets, "alice"));
        const first = loaded.interfaces.find((listed) => listed.document !== null);
        if (first?.document) {
          setSelectedInterface(first.address);
          setValues(defaults(first.document, localWallets));
        }
      })
      .catch((error: unknown) => setLoadError(describe(error)));
  }, []);

  const listed = registry?.interfaces.find((entry) => entry.address === selectedInterface) ?? null;
  const document = listed?.document ?? null;
  const inputsKey = document === null ? "" : JSON.stringify(intentInputs(document, values));

  useEffect(() => {
    if (listed?.id == null || inputsKey === "") return;

    let current = true;
    setCandidates(null);
    setCandidatesError(null);
    const timer = setTimeout(() => {
      const body = {
        interface: `${listed.id}@^${(listed.shown ?? "1").split(".")[0]}`,
        inputs: JSON.parse(inputsKey),
        payers: { fee: feePayer },
        all: showUnapproved,
      };
      api
        .implementations(body)
        .then((found) => current && setCandidates(found))
        .catch((error: unknown) => current && setCandidatesError(describe(error)));
    }, 250);

    return () => {
      current = false;
      clearTimeout(timer);
    };
  }, [listed?.id, listed?.shown, inputsKey, feePayer, showUnapproved]);

  const selected =
    candidates?.find((candidate) => candidate.id === pinned) ??
    candidates?.find((candidate) => candidate.fits) ??
    null;
  const record =
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
  const request = useMemo(() => planRequest(intent, feePayer), [intent, feePayer]);
  const requestKey = JSON.stringify(request);

  useEffect(() => {
    if (requestKey !== "") setPlanState(NO_PLAN);
  }, [requestKey]);

  const selectInterface = (address: string, implementation: string | null) => {
    const next = registry?.interfaces.find((entry) => entry.address === address);
    if (next?.document && address !== selectedInterface) {
      setValues(defaults(next.document, wallets));
    }

    setSelectedInterface(address);
    setPinned(implementation);
  };
  const selectImplementation = (implementation: ListedImplementation) => {
    selectInterface(implementation.interface, implementation.id);
    if (!implementation.approved) setShowUnapproved(true);
    setTab("record");
  };

  const compiled = planState.plan?.transactions[0]?.compiled ?? "";
  const prepare = () => {
    setPlanState({ ...NO_PLAN, busy: "prepare" });
    setTab("plan");
    api
      .prepare(request, tamper)
      .then((plan) => setPlanState({ ...NO_PLAN, plan }))
      .catch((error: unknown) => setPlanState({ ...NO_PLAN, error: describe(error) }));
  };
  const verify = () => {
    const plan = planState.plan;
    if (plan === null) return;

    setPlanState({ ...planState, busy: "verify", error: null });
    api
      .verify(compiled, plan.message)
      .then((verified) => setPlanState({ ...planState, verified, busy: null, error: null }))
      .catch((error: unknown) =>
        setPlanState({ ...planState, busy: null, error: describe(error) })
      );
  };
  const send = () => {
    setPlanState({ ...planState, busy: "send", error: null });
    api
      .send(compiled)
      .then(({ signature }) => setPlanState({ ...planState, signature, busy: null, error: null }))
      .catch((error: unknown) =>
        setPlanState({ ...planState, busy: null, error: describe(error) })
      );
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
              feePayer={feePayer}
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
            record={record}
            planState={planState}
            tamper={tamper}
            ready={selected !== null && feePayer !== ""}
            onTab={setTab}
            onTamper={setTamper}
            onPrepare={prepare}
            onVerify={verify}
            onSend={send}
          />
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

/// A service error with its findings or its program logs.
function describe(error: unknown): string {
  if (!(error instanceof ServiceError)) {
    return error instanceof Error ? error.message : String(error);
  }

  const details = error.details as { rendered?: string; logs?: string[] } | null;
  const extra = details?.rendered ?? details?.logs?.slice(-8).join("\n");

  return extra === undefined ? error.message : `${error.message}\n\n${extra}`;
}
