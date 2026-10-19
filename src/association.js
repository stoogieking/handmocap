// Layer 2: stable left/right hand association.
//
// MediaPipe returns detections in arbitrary order with a per-frame handedness label. This layer
// keeps persistent tracks (ids survive across frames), matches detections to tracks by image
// position (not array order), and only changes a track's anatomical side when accumulated label
// evidence crosses a hysteresis threshold. Overlapping hands are handled conservatively: no side
// changes and the poses are marked ambiguous so the output layer holds them.
//
// Mirroring never enters here: detections are in raw (unmirrored) camera image coordinates.
// `labelConvention` describes MediaPipe's label semantics for the unmirrored frames we feed:
//   'reported' : the label is the anatomical side (default). Verified with Tasks Vision 1.0.1 and
//                the hand_landmarker.task bundle on unmirrored photos of palm-facing hands: labels
//                matched the hands' chirality and the 3-D palm normals faced the camera.
//   'swap'     : labels assume a mirrored (selfie) input, as the legacy MediaPipe Hands docs state.
// Calibration checks the convention geometrically and switches it automatically if every
// calibrated hand appears palm-away (see calibration.js).
//
// Side evidence per frame = label vote + geometric chirality vote. The geometric vote uses the
// fact that fingers curl toward the palm: under the right-hand hypothesis the fingertips of a
// curled right hand lie on the palmar side (+), of a curled left hand on the dorsal side (-).
// It is silent for flat hands, so the label decides there.

import { Vector3 } from 'three';
import { palmFrame } from './handmodel.js';
import { newFrame } from './math.js';

const PALM = [0, 5, 9, 13, 17];
const _P = Array.from({ length: 21 }, () => new Vector3());
const _F = newFrame();
const _v = new Vector3();

// Returns a vote in [-0.8, 0.8]: > 0 right hand, < 0 left hand, 0 = no geometric evidence.
export function chiralityVote(world) {
  for (let i = 0; i < 21; i++) _P[i].set(world[i * 3], -world[i * 3 + 1], -world[i * 3 + 2]);
  if (palmFrame(_P, 'right', _F) < 0.15) return 0;
  let m = 0;
  for (const b of [5, 9, 13, 17]) {
    _v.subVectors(_P[b + 3], _P[b]);
    const l = _v.length();
    if (l > 1e-6) m += _v.dot(_F.z) / l;
  }
  m /= 4;
  const strength = Math.min(1, Math.max(0, (Math.abs(m) - 0.3) / 0.4));
  return Math.sign(m) * strength * 0.8;
}

export function anatomicalSide(label, convention) {
  const l = String(label).toLowerCase().startsWith('l') ? 'left' : 'right';
  if (convention === 'reported') return l;
  return l === 'left' ? 'right' : 'left';
}

function palmCenterAndSize(image, aspect) {
  let cx = 0, cy = 0;
  for (const i of PALM) {
    cx += image[i * 3];
    cy += image[i * 3 + 1];
  }
  cx /= PALM.length;
  cy /= PALM.length;
  // size: wrist -> middle MCP length in width-normalised units
  const dx = image[27] - image[0], dy = (image[28] - image[1]) / aspect;
  return { cx, cy: cy / aspect, size: Math.max(0.02, Math.hypot(dx, dy)) };
}

export class HandAssociator {
  constructor() {
    this.labelConvention = 'reported';
    this.gate = 2.5; // max match distance in hand sizes
    this.overlap = 0.6; // centres closer than this many hand sizes => ambiguous
    this.flipThreshold = 2.0; // hysteresis on accumulated evidence
    this.evidenceDecay = 0.85;
    this.maxMissing = 0.75; // s before a track is dropped
    this.reset();
  }

  reset() {
    this.tracks = [];
    this.nextId = 1;
  }

