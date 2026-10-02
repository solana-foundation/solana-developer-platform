import * as THREE from "three";
import { finishMatcap, glowMatcap, outlineColor } from "./materials";

/** How long the whole form-in takes: the last part finishes by then. */
export const FORM_IN_SECONDS = 3.5;

const smoothRamp = (u: number, from: number, to: number) => {
  const x = Math.min(1, Math.max(0, (u - from) / (to - from)));
  return x * x * (3 - 2 * x);
};

/**
 * The headline form-in, in three dimensions: every mesh is first its dashed
 * outline, then brand purple, then its finished skin, one part after another.
 * `play(seconds)` sets the state `seconds` after the start; `finish()` jumps
 * to the end, for reduced motion.
 */
export function makeFormable(root: THREE.Object3D, ground: "paper" | "dark") {
  const glowTexture = glowMatcap();
  const finishTexture = finishMatcap(ground);
  const parts: {
    glow: THREE.MeshMatcapMaterial;
    finish: THREE.MeshMatcapMaterial;
    dash: THREE.LineDashedMaterial;
    edges: THREE.EdgesGeometry;
  }[] = [];

  const meshes: THREE.Mesh[] = [];
  root.traverse((object) => {
    if (object instanceof THREE.Mesh) meshes.push(object);
  });
  for (const mesh of meshes) {
    const glow = new THREE.MeshMatcapMaterial({
      matcap: glowTexture,
      transparent: true,
      opacity: 0,
    });
    const finish = new THREE.MeshMatcapMaterial({
      matcap: finishTexture,
      transparent: true,
      opacity: 0,
    });
    const dash = new THREE.LineDashedMaterial({
      color: outlineColor(ground),
      dashSize: 0.14,
      gapSize: 0.09,
      transparent: true,
      opacity: 0.32,
    });
    mesh.material = glow;
    // The finished skin is a second mesh drawn after the purple, at the same depth.
    const skin = new THREE.Mesh(mesh.geometry, finish);
    skin.renderOrder = 2;
    const edges = new THREE.EdgesGeometry(mesh.geometry, 18);
    const outline = new THREE.LineSegments(edges, dash);
    outline.computeLineDistances();
    outline.renderOrder = 3;
    mesh.add(skin, outline);
    parts.push({ glow, finish, dash, edges });
  }

  const play = (seconds: number) => {
    parts.forEach((part, index) => {
      // The stagger spreads over about 1.2 seconds, whatever the part count.
      const u = seconds - 0.2 - index * (1.2 / Math.max(1, parts.length));
      part.dash.opacity = 0.32 * (1 - smoothRamp(u, 0.7, 1.4));
      part.glow.opacity = smoothRamp(u, 0.45, 1.0);
      part.finish.opacity = smoothRamp(u, 1.3, 2.1);
    });
  };

  return {
    play,
    finish: () => play(FORM_IN_SECONDS),
    dispose: () => {
      for (const part of parts) {
        part.glow.dispose();
        part.finish.dispose();
        part.dash.dispose();
        part.edges.dispose();
      }
      glowTexture.dispose();
      finishTexture.dispose();
    },
  };
}
