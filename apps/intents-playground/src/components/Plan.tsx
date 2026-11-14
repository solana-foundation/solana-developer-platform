import type { Recipe, SignStep } from "@/api";
import { explorerUrl, PROGRAMS, shortAddress } from "@/known";
import type { Verified } from "@/verifier";

export function Row({ label, value }: { label: string; value: string }) {
  return (
    <div className="data-row">
      <span className="dr-label">{label}</span>
      <span className="dr-value">{value}</span>
    </div>
  );
}

export function AddressRow({
  label,
  address,
  sub,
}: {
  label: string;
  address: string;
  sub?: string;
}) {
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

export function StepRows({ step, recipe }: { step: SignStep; recipe: Recipe | null }) {
  const transaction = step.transaction;
  const tiers = step.message.match(/\| tier (\d)/g)?.map((tier) => tier.slice(-1));
  const instructions =
    step.instructions === undefined
      ? recipe === "shielded" || recipe === "flow"
        ? "proved by the spender"
        : "signed by the provider"
      : String(step.instructions.length);

  return (
    <div className="data-rows">
      <Row label="Message" value={`${new TextEncoder().encode(step.message).length} bytes`} />
      <Row label="Instructions" value={instructions} />
      <Row label="Compute units" value={step.simulation.unitsConsumed} />
      <Row
        label="Signers"
        value={step.signers.map((signer) => shortAddress(signer.address)).join(", ")}
      />
      <Row label="Tier" value={tiers?.join(", ") ?? "1"} />
      {transaction !== undefined && (
        <Row label="Transaction version" value={String(transaction.version)} />
      )}
      {transaction?.lastValidBlockHeight != null && (
        <Row label="Expires at block height" value={transaction.lastValidBlockHeight} />
      )}
    </div>
  );
}

/// Each instruction with its part of the segment: `verify_intent`, a built instruction, or an
/// onchain check.
export function Instructions({ step }: { step: SignStep }) {
  const part = (position: number, program: string) => {
    if (step.intents.some((planned) => planned.verify === position)) return "verify_intent";
    if (
      step.intents.some((planned) => position >= planned.span.start && position < planned.span.end)
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
          {(step.instructions ?? []).map((instruction, position) => (
            // biome-ignore lint/suspicious/noArrayIndexKey: an instruction's position is its identity.
            <tr key={position}>
              <td>{position}</td>
              <td>
                {PROGRAMS[instruction.programAddress] ?? shortAddress(instruction.programAddress)}
              </td>
              <td>{part(position, instruction.programAddress)}</td>
              <td>{step.simulation.unitsByInstruction[position] ?? "builtin"}</td>
              <td>{instruction.accounts.length}</td>
              <td>{atob(instruction.data).length} B</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

export function VerifiedResult({ verified }: { verified: Verified }) {
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
        ? "The transaction proves the step's message, and every instruction is in a segment."
        : `The message ${verified.matches ? "matches" : "differs"}. Instructions in no segment: ${unverified}.`}
    </div>
  );
}
