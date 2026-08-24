/* anatomy.js — muscle-map body diagrams.
 *
 * PURE. Emits SVG strings; touches no DOM and no network.
 *
 * The geometry lives in anatomy-paths.js, generated from
 * react-native-body-highlighter (MIT). Hand-drawing this was attempted first
 * and abandoned — see that file's header for why.
 *
 * This module owns everything the artwork does not: mapping muscle ids to drawn
 * regions, the colour ramps, and normalising app data onto 0..1 intensities.
 * Muscle ids are exactly the ids in exercises.js, which is what lets
 * stats.volumeByGroup() feed this with no translation layer in between.
 */

import { ATTRIBUTION, VIEWBOX, OUTLINE, BASE_PARTS, REGIONS } from './anatomy-paths.js';

export { ATTRIBUTION };
export const VIEWS = ['front', 'back'];
export const SEXES = ['male', 'female'];

const keyFor = (sex, view) => `${SEXES.includes(sex) ? sex : 'male'}_${view === 'back' ? 'back' : 'front'}`;

/* ============================== colour ============================== */

const hexToRgb = (h) => {
  const n = parseInt(h.replace('#', ''), 16);
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
};
const rgbToHex = (rgb) =>
  '#' + rgb.map((v) => Math.round(Math.min(255, Math.max(0, v))).toString(16).padStart(2, '0')).join('');

/** Linear blend between two hex colours. */
export function lerpColor(a, b, t) {
  const A = hexToRgb(a), B = hexToRgb(b);
  const k = Math.min(1, Math.max(0, t));
  return rgbToHex([0, 1, 2].map((i) => A[i] + (B[i] - A[i]) * k));
}

/* The body sits a shade darker than an idle muscle, so the figure reads as
   anatomy before any training data lands on it. */
export const BODY_BASE = '#2b323d';
export const BODY_PART = '#39424f';
const GROOVE = '#222831';

/* `heat` shows work done. `fresh` shows recovery headroom, which is the inverse
   reading and needs its own ramp — reversing `heat` would paint an untrained
   muscle bright red. */
export const PALETTES = {
  heat: { idle: '#454e5d', mid: '#c04358', hot: '#ff4f6a' },
  fresh: { idle: '#454e5d', mid: '#3f9b78', hot: '#46e0a4' },
  sore: { idle: '#454e5d', mid: '#c96c37', hot: '#ff9147' },
};

function colorFor(value, palette) {
  const p = PALETTES[palette] || PALETTES.heat;
  const v = Math.min(1, Math.max(0, Number(value) || 0));
  if (v <= 0) return p.idle;
  return v < 0.5
    ? lerpColor(p.idle, p.mid, v / 0.5)
    : lerpColor(p.mid, p.hot, (v - 0.5) / 0.5);
}

/* ============================== render ============================== */

/** Muscle ids a given view can actually show. */
export function musclesInView(view, sex = 'male') {
  const regions = REGIONS[keyFor(sex, view)] || [];
  return [...new Set(regions.flatMap((r) => r.sources))];
}

/**
 * Render a body diagram.
 *
 * @param {object}  o
 * @param {string} [o.sex='male']      'male' | 'female'
 * @param {string} [o.view='front']    'front' | 'back'
 * @param {object} [o.values={}]       muscleId -> 0..1 intensity
 * @param {string} [o.palette='heat']  'heat' | 'fresh' | 'sore'
 * @param {boolean}[o.interactive]     tag regions with data-muscle for taps
 * @param {boolean}[o.outline=true]    draw the body outline underneath
 * @returns {string} an <svg> string
 */
export function bodySVG(o = {}) {
  const view = o.view === 'back' ? 'back' : 'front';
  const sex = SEXES.includes(o.sex) ? o.sex : 'male';
  const key = keyFor(sex, view);
  const values = o.values || {};
  const palette = o.palette || 'heat';

  const paths = (list, attrs) =>
    `<g ${attrs}>${list.map((d) => `<path d="${d}"/>`).join('')}</g>`;

  const layers = [];

  if (o.outline !== false && OUTLINE[key]) {
    layers.push(paths([OUTLINE[key]], `fill="${BODY_BASE}"`));
  }

  /* Head, hands, feet and joints: drawn so the figure is whole, but never
     coloured, because none of them is something you log training against. */
  layers.push(paths(BASE_PARTS[key] || [], `fill="${BODY_PART}"`));

  for (const region of REGIONS[key] || []) {
    /* One drawn region can stand for several muscle ids — the deltoid covers
       the front, side and rear head. Take the strongest value among them so a
       lit muscle is never hidden by a quiet neighbour sharing the shape. */
    const value = Math.max(...region.sources.map((m) => Number(values[m]) || 0));
    const tag = o.interactive
      ? `data-muscle="${region.sources[0]}" data-slug="${region.slug}" class="muscle" tabindex="0" role="button"`
      : 'class="muscle"';
    layers.push(paths(region.paths,
      `${tag} fill="${colorFor(value, palette)}" stroke="${GROOVE}" stroke-width="2" stroke-linejoin="round"`));
  }

  return `<svg viewBox="${VIEWBOX[view]}" xmlns="http://www.w3.org/2000/svg" ` +
    `role="img" aria-label="${sex} body, ${view} view" class="body-svg">${layers.join('')}</svg>`;
}

/* ============================== data mapping ============================== */

/**
 * Normalise raw per-muscle numbers to the 0..1 the renderer wants.
 *
 * Scales against the largest value present rather than a fixed ceiling, so the
 * body always uses its full colour range — otherwise an early, low-volume week
 * renders as a uniformly grey figure that tells you nothing.
 */
export function normalise(raw, opts = {}) {
  const entries = Object.entries(raw || {});
  if (entries.length === 0) return {};

  const max = opts.max ?? Math.max(...entries.map(([, v]) => Number(v) || 0));
  if (!max) return Object.fromEntries(entries.map(([k]) => [k, 0]));

  return Object.fromEntries(entries.map(([k, v]) => [k, Math.min(1, (Number(v) || 0) / max)]));
}

/**
 * Spread group-level values (the six groups from exercises.js) across the
 * individual muscles a diagram draws, so `volumeByGroup` output can paint a
 * body without the caller doing the fan-out.
 */
export function fromGroups(groupValues, muscleGroups) {
  const out = {};
  for (const [group, value] of Object.entries(groupValues || {})) {
    for (const muscle of muscleGroups[group] || []) out[muscle] = value;
  }
  return out;
}

/**
 * Days since each muscle was last trained, mapped to a 0..1 freshness where 1
 * is fully recovered. Drives the "fresh muscle groups" readout.
 *
 * `fullRecoveryDays` is deliberately 3: most groups are ready again inside
 * 48-72 hours, and a longer curve would show everything as perpetually fatigued.
 */
export function freshness(lastTrainedDays, fullRecoveryDays = 3) {
  const out = {};
  for (const [muscle, days] of Object.entries(lastTrainedDays || {})) {
    const d = Number(days);
    out[muscle] = !Number.isFinite(d) ? 1 : Math.min(1, Math.max(0, d / fullRecoveryDays));
  }
  return out;
}
