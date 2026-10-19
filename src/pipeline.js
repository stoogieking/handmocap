// Tracking pipeline glue for layers 2-5 (association -> conditioning/solver -> calibration).
// Consumes tracker results, produces canonical frames. Has no DOM, rig or render dependencies,
// so it runs identically in the browser and in node tests.
import { HandAssociator } from './association.js';
import { SideProcessor, DEFAULT_SETTINGS } from './conditioning.js';
import { Calibrator } from './calibration.js';
import { SIDES } from './canonical.js';

export class MocapPipeline {
  constructor(settings = {}) {
    this.settings = { ...DEFAULT_SETTINGS, ...settings };
    this.associator = new HandAssociator();
    this.sides = { left: new SideProcessor('left'), right: new SideProcessor('right') };
    this.calibration = { left: null, right: null };
    this.calibrator = new Calibrator();
    this.lastFrame = null;
    this.lastAssign = null;
  }

  setLabelConvention(c) {
    this.associator.labelConvention = c;
    this.reset();
  }

  // Clear all temporal state (camera change, restart, tab resume after a long gap).
  reset() {
    this.associator.reset();
    for (const s of SIDES) this.sides[s].reset();
    this.lastFrame = null;
  }

  enabled(side) {
    return this.settings.hands === 'both' || this.settings.hands === side;
  }

  // result: { t (s, capture time), width, height, hands: [{ image, world, label, score }] }
  process(result) {
    const t = result.t;
    if (this.lastFrame && t - this.lastFrame.t > 1.0) {
      // Long gap (background tab, stalled camera): stale filters/tracks must not be reused.
      this.associator.reset();
      for (const s of SIDES) this.sides[s]._resetFilters();
    }
    const assign = this.associator.update(result);
    this.lastAssign = assign;
    const frame = { t, hands: { left: null, right: null } };
    const samples = {};
    for (const side of SIDES) {
      const proc = this.sides[side];
      if (!this.enabled(side)) {
        if (proc.lastOut) proc.reset();
        continue;
      }
      const a = assign[side];
      frame.hands[side] = a ? proc.observe(a, t, this.settings, this.calibration[side]) : proc.noObservation(t, this.settings, this.calibration[side]);
      samples[side] = proc.lastSample;
    }
    if (this.calibrator.state === 'countdown' || this.calibrator.state === 'capturing') {
      this.calibrator.update(t, samples, this.settings);
      if (this.calibrator.state === 'done') {
        if (this.calibrator.flipConvention) {
          this.associator.labelConvention = this.associator.labelConvention === 'swap' ? 'reported' : 'swap';
          this.associator.reset();
          for (const s of SIDES) this.sides[s].reset();
        }
        for (const [side, c] of Object.entries(this.calibrator.result)) this.calibration[side] = c;
        // Neutral offsets changed: restart filters so they do not blend across the change.
        for (const s of SIDES) this.sides[s]._resetFilters();
      }
    }
    this.lastFrame = frame;
    return frame;
  }

  startCalibration(t) {
    const sides = SIDES.filter((s) => this.enabled(s));
    this.calibrator.start(t, sides);
  }
}
