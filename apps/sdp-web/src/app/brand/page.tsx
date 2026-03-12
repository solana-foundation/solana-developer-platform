import Image from "next/image";

const colorTokens = [
  { name: "Gray 50", value: "#f6f6f9", var: "--gray-50" },
  { name: "Gray 100", value: "#ededf3", var: "--gray-100" },
  { name: "Gray 200", value: "#dbdae5", var: "--gray-200" },
  { name: "Gray 300", value: "#cbc9d7", var: "--gray-300" },
  { name: "Gray 400", value: "#bbb8c7", var: "--gray-400" },
  { name: "Gray 500", value: "#aca8b7", var: "--gray-500" },
  { name: "Gray 600", value: "#9d98a6", var: "--gray-600" },
  { name: "Gray 700", value: "#8e8a94", var: "--gray-700" },
  { name: "Gray 800", value: "#7b7782", var: "--gray-800" },
  { name: "Gray 900", value: "#69666f", var: "--gray-900" },
  { name: "Gray 1000", value: "#56555c", var: "--gray-1000" },
  { name: "Gray 1100", value: "#444449", var: "--gray-1100" },
  { name: "Gray 1200", value: "#323236", var: "--gray-1200" },
  { name: "Gray 1300", value: "#212123", var: "--gray-1300" },
  { name: "Gray 1400", value: "#0f0f10", var: "--gray-1400" },
];

const typographyScale = [
  { name: "Display", class: "text-display", spec: "36px - 48px fluid" },
  { name: "Title XL", class: "text-title-xl", spec: "28px - 36px fluid" },
  { name: "Title LG", class: "text-title-lg", spec: "22px - 28px fluid" },
  { name: "Title MD", class: "text-title-md", spec: "19px - 24px fluid" },
  { name: "Title SM", class: "text-title-sm", spec: "16px - 19px fluid" },
  { name: "Headline LG", class: "text-headline-lg", spec: "16px static" },
  { name: "Headline MD", class: "text-headline-md", spec: "14px static" },
  { name: "Body LG", class: "text-body-lg", spec: "16px / 1.5" },
  { name: "Body MD", class: "text-body-md", spec: "14px / 1.5" },
  { name: "Body SM", class: "text-body-sm", spec: "12px / 1.5" },
];

const fontWeights = [
  { name: "Regular", value: 450 },
  { name: "Medium", value: 500 },
  { name: "Bold", value: 550 },
  { name: "Semibold", value: 600 },
];

