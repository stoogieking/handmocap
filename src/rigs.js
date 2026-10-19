// Target rigs: the built-in procedural hand rig and the TargetRig wrapper used for any rig
// (built-in or imported glTF). TargetRig records the rest transforms once; every retarget writes
// absolute local transforms computed from those rest values, so nothing accumulates.
import { Group, Bone, Skeleton, SkinnedMesh, MeshStandardMaterial, CapsuleGeometry, BoxGeometry, Matrix4, Vector3, Quaternion, Float32BufferAttribute, Uint16BufferAttribute, Object3D } from 'three';
import { mergeGeometries, mergeVertices } from 'three/addons/utils/BufferGeometryUtils.js';
import { FINGERS, FINGER_BASE, JOINTS } from './canonical.js';
import { TEMPLATE, fingerRestFrame, thumbRestFrame, templateThumbDir } from './handmodel.js';
import { newFrame, quatFromFrame } from './math.js';

const _m = new Matrix4();

// ---------------------------------------------------------------------------------------------
// Rigid-skinned mesh: each piece is a BufferGeometry in its bone's local space, weighted 100% to
// that bone. The mesh is added next to `rootBone` (same parent), the usual glTF skin layout.
export function capsuleAlong(dir, length, radius) {
  const g = new CapsuleGeometry(radius, Math.max(1e-4, length - radius), 3, 8);
  g.translate(0, length / 2, 0);
  g.applyQuaternion(new Quaternion().setFromUnitVectors(new Vector3(0, 1, 0), dir.clone().normalize()));
  return g;
}

export function buildSkinnedMesh(rootBone, bones, pieces, color) {
  const parent = rootBone.parent;
  parent.updateMatrixWorld(true);
  const parentInv = new Matrix4().copy(parent.matrixWorld).invert();
  const geoms = [];
  for (const { bone, geometry } of pieces) {
    let geom = geometry.index ? geometry.toNonIndexed() : geometry;
    const bi = bones.indexOf(bone);
    const n = geom.attributes.position.count;
    geom.applyMatrix4(_m.multiplyMatrices(parentInv, bone.matrixWorld));
    const si = new Uint16Array(n * 4), sw = new Float32Array(n * 4);
    for (let v = 0; v < n; v++) {
      si[v * 4] = bi;
      sw[v * 4] = 1;
    }
    geom.setAttribute('skinIndex', new Uint16BufferAttribute(si, 4));
    geom.setAttribute('skinWeight', new Float32BufferAttribute(sw, 4));
    if (geom.attributes.uv) geom.deleteAttribute('uv');
    if (geom.attributes.normal) geom.deleteAttribute('normal');
    geoms.push(geom);
  }
  const geometry = mergeVertices(mergeGeometries(geoms), 1e-6);
  geometry.computeVertexNormals();
  const mesh = new SkinnedMesh(geometry, new MeshStandardMaterial({ color, roughness: 0.75, metalness: 0 }));
  mesh.name = rootBone.name + '_mesh';
  parent.add(mesh);
  mesh.bind(new Skeleton(bones));
  return mesh;
}

// ---------------------------------------------------------------------------------------------
// Built-in procedural hands. Bone axes follow the canonical bone frame exactly (Y along the bone,
// Z palmar); rest pose = flat open hand facing the camera, fingers up.
export const BUILTIN_PREFIX = { left: 'L_', right: 'R_' };
export const BUILTIN_COLORS = { left: 0x9fb2d8, right: 0xd9a37a }; // left cool, right warm
export const BUILTIN_OFFSET = { left: new Vector3(0.11, 0, 0), right: new Vector3(-0.11, 0, 0) };

export function builtinBoneName(side, joint) {
  return BUILTIN_PREFIX[side] + joint;
}

export function buildProceduralHands() {
  const root = new Group();
  root.name = 'HandMocap_BuiltinHands';
  for (const side of ['left', 'right']) {
    const T = TEMPLATE[side];
    const group = new Group();
    group.name = BUILTIN_PREFIX[side] + 'hand_root';
    group.position.copy(BUILTIN_OFFSET[side]);
    root.add(group);
    const bones = [];
    const segs = [];
    const mk = (name, worldPos, worldQuat, parent) => {
      const b = new Bone();
      b.name = name;
      // local = parentWorld^-1 * world (parent world is pure rotation+translation here)
      const pq = parent ? parent.userData.wq : new Quaternion();
      const pp = parent ? parent.userData.wp : new Vector3();
      b.position.copy(worldPos).sub(pp).applyQuaternion(pq.clone().invert());
      b.quaternion.copy(pq.clone().invert().multiply(worldQuat));
      b.userData.wq = worldQuat.clone();
      b.userData.wp = worldPos.clone();
      if (parent) parent.add(b);
      bones.push(b);
      return b;
    };
    const wrist = mk(builtinBoneName(side, 'wrist'), new Vector3(), new Quaternion(), null);
    group.add(wrist);
    const f = newFrame();
    for (const finger of FINGERS) {
      const b = FINGER_BASE[finger];
      if (finger === 'thumb') thumbRestFrame(templateThumbDir(side), f);
      else fingerRestFrame(T[b], f);
      const q = quatFromFrame(f);
      let parent = wrist;
      for (let s = 0; s < 4; s++) {
        const name = builtinBoneName(side, s < 3 ? finger + (s + 1) : finger + '_tip');
        const bone = mk(name, T[b + s], q, parent);
        if (s < 3) {
          const radius = finger === 'thumb' && s === 0 ? 0.011 : finger === 'pinky' ? 0.0068 - s * 0.0006 : 0.0078 - s * 0.0007;
          segs.push({ bone, geometry: capsuleAlong(new Vector3(0, 1, 0), T[b + s + 1].distanceTo(T[b + s]), radius) });
        }
        parent = bone;
      }
    }
    const palmW = T[5].distanceTo(T[17]) + 0.016;
    const palm = new BoxGeometry(palmW, T[9].y * 0.95, 0.024, 2, 3, 1);
    palm.translate((T[5].x + T[17].x) / 2, T[9].y * 0.47, 0);
    group.updateMatrixWorld(true);
    buildSkinnedMesh(wrist, bones, [...segs, { bone: wrist, geometry: palm }], BUILTIN_COLORS[side]);
    for (const b of bones) {
      delete b.userData.wq;
      delete b.userData.wp;
    }
  }
  return root;
}

