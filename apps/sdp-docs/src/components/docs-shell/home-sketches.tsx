import type { ReactNode } from "react";

/**
 * Shared canvas for all home-card sketches. Every viewBox must be 314x126 so
 * sketch heights (and card dividers) stay uniform across a row; the x/y offset
 * is chosen per sketch to optically center that drawing's content bounds.
 */
function SketchSvg({ viewBox, children }: { viewBox: string; children: ReactNode }) {
  return (
    <svg viewBox={viewBox} fill="none" aria-hidden="true">
      {children}
    </svg>
  );
}

/** Rounded pill chip with a centered mono micro-label. */
function LabelChip({ x, y, width, label }: { x: number; y: number; width: number; label: string }) {
  return (
    <>
      <rect
        x={x}
        y={y}
        width={width}
        height="18"
        rx="9"
        fill="var(--launch-white)"
        stroke="currentColor"
        strokeOpacity="0.22"
      />
      <text
        x={x + width / 2}
        y={y + 12}
        textAnchor="middle"
        fontSize="10"
        letterSpacing="0.08em"
        fill="currentColor"
        fillOpacity="0.45"
      >
        {label}
      </text>
    </>
  );
}

/** Dashboard window → /v1 API → onchain blocks. */
export function ArchitectureSketch() {
  return (
    <SketchSvg viewBox="6 3 314 126">
      <rect
        x="14"
        y="16"
        width="112"
        height="76"
        rx="6"
        stroke="currentColor"
        strokeOpacity="0.35"
      />
      <line x1="14" y1="34" x2="126" y2="34" stroke="currentColor" strokeOpacity="0.18" />
      <circle cx="23" cy="25" r="2" fill="currentColor" fillOpacity="0.35" />
      <circle cx="31" cy="25" r="2" fill="currentColor" fillOpacity="0.35" />
      <line x1="24" y1="46" x2="80" y2="46" stroke="currentColor" strokeOpacity="0.18" />
      <line x1="24" y1="58" x2="106" y2="58" stroke="currentColor" strokeOpacity="0.12" />
      <line x1="24" y1="70" x2="92" y2="70" stroke="currentColor" strokeOpacity="0.12" />
      <rect x="24" y="78" width="28" height="7" rx="3.5" fill="currentColor" fillOpacity="0.22" />
      <line
        x1="126"
        y1="54"
        x2="160"
        y2="54"
        stroke="currentColor"
        strokeOpacity="0.3"
        strokeDasharray="3 3"
      />
      <rect
        x="160"
        y="41"
        width="66"
        height="26"
        rx="13"
        stroke="currentColor"
        strokeOpacity="0.7"
      />
      <text x="193" y="58" textAnchor="middle" fontSize="12" fill="currentColor">
        /v1 API
      </text>
      <line
        x1="226"
        y1="54"
        x2="260"
        y2="54"
        stroke="currentColor"
        strokeOpacity="0.3"
        strokeDasharray="3 3"
      />
      <rect
        x="260"
        y="20"
        width="52"
        height="20"
        rx="4"
        stroke="currentColor"
        strokeOpacity="0.35"
      />
      <rect
        x="260"
        y="46"
        width="52"
        height="20"
        rx="4"
        stroke="currentColor"
        strokeOpacity="0.45"
      />
      <rect
        x="260"
        y="72"
        width="52"
        height="20"
        rx="4"
        stroke="currentColor"
        strokeOpacity="0.35"
      />
      <line x1="286" y1="40" x2="286" y2="46" stroke="currentColor" strokeOpacity="0.3" />
      <line x1="286" y1="66" x2="286" y2="72" stroke="currentColor" strokeOpacity="0.3" />
      <text
        x="70"
        y="116"
        textAnchor="middle"
        fontSize="10"
        letterSpacing="0.08em"
        fill="currentColor"
        fillOpacity="0.4"
      >
        DASHBOARD
      </text>
      <text
        x="193"
        y="116"
        textAnchor="middle"
        fontSize="10"
        letterSpacing="0.08em"
        fill="currentColor"
        fillOpacity="0.4"
      >
        API
      </text>
      <text
        x="286"
        y="116"
        textAnchor="middle"
        fontSize="10"
        letterSpacing="0.08em"
        fill="currentColor"
        fillOpacity="0.4"
      >
        ONCHAIN
      </text>
    </SketchSvg>
  );
}