export default function BrandPage() {
  return (
    <div className="space-y-20">
      {/* Hero */}
      <section>
        <h1 className="max-w-[700px] text-[42px] font-medium leading-[0.98] tracking-[-0.5px] md:text-[56px]">
          Brand
        </h1>
        <p className="mt-5 max-w-[560px] text-[16px] font-[450] leading-6 text-[rgba(28,28,29,0.72)]">
          Visual identity, color system, and typography for the Solana Developer
          Platform. Built on the Solana Foundation design system.
        </p>
      </section>

      {/* Logo */}
      <section className="space-y-6">
        <div>
          <h2 className="text-[28px] font-medium leading-[1.1] tracking-[-0.3px]">Logo</h2>
          <p className="mt-2 max-w-[480px] text-[14px] font-[450] leading-[1.5] text-[rgba(28,28,29,0.72)]">
            The Solana logomark. Use on light backgrounds with adequate clear space.
          </p>
        </div>

        <div className="grid gap-4 md:grid-cols-2">
          {/* Light variant */}
          <div className="flex h-[200px] items-center justify-center rounded-[16px] border border-[rgba(28,28,29,0.08)] bg-white">
            <Image src="/landing/solana-logo.svg" alt="Solana logo" width={48} height={44} />
          </div>
          {/* Dark variant */}
          <div className="flex h-[200px] items-center justify-center rounded-[16px] border border-[rgba(28,28,29,0.08)] bg-[#0f0f10]">
            <Image
              src="/landing/solana-logo.svg"
              alt="Solana logo on dark"
              width={48}
              height={44}
              className="invert"
            />
          </div>
        </div>
      </section>

      {/* Color Palette */}
      <section className="space-y-6">
        <div>
          <h2 className="text-[28px] font-medium leading-[1.1] tracking-[-0.3px]">Color</h2>
          <p className="mt-2 max-w-[480px] text-[14px] font-[450] leading-[1.5] text-[rgba(28,28,29,0.72)]">
            Neutral gray palette with transparency-based semantic tokens for text
            and borders.
          </p>
        </div>

        {/* Surface colors */}
        <div className="space-y-3">
          <h3 className="text-[14px] font-medium uppercase tracking-[0.4px] text-[rgba(28,28,29,0.48)]">
            Surface
          </h3>
          <div className="grid grid-cols-2 gap-3 md:grid-cols-4">
            <div className="space-y-2">
              <div className="h-20 rounded-[12px] border border-[rgba(28,28,29,0.08)] bg-[#e9e7de]" />
              <div>
                <p className="text-[13px] font-medium">Sand</p>
                <p className="text-[12px] text-[rgba(28,28,29,0.56)]">#e9e7de</p>
              </div>
            </div>
            <div className="space-y-2">
              <div className="h-20 rounded-[12px] border border-[rgba(28,28,29,0.08)] bg-white" />
              <div>
                <p className="text-[13px] font-medium">White</p>
                <p className="text-[12px] text-[rgba(28,28,29,0.56)]">#ffffff</p>
              </div>
            </div>
            <div className="space-y-2">
              <div className="h-20 rounded-[12px] border border-[rgba(28,28,29,0.08)] bg-[rgba(255,255,255,0.8)]" />
              <div>
                <p className="text-[13px] font-medium">Card</p>
                <p className="text-[12px] text-[rgba(28,28,29,0.56)]">white / 80%</p>
              </div>
            </div>
            <div className="space-y-2">
              <div className="h-20 rounded-[12px] border border-[rgba(28,28,29,0.08)] bg-[#0f0f10]" />
              <div>
                <p className="text-[13px] font-medium">Ink</p>
                <p className="text-[12px] text-[rgba(28,28,29,0.56)]">#0f0f10</p>
              </div>
            </div>
          </div>
        </div>

        {/* Gray scale */}
        <div className="space-y-3">
          <h3 className="text-[14px] font-medium uppercase tracking-[0.4px] text-[rgba(28,28,29,0.48)]">
            Gray scale
          </h3>
          <div className="grid grid-cols-5 gap-1 md:grid-cols-[repeat(15,1fr)]">
            {colorTokens.map((token) => (
              <div key={token.var} className="group space-y-1.5">
                <div
                  className="aspect-square rounded-[8px] border border-[rgba(28,28,29,0.06)] transition-transform group-hover:scale-105"
                  style={{ backgroundColor: token.value }}
                />
                <div className="hidden md:block">
                  <p className="truncate text-[11px] font-medium leading-tight">{token.name}</p>
                  <p className="text-[10px] leading-tight text-[rgba(28,28,29,0.48)]">
                    {token.value}
                  </p>
                </div>
              </div>
            ))}
          </div>
        </div>

        {/* Text emphasis */}
        <div className="space-y-3">
          <h3 className="text-[14px] font-medium uppercase tracking-[0.4px] text-[rgba(28,28,29,0.48)]">
            Text emphasis
          </h3>
          <div className="space-y-0 overflow-hidden rounded-[12px] border border-[rgba(28,28,29,0.08)]">
            {[
              { name: "Extra-high", token: "var(--gray-1400)", opacity: "100%" },
              { name: "High", token: "gray-1400 / 88%", opacity: "88%" },
              { name: "Medium", token: "gray-1400 / 72%", opacity: "72%" },
              { name: "Low", token: "gray-1400 / 56%", opacity: "56%" },
              { name: "Extra-low", token: "gray-1400 / 44%", opacity: "44%" },
            ].map((item, i) => (
              <div
                key={item.name}
                className={[
                  "flex items-center justify-between bg-white px-4 py-3",
                  i > 0 ? "border-t border-[rgba(28,28,29,0.06)]" : "",
                ].join(" ")}
              >
                <span
                  className="text-[15px] font-medium"
                  style={{ color: `color-mix(in srgb, #0f0f10 ${item.opacity}, transparent)` }}
                >
                  {item.name}
                </span>
                <span className="text-[12px] text-[rgba(28,28,29,0.48)]">{item.token}</span>
              </div>
            ))}
          </div>
        </div>
      </section>

      {/* Typography */}
      <section className="space-y-6">
        <div>
          <h2 className="text-[28px] font-medium leading-[1.1] tracking-[-0.3px]">Typography</h2>
          <p className="mt-2 max-w-[480px] text-[14px] font-[450] leading-[1.5] text-[rgba(28,28,29,0.72)]">
            Inter Variable with fluid scaling for display and title sizes. Static
            sizing for body and UI text. Dark mode applies a 0.90 weight multiplier
            to counteract the irradiation illusion.
          </p>
        </div>

        {/* Type scale */}
        <div className="space-y-3">
          <h3 className="text-[14px] font-medium uppercase tracking-[0.4px] text-[rgba(28,28,29,0.48)]">
            Scale
          </h3>
          <div className="space-y-0 overflow-hidden rounded-[16px] border border-[rgba(28,28,29,0.08)]">
            {typographyScale.map((item, i) => (
              <div
                key={item.name}
                className={[
                  "flex items-baseline justify-between bg-white px-5 py-4",
                  i > 0 ? "border-t border-[rgba(28,28,29,0.06)]" : "",
                ].join(" ")}
              >
                <span className={item.class}>{item.name}</span>
                <span className="shrink-0 text-[12px] text-[rgba(28,28,29,0.48)]">
                  {item.spec}
                </span>
              </div>
            ))}
          </div>
        </div>

        {/* Font weights */}
        <div className="space-y-3">
          <h3 className="text-[14px] font-medium uppercase tracking-[0.4px] text-[rgba(28,28,29,0.48)]">
            Weights
          </h3>
          <div className="grid gap-3 md:grid-cols-4">
            {fontWeights.map((w) => (
              <div
                key={w.name}
                className="rounded-[12px] border border-[rgba(28,28,29,0.08)] bg-white px-5 py-4"
              >
                <p className="text-[28px] leading-[1.1]" style={{ fontWeight: w.value }}>
                  Aa
                </p>
                <p className="mt-2 text-[13px] font-medium">{w.name}</p>
                <p className="text-[12px] text-[rgba(28,28,29,0.48)]">{w.value}</p>
              </div>
            ))}
          </div>
        </div>
      </section>

      {/* Spacing & Radius */}
      <section className="space-y-6">
        <div>
          <h2 className="text-[28px] font-medium leading-[1.1] tracking-[-0.3px]">
            Radius
          </h2>
          <p className="mt-2 max-w-[480px] text-[14px] font-[450] leading-[1.5] text-[rgba(28,28,29,0.72)]">
            Consistent border radii across UI elements. Base radius is 10px with
            calculated variants.
          </p>
        </div>

        <div className="grid grid-cols-2 gap-3 md:grid-cols-4">
          {[
            { name: "SM", value: "6px" },
            { name: "MD", value: "8px" },
            { name: "LG", value: "10px" },
            { name: "XL", value: "14px" },
            { name: "2XL", value: "18px" },
            { name: "3XL", value: "22px" },
            { name: "4XL", value: "26px" },
            { name: "Full", value: "9999px" },
          ].map((r) => (
            <div key={r.name} className="space-y-2">
              <div
                className="flex h-20 items-center justify-center border border-[rgba(28,28,29,0.12)] bg-white"
                style={{ borderRadius: r.value }}
              />
              <div>
                <p className="text-[13px] font-medium">{r.name}</p>
                <p className="text-[12px] text-[rgba(28,28,29,0.48)]">{r.value}</p>
              </div>
            </div>
          ))}
        </div>
      </section>

      {/* Buttons */}
      <section className="space-y-6">
        <div>
          <h2 className="text-[28px] font-medium leading-[1.1] tracking-[-0.3px]">Buttons</h2>
          <p className="mt-2 max-w-[480px] text-[14px] font-[450] leading-[1.5] text-[rgba(28,28,29,0.72)]">
            Primary and secondary button variants with four size options.
          </p>
        </div>

        <div className="space-y-3">
          <h3 className="text-[14px] font-medium uppercase tracking-[0.4px] text-[rgba(28,28,29,0.48)]">
            Primary
          </h3>
          <div className="flex flex-wrap items-center gap-3 rounded-[16px] border border-[rgba(28,28,29,0.08)] bg-white p-6">
            <button
              type="button"
              className="inline-flex h-12 items-center justify-center rounded-[12px] bg-[#0f0f10] px-5 text-[16px] font-semibold text-white"
            >
              Extra Large
            </button>
            <button
              type="button"
              className="inline-flex h-10 items-center justify-center rounded-[10px] bg-[#0f0f10] px-[18px] text-[15px] font-semibold text-white"
            >
              Large
            </button>
            <button
              type="button"
              className="inline-flex h-9 items-center justify-center rounded-[8px] bg-[#0f0f10] px-3 text-[14px] font-semibold text-white"
            >
              Medium
            </button>
            <button
              type="button"
              className="inline-flex h-7 items-center justify-center rounded-[6px] bg-[#0f0f10] px-2 text-[13px] font-semibold text-white"
            >
              Small
            </button>
          </div>
        </div>

        <div className="space-y-3">
          <h3 className="text-[14px] font-medium uppercase tracking-[0.4px] text-[rgba(28,28,29,0.48)]">
            Secondary
          </h3>
          <div className="flex flex-wrap items-center gap-3 rounded-[16px] border border-[rgba(28,28,29,0.08)] bg-white p-6">
            <button
              type="button"
              className="inline-flex h-12 items-center justify-center rounded-[12px] bg-[rgba(28,28,29,0.08)] px-5 text-[16px] font-semibold text-[#1c1c1d]"
            >
              Extra Large
            </button>
            <button
              type="button"
              className="inline-flex h-10 items-center justify-center rounded-[10px] bg-[rgba(28,28,29,0.08)] px-[18px] text-[15px] font-semibold text-[#1c1c1d]"
            >
              Large
            </button>
            <button
              type="button"
              className="inline-flex h-9 items-center justify-center rounded-[8px] bg-[rgba(28,28,29,0.08)] px-3 text-[14px] font-semibold text-[#1c1c1d]"
            >
              Medium
            </button>
            <button
              type="button"
              className="inline-flex h-7 items-center justify-center rounded-[6px] bg-[rgba(28,28,29,0.08)] px-2 text-[13px] font-semibold text-[#1c1c1d]"
            >
              Small
            </button>
          </div>
        </div>
      </section>
    </div>
  );
}
