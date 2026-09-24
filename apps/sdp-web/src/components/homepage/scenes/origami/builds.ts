import * as THREE from "three";
import { easeInOutCubic } from "../easing";

const TAU = Math.PI * 2;
const mod = (a: number, n: number) => ((a % n) + n) % n;

export type OrigamiKind = "coins" | "loop" | "balance";

/** A scene's object and how it moves: `tick` places it at `t` seconds. */
export type OrigamiBuild = { group: THREE.Group; tick: (t: number) => void };

/** Eight coins on a ring, tumbling while the ring turns. Issuance: the asset. */
function coins(material: THREE.Material): OrigamiBuild {
  const group = new THREE.Group();
  const ring = new THREE.Group();
  const geometry = new THREE.CylinderGeometry(1, 1, 0.1, 64);
  const tumblers: THREE.Group[] = [];
  for (let i = 0; i < 8; i++) {
    const angle = (i * TAU) / 8 + Math.PI / 4;
    const slot = new THREE.Group();
    slot.position.set(Math.cos(angle) * 3, Math.sin(angle) * 3, 0);
    slot.rotation.z = (i * TAU) / 8;
    const tumbler = new THREE.Group();
    tumbler.rotation.set(0, Math.PI / 8, Math.PI / 2);
    tumbler.add(new THREE.Mesh(geometry, material));
    slot.add(tumbler);
    ring.add(slot);
    tumblers.push(tumbler);
  }
  ring.scale.setScalar(0.6);
  group.add(ring);
  return {
    group,
    tick: (t) => {
      for (const tumbler of tumblers) {
        tumbler.rotation.set(0.6 * t, Math.PI / 8 + 0.6 * t, Math.PI / 2 + 0.6 * t);
      }
      ring.rotation.z = -0.6 * t;
    },
  };
}

/** Twenty plates on a ring, each turning, the ring turning. Payments: the flow. */
function loop(material: THREE.Material): OrigamiBuild {
  const group = new THREE.Group();
  const ring = new THREE.Group();
  const geometry = new THREE.BoxGeometry(1, 0.2, 1);
  const plates: THREE.Mesh[] = [];
  for (let i = 0; i < 20; i++) {
    const angle = (i / 20) * TAU;
    const slot = new THREE.Group();
    slot.rotation.z = angle;
    slot.position.set(Math.cos(angle) * 3, Math.sin(angle) * 3, 0);
    const plate = new THREE.Mesh(geometry, material);
    slot.add(plate);
    ring.add(slot);
    plates.push(plate);
  }
  ring.scale.setScalar(0.6);
  group.add(ring);
  return {
    group,
    tick: (t) => {
      for (const plate of plates) plate.rotation.y = (t / 6) * TAU;
      ring.rotation.z = (t / 24) * TAU;
    },
  };
}

/** A bar with two weights sliding past each other, the bar turning over. Markets: the balance. */
function balance(material: THREE.Material): OrigamiBuild {
  const group = new THREE.Group();
  const bar = new THREE.Mesh(new THREE.BoxGeometry(4, 0.4, 1), material);
  const weightGeometry = new THREE.CylinderGeometry(0.5, 0.5, 1, 48);
  const left = new THREE.Mesh(weightGeometry, material);
  left.rotation.x = Math.PI / 2;
  left.position.set(1.5, 1, 0);
  const right = new THREE.Mesh(weightGeometry, material);
  right.rotation.x = Math.PI / 2;
  right.position.set(-1.5, -1, 0);
  group.add(bar, left, right);
  return {
    group,
    tick: (t) => {
      const phase = mod(t, 4);
      const x =
        phase > 2
          ? -1.5 + 3 * easeInOutCubic((phase - 2) / 2)
          : 1.5 - 3 * easeInOutCubic(phase / 2);
      left.position.x = x;
      right.position.x = -x;
      group.rotation.z = Math.PI * (Math.floor(t / 4) + easeInOutCubic(phase / 4));
    },
  };
}

export const ORIGAMI_BUILDS: Record<OrigamiKind, (material: THREE.Material) => OrigamiBuild> = {
  coins,
  loop,
  balance,
};
