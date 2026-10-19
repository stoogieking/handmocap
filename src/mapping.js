// Layer 5 (target side): bone mapping suggestions, validation and versioned rig profiles.
import { JOINTS, JOINT_INFO, FINGERS, SIDES, PROFILE_SCHEMA, PROFILE_VERSION, CONVENTIONS } from './canonical.js';
import { calibrationToJSON, calibrationFromJSON } from './calibration.js';

// ---------------------------------------------------------------------------------------------
// Name parsing for common conventions: Mixamo (mixamorig:LeftHandIndex1), Unreal (index_01_l,
// hand_l, index_metacarpal_l), Blender metarig/Rigify (f_index.01.L, DEF-thumb.01.L),
// VRM/Unity humanoid (J_Bip_L_Index1, LeftIndexProximal), 3ds Max Biped (Bip01 L Finger01).
export function tokens(name) {
  return String(name)
    .replace(/([a-z])([A-Z])/g, '$1 $2')
    .replace(/([A-Z]+)([A-Z][a-z])/g, '$1 $2')
    .replace(/([A-Za-z])(\d)/g, '$1 $2')
    .replace(/(\d)([A-Za-z])/g, '$1 $2')
    .toLowerCase()
    .split(/[\s_.:\-|/\\]+/)
    .filter(Boolean);
}

const SIDE_TOKENS = { left: new Set(['l', 'left', 'lft', 'lf']), right: new Set(['r', 'right', 'rgt', 'rt']) };
const FINGER_TOKENS = {
  thumb: ['thumb', 'pollex', 'thmb'],
  index: ['index', 'pointer', 'forefinger', 'idx', 'indexfinger'], // not 'fore': ForeArm
  middle: ['middle', 'mid', 'midfinger'],
  ring: ['ring', 'annular'],
  pinky: ['pinky', 'pinkie', 'little', 'small', 'lil'],
};
const CONTROL_TOKENS = new Set(['ik', 'fk', 'ctrl', 'ctr', 'control', 'mch', 'org', 'helper', 'target', 'pole', 'twist', 'socket', 'roll', 'mstr', 'master', 'tweak', 'con', 'jnt_ctrl']);
const META_TOKENS = new Set(['metacarpal', 'meta', 'carpal', 'palm', 'metacarpus']);
const TIP_TOKENS = new Set(['tip', 'end', 'nub', 'top', 'tail', 'leaf']);

export function parseBoneName(name) {
  const t = tokens(name);
  const info = { tokens: t, side: null, finger: null, kind: null, control: false, deformHint: false };
  for (const s of SIDES) if (t.some((x) => SIDE_TOKENS[s].has(x))) info.side = info.side ? 'both' : s;
  if (info.side === 'both') info.side = null;
  if (t.some((x) => CONTROL_TOKENS.has(x))) info.control = true;
  if (t.includes('def')) info.deformHint = true;
  for (const f of FINGERS) if (t.some((x) => FINGER_TOKENS[f].includes(x))) info.finger = info.finger || f;
  // 3ds Max Biped: "Finger0" (thumb) .. "Finger4" (pinky), segments Finger0, Finger01, Finger02
  const fi = t.indexOf('finger');
  if (!info.finger && fi >= 0 && /^\d+$/.test(t[fi + 1] || '')) {
    const n = t[fi + 1];
    info.finger = FINGERS[+n[0]] || null;
  }
  if (info.finger) {
    if (t.some((x) => META_TOKENS.has(x))) info.kind = 'metacarpal';
    else if (t.some((x) => TIP_TOKENS.has(x))) info.kind = 'tip';
    else info.kind = 'finger';
  } else if (t.includes('hand') || t.includes('wrist')) info.kind = 'wrist';
  return info;
}