/** A transaction passes a policy gate (key in a diamond) and exits signed. */
export function WalletsSketch() {
  return (
    <SketchSvg viewBox="11 7 314 126">
      <rect
        x="29"
        y="57"
        width="46"
        height="26"
        rx="6"
        stroke="currentColor"
        strokeOpacity="0.35"
      />
      <text x="52" y="74" textAnchor="middle" fontSize="12" fill="currentColor" fillOpacity="0.55">
        TX
      </text>
      <line
        x1="75"
        y1="70"
        x2="144"
        y2="70"
        stroke="currentColor"
        strokeOpacity="0.3"
        strokeDasharray="3 3"
      />
      <path d="M174 40 L204 70 L174 100 L144 70 Z" stroke="currentColor" strokeOpacity="0.7" />
      <circle cx="163" cy="70" r="6" stroke="currentColor" strokeOpacity="0.75" />
      <line x1="169" y1="70" x2="188" y2="70" stroke="currentColor" strokeOpacity="0.75" />
      <line x1="183" y1="70" x2="183" y2="76" stroke="currentColor" strokeOpacity="0.75" />
      <line x1="188" y1="70" x2="188" y2="76" stroke="currentColor" strokeOpacity="0.75" />
      <LabelChip x={112} y={10} width={124} label="THRESHOLD 2-OF-3" />
      <line x1="174" y1="28" x2="174" y2="40" stroke="currentColor" strokeOpacity="0.18" />
      <LabelChip x={130} y={112} width={88} label="DAILY LIMIT" />
      <line x1="174" y1="100" x2="174" y2="112" stroke="currentColor" strokeOpacity="0.18" />
      <line
        x1="204"
        y1="70"
        x2="273"
        y2="70"
        stroke="currentColor"
        strokeOpacity="0.3"
        strokeDasharray="3 3"
      />
      <circle cx="290" cy="70" r="17" stroke="currentColor" strokeOpacity="0.7" />
      <path
        d="M283 70 L288 75 L297 64"
        stroke="currentColor"
        strokeOpacity="0.85"
        strokeWidth="1.5"
      />
      <text
        x="290"
        y="104"
        textAnchor="middle"
        fontSize="10"
        letterSpacing="0.08em"
        fill="currentColor"
        fillOpacity="0.4"
      >
        SIGNED
      </text>
    </SketchSvg>
  );
}

/** Token-2022 coin orbited by extension chips. */
export function IssuanceSketch() {
  return (
    <SketchSvg viewBox="17 7 314 126">
      <circle cx="174" cy="70" r="36" stroke="currentColor" strokeOpacity="0.7" />
      <circle
        cx="174"
        cy="70"
        r="28"
        stroke="currentColor"
        strokeOpacity="0.25"
        strokeDasharray="3 3"
      />
      <text x="174" y="74" textAnchor="middle" fontSize="13" fill="currentColor">
        T-22
      </text>
      <line x1="144" y1="50" x2="106" y2="30" stroke="currentColor" strokeOpacity="0.18" />
      <LabelChip x={22} y={18} width={84} label="FREEZE" />
      <line x1="204" y1="50" x2="242" y2="30" stroke="currentColor" strokeOpacity="0.18" />
      <LabelChip x={242} y={18} width={84} label="METADATA" />
      <line x1="144" y1="90" x2="106" y2="110" stroke="currentColor" strokeOpacity="0.18" />
      <LabelChip x={22} y={104} width={84} label="ALLOWLIST" />
      <line x1="204" y1="90" x2="242" y2="110" stroke="currentColor" strokeOpacity="0.18" />
      <LabelChip x={242} y={104} width={84} label="MINT/BURN" />
    </SketchSvg>
  );
}

/** Fiat box ⇄ USDC box with onramp/offramp arrows. */
export function RampsSketch() {
  return (
    <SketchSvg viewBox="17 17 314 126">
      <rect
        x="24"
        y="44"
        width="92"
        height="52"
        rx="8"
        stroke="currentColor"
        strokeOpacity="0.45"
      />
      <text x="70" y="66" textAnchor="middle" fontSize="15" fill="currentColor">
        $
      </text>
      <text
        x="70"
        y="84"
        textAnchor="middle"
        fontSize="11"
        letterSpacing="0.08em"
        fill="currentColor"
        fillOpacity="0.45"
      >
        USD / EUR
      </text>
      <rect
        x="232"
        y="44"
        width="92"
        height="52"
        rx="8"
        stroke="currentColor"
        strokeOpacity="0.45"
      />
      <circle cx="278" cy="62" r="7" stroke="currentColor" strokeOpacity="0.85" />
      <text
        x="278"
        y="84"
        textAnchor="middle"
        fontSize="11"
        letterSpacing="0.08em"
        fill="currentColor"
        fillOpacity="0.45"
      >
        USDC
      </text>
      <line x1="128" y1="58" x2="216" y2="58" stroke="currentColor" strokeOpacity="0.6" />
      <path d="M216 58 L209 54 M216 58 L209 62" stroke="currentColor" strokeOpacity="0.6" />
      <text
        x="172"
        y="48"
        textAnchor="middle"
        fontSize="10"
        letterSpacing="0.08em"
        fill="currentColor"
        fillOpacity="0.45"
      >
        ONRAMP
      </text>
      <line
        x1="216"
        y1="82"
        x2="128"
        y2="82"
        stroke="currentColor"
        strokeOpacity="0.35"
        strokeDasharray="3 3"
      />
      <path d="M128 82 L135 78 M128 82 L135 86" stroke="currentColor" strokeOpacity="0.35" />
      <text
        x="172"
        y="100"
        textAnchor="middle"
        fontSize="10"
        letterSpacing="0.08em"
        fill="currentColor"
        fillOpacity="0.45"
      >
        OFFRAMP
      </text>
      <text
        x="70"
        y="118"
        textAnchor="middle"
        fontSize="10"
        letterSpacing="0.08em"
        fill="currentColor"
        fillOpacity="0.3"
      >
        FIAT
      </text>
      <text
        x="278"
        y="118"
        textAnchor="middle"
        fontSize="10"
        letterSpacing="0.08em"
        fill="currentColor"
        fillOpacity="0.3"
      >
        CRYPTO
      </text>
    </SketchSvg>
  );
}

