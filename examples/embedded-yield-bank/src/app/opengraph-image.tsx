import { ImageResponse } from "next/og";

export const alt = "Northstar Bank";
export const size = { width: 1200, height: 630 };
export const contentType = "image/png";

// The sidebar's star mark (lucide "star"), inlined so the card renders with
// no runtime fetch.
const STAR_PATH =
  "M11.525 2.295a.53.53 0 0 1 .95 0l2.31 4.679a2.123 2.123 0 0 0 1.595 1.16l5.166.756a.53.53 0 0 1 .294.904l-3.736 3.638a2.123 2.123 0 0 0-.611 1.878l.882 5.14a.53.53 0 0 1-.771.56l-4.618-2.428a2.122 2.122 0 0 0-1.973 0L6.396 21.01a.53.53 0 0 1-.77-.56l.881-5.139a2.122 2.122 0 0 0-.611-1.879L2.16 9.795a.53.53 0 0 1 .294-.906l5.165-.755a2.122 2.122 0 0 0 1.597-1.16z";

export default function OpengraphImage() {
  return new ImageResponse(
    <div
      style={{
        width: "100%",
        height: "100%",
        display: "flex",
        flexDirection: "column",
        justifyContent: "space-between",
        padding: "72px 80px",
        backgroundColor: "#e9e7de",
        color: "#1c1c1d",
        fontFamily: "sans-serif",
      }}
    >
      <div style={{ display: "flex", alignItems: "center", gap: 18 }}>
        <svg
          width="52"
          height="52"
          viewBox="0 0 24 24"
          fill="#1c1c1d"
          stroke="#1c1c1d"
          strokeWidth="1.5"
          strokeLinecap="round"
          strokeLinejoin="round"
          role="img"
          aria-label="Northstar"
        >
          <path d={STAR_PATH} />
        </svg>
        <div
          style={{ fontSize: 40, fontWeight: 600, letterSpacing: "-0.02em" }}
        >
          Northstar
        </div>
      </div>
      <div style={{ display: "flex", flexDirection: "column", gap: 22 }}>
        <div
          style={{
            fontSize: 80,
            fontWeight: 600,
            letterSpacing: "-0.03em",
            lineHeight: 1.02,
          }}
        >
          Savings that earn.
        </div>
        <div
          style={{
            fontSize: 30,
            lineHeight: 1.4,
            color: "#6d6a63",
            maxWidth: 920,
          }}
        >
          Checking and savings in one place, with savings earning on-chain yield
          through Solana Earn.
        </div>
      </div>
      <div style={{ display: "flex", fontSize: 24, color: "#9c978d" }}>
        Solana devnet demo
      </div>
    </div>,
    size
  );
}
