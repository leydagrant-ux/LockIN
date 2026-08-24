/* program.js — program model, progressive overload, and daily auto-regulation.
 *
 * PURE. No DOM, no network, no Firebase. Everything here is a function of its
 * arguments, which is what lets selftest.js check it exhaustively.
 *
 * The division of labour that keeps this app free: the AI picks exercises for a
 * handful of DAY TEMPLATES, and this module expands those templates across a
 * mesocycle and adapts them day to day. Expansion and adaptation are rules, not
 * generation, so they cost nothing, run instantly offline, and behave the same
 * way every time.
 */

import { BY_ID, MUSCLE_GROUPS, findSwaps, groupOf } from './exercises.js';

/* ============================== goals ============================== */

export const GOALS = {
  lose_fat: {
    label: 'Lose fat',
    /* Calories below maintenance, protein held high to spare lean mass. */
    calorieDelta: -0.20, proteinPerLb: 1.0,
    repRange: [8, 15], defaultRir: 2,
    blurb: 'Keep the weights heavy, let the deficit do the fat loss.',
  },
  build_muscle: {
    label: 'Build muscle',
    calorieDelta: 0.10, proteinPerLb: 1.0,
    repRange: [6, 12], defaultRir: 2,
    blurb: 'Small surplus, progressive overload, sleep.',
  },
  recomp: {
    label: 'Recomposition',
    calorieDelta: 0, proteinPerLb: 1.1,
    repRange: [8, 12], defaultRir: 2,
    blurb: 'Maintenance calories, high protein, push the lifts.',
  },
  strength: {
    label: 'Get stronger',
    calorieDelta: 0.05, proteinPerLb: 0.9,
    repRange: [3, 6], defaultRir: 2,
    blurb: 'Heavy compounds, longer rests, lower reps.',
  },
  endurance: {
    label: 'Endurance',
    calorieDelta: 0, proteinPerLb: 0.8,
    repRange: [12, 20], defaultRir: 3,
    blurb: 'Higher reps, shorter rests, cardio carries the block.',
  },
  general_health: {
    label: 'General health',
    calorieDelta: 0, proteinPerLb: 0.8,
    repRange: [8, 15], defaultRir: 3,
    blurb: 'Move often, get a bit stronger, do not overthink it.',
  },
};

/* ============================== load progression ============================== */

/* Smallest jump that is actually loadable, in pounds. A dumbbell rack steps in
   5 lb pairs, so "add 2.5" is not a real option on a dumbbell press. */
export const INCREMENTS = {
  barbell_lower: 10,
  barbell_upper: 5,
  dumbbell: 5,
  machine: 5,
  isolation: 5,
  bodyweight: 5,
};

const LOWER_MUSCLES = new Set(['quads', 'hamstrings', 'glutes', 'calves', 'adductors', 'abductors']);

/**
 * How much weight to add when an exercise earns a jump.
 * Lower-body barbell work tolerates bigger jumps than upper-body pressing.
 */
export function incrementFor(exerciseId) {
  const ex = BY_ID[exerciseId];
  if (!ex) return INCREMENTS.isolation;

  const eq = new Set(ex.equipment);
  const isLower = ex.primary.some((m) => LOWER_MUSCLES.has(m));

  if (eq.has('barbell') || eq.has('trap_bar') || eq.has('smith')) {
    return isLower ? INCREMENTS.barbell_lower : INCREMENTS.barbell_upper;
  }
  if (eq.has('dumbbell') || eq.has('kettlebell')) return INCREMENTS.dumbbell;
  if (ex.type === 'isolation') return INCREMENTS.isolation;
  return INCREMENTS.machine;
}

/**
 * Double progression: work up the rep range at a fixed load, and once every set
 * reaches the top of the range, add weight and drop back to the bottom.
 *
 * This is the whole strength-progression engine. It is intentionally boring —
 * boring is what makes it correct in the gym at 6am.
 *
 * @param {object} block  prescribed block { exerciseId, sets, repMin, repMax }
 * @param {object} [last] last performance { weight, reps: number[] }
 * @returns {{weight:number, reps:number, sets:number, reason:string, progressed:boolean}}
 */
export function nextTarget(block, last) {
  const { repMin, repMax, sets } = block;

  if (!last || !Array.isArray(last.reps) || last.reps.length === 0) {
    return {
      weight: last?.weight ?? 0, reps: repMin, sets,
      reason: 'First time logging this. Pick a weight you could do for ' + repMax + '.',
      progressed: false,
    };
  }

  const inc = incrementFor(block.exerciseId);
  /* Only sets that were actually performed count toward the decision; a session
     cut short should not be read as a failure to progress. */
  const completed = last.reps.filter((r) => Number.isFinite(r) && r > 0);
  const hitTop = completed.length >= sets && completed.every((r) => r >= repMax);

  if (hitTop) {
    return {
      weight: last.weight + inc, reps: repMin, sets,
      reason: `All ${sets} sets hit ${repMax}. Add ${inc} lb, back to ${repMin} reps.`,
      progressed: true,
    };
  }

  const weakest = Math.min(...completed);
  return {
    weight: last.weight, reps: Math.min(weakest + 1, repMax), sets,
    reason: `Same weight. Beat ${weakest} reps on your worst set.`,
    progressed: false,
  };
}