export function builtinMapping() {
  const m = { left: {}, right: {} };
  for (const side of ['left', 'right']) for (const j of JOINTS) m[side][j] = builtinBoneName(side, j);
  return m;
}

// ---------------------------------------------------------------------------------------------
// Wrapper for any target rig.
const SKIP_TYPES = new Set(['Mesh', 'SkinnedMesh', 'Line', 'LineSegments', 'Points', 'Sprite', 'PerspectiveCamera', 'OrthographicCamera', 'DirectionalLight', 'PointLight', 'SpotLight', 'AmbientLight', 'HemisphereLight']);

export class TargetRig {
  constructor(root, { name = root.name || 'rig', kind = 'file', fileName = null } = {}) {
    this.root = root;
    this.name = name;
    this.kind = kind;
    this.fileName = fileName;
    this.renamed = [];
    this.nodes = [];
    this.byName = new Map();
    this.depth = new Map();
    root.traverse((o) => {
      if (o === root || SKIP_TYPES.has(o.type) || o.isMesh || o.isLight || o.isCamera) return;
      this.nodes.push(o);
    });
    // Unique, non-empty names are required for mapping and for animation channel binding.
    let k = 0;
    for (const o of this.nodes) {
      let n = o.name || `node_${k}`;
      if (this.byName.has(n)) {
        let i = 1;
        while (this.byName.has(`${n}_${i}`)) i++;
        this.renamed.push([n, `${n}_${i}`]);
        n = `${n}_${i}`;
      }
      o.name = n;
      this.byName.set(n, o);
      k++;
    }
    for (const o of this.nodes) {
      let d = 0, p = o.parent;
      while (p && p !== root) {
        d++;
        p = p.parent;
      }
      this.depth.set(o, d);
    }
    // Exactly-unit rest rotations (glTF validators reject components like 1.0000000000000002).
    for (const o of this.nodes) cleanQuat(o.quaternion);
    this.rest = new Map(this.nodes.map((o) => [o, { p: o.position.clone(), q: o.quaternion.clone(), s: o.scale.clone() }]));
    this.skinnedMeshes = [];
    root.traverse((o) => o.isSkinnedMesh && this.skinnedMeshes.push(o));
    this.deforming = new Set();
    for (const sm of this.skinnedMeshes) {
      const si = sm.geometry.attributes.skinIndex, sw = sm.geometry.attributes.skinWeight;
      if (!si || !sw) continue;
      const used = new Set();
      for (let v = 0; v < si.count; v++) for (let c = 0; c < 4; c++) if (sw.getComponent(v, c) > 1e-4) used.add(si.getComponent(v, c));
      used.forEach((i) => sm.skeleton.bones[i] && this.deforming.add(sm.skeleton.bones[i]));
    }
  }

  get(name) {
    return name ? this.byName.get(name) || null : null;
  }

  resetToRest() {
    for (const [o, r] of this.rest) {
      o.position.copy(r.p);
      o.quaternion.copy(r.q);
      o.scale.copy(r.s);
    }
    this.root.updateMatrixWorld(true);
  }

  // Indented hierarchy listing for the bone browser.
  hierarchyLines(mapped = new Map()) {
    const lines = [];
    const walk = (o, d) => {
      if (this.rest.has(o)) {
        const tags = [];
        if (o.isBone) tags.push('bone');
        if (this.skinnedMeshes.length && !this.deforming.has(o)) tags.push('no skin weights');
        if (mapped.has(o.name)) tags.push('→ ' + mapped.get(o.name));
        lines.push(`${'  '.repeat(d)}${o.name}${tags.length ? '  [' + tags.join(', ') + ']' : ''}`);
        d++;
      }
      for (const c of o.children) walk(c, d);
    };
    walk(this.root, 0);
    return lines;
  }

  // World-space rest position (rig must be at rest when called).
  worldPos(o, out = new Vector3()) {
    return o.getWorldPosition(out);
  }
}

export function cleanQuat(q) {
  q.normalize();
  q.set(Math.max(-1, Math.min(1, q.x)), Math.max(-1, Math.min(1, q.y)), Math.max(-1, Math.min(1, q.z)), Math.max(-1, Math.min(1, q.w)));
  return q;
}

export function isObject3D(o) {
  return o instanceof Object3D;
}
