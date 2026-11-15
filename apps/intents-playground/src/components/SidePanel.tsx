import type { ListedImplementation, ListedInterface, Recipe, Registry } from "@/api";
import { recipeOf } from "@/api";
import { Code, hexDump, Snippets } from "@/components/Code";
import { InterfaceTab } from "@/components/InterfaceTab";
import { Loop } from "@/components/Loop";
import { AddressRow, Row } from "@/components/Plan";
import { describe } from "@/errors";
import type { IntentOptions, Output } from "@/intent";
import { useImplementationVersion } from "@/queries";
import { startSnippets } from "@/snippets";

export type Tab = "intent" | "interface" | "implementation";

interface Props {
  tab: Tab;
  intent: object;
  request: object;
  requestKey: string;
  options: IntentOptions;
  onOptions: (options: IntentOptions) => void;
  listed: ListedInterface | null;
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
  { key: "interface", label: "Interface" },
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
        {props.tab === "interface" && (
          <InterfaceTab listed={props.listed} organizations={props.organizations} />
        )}
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
      <Options {...props} />
      <div className="section-sub">
        The plan request holds the intent with its payers and options. Every intent starts the same
        way, for one transaction or many.
      </div>
      <Snippets snippets={startSnippets(props.request)} />
      <PrepareControls {...props} />
      <Loop
        key={props.requestKey}
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

/// The request's options in one place: what the chain checks, what the plan returns, and the
/// switches that attack a plan to show the checks.
function Options(props: Props) {
  const frozen = props.recipe === "remote transaction";
  const attackable = props.recipe !== "shielded" && props.recipe !== "flow";
  const check = (key: "verifyIntent" | "assertions") => (checked: boolean) =>
    props.onOptions({ ...props.options, [key]: checked });

  return (
    <div className="options">
      <div className="section-title">Options</div>
      <Switch
        label="verify_intent"
        sub="The registry checks the built instructions against the intent, or limits them to the implementation's programs when it cannot rebuild them."
        checked={props.options.verifyIntent}
        onChange={check("verifyIntent")}
      />
      <Switch
        label="Lighthouse assertions"
        sub="Each guarantee becomes an assertion after the segment."
        checked={props.options.assertions}
        onChange={check("assertions")}
      />
      {!frozen && (
        <Switch
          label="Instructions only"
          sub="The plan holds no transaction. The caller compiles the instructions as legacy, v0, or v1."
          checked={props.output === "instructions"}
          onChange={(checked) => props.onOutput(checked ? "instructions" : "transaction")}
        />
      )}
      {props.recipe === "remote" && (
        <Switch
          label="Malicious endpoint"
          sub="The Jupiter wrapper also approves an attacker. The assertions refuse it."
          checked={props.malicious}
          onChange={props.onMalicious}
        />
      )}
      {attackable && (
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

/// What the recipe means for planning: a flow plans one step at a time, a shielded spend is built
/// and proved by the spender, and a provider's transaction is checked by simulation only.
function PrepareControls(props: Props) {
  const callout = RECIPE_CALLOUTS[props.recipe ?? ""];

  return callout === undefined ? null : (
    <div className={`callout ${callout.tone}`}>{callout.text}</div>
  );
}

const RECIPE_CALLOUTS: Record<string, { tone: string; text: string }> = {
  flow: {
    tone: "callout-gray",
    text: "This implementation is a flow: each step is its own transaction, and the loop below plans one step at a time.",
  },
  shielded: {
    tone: "callout-amber",
    text: "The spender's client builds and proves this spend, so verify_intent cannot rebuild it. It limits the spend to the pool, and the assertions bound its public effects. The notes inside stay hidden. The verifier reports the statement, and the wallet signs only a spend that it built from that statement.",
  },
  "remote transaction": {
    tone: "callout-amber",
    text: "The provider signs this transaction, so nothing onchain checks it. Turn both onchain checks off to accept it. The service's simulation checks every guarantee, and the verifier proves none of them.",
  },
};

/// The default address means that the index follows its organization's authority.
const FOLLOWS_ORGANIZATION = "11111111111111111111111111111111";

function ImplementationTab({
  implementation,
  organizations,
}: {
  implementation: ListedImplementation | null;
  organizations: Registry["organizations"];
}) {
  const read = useImplementationVersion(implementation?.id ?? null, implementation?.shown ?? null);
  const published = read.data ?? null;

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
            value={`${CHECKED[entry.tier] ?? "unknown checks"}, ${entry.removed ? "removed" : entry.approved ? "approved" : "not approved"}`}
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
        <div className="section-sub">
          {read.error === null ? "Reading the version…" : describe(read.error)}
        </div>
      )}
    </>
  );
}

/// What the chain checks of an implementation, by the registry's trust tier.
const CHECKED: Record<number, string> = {
  1: "instructions rebuilt onchain",
  2: "guarantees checked onchain",
  3: "only simulated",
};
