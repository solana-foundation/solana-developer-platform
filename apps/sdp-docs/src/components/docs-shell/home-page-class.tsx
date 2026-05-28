"use client";
import { useEffect } from "react";

function pseudoNoise(col: number, row: number): number {
  const n = Math.sin(col * 127.1 + row * 311.7) * 43758.5453;
  return n - Math.floor(n);
}

function drawPattern(canvas: HTMLCanvasElement) {
  const dpr = Math.min(window.devicePixelRatio ?? 1, 2);
  const W = canvas.offsetWidth;
  const H = canvas.offsetHeight;
  if (!W || !H) return;

  canvas.width = W * dpr;
  canvas.height = H * dpr;

  const ctx = canvas.getContext("2d");
  if (!ctx) return;
  ctx.scale(dpr, dpr);
  ctx.clearRect(0, 0, W, H);

  const isDark = document.documentElement.classList.contains("dark");
  const dotRGB = isDark ? "255,255,255" : "0,0,0";
  const maxAlpha = isDark ? 0.1 : 0.14;

  const spacing = 16;
  const cols = Math.ceil(W / spacing) + 1;
  const rows = Math.ceil(H / spacing) + 1;

  for (let col = 0; col < cols; col++) {
    for (let row = 0; row < rows; row++) {
      const x = col * spacing;
      const y = row * spacing;
      const nx = x / W;
      const ny = y / H;

      // Vertical: full at top, fades to zero at 65% height
      const vFade = Math.max(0, (1 - ny / 0.65) ** 2.4);

      // Horizontal: dense at edges, open center
      const centerDist = Math.abs(2 * nx - 1); // 0 = center, 1 = edges
      const hFade = centerDist ** 0.7;

      let strength = vFade * hFade;

      // Deterministic per-dot variation for organic feel
      strength *= 0.72 + pseudoNoise(col, row) * 0.56;

      if (strength < 0.05) continue;

      const alpha = Math.min(strength * (isDark ? 0.16 : 0.22), maxAlpha);
      const radius = 0.8 + strength * 1.4;

      ctx.beginPath();
      ctx.arc(x, y, radius, 0, Math.PI * 2);
      ctx.fillStyle = `rgba(${dotRGB},${alpha.toFixed(3)})`;
      ctx.fill();
    }
  }
}

export function HomePageClass() {
  useEffect(() => {
    document.documentElement.classList.add("docs-is-home");

    const main = document.querySelector<HTMLElement>(".launch-docs-main");
    if (!main) return;

    const canvas = document.createElement("canvas");
    canvas.className = "launch-home-pattern-bg";
    canvas.setAttribute("aria-hidden", "true");
    main.prepend(canvas);

    drawPattern(canvas);

    const ro = new ResizeObserver(() => drawPattern(canvas));
    ro.observe(main);

    // Redraw when light/dark class changes
    const mo = new MutationObserver(() => drawPattern(canvas));
    mo.observe(document.documentElement, { attributes: true, attributeFilter: ["class"] });

    return () => {
      document.documentElement.classList.remove("docs-is-home");
      canvas.remove();
      ro.disconnect();
      mo.disconnect();
    };
  }, []);

  return null;
}