/** Custody wallet fanning out to recipient addresses. */
export function TransfersSketch() {
  return (
    <SketchSvg viewBox="20 7 314 126">
      <rect x="40" y="54" width="62" height="32" rx="6" stroke="currentColor" strokeOpacity="0.7" />
      <text x="71" y="74" textAnchor="middle" fontSize="12" fill="currentColor">
        WALLET
      </text>
      <line
        x1="102"
        y1="62"
        x2="238"
        y2="20"
        stroke="currentColor"
        strokeOpacity="0.3"
        strokeDasharray="3 3"
      />
      <line x1="102" y1="70" x2="238" y2="70" stroke="currentColor" strokeOpacity="0.45" />
      <line x1="102" y1="78" x2="238" y2="120" stroke="currentColor" strokeOpacity="0.3" />
      <circle cx="248" cy="20" r="10" stroke="currentColor" strokeOpacity="0.4" />
      <circle cx="248" cy="70" r="10" stroke="currentColor" strokeOpacity="0.55" />
      <circle cx="248" cy="120" r="10" stroke="currentColor" strokeOpacity="0.4" />
      <text
        x="268"
        y="24"
        fontSize="10"
        letterSpacing="0.06em"
        fill="currentColor"
        fillOpacity="0.45"
      >
        9xF…3kQ
      </text>
      <text
        x="268"
        y="74"
        fontSize="10"
        letterSpacing="0.06em"
        fill="currentColor"
        fillOpacity="0.45"
      >
        4hT…8mZ
      </text>
      <text
        x="268"
        y="124"
        fontSize="10"
        letterSpacing="0.06em"
        fill="currentColor"
        fillOpacity="0.45"
      >
        Bv2…xW7
      </text>
      <LabelChip x={132} y={32} width={76} label="RECURRING" />
      <LabelChip x={132} y={61} width={76} label="BATCH" />
      <LabelChip x={132} y={90} width={76} label="REQUEST" />
    </SketchSvg>
  );
}

/** Locked market depth curve for the coming-soon Markets card. */
export function MarketsSketch() {
  return (
    <SketchSvg viewBox="17 5 314 126">
      <line x1="24" y1="112" x2="324" y2="112" stroke="currentColor" strokeOpacity="0.18" />
      <line
        x1="24"
        y1="80"
        x2="324"
        y2="80"
        stroke="currentColor"
        strokeOpacity="0.08"
        strokeDasharray="2 4"
      />
      <line
        x1="24"
        y1="48"
        x2="324"
        y2="48"
        stroke="currentColor"
        strokeOpacity="0.08"
        strokeDasharray="2 4"
      />
      <path
        d="M24 104 L64 96 L96 100 L136 78 L168 84 L208 58 L240 64 L280 38 L324 28"
        stroke="currentColor"
        strokeOpacity="0.45"
      />
      <rect x="80" y="86" width="2" height="26" fill="currentColor" fillOpacity="0.18" />
      <rect x="152" y="70" width="2" height="42" fill="currentColor" fillOpacity="0.18" />
      <rect x="224" y="50" width="2" height="62" fill="currentColor" fillOpacity="0.18" />
      <rect x="296" y="36" width="2" height="76" fill="currentColor" fillOpacity="0.18" />
      <circle
        cx="174"
        cy="70"
        r="20"
        fill="var(--launch-white)"
        stroke="currentColor"
        strokeOpacity="0.55"
      />
      <rect
        x="167"
        y="68"
        width="14"
        height="11"
        rx="2"
        stroke="currentColor"
        strokeOpacity="0.75"
      />
      <path d="M169 68 V64 A5 5 0 0 1 179 64 V68" stroke="currentColor" strokeOpacity="0.75" />
    </SketchSvg>
  );
}