/* ============================== mesocycle expansion ============================== */

/**
 * Expand day templates into a full mesocycle.
 *
 * Accumulation weeks add a set to compounds partway through and shave RIR each
 * week (the same sets get harder without the load having to jump). The final
 * week is a deload: half the sets, ~90% of the load, RIR way up.
 *
 * @param {object}  template   { name, goal, days: [{ name, focus, blocks: [...] }] }
 * @param {object} [opts]
 * @param {number} [opts.weeks=5]      total weeks INCLUDING the deload
 * @param {boolean}[opts.deload=true]  make the last week a deload
 */
export function expandProgram(template, opts = {}) {
  const weeks = Math.max(1, opts.weeks ?? 5);
  const deload = opts.deload !== false;
  const accumulation = deload ? weeks - 1 : weeks;
  const baseRir = GOALS[template.goal]?.defaultRir ?? 2;

  const out = [];
  for (let w = 1; w <= weeks; w++) {
    const isDeload = deload && w === weeks;

    /* RIR walks down across accumulation, floored at 0 so a long block does not
       end up prescribing negative reps in reserve. */
    const rirDrop = accumulation > 1 ? Math.floor(((w - 1) / (accumulation - 1)) * 2) : 0;
    const weekRir = isDeload ? baseRir + 2 : Math.max(0, baseRir - rirDrop);

    /* One extra set on compounds once past the halfway point. */
    const extraSet = !isDeload && accumulation > 2 && w > Math.ceil(accumulation / 2) ? 1 : 0;

    out.push({
      week: w,
      deload: isDeload,
      label: isDeload ? 'Deload' : `Week ${w}`,
      days: template.days.map((day) => ({
        ...day,
        blocks: day.blocks.map((b) => {
          const ex = BY_ID[b.exerciseId];
          const compound = ex?.type === 'compound';
          const sets = isDeload
            ? Math.max(1, Math.round(b.sets * 0.5))
            : b.sets + (compound ? extraSet : 0);
          return {
            ...b,
            sets,
            rir: weekRir,
            loadFactor: isDeload ? 0.9 : 1,
          };
        }),
      })),
    });
  }
  return { ...template, weeks: out };
}

/* ============================== readiness ============================== */

/* All four inputs are 1-5. Sleep and energy are "more is better"; soreness and
   stress are "more is worse" and get inverted so the average is directional. */
export const READINESS_FIELDS = [
  { id: 'sleep', label: 'Sleep', low: 'Terrible', high: 'Great', invert: false },
  { id: 'energy', label: 'Energy', low: 'Drained', high: 'Fired up', invert: false },
  { id: 'soreness', label: 'Soreness', low: 'None', high: 'Wrecked', invert: true },
  { id: 'stress', label: 'Stress', low: 'Calm', high: 'Slammed', invert: true },
];

/** Average the four inputs onto a 1-5 scale where 5 is "ready to work". */
export function readinessScore(checkin) {
  const v = (k, dflt) => {
    const n = Number(checkin?.[k]);
    return Number.isFinite(n) ? Math.min(5, Math.max(1, n)) : dflt;
  };
  const sleep = v('sleep', 3);
  const energy = v('energy', 3);
  const soreness = 6 - v('soreness', 3);
  const stress = 6 - v('stress', 3);
  return (sleep + energy + soreness + stress) / 4;
}

/* Thresholds are centred on the midpoint of the 1-5 scale: an all-threes
   check-in scores exactly 3.0 and MUST land in `normal`. An earlier cut had
   `normal` starting at 3.25, which quietly trimmed volume on every average day
   — the most common check-in there is silently became a permanent deload. */
export const BANDS = [
  { id: 'primed', min: 4.0, label: 'Primed', setFactor: 1, rirDelta: -1,
    blurb: 'You are ready. Push the top set.' },
  { id: 'normal', min: 3.0, label: 'Normal', setFactor: 1, rirDelta: 0,
    blurb: 'Run the session as written.' },
  { id: 'reduced', min: 2.0, label: 'Reduced', setFactor: 0.8, rirDelta: 1,
    blurb: 'Trim the volume, keep the movement quality.' },
  { id: 'recovery', min: -Infinity, label: 'Recovery', setFactor: 0.5, rirDelta: 2,
    blurb: 'Light day. Showing up is the win.' },
];

