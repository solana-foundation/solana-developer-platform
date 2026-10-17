import * as THREE from "three";

function canvasTexture(size: number, draw: (context: CanvasRenderingContext2D) => void) {
  const canvas = document.createElement("canvas");
  canvas.width = size;
  canvas.height = size;
  const context = canvas.getContext("2d");
  if (context) draw(context);
  const texture = new THREE.CanvasTexture(canvas);
  texture.colorSpace = THREE.SRGBColorSpace;
  return texture;
}

/** A filled disc: the pins and the signal. */
export function discTexture() {
  const texture = canvasTexture(128, (context) => {
    context.fillStyle = "#fff";
    context.beginPath();
    context.arc(64, 64, 60, 0, Math.PI * 2);
    context.fill();
  });
  texture.anisotropy = 4;
  return texture;
}

/** A fine ring: the ripples where a payment leaves and lands. */
export function ringTexture() {
  return canvasTexture(256, (context) => {
    context.strokeStyle = "#fff";
    context.lineWidth = 4;
    context.beginPath();
    context.arc(128, 128, 120, 0, Math.PI * 2);
    context.stroke();
  });
}

/** A soft radial glow: the signal's halo and the bloom under a landing. */
export function haloTexture() {
  return canvasTexture(128, (context) => {
    const gradient = context.createRadialGradient(64, 64, 0, 64, 64, 64);
    gradient.addColorStop(0, "rgba(255,255,255,.9)");
    gradient.addColorStop(0.45, "rgba(255,255,255,.38)");
    gradient.addColorStop(1, "rgba(255,255,255,0)");
    context.fillStyle = gradient;
    context.fillRect(0, 0, 128, 128);
  });
}
