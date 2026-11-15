import { useState } from "react";

import type { ListedImplementation, ListedInterface, Wallet } from "@/api";
import { InterfacePage } from "@/components/InterfacePage";
import { RegistryTree } from "@/components/RegistryTree";
import { SidePanel, type Tab } from "@/components/SidePanel";
import { describe } from "@/errors";
import type { IntentOptions, Output } from "@/intent";
import { useAdapterMode, useRefreshRing, useRegistry, useWallets } from "@/queries";
import { useIntentRequest, useSelection } from "@/workspace";

const DEFAULT_OPTIONS: IntentOptions = {
  verifyIntent: true,
  assertions: true,
  allowUnapproved: false,
};

export function App() {
  const registry = useRegistry();
  const wallets = useWallets();
  const [options, setOptions] = useState(DEFAULT_OPTIONS);
  const [tab, setTab] = useState<Tab>("intent");
  const [tamper, setTamper] = useState(false);
  const [output, setOutput] = useState<Output>("transaction");
  const adapter = useAdapterMode();
  const refreshRing = useRefreshRing();

  const selection = useSelection(registry.data);
  const { listed } = selection;
  const form = useIntentRequest(
    listed,
    wallets.data ?? [],
    selection.pinned,
    selection.showUnapproved,
    options,
    output
  );
  const { selected } = form;
  const selectedImplementation =
    registry.data?.implementations.find((implementation) => implementation.id === selected?.id) ??
    null;

  if (registry.data === undefined) {
    const failure = registry.error ?? wallets.error;

    return <Loading error={failure === null ? null : describe(failure)} />;
  }

  return (
    <div className="app">
      <RegistryTree
        registry={registry.data}
        selectedInterface={selection.selectedInterface}
        selectedImplementation={selected?.id ?? null}
        showUnapproved={selection.showUnapproved}
        onShowUnapproved={selection.setShowUnapproved}
        onSelectInterface={(address) => selection.selectInterface(address, null)}
        onSelectImplementation={selection.selectImplementation}
      />
      <div className="content-wrap">
        <div className="content-card workspace">
          <InterfaceView
            listed={listed}
            form={form}
            wallets={wallets.data ?? []}
            implementation={selectedImplementation}
            onPin={selection.setPinned}
          />
          <SidePanel
            tab={tab}
            intent={form.intent}
            request={form.request}
            requestKey={JSON.stringify(form.request)}
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
            ready={selected !== null && form.feePayer !== ""}
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

interface InterfaceViewProps {
  listed: ListedInterface | null;
  form: ReturnType<typeof useIntentRequest>;
  wallets: Wallet[];
  implementation: ListedImplementation | null;
  onPin: (implementation: string) => void;
}

function InterfaceView({ listed, form, wallets, implementation, onPin }: InterfaceViewProps) {
  if (listed === null || form.document === null) {
    return <div className="pc">Select an interface.</div>;
  }

  return (
    <InterfacePage
      listed={listed}
      document={form.document}
      values={form.values}
      wallets={wallets}
      feePayer={form.feePayer}
      candidates={form.candidates}
      implementation={implementation}
      candidatesError={form.matches.error === null ? null : describe(form.matches.error)}
      selected={form.selected}
      onValue={form.setValue}
      onFeePayer={form.setFeePayer}
      onSelect={(candidate) => onPin(candidate.id)}
    />
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