// Suggest a mapping { left: {joint: nodeName}, right: {...} } for a TargetRig.
export function suggestMapping(rig) {
  const parsed = new Map(rig.nodes.map((o) => [o, parseBoneName(o.name)]));
  // Inherit side from the nearest ancestor that has one (e.g. "Index1" under "LeftHand").
  const sideOf = (o) => {
    for (let p = o; p && p !== rig.root; p = p.parent) {
      const s = parsed.get(p)?.side;
      if (s) return s;
    }
    return null;
  };
  const score = (o, info) => (info.control ? -10 : 0) + (info.deformHint ? 2 : 0) + (rig.deforming.size ? (rig.deforming.has(o) ? 3 : -2) : 0) - 0.01 * (rig.depth.get(o) || 0);
  const mapping = { left: {}, right: {} };
  for (const side of SIDES) {
    const wristCands = rig.nodes.filter((o) => parsed.get(o).kind === 'wrist' && sideOf(o) === side);
    wristCands.sort((a, b) => score(b, parsed.get(b)) - score(a, parsed.get(a)) || rig.depth.get(a) - rig.depth.get(b));
    const wrist = wristCands[0] || null;
    if (wrist) mapping[side].wrist = wrist.name;
    const under = (o) => {
      if (!wrist) return true;
      for (let p = o.parent; p; p = p.parent) if (p === wrist) return true;
      return false;
    };
    for (const f of FINGERS) {
      let cands = rig.nodes.filter((o) => {
        const i = parsed.get(o);
        return i.finger === f && sideOf(o) === side && i.kind !== 'tip' && (f === 'thumb' || i.kind !== 'metacarpal');
      });
      if (cands.some(under)) cands = cands.filter(under);
      const good = cands.filter((o) => !parsed.get(o).control);
      if (good.length) cands = good;
      // Prefer a single chain: if several bones share a depth, keep the best-scoring one per depth.
      const byDepth = new Map();
      for (const o of cands) {
        const d = rig.depth.get(o);
        const cur = byDepth.get(d);
        if (!cur || score(o, parsed.get(o)) > score(cur, parsed.get(cur))) byDepth.set(d, o);
      }
      const chain = [...byDepth.entries()].sort((a, b) => a[0] - b[0]).map((e) => e[1]);
      // A trailing bone without children is a tip/end bone when the chain has 4+ bones.
      const usable = chain.length > 3 ? chain.slice(0, 3) : chain;
      usable.forEach((o, i) => (mapping[side][f + (i + 1)] = o.name));
    }
  }
  return mapping;
}

// ---------------------------------------------------------------------------------------------
// Validation. Returns { errors: [], warnings: [], sides: { left: 'ok'|'partial'|'none'|'error' } }
export function validateMapping(rig, mapping) {
  const errors = [], warnings = [], sides = {};
  const used = new Map();
  for (const side of SIDES) {
    const m = mapping?.[side] || {};
    const names = Object.entries(m).filter(([, n]) => n);
    if (!names.length) {
      sides[side] = 'none';
      continue;
    }
    let sideErr = false;
    for (const [joint, n] of names) {
      if (!JOINT_INFO[joint]) {
        errors.push(`${side}: unknown canonical joint "${joint}"`);
        sideErr = true;
        continue;
      }
      const o = rig.get(n);
      if (!o) {
        errors.push(`${side} ${joint}: bone "${n}" not found in rig`);
        sideErr = true;
        continue;
      }
      if (used.has(n)) {
        errors.push(`bone "${n}" mapped twice (${used.get(n)} and ${side} ${joint})`);
        sideErr = true;
      }
      used.set(n, `${side} ${joint}`);
      if (rig.skinnedMeshes.length && !rig.deforming.has(o)) warnings.push(`${side} ${joint}: "${n}" has no skin weights — it may be a control/helper bone driven by constraints that glTF does not carry; animating it will not deform the mesh`);
    }
    const wrist = rig.get(m.wrist);
    const isDesc = (o, anc) => {
      for (let p = o?.parent; p; p = p.parent) if (p === anc) return true;
      return false;
    };
    if (!wrist) warnings.push(`${side}: no wrist mapped — hand orientation will not be applied`);
    for (const j of JOINTS.slice(1)) {
      const o = rig.get(m[j]);
      if (!o) continue;
      if (wrist && !isDesc(o, wrist)) warnings.push(`${side} ${j}: "${o.name}" is not under the mapped wrist`);
      const parentJ = JOINT_INFO[j].parent;
      const po = rig.get(m[parentJ]);
      if (po && parentJ !== 'wrist' && !isDesc(o, po)) warnings.push(`${side} ${j}: "${o.name}" is not a descendant of the ${parentJ} bone`);
      if (wrist && isDesc(wrist, o)) {
        errors.push(`${side} ${j}: "${o.name}" is an ancestor of the wrist`);
        sideErr = true;
      }
    }
    const fingersMapped = JOINTS.slice(1).filter((j) => m[j]);
    if (fingersMapped.length && !(m.wrist && m.index1 && (m.pinky1 || m.ring1))) {
      errors.push(`${side}: map at least wrist, index1 and pinky1 (or ring1) so the palm frame can be inferred`);
      sideErr = true;
    }
    for (const f of FINGERS) {
      const segs = [1, 2, 3].filter((s) => m[f + s]);
      if (segs.length && segs.length < 3) warnings.push(`${side} ${f}: ${3 - segs.length} segment(s) unmapped — their rotation is folded into the nearest mapped segment`);
    }
    // Non-uniform scale on the path to the hand distorts rotations.
    for (let p = wrist; p; p = p.parent) {
      const s = p.scale;
      if (Math.abs(s.x - s.y) > 1e-3 * Math.abs(s.x) || Math.abs(s.x - s.z) > 1e-3 * Math.abs(s.x)) {
        warnings.push(`${side}: non-uniform scale on "${p.name}" — rotations may be distorted (unsupported)`);
        break;
      }
      if (s.x < 0 || s.y < 0 || s.z < 0) {
        warnings.push(`${side}: negative scale (mirroring) on "${p.name}" — unsupported`);
        break;
      }
    }
    sides[side] = sideErr ? 'error' : fingersMapped.length === 15 && m.wrist ? 'ok' : 'partial';
  }
  return { errors, warnings, sides };
}

