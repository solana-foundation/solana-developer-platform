import type { Candidate, CandidateStatus, InterfaceDocument, ListedInterface, Wallet } from "@/api";
import { InputField } from "@/components/InputField";
import { PrivacyRing } from "@/components/PrivacyRing";
import { type FormValues, type IntentOptions, renderTemplate } from "@/intent";

interface Props {
  listed: ListedInterface;
  document: InterfaceDocument;
  values: FormValues;
  wallets: Wallet[];
  feePayer: string;
  /// A shielded spend's fee payer is its spender, so the form does not offer another.
  feePayerFixed: boolean;
  signature: string | null;
  candidates: Candidate[] | null;
  candidatesError: string | null;
  selected: Candidate | null;
  options: IntentOptions;
  onValue: (name: string, value: string) => void;
  onFeePayer: (address: string) => void;
  onSelect: (candidate: Candidate) => void;
  onOptions: (options: IntentOptions) => void;
}

/// The interface as an endpoint: its display is the title, its inputs are the form, and its
/// postconditions read as guarantees. Each implementation shows whether its `applies` checks hold.
export function InterfacePage(props: Props) {
  const { listed, document, values, wallets } = props;

  return (
    <section className="interface-page">
      <div className="ph">
        <div className="ph-top interface-header">
          <div>
            <div className="section-sub">
              {listed.id} · {listed.shown}
              {document.settlement === "async" && (
                <span className="badge badge-amber header-badge">settles later</span>
              )}
            </div>
            <h1 className="page-title">{renderTemplate(document.display, values, wallets)}</h1>
          </div>
        </div>
      </div>

      <div className="pc interface-body">
        <div className="card f-section">
          <div className="section-title">Inputs</div>
          {document.inputs.map((input) => (
            <InputField
              key={input.name}
              input={input}
              values={values}
              wallets={wallets}
              onChange={props.onValue}
            />
          ))}
          <div className="f-col">
            <label className="input-lbl" htmlFor="fee-payer">
              Fee payer
            </label>
            <select
              id="fee-payer"
              className="select"
              value={props.feePayer}
              disabled={props.feePayerFixed}
              onChange={(event) => props.onFeePayer(event.target.value)}
            >
              {wallets.map((wallet) => (
                <option key={wallet.address} value={wallet.address}>
                  {wallet.name}
                </option>
              ))}
            </select>
          </div>
        </div>

        <div className="card f-section">
          <div className="section-title">Guarantees</div>
          <ul className="guarantees">
            {document.postConditions.map((condition) => (
              <li key={condition}>
                <span className="check">✓</span>
                {renderTemplate(condition, values, wallets)}
              </li>
            ))}
          </ul>
        </div>

        <Implementations {...props} />
        {props.selected?.recipe === "shielded" && <PrivacyRing signature={props.signature} />}
        <OnchainChecks options={props.options} onOptions={props.onOptions} />
      </div>
    </section>
  );
}

function Implementations({ candidates, candidatesError, selected, onSelect }: Props) {
  return (
    <div className="card f-section">
      <div>
        <div className="section-title">Implementations</div>
        <div className="section-sub">
          The service checks each one's `applies` hints against the inputs.
        </div>
      </div>

      {candidatesError !== null && <div className="callout callout-red">{candidatesError}</div>}
      {candidates === null && candidatesError === null && (
        <div className="section-sub">Checking…</div>
      )}

      <div className="radio-group">
        {(candidates ?? []).map((candidate) => (
          <button
            type="button"
            key={candidate.id}
            className={`sel-card candidate ${selected?.id === candidate.id ? "selected" : ""}`}
            onClick={() => onSelect(candidate)}
          >
            <div className="candidate-top">
              <span className="sel-card-title">{candidate.id.split("/")[1]}</span>
              <span className="candidate-badges">
                <span className="badge badge-gray">{candidate.recipe}</span>
                {!candidate.approved && <span className="badge badge-amber">unapproved</span>}
                <StatusBadge status={candidate.status} />
              </span>
            </div>
            {candidate.reason !== null && <div className="sel-card-sub">{candidate.reason}</div>}
          </button>
        ))}
      </div>
    </div>
  );
}

const STATUS_BADGES: Record<CandidateStatus, { label: string; tone: string }> = {
  applies: { label: "applies", tone: "badge-green" },
  doesNotApply: { label: "does not apply", tone: "badge-red" },
  invalidInputs: { label: "invalid inputs", tone: "badge-amber" },
  unknown: { label: "unknown", tone: "badge-gray" },
};

function StatusBadge({ status }: { status: CandidateStatus }) {
  const badge = STATUS_BADGES[status];

  return <span className={`badge ${badge.tone}`}>{badge.label}</span>;
}

function OnchainChecks({
  options,
  onOptions,
}: {
  options: IntentOptions;
  onOptions: (options: IntentOptions) => void;
}) {
  const switches: { key: "verifyIntent" | "assertions"; label: string; sub: string }[] = [
    {
      key: "verifyIntent",
      label: "verify_intent",
      sub: "The registry checks the built instructions against the intent.",
    },
    {
      key: "assertions",
      label: "Lighthouse assertions",
      sub: "Each postcondition becomes an assertion after the segment.",
    },
  ];

  return (
    <div className="card f-section">
      <div className="section-title">Onchain checks</div>
      {switches.map((entry) => (
        <label className="switch-row" key={entry.key}>
          <span>
            <span className="switch-label">{entry.label}</span>
            <span className="section-sub">{entry.sub}</span>
          </span>
          <span className="toggle">
            <input
              type="checkbox"
              checked={options[entry.key]}
              onChange={(event) => onOptions({ ...options, [entry.key]: event.target.checked })}
            />
            <span className="toggle-track" />
            <span className="toggle-thumb" />
          </span>
        </label>
      ))}
    </div>
  );
}
