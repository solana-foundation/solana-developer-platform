import { useCallback, useEffect, useState } from "react";

import { api, type RingBalance } from "@/api";

const SHIELDED_LAMPORTS = 1_000_000_000;
const LAMPORTS_PER_SOL = 1_000_000_000;

interface Props {
  /// The last landed signature. A new one reads the balances again.
  signature: string | null;
}

/// Each local wallet's private SOL. A shielded spend consumes the spender's notes, so the spender
/// shields SOL first. The deposit is public, and the transfers after it are private.
export function PrivacyRing({ signature }: Props) {
  const [balances, setBalances] = useState<RingBalance[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [shielding, setShielding] = useState<string | null>(null);

  const read = useCallback(() => {
    api
      .ring()
      .then((read) => {
        setBalances(read);
        setError(null);
      })
      .catch((failure: unknown) => setError(String(failure)));
  }, []);

  // The indexer reads a landed transaction a moment after it lands.
  useEffect(() => {
    read();
    if (signature === null) return;

    const timer = setTimeout(read, 3000);

    return () => clearTimeout(timer);
  }, [read, signature]);

  const shield = (wallet: RingBalance) => {
    setShielding(wallet.address);
    api
      .shield(wallet.address, SHIELDED_LAMPORTS)
      .then(() => new Promise((resolve) => setTimeout(resolve, 3000)))
      .then(read)
      .catch((failure: unknown) => setError(String(failure)))
      .finally(() => setShielding(null));
  };

  return (
    <div className="card f-section">
      <div>
        <div className="section-title">Privacy ring</div>
        <div className="section-sub">
          Private SOL of each local wallet. Only the wallet's viewing key reads it.
        </div>
      </div>

      {error !== null && <div className="callout callout-red error-text">{error}</div>}
      {balances === null && error === null && <div className="section-sub">Reading notes…</div>}

      <div className="data-rows">
        {(balances ?? []).map((wallet) => (
          <div className="data-row" key={wallet.address}>
            <span className="dr-label">{wallet.name}</span>
            <span className="dr-value ring-value">
              {(wallet.lamports / LAMPORTS_PER_SOL).toLocaleString()} SOL
              <button
                type="button"
                className="btn btn-sec-sm"
                disabled={shielding !== null}
                onClick={() => shield(wallet)}
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
