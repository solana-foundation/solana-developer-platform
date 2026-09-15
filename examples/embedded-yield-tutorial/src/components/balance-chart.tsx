import {
  balanceAfterDays,
  EARN_APY,
  EARN_DAYS,
  EARN_PRINCIPAL,
} from "@/lib/yield";

const WIDTH = 272;
const HEIGHT = 108;
const SAMPLES = 48;
const PAD_Y = 8;

/**
 * Fast-forwarded balance history: an SVG area chart swept from day 0 up to
 * `day`, showing the balance rising and to the right as yield accrues.
 */
export function BalanceChart({ day }: { day: number }) {
  const max = balanceAfterDays(EARN_PRINCIPAL, EARN_APY, EARN_DAYS);
  const span = max - EARN_PRINCIPAL;

  const points: string[] = [];
  for (let index = 0; index < SAMPLES; index += 1) {
    const dayOfSample = (day * index) / (SAMPLES - 1);
    const value = balanceAfterDays(EARN_PRINCIPAL, EARN_APY, dayOfSample);
    const x = (index / (SAMPLES - 1)) * WIDTH;
    const y =
      HEIGHT - PAD_Y - ((value - EARN_PRINCIPAL) / span) * (HEIGHT - PAD_Y * 2);
    points.push(`${x.toFixed(1)},${y.toFixed(1)}`);
  }
  const line = `M${points.join(" L")}`;
  const area = `${line} L${WIDTH},${HEIGHT} L0,${HEIGHT} Z`;
  const [tipX, tipY] = points[points.length - 1].split(",");

  return (
    <svg
      viewBox={`0 0 ${WIDTH} ${HEIGHT}`}
      className="mt-2 block w-full"
      role="img"
      aria-label="Balance rising over 30 days of yield"
    >
      <defs>
        <linearGradient id="earn-chart-fill" x1="0" y1="0" x2="0" y2="1">
          <stop offset="0%" stopColor="#00875a" stopOpacity="0.22" />
          <stop offset="100%" stopColor="#00875a" stopOpacity="0" />
        </linearGradient>
      </defs>
      <path d={area} fill="url(#earn-chart-fill)" />
      <path
        d={line}
        fill="none"
        stroke="#00875a"
        strokeWidth="2"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
      {day > 0 ? (
        <circle
          cx={tipX}
          cy={tipY}
          r="3"
          fill="#00875a"
          stroke="#ffffff"
          strokeWidth="1.5"
        />
      ) : null}
    </svg>
  );
}