/** Which band a readiness score falls into. */
export function readinessBand(score) {
  return BANDS.find((b) => score >= b.min);
}

/**
 * Adapt one prescribed day to how the person actually feels.
 *
 * Two independent adjustments:
 *   1. Global volume and RIR, from the overall readiness band.
 *   2. Per-exercise swaps, when a muscle group was rated sore (>= 4) and the
 *      exercise's PRIMARY muscle sits in that group. Secondary involvement is
 *      left alone — training around soreness, not avoiding all contact.
 *
 * Every change carries a human-readable reason so the UI can explain itself
 * rather than silently rewriting someone's workout.
 *
 * @param {object}   day         { name, focus, blocks: [...] }
 * @param {object}   checkin     { sleep, energy, soreness, stress, soreGroups: string[] }
 * @param {string[]} equipment   the user's active gym profile
 */
export function adjustSession(day, checkin, equipment) {
  const score = readinessScore(checkin);
  const band = readinessBand(score);
  const notes = [];

  if (band.setFactor !== 1 || band.rirDelta !== 0) {
    notes.push(`${band.label}: ${band.blurb}`);
  }

  /* Muscles to train around today. */
  const soreGroups = (checkin?.soreGroups || []).filter((g) => MUSCLE_GROUPS[g]);
  const avoidMuscles = new Set(soreGroups.flatMap((g) => MUSCLE_GROUPS[g]));

  const blocks = day.blocks.map((b) => {
    const sets = Math.max(1, Math.round(b.sets * band.setFactor));
    const rir = Math.max(0, (b.rir ?? 2) + band.rirDelta);
    const ex = BY_ID[b.exerciseId];

    const needsSwap = ex && ex.primary.some((m) => avoidMuscles.has(m));
    if (!needsSwap) return { ...b, sets, rir };

    const [swap] = findSwaps(b.exerciseId, equipment, { avoidMuscles: [...avoidMuscles] });
    if (!swap) {
      /* Nothing available that dodges the sore muscle. Keep the movement but
         pull it back hard rather than dropping it silently. */
      notes.push(`${ex.name}: no swap available, cut to ${Math.max(1, Math.round(sets * 0.5))} lighter sets.`);
      return { ...b, sets: Math.max(1, Math.round(sets * 0.5)), rir: rir + 2, deloaded: true };
    }

    const groups = [...new Set(ex.primary.map(groupOf).filter(Boolean))].join('/');
    notes.push(`${ex.name} → ${swap.name} (${groups} is sore).`);
    return { ...b, exerciseId: swap.id, sets, rir, swappedFrom: b.exerciseId };
  });

  return {
    day: { ...day, blocks },
    score: Math.round(score * 100) / 100,
    band: band.id,
    bandLabel: band.label,
    notes,
    changed: notes.length > 0,
  };
}

/* ============================== volume accounting ============================== */

/* Weekly hard sets per muscle group, the landmarks most hypertrophy programming
   is built around. Below MEV nothing much happens; past MRV you stop recovering. */
export const VOLUME_LANDMARKS = {
  chest: { mev: 8, mav: 16, mrv: 22 },
  back: { mev: 10, mav: 20, mrv: 26 },
  shoulders: { mev: 8, mav: 18, mrv: 24 },
  arms: { mev: 6, mav: 16, mrv: 24 },
  legs: { mev: 10, mav: 20, mrv: 26 },
  core: { mev: 4, mav: 12, mrv: 20 },
};

/**
 * Hard sets per muscle group for a set of days.
 *
 * A primary muscle earns a full set; a secondary earns half, which is the usual
 * convention — an incline press builds triceps, just not like a pushdown does.
 */
export function weeklyVolumeByGroup(days) {
  const totals = Object.fromEntries(Object.keys(MUSCLE_GROUPS).map((g) => [g, 0]));

  for (const day of days || []) {
    for (const b of day.blocks || []) {
      const ex = BY_ID[b.exerciseId];
      if (!ex || ex.type === 'cardio') continue;
      const sets = Number(b.sets) || 0;

      const credited = new Set();
      for (const m of ex.primary) {
        const g = groupOf(m);
        if (g && !credited.has(g)) { totals[g] += sets; credited.add(g); }
      }
      for (const m of ex.secondary) {
        const g = groupOf(m);
        if (g && !credited.has(g)) { totals[g] += sets * 0.5; credited.add(g); }
      }
    }
  }

  for (const g of Object.keys(totals)) totals[g] = Math.round(totals[g] * 10) / 10;
  return totals;
}

/**
 * Compare a week's volume against the landmarks and report anything off.
 * Used to sanity-check a generated program before it is ever shown to the user.
 */
