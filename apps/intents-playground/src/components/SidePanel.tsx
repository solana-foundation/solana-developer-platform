import { useEffect, useState } from "react";

import type {
  ImplementationDefinition,
  ListedImplementation,
  Published,
  Recipe,
  Registry,
} from "@/api";
import { api, recipeOf } from "@/api";
import { Code, hexDump, Snippets } from "@/components/Code";
import { Loop } from "@/components/Loop";
import { AddressRow, Row } from "@/components/Plan";
import type { Output } from "@/intent";
import { startSnippets } from "@/snippets";

export type Tab = "intent" | "implementation";

interface Props {
  tab: Tab;
  intent: object;
  request: object;
  requestKey: string;
  implementation: ListedImplementation | null;
  /// The selected implementation's recipe, as the service matched it.
  recipe: Recipe | null;
  organizations: Registry["organizations"];
  output: Output;
  tamper: boolean;
  malicious: boolean;
  onMalicious: (malicious: boolean) => void;
  ready: boolean;
  onTab: (tab: Tab) => void;
  onOutput: (output: Output) => void;
  onTamper: (tamper: boolean) => void;
  onSent: (signature: string) => void;
}

const TABS: { key: Tab; label: string }[] = [
  { key: "intent", label: "Intent" },
  { key: "implementation", label: "Implementation" },
];

export function SidePanel(props: Props) {
  return (
    <section className="side-panel">
      <div className="ph-tabs side-tabs">
        {TABS.map((tab) => (
          <button
            type="button"
            key={tab.key}
            className={`ph-tab ${props.tab === tab.key ? "active" : ""}`}
            onClick={() => props.onTab(tab.key)}
          >
            {tab.label}
          </button>
        ))}
      </div>

      <div className="side-body">
        {props.tab === "intent" && <IntentTab {...props} />}
        {props.tab === "implementation" && (
          <ImplementationTab
            implementation={props.implementation}
            organizations={props.organizations}
          />
        )}
      </div>
    </section>
  );
}

function IntentTab(props: Props) {
  return (
    <>
      <Code text={JSON.stringify(props.intent, null, 2)} />
      <div className="section-sub">
        The plan request holds the intent with its payers. Every intent starts the same way, for one
        transaction or many.
      </div>
      <Snippets snippets={startSnippets(props.request)} />
      <PrepareControls {...props} />
      <Loop
        request={props.request}
        requestKey={props.requestKey}
        recipe={props.recipe}
        tamper={props.tamper}
        ready={props.ready}
        onSent={props.onSent}
      />
    </>
  );
}

function Switch(props: {
  label: string;
  sub: string;
  checked: boolean;
  onChange: (checked: boolean) => void;
}) {
  return (
    <label className="switch-row">
      <span>
        <span className="switch-label">{props.label}</span>
        <span className="section-sub">{props.sub}</span>
      </span>
      <span className="toggle">
        <input
          type="checkbox"
          checked={props.checked}
          onChange={(event) => props.onChange(event.target.checked)}
        />
        <span className="toggle-track" />
        <span className="toggle-thumb" />
      </span>
    </label>
  );
}

function PrepareControls(props: Props) {
  const remote = props.recipe === "remote";
  const shielded = props.recipe === "shielded";
  const flow = props.recipe === "flow";
  const frozen = shielded || flow || props.recipe === "remote transaction";

  return (
    <div className="side-actions">
      {flow && (
        <div className="callout callout-amber">
          This implementation is a flow: each step is its own transaction, and the loop below plans
          one step at a time. Its steps are shielded spends, which nothing onchain checks against
          their intents, so turn both onchain checks off.
        </div>
      )}
      {shielded && (
        <div className="callout callout-amber">
          The spender's shielded keys build and prove this spend, and the amounts and the recipient
          stay hidden. Nothing onchain checks it against the intent, so turn both onchain checks
          off. The service's simulation checks every guarantee, and the verifier proves none of
          them.
        </div>
      )}
      {frozen && !shielded && !flow && (
        <div className="callout callout-amber">
          The provider signs this transaction, so nothing onchain checks it. Turn both onchain
          checks off to accept it. The service's simulation checks every guarantee, and the verifier
          proves none of them.
        </div>
      )}
      {remote && (
        <Switch
          label="Malicious endpoint"
          sub="The Jupiter wrapper also approves an attacker. The assertions refuse it."
          checked={props.malicious}
          onChange={props.onMalicious}
        />
      )}
      {!frozen && (
        <Switch
          label="Instructions only"
          sub="The plan holds no transaction. The caller compiles the instructions as legacy, v0, or v1."
          checked={props.output === "instructions"}
          onChange={(checked) => props.onOutput(checked ? "instructions" : "transaction")}
        />
      )}
      {!shielded && !flow && (
        <Switch
          label="Tamper with the plan"
          sub="The service changes one built byte. verify_intent refuses it onchain."
          checked={props.tamper}
          onChange={props.onTamper}
        />
      )}
    </div>
  );
}

/// The default address means that the index follows its organization's authority.
const FOLLOWS_ORGANIZATION = "11111111111111111111111111111111";

function ImplementationTab({
  implementation,
  organizations,
}: {
  implementation: ListedImplementation | null;
  organizations: Registry["organizations"];
}) {
  const [published, setPublished] = useState<Published<ImplementationDefinition> | null>(null);
  const [failed, setFailed] = useState<string | null>(null);
  const id = implementation?.id ?? null;
  const version = implementation?.shown ?? null;

  useEffect(() => {
    setPublished(null);
    setFailed(null);
    if (id === null || version === null) return;

    let current = true;
    api
      .implementationVersion(id, version)
      .then((answer) => current && setPublished(answer))
      .catch(
        (error: unknown) =>
          current && setFailed(error instanceof Error ? error.message : String(error))
      );

    return () => {
      current = false;
    };
  }, [id, version]);

  if (implementation === null) {
    return <div className="section-sub">Select an implementation to see its definition.</div>;
  }

  const organization = organizations.find((listed) => listed.name === implementation.organization);
  const follows =
    implementation.updateAuthority === FOLLOWS_ORGANIZATION && organization !== undefined;

  return (
    <>
      <div>
        <div className="section-title">{implementation.id}</div>
        <div className="section-sub">
          {implementation.shown} · {published?.document.cluster ?? "unknown cluster"} ·{" "}
          {published === null ? "unknown" : recipeOf(published.document)} recipe ·{" "}
          {implementation.approved ? "approved" : "unapproved"}
        </div>
      </div>
      <div className="data-rows">
        <AddressRow label="Index" address={implementation.address} />
        <AddressRow
          label="Update authority"
          address={follows ? organization.authority : implementation.updateAuthority}
          sub={follows ? `the authority of ${implementation.organization}` : undefined}
        />
        {implementation.versions.map((entry) => (
          <Row
            key={entry.version}
            label={`Version ${entry.version}`}
            value={`tier ${entry.tier}, ${entry.removed ? "removed" : entry.approved ? "approved" : "not approved"}`}
          />
        ))}
      </div>
      {published !== null ? (
        <>
          <div className="section-sub">
            The implementation as the service decompiles it from the registry, in the format of{" "}
            <code>intents/definitions</code>.
          </div>
          <Code text={JSON.stringify(published.document, null, 2)} />
          <div className="section-sub">
            The document as the registry holds it, {atob(published.bytes).length} bytes.
          </div>
          <Code text={hexDump(published.bytes)} />
        </>
      ) : (
        <div className="section-sub">{failed ?? "Reading the version…"}</div>
      )}
    </>
  );
}
