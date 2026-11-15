import {
  type Candidate,
  type CandidateStatus,
  deprecationText,
  type InterfaceDocument,
  type ListedImplementation,
  type ListedInterface,
  type Wallet,
} from "@/api";
import { InputField } from "@/components/InputField";
import { PrivacyRing } from "@/components/PrivacyRing";
import { type FormValues, renderTemplate } from "@/intent";
import { useImplementationVersion } from "@/queries";

interface Props {
  listed: ListedInterface;
  document: InterfaceDocument;
  values: FormValues;
  wallets: Wallet[];
  feePayer: string;
  candidates: Candidate[] | null;
  /// The selected implementation's index, whose definition adds guarantees.
  implementation: ListedImplementation | null;
  candidatesError: string | null;
  selected: Candidate | null;
  onValue: (name: string, value: string) => void;
  onFeePayer: (address: string) => void;
  onSelect: (candidate: Candidate) => void;
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
        {listed.deprecation !== null && (
          <div className="callout callout-amber">{deprecationText(listed.deprecation)}</div>
        )}
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

        <Guarantees {...props} />

        <Implementations {...props} />
        {props.candidates?.some((candidate) => candidate.recipe === "shielded") === true && (
          <PrivacyRing />
        )}
      </div>
    </section>
  );
}

/// The interface's guarantees, which every implementation keeps, then what the selected
/// implementation adds. An implementation can add guarantees and never remove one.
function Guarantees({ document, values, wallets, implementation }: Props) {
  const read = useImplementationVersion(implementation?.id ?? null, implementation?.shown ?? null);
  const added = (read.data?.document.postConditions ?? []).map((condition) => condition.message);
  const message = read.data?.document.message;

  return (
    <div className="card f-section">
      <div className="section-title">Guarantees</div>
      {document.settlement === "async" && (
        <div className="callout callout-amber">
          This is a request. It settles later, outside this transaction, so no guarantee here covers
          what comes back.
          {message !== undefined && <> {renderTemplate(message, values, wallets)}.</>}
        </div>
      )}
      <ul className="guarantees">
        {document.postConditions.map((condition) => (
          <li key={condition}>
            <span className="check">✓</span>
            {renderTemplate(condition, values, wallets)}
          </li>
        ))}
      </ul>
      {implementation !== null && (
        <>
          <div className="section-sub">{implementation.id} adds</div>
          {added.length === 0 ? (
            <div className="section-sub">nothing beyond the interface's guarantees</div>
          ) : (
            <ul className="guarantees">
              {added.map((condition) => (
                <li key={condition}>
                  <span className="check">✓</span>
                  {renderTemplate(condition, values, wallets)}
                </li>
              ))}
            </ul>
          )}
        </>
      )}
    </div>
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
                {candidate.deprecation !== null && (
                  <span className="badge badge-gray">deprecated</span>
                )}
                <StatusBadge status={candidate.status} />
              </span>
            </div>
            {candidate.reason !== null && <div className="sel-card-sub">{candidate.reason}</div>}
            {candidate.deprecation !== null && (
              <div className="sel-card-sub">{deprecationText(candidate.deprecation)}</div>
            )}
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
