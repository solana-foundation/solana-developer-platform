import { describe } from "@/errors";
import { MINTS } from "@/known";
import { useRing, useShield } from "@/queries";

const SHIELDED_LAMPORTS = 1_000_000_000;
const LAMPORTS_PER_SOL = 1_000_000_000;

/// Each local wallet's private balances. A shielded spend consumes the spender's notes, so the
/// spender shields first. The deposit is public, and the transfers after it are private.
export function PrivacyRing() {
  const ring = useRing();
  const shield = useShield();
  const shielding = shield.isPending ? (shield.variables?.address ?? null) : null;
  const failure = shield.error ?? (ring.noRing ? null : ring.error);

  if (ring.noRing) return null;

  return (
    <div className="card f-section">
      <div>
        <div className="section-title">Solana Privacy Rings</div>
        <div className="section-sub">
          Private balances of each local wallet in the default ring. Only the wallet's viewing key
          reads them.
        </div>
      </div>

      {failure !== null && (
        <div className="callout callout-red error-text">{describe(failure)}</div>
      )}
      {ring.isPending && <div className="section-sub">Reading notes…</div>}

      <div className="data-rows">
        {(ring.data ?? []).map((wallet) => (
          <div className="data-row" key={wallet.address}>
            <span className="dr-label">{wallet.name}</span>
            <span className="dr-value ring-value">
              {(wallet.lamports / LAMPORTS_PER_SOL).toLocaleString()} SOL
              {Object.entries(wallet.tokens ?? {}).map(([mint, amount]) => (
                <span key={mint}>· {tokenAmount(mint, amount)}</span>
              ))}
              <button
                type="button"
                className="btn btn-sec-sm"
                disabled={shielding !== null}
                onClick={() =>
                  shield.mutate({ address: wallet.address, lamports: SHIELDED_LAMPORTS })
                }
              >
                {shielding === wallet.address ? "Shielding…" : "Shield 1 SOL"}
              </button>
            </span>
          </div>
        ))}
      </div>
    </div>
  );
}

/// A known mint's amount in its units, and any other mint's in base units.
function tokenAmount(mint: string, amount: string): string {
  const known = MINTS.find((listed) => listed.address === mint);

  return known === undefined
    ? `${amount} ${mint.slice(0, 4)}…`
    : `${(Number(amount) / 10 ** known.decimals).toLocaleString()} ${known.symbol}`;
}
