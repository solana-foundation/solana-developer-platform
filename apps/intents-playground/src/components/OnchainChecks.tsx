import type { IntentOptions } from "@/intent";

/// The intent's onchain checks. They are options of the request, so they sit beside it.
export function OnchainChecks({
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
      sub: "The registry checks the built instructions against the intent, or limits them to the implementation's programs when it cannot rebuild them.",
    },
    {
      key: "assertions",
      label: "Lighthouse assertions",
      sub: "Each postcondition becomes an assertion after the segment.",
    },
  ];

  return (
    <div className="onchain-checks">
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