  // frame: { t (s), width, height, hands: [{ image, world, label, score }] }
  // Returns { left: assignment|null, right: assignment|null, tracks }
  //   assignment = { id, det, ambiguous, sideConfidence }
  update(frame) {
    const t = frame.t;
    const aspect = frame.width && frame.height ? frame.width / frame.height : 4 / 3;
    const dets = frame.hands.map((h) => {
      const g = palmCenterAndSize(h.image, aspect);
      const side = anatomicalSide(h.label, this.labelConvention);
      const score = h.score ?? 0.5;
      const labelVote = (side === 'right' ? 1 : -1) * Math.max(0, 2 * score - 1);
      const geoVote = h.world ? chiralityVote(h.world) : 0;
      const vote = labelVote + geoVote;
      return { h, ...g, side, score, labelVote, geoVote, vote, voteSide: vote > 0 ? 'right' : vote < 0 ? 'left' : side };
    });

    // Ambiguity: two detections nearly on top of each other.
    let ambiguous = false;
    if (dets.length === 2) {
      const d = Math.hypot(dets[0].cx - dets[1].cx, dets[0].cy - dets[1].cy);
      if (d < this.overlap * Math.min(dets[0].size, dets[1].size)) ambiguous = true;
    }

    // Predict and match (exhaustive over <=2x2 assignments).
    for (const tr of this.tracks) {
      const dt = Math.min(0.2, Math.max(0, t - tr.t));
      tr.px = tr.cx + tr.vx * dt;
      tr.py = tr.cy + tr.vy * dt;
    }
    const cost = (tr, d) => {
      const dist = Math.hypot(tr.px - d.cx, tr.py - d.cy) / Math.max(tr.size, d.size);
      if (dist > this.gate) return Infinity;
      const disagree = d.voteSide !== tr.side ? 0.4 * Math.min(1.5, Math.abs(d.vote)) : 0; // soft evidence
      return dist + disagree;
    };
    const best = bestAssignment(this.tracks, dets, cost);
    const matchedTracks = new Set();
    const matchedDets = new Set();
    for (const [ti, di] of best) {
      const tr = this.tracks[ti], d = dets[di];
      matchedTracks.add(ti);
      matchedDets.add(di);
      const dt = Math.max(1e-3, t - tr.t);
      if (t - tr.t < 0.2) {
        tr.vx = 0.5 * tr.vx + 0.5 * ((d.cx - tr.cx) / dt);
        tr.vy = 0.5 * tr.vy + 0.5 * ((d.cy - tr.cy) / dt);
      } else {
        tr.vx = tr.vy = 0;
      }
      tr.cx = d.cx;
      tr.cy = d.cy;
      tr.size = d.size;
      tr.t = t;
      tr.det = d.h;
      tr.seen = true;
      tr.ambiguous = ambiguous;
      if (!ambiguous) this._evidence(tr, d);
    }
    for (let ti = 0; ti < this.tracks.length; ti++) {
      if (!matchedTracks.has(ti)) {
        this.tracks[ti].seen = false;
        this.tracks[ti].det = null;
      }
    }
    this.tracks = this.tracks.filter((tr) => tr.seen || t - tr.t <= this.maxMissing);
    for (let di = 0; di < dets.length; di++) {
      if (matchedDets.has(di)) continue;
      const d = dets[di];
      const tr = {
        id: 'hand-' + this.nextId++,
        side: d.voteSide,
        strong: 0,
        evidence: (d.voteSide === 'right' ? 1 : -1) * this.flipThreshold * 0.75,
        cx: d.cx, cy: d.cy, px: d.cx, py: d.cy, vx: 0, vy: 0, size: d.size,
        t, det: d.h, seen: true, ambiguous,
      };
      // A new track never takes a side an established visible track already holds.
      const holder = this.tracks.find((o) => o.seen && o.side === tr.side);
      if (holder && Math.abs(holder.evidence) >= Math.abs(tr.evidence)) {
        tr.side = tr.side === 'right' ? 'left' : 'right';
        tr.evidence = -tr.evidence * 0.5;
      }
      this.tracks.push(tr);
    }

    // Resolve conflicts: two visible tracks claiming the same side -> stronger evidence keeps it.
    const out = { left: null, right: null, tracks: this.tracks };
    const visible = this.tracks.filter((tr) => tr.seen);
    for (const side of ['left', 'right']) {
      const claim = visible.filter((tr) => tr.side === side);
      if (!claim.length) continue;
      claim.sort((a, b) => Math.abs(b.evidence) - Math.abs(a.evidence));
      const tr = claim[0];
      out[side] = { id: tr.id, det: tr.det, ambiguous: tr.ambiguous || claim.length > 1, sideConfidence: Math.min(1, Math.abs(tr.evidence) / (2 * this.flipThreshold)) };
    }
    return out;
  }

  _evidence(tr, d) {
    tr.evidence = tr.evidence * this.evidenceDecay + d.vote;
    tr.evidence = Math.max(-3 * this.flipThreshold, Math.min(3 * this.flipThreshold, tr.evidence));
    // A confident label AND clear geometry both contradicting the track for 2 consecutive frames
    // means the identity changed (e.g. hands exchanged places while occluded): flip at once.
    const against = (v) => (tr.side === 'right' ? v < 0 : v > 0);
    if (against(d.labelVote) && Math.abs(d.labelVote) > 0.9 && against(d.geoVote) && Math.abs(d.geoVote) > 0.3) tr.strong = (tr.strong || 0) + 1;
    else tr.strong = 0;
    if (tr.strong >= 2) {
      tr.side = tr.side === 'right' ? 'left' : 'right';
      tr.evidence = (tr.side === 'right' ? 1 : -1) * this.flipThreshold * 1.5;
      tr.strong = 0;
      return;
    }
    if (tr.side === 'left' && tr.evidence > this.flipThreshold) tr.side = 'right';
    else if (tr.side === 'right' && tr.evidence < -this.flipThreshold) tr.side = 'left';
  }
}

function bestAssignment(tracks, dets, cost) {
  let best = [], bestScore = Infinity, bestCount = -1;
  const n = tracks.length, m = dets.length;
  const rec = (ti, used, pairs, score) => {
    if (ti === n) {
      if (pairs.length > bestCount || (pairs.length === bestCount && score < bestScore)) {
        best = pairs.slice();
        bestScore = score;
        bestCount = pairs.length;
      }
      return;
    }
    rec(ti + 1, used, pairs, score); // track unmatched
    for (let di = 0; di < m; di++) {
      if (used & (1 << di)) continue;
      const c = cost(tracks[ti], dets[di]);
      if (!Number.isFinite(c)) continue;
      pairs.push([ti, di]);
      rec(ti + 1, used | (1 << di), pairs, score + c);
      pairs.pop();
    }
  };
  if (n <= 4 && m <= 4) rec(0, 0, [], 0);
  return best;
}
