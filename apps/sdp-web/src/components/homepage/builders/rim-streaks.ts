import * as THREE from "three";

const SEGS = 20;
const COUNT = 12;
const SPAN = 0.3;
/* the reference's per-frame rates at 60fps, as rates per second: the opacity eases 15% of the way
   a frame, a turn of 0.0001rad a frame counts as turning, and the glow is 300x the turn a frame */
const FADE = -Math.log(1 - 0.15) * 60;
const TURNING = 0.0001 * 60;
const GLOW = 300 / 60;

type Streak = {
  line: THREE.Line<THREE.BufferGeometry, THREE.LineBasicMaterial>;
  position: THREE.BufferAttribute;
  base: number;
  y: number;
  speed: number;
};

/**
 * Twelve short arcs of light around the ring. They show while the scroll
 * turns the ring, run with it, and fade when it stops.
 */
export function createRimStreaks(scene: THREE.Scene, radius: number, band: number) {
  const streaks: Streak[] = [];

  function lay(streak: Streak) {
    const { array } = streak.position;
    for (let j = 0; j <= SEGS; j++) {
      const angle = streak.base + SPAN * (j / SEGS);
      array[j * 3] = Math.cos(angle) * radius;
      array[j * 3 + 1] = streak.y;
      array[j * 3 + 2] = Math.sin(angle) * radius;
    }
    streak.position.needsUpdate = true;
  }

  for (let i = 0; i < COUNT; i++) {
    const position = new THREE.BufferAttribute(new Float32Array((SEGS + 1) * 3), 3);
    const geometry = new THREE.BufferGeometry();
    geometry.setAttribute("position", position);
    const line = new THREE.Line(
      geometry,
      new THREE.LineBasicMaterial({ color: 0xb478ff, transparent: true, opacity: 0 })
    );
    line.frustumCulled = false;
    const streak: Streak = {
      line,
      position,
      base: (i / COUNT) * Math.PI * 2 + Math.random() * 0.4,
      y: (Math.random() - 0.5) * band * 1.3,
      speed: 0.6 + Math.random() * 0.8,
    };
    lay(streak);
    scene.add(line);
    streaks.push(streak);
  }

  return {
    /** `velocity`: how far the scroll turned the ring this frame, in radians; `dt` in seconds. */
    update(velocity: number, dt: number) {
      if (dt <= 0) return;
      const rate = Math.abs(velocity) / dt;
      const turning = rate > TURNING;
      const want = turning ? Math.min(rate * GLOW, 0.95) : 0;
      for (const streak of streaks) {
        const material = streak.line.material;
        material.opacity = THREE.MathUtils.damp(material.opacity, want, FADE, dt);
        if (turning) {
          streak.base += velocity * streak.speed * 1.5;
          lay(streak);
        }
      }
    },
    dispose() {
      for (const streak of streaks) {
        streak.line.geometry.dispose();
        streak.line.material.dispose();
      }
    },
  };
}