export function validateVolume(days) {
  const totals = weeklyVolumeByGroup(days);
  const issues = [];

  for (const [group, sets] of Object.entries(totals)) {
    const lm = VOLUME_LANDMARKS[group];
    if (!lm) continue;
    if (sets < lm.mev) {
      issues.push({ group, sets, severity: sets === 0 ? 'high' : 'medium',
        message: `${group}: ${sets} sets is below the ${lm.mev} needed to make progress.` });
    } else if (sets > lm.mrv) {
      issues.push({ group, sets, severity: 'medium',
        message: `${group}: ${sets} sets is past the ${lm.mrv} most people recover from.` });
    }
  }
  return { totals, issues, ok: issues.length === 0 };
}

/* ============================== estimated 1RM ============================== */

/**
 * Epley. Exact at 1 rep by construction, and the standard the selftest checks
 * against. Beyond ~12 reps it drifts badly, so callers should not trust it there.
 */
export function epley(weight, reps) {
  if (!Number.isFinite(weight) || !Number.isFinite(reps) || reps < 1) return 0;
  if (reps === 1) return weight;
  return weight * (1 + reps / 30);
}

/** Load that should be good for `reps`, inverted from an estimated 1RM. */
export function loadForReps(e1rm, reps) {
  if (!Number.isFinite(e1rm) || !Number.isFinite(reps) || reps < 1) return 0;
  return e1rm / (1 + reps / 30);
}

/* ============================== overload notes ============================== */

const dayDiff = (from, to) => Math.round(
  (Date.parse(`${to}T00:00:00Z`) - Date.parse(`${from}T00:00:00Z`)) / 86400000,
);

/** The heaviest set of an entry. Reps break a tie, so 135x8 beats 135x5. */
function topSet(sets) {
  const real = (sets || []).filter((s) => Number(s.reps) > 0);
  if (!real.length) return null;
  return real.reduce((best, s) => {
    const w = Number(s.weight) || 0, bw = Number(best.weight) || 0;
    if (w > bw) return s;
    if (w === bw && (Number(s.reps) || 0) > (Number(best.reps) || 0)) return s;
    return best;
  });
}

/**
 * Lifts that have sat at the same load long enough to deserve a nudge.
 *
 * The bar is deliberately high, because the cost of a wrong suggestion is a
 * missed rep or a tweaked shoulder. A lift only qualifies when the TOP SET has
 * been at the same weight for `sessions` sessions running AND that streak
 * spans at least `days` days. Anything still climbing week to week needs no
 * advice and gets none.
 *
 * `ready` separates the two real cases. Hitting the top of the rep range at a
 * stuck weight means add weight. Stuck below it means the reps come first —
 * telling someone to add weight when they cannot finish the set they have is
 * how people get hurt.
 *
 * @param {object[]} workouts  logged sessions, any order, each { date, entries[] }
 * @returns {object[]} longest stall first
 */
export function overloadSuggestions(workouts, opts = {}) {
  const minSessions = opts.sessions ?? 3;
  const minDays = opts.days ?? 14;
  const repTarget = opts.repTarget ?? 10;

  const newestFirst = [...(workouts || [])]
    .filter((w) => w && w.date)
    .sort((a, b) => String(b.date).localeCompare(String(a.date)));

  const runs = new Map();

  for (const w of newestFirst) {
    for (const entry of w.entries || []) {
      const top = topSet(entry.sets);
      if (!top) continue;
      const weight = Number(top.weight) || 0;
      const reps = Number(top.reps) || 0;

      const run = runs.get(entry.exerciseId);
      if (!run) {
        runs.set(entry.exerciseId, {
          exerciseId: entry.exerciseId, weight, sessions: 1,
          bestReps: reps, latest: w.date, oldest: w.date, closed: false,
        });
        continue;
      }
      /* A different load ends the streak. Only the unbroken stretch at the
         CURRENT weight counts, or an old plateau would resurrect itself the
         moment somebody deloaded back down to it. */
      if (run.closed) continue;
      if (weight !== run.weight) { run.closed = true; continue; }
      run.sessions += 1;
      run.bestReps = Math.max(run.bestReps, reps);
      run.oldest = w.date;
    }
  }

  const out = [];
  for (const run of runs.values()) {
    const days = dayDiff(run.oldest, run.latest);
    if (run.sessions < minSessions || days < minDays) continue;

    const ready = run.bestReps >= repTarget;
    const step = incrementFor(run.exerciseId);
    out.push({
      exerciseId: run.exerciseId,
      weight: run.weight,
      bestReps: run.bestReps,
      sessions: run.sessions,
      days,
      ready,
      suggested: ready ? Math.round((run.weight + step) * 100) / 100 : run.weight,
      step,
      repTarget,
    });
  }

  return out.sort((a, b) => b.days - a.days || b.sessions - a.sessions);
}
