import { useEffect, useState } from "react";

import type {
  ImplementationDefinition,
  ListedImplementation,
  Plan,
  Published,
  Recipe,
  Registry,
} from "@/api";
import { api, recipeOf } from "@/api";
import { Code, hexDump, Snippets } from "@/components/Code";
import type { Output } from "@/intent";
import { explorerUrl, PROGRAMS, shortAddress } from "@/known";
import { compileSnippets, prepareSnippets, sendSnippets } from "@/snippets";
import type { Verified } from "@/verifier";

export type Tab = "intent" | "implementation";

/// The plan of the Intent tab, then what each step after it returned.
export interface PlanState {
  plan: Plan | null;
  error: string | null;
  verified: Verified | null;
  signature: string | null;
  busy: "prepare" | "verify" | "send" | null;
}

interface Props {
  tab: Tab;
  intent: object;
  request: object;
  implementation: ListedImplementation | null;
  /// The selected implementation's recipe, as the service matched it.
  recipe: Recipe | null;
  organizations: Registry["organizations"];
  planState: PlanState;
  output: Output;
  tamper: boolean;
  malicious: boolean;
  onMalicious: (malicious: boolean) => void;
  ready: boolean;
  onTab: (tab: Tab) => void;
  onOutput: (output: Output) => void;
  onTamper: (tamper: boolean) => void;
  onPrepare: () => void;
  onVerify: () => void;
  onSend: () => void;
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
      <div className="section-sub">The plan request holds the intent with its payers.</div>
      <Snippets snippets={prepareSnippets(props.request)} />
      <PrepareControls {...props} />
      {props.planState.error !== null && (
        <div className="callout callout-red error-text">{props.planState.error}</div>
      )}
      {props.planState.plan !== null && <PlanResult {...props} plan={props.planState.plan} />}
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
  const frozen = shielded || props.recipe === "remote transaction";

