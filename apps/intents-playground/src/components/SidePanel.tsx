import type { ListedImplementation, Plan, Verified } from "@/api";
import { Code, hexDump, Snippets } from "@/components/Code";
import { PROGRAMS, shortAddress } from "@/known";
import { prepareSnippets, sendSnippets } from "@/snippets";

export type Tab = "intent" | "plan" | "record";

/// What the Plan tab shows: the plan, then what each step after it returned.
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
  record: ListedImplementation | null;
  planState: PlanState;
  tamper: boolean;
  ready: boolean;
  onTab: (tab: Tab) => void;
  onTamper: (tamper: boolean) => void;
  onPrepare: () => void;
  onVerify: () => void;
  onSend: () => void;
}

const TABS: { key: Tab; label: string }[] = [
  { key: "intent", label: "Intent" },
  { key: "plan", label: "Plan" },
  { key: "record", label: "Record" },
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
        {props.tab === "plan" && <PlanTab {...props} />}
        {props.tab === "record" && <RecordTab record={props.record} />}
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
    </>
  );
}

function PrepareControls(props: Props) {
  return (
    <div className="side-actions">
      <label className="switch-row">
        <span>
          <span className="switch-label">Tamper with the plan</span>
          <span className="section-sub">
            The service changes one built byte. verify_intent refuses it onchain.
          </span>
        </span>
        <span className="toggle">
          <input
            type="checkbox"
            checked={props.tamper}
            onChange={(event) => props.onTamper(event.target.checked)}
          />
          <span className="toggle-track" />
          <span className="toggle-thumb" />
        </span>
      </label>
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

function PlanTab(props: Props) {
  const { plan, error, verified, signature, busy } = props.planState;

  if (plan === null) {
    return (
      <>
        {error !== null && <div className="callout callout-red error-text">{error}</div>}
        <div className="section-sub">Prepare the intent to see its plan.</div>
        <PrepareControls {...props} />
      </>
    );
  }

  const transaction = plan.transactions[0];

  return (
    <>
      <div className="callout callout-gray message">{plan.message}</div>
      <div className="data-rows">
        <Row label="Instructions" value={String(transaction?.instructions.length ?? 0)} />
        <Row label="Compute units" value={plan.simulation.unitsConsumed} />
        <Row
          label="Signers"
          value={(transaction?.signatures ?? [])
            .map((signer) => shortAddress(signer.address))
            .join(", ")}
        />
        <Row
          label="Builder simulations"
          value={plan.intents.map((intent) => intent.builderSimulations).join(", ")}
        />
        {Object.entries(plan.rpcCalls).map(([method, count]) => (
          <Row key={method} label={`Service ${method}`} value={String(count)} />
        ))}
      </div>

      <Instructions plan={plan} />

      {error !== null && <div className="callout callout-red error-text">{error}</div>}
      {verified !== null && <VerifiedResult verified={verified} />}
      {signature !== null && (
        <div className="callout callout-green">
          Landed on the surfnet: {shortAddress(signature)}
        </div>
      )}

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

      {transaction !== undefined && (
        <Snippets snippets={sendSnippets(transaction.compiled, plan.message)} />
      )}
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
            <th>Accounts</th>
            <th>Data</th>
          </tr>
        </thead>
        <tbody>
          {(plan.transactions[0]?.instructions ?? []).map((instruction, position) => (
            // biome-ignore lint/suspicious/noArrayIndexKey: an instruction's position is its identity.
            <tr key={position}>
              <td>{position}</td>
              <td>
                {PROGRAMS[instruction.programAddress] ?? shortAddress(instruction.programAddress)}
              </td>
              <td>{part(position, instruction.programAddress)}</td>
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
  const proves = verified.matches === true && verified.unverified.length === 0;

  return (
    <div className={`callout ${proves ? "callout-green" : "callout-amber"}`}>
      {proves
        ? "The transaction proves the plan's message, and every instruction is in a segment."
        : `The message ${verified.matches ? "matches" : "differs"}. Instructions in no segment: ${verified.unverified.join(", ") || "none"}.`}
    </div>
  );
}

/// The default address means that the index follows its organization's authority.
function authority(address: string): string {
  return address === "11111111111111111111111111111111"
    ? "the organization's authority"
    : shortAddress(address);
}

function RecordTab({ record }: { record: ListedImplementation | null }) {
  if (record === null) {
    return <div className="section-sub">Select an implementation to see its record.</div>;
  }

  return (
    <>
      <div>
        <div className="section-title">{record.id}</div>
        <div className="section-sub">
          {record.shown} · {record.document?.recipe ?? "unknown"} recipe ·{" "}
          {record.approved ? "approved" : "unapproved"}
        </div>
      </div>
      <div className="data-rows">
        <Row label="Index" value={shortAddress(record.address)} />
        <Row label="Update authority" value={authority(record.updateAuthority)} />
        {record.versions.map((entry) => (
          <Row
            key={entry.version}
            label={`Version ${entry.version}`}
            value={entry.removed ? "removed" : entry.approved ? "approved" : "not approved"}
          />
        ))}
      </div>
      {record.document !== null && <Code text={JSON.stringify(record.document, null, 2)} />}
      {record.bytes !== null && (
        <>
          <div className="section-sub">
            The document as the registry holds it, {atob(record.bytes).length} bytes.
          </div>
          <Code text={hexDump(record.bytes)} />
        </>
      )}
    </>
  );
}