// ---------------------------------------------------------------------------------------------
// Rig profile: mapping + axis overrides + calibration + coordinate settings, versioned JSON.
export function rigSignature(rig) {
  let h = 2166136261;
  for (const o of rig.nodes) for (let i = 0; i < o.name.length; i++) h = Math.imul(h ^ o.name.charCodeAt(i), 16777619);
  return { name: rig.name, kind: rig.kind, fileName: rig.fileName, nodeCount: rig.nodes.length, nodeNameHash: (h >>> 0).toString(16) };
}

export function makeProfile(rig, mapping, { axisOverrides = { left: {}, right: {} }, calibration = { left: null, right: null }, settings = {} } = {}) {
  return {
    schema: PROFILE_SCHEMA,
    version: PROFILE_VERSION,
    createdAt: new Date().toISOString(),
    rig: rigSignature(rig),
    mapping,
    axisOverrides,
    calibration: { left: calibrationToJSON(calibration.left), right: calibrationToJSON(calibration.right) },
    settings: {
      wristMode: settings.wristMode || 'absolute',
      rootPolicy: settings.rootPolicy || 'fixed',
      labelConvention: settings.labelConvention || 'reported',
      positionScale: settings.positionScale ?? 'auto',
    },
    conventions: { ...CONVENTIONS, axisOverrides: 'per-bone extra rotation (Euler XYZ degrees) applied to the inferred canonical bone frame' },
  };
}

export function parseProfile(obj, rig = null) {
  if (!obj || obj.schema !== PROFILE_SCHEMA) throw new Error('not a HandMocap rig profile (schema mismatch)');
  if (obj.version !== PROFILE_VERSION) throw new Error(`unsupported rig profile version ${obj.version} (this app reads version ${PROFILE_VERSION})`);
  const warnings = [];
  if (rig) {
    const sig = rigSignature(rig);
    if (sig.nodeNameHash !== obj.rig?.nodeNameHash) warnings.push(`profile was saved for "${obj.rig?.name}" (${obj.rig?.nodeCount} nodes); bone names differ from the current rig`);
  }
  return {
    mapping: { left: { ...(obj.mapping?.left || {}) }, right: { ...(obj.mapping?.right || {}) } },
    axisOverrides: { left: { ...(obj.axisOverrides?.left || {}) }, right: { ...(obj.axisOverrides?.right || {}) } },
    calibration: { left: calibrationFromJSON(obj.calibration?.left), right: calibrationFromJSON(obj.calibration?.right) },
    settings: { ...obj.settings },
    warnings,
  };
}