  return (
    <div className="side-actions">
      {shielded && (
        <div className="callout callout-amber">
          The spender's shielded keys build and prove this spend, and the amounts and the recipient
          stay hidden. Nothing onchain checks it against the intent, so turn both onchain checks
          off. The service's simulation checks every guarantee, and the verifier proves none of
          them.
        </div>
      )}
      {frozen && !shielded && (
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
      {!shielded && (
        <Switch
          label="Tamper with the plan"
          sub="The service changes one built byte. verify_intent refuses it onchain."
          checked={props.tamper}
          onChange={props.onTamper}
        />
      )}
      <button
        type="button"
        className="btn btn-pri"
        disabled={!props.ready || props.planState.busy !== null}
        onClick={props.onPrepare}
      >
        {props.planState.busy === "prepare" ? "Preparing…" : "Prepare"}
      </button>
    </div>
  );
}

function PlanResult(props: Props & { plan: Plan }) {
  const { plan } = props;
  const { verified, signature } = props.planState;

  return (
    <>
      <div className="section-title">Plan</div>
      <div className="callout callout-gray message">{plan.message}</div>
      <PlanRows plan={plan} recipe={props.recipe} />

      {plan.instructions !== undefined && <Instructions plan={plan} />}

      {verified !== null && <VerifiedResult verified={verified} />}
      {signature !== null && (
        <div className="callout callout-green">
          Landed on the surfnet:{" "}
          <a href={explorerUrl("tx", signature)} target="_blank" rel="noreferrer">
            {signature}
          </a>
        </div>
      )}

      <SignerSteps {...props} />
    </>
  );
}

function PlanRows({ plan, recipe }: { plan: Plan; recipe: Recipe | null }) {
  const transaction = plan.transaction;
  const tiers = plan.message.match(/\| tier (\d)/g)?.map((tier) => tier.slice(-1));

  return (
    <div className="data-rows">
      <Row label="Message" value={`${new TextEncoder().encode(plan.message).length} bytes`} />
      <Row
        label="Instructions"
        value={
          plan.instructions === undefined
            ? recipe === "shielded"
              ? "proved by the spender"
              : "signed by the provider"
            : String(plan.instructions.length)
        }
      />
      <Row label="Compute units" value={plan.simulation.unitsConsumed} />
      <Row
        label="Signers"
        value={plan.signers.map((signer) => shortAddress(signer.address)).join(", ")}
      />
      <Row
        label="Builder simulations"
        value={plan.intents.map((intent) => intent.builderSimulations).join(", ")}
      />
      <Row label="Tier" value={tiers?.join(", ") ?? "1"} />
      {transaction !== undefined && (
        <Row label="Transaction version" value={String(transaction.version)} />
      )}
      {transaction !== undefined && transaction.presigned.length > 0 && (
        <Row
          label="Signed by the provider"
          value={transaction.presigned.map((signed) => shortAddress(signed.address)).join(", ")}
        />
      )}
      {Object.entries(plan.rpcCalls).map(([method, count]) => (
        <Row key={method} label={`Service ${method}`} value={String(count)} />
      ))}
    </div>
  );
}

/// A plan of instructions alone goes to the caller's compiler. A plan with its transaction goes to
/// the signer: verify it, then sign and send it.
function SignerSteps(props: Props & { plan: Plan }) {
  const transaction = props.plan.transaction;
  const busy = props.planState.busy;

  return transaction === undefined ? (
    <>
      <div className="section-sub">
        The plan holds the instructions alone. Compile them into a transaction of any version, then
        verify that transaction before it is signed.
      </div>
      <Snippets snippets={compileSnippets()} />
    </>
  ) : (
    <>
      <div className="side-actions row">
        <button
          type="button"
          className="btn btn-sec"
          disabled={busy !== null}
          onClick={props.onVerify}
        >
          {busy === "verify" ? "Verifying…" : "Verify"}
        </button>
        <button
          type="button"
          className="btn btn-pri"
          disabled={busy !== null}
          onClick={props.onSend}
        >
          {busy === "send" ? "Sending…" : "Send"}
        </button>
      </div>
      <div className="section-sub">
        Verify runs <code>@sdp/intents-verifier</code> in this browser. It reads the registry from
        the surfnet's RPC, not from the service that planned the transaction.
      </div>
      <Snippets snippets={sendSnippets(transaction.messageBytes)} />
    </>
  );
}

function Row({ label, value }: { label: string; value: string }) {
  return (
    <div className="data-row">
      <span className="dr-label">{label}</span>
      <span className="dr-value">{value}</span>
    </div>
  );
}

function AddressRow({ label, address, sub }: { label: string; address: string; sub?: string }) {
  return (
    <div className="data-row">
      <span className="dr-label">{label}</span>
      <span className="dr-value">
        <a href={explorerUrl("address", address)} target="_blank" rel="noreferrer">
          {shortAddress(address)}
        </a>
        {sub !== undefined && <span className="section-sub"> {sub}</span>}
      </span>
    </div>
  );
}

/// Each instruction with its part of the segment: `verify_intent`, a built instruction, or an
/// onchain check.
function Instructions({ plan }: { plan: Plan }) {
  const part = (position: number, program: string) => {
    const intent = plan.intents.find((planned) => planned.verify === position);

    if (intent !== undefined) return "verify_intent";
    if (
      plan.intents.some((planned) => position >= planned.span.start && position < planned.span.end)
    )
      return "built";

    return PROGRAMS[program] === "Lighthouse" ? "check" : "";
  };

  return (
    <div className="table-wrap">
      <table>
        <thead>
          <tr>
            <th>#</th>
            <th>Program</th>
            <th>Part</th>
            <th>Compute units</th>
            <th>Accounts</th>
            <th>Data</th>
          </tr>
        </thead>
        <tbody>
          {(plan.instructions ?? []).map((instruction, position) => (
            // biome-ignore lint/suspicious/noArrayIndexKey: an instruction's position is its identity.
            <tr key={position}>
              <td>{position}</td>
              <td>
                {PROGRAMS[instruction.programAddress] ?? shortAddress(instruction.programAddress)}
              </td>
              <td>{part(position, instruction.programAddress)}</td>
              <td>{plan.simulation.unitsByInstruction[position] ?? "builtin"}</td>
              <td>{instruction.accounts.length}</td>
              <td>{atob(instruction.data).length} B</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function VerifiedResult({ verified }: { verified: Verified }) {
  const proves = verified.matches && verified.unverified.length === 0;
  const unverified = verified.unverified.join(", ") || "none";

  if (verified.intents.length === 0) {
    return (
      <div className="callout callout-red">
        No verify_intent proves this transaction. Instructions in no segment: {unverified}.
      </div>
    );
  }

  return (
    <div className={`callout ${proves ? "callout-green" : "callout-amber"}`}>
      {proves
        ? "The transaction proves the plan's message, and every instruction is in a segment."
        : `The message ${verified.matches ? "matches" : "differs"}. Instructions in no segment: ${unverified}.`}
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
