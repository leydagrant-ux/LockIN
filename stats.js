/* stats.js — analytics over logged history.
 *
 * PURE. No DOM, no network, no Firebase.
 *
 * Everything here reads WHAT ACTUALLY HAPPENED (logged workouts, weigh-ins,
 * meals), never what was prescribed. program.js owns the plan; this module owns
 * the record. Keeping those separate is what makes "planned vs actual" possible
 * to show at all.
 *
 * Workout shape consumed throughout:
 *   { id, date: 'YYYY-MM-DD', entries: [ { exerciseId, sets: [ { weight, reps, rir, done } ] } ] }
 */

import { BY_ID, MUSCLE_GROUPS, groupOf } from './exercises.js';
import { epley, GOALS } from './program.js';
import { isoWeekKey, dayKey } from './score.js';

/* A set counts only if it was actually performed. An untouched row in the
   logger is a plan, not a data point, and must never inflate volume. */
const isCompleted = (s) => s && s.done !== false && Number(s.reps) > 0;

/* ============================== per-set ============================== */

/** Best set of a group by estimated 1RM. Null when nothing was completed. */
export function bestSet(sets) {
  let best = null;
  for (const s of sets || []) {
    if (!isCompleted(s)) continue;
    const e1rm = epley(Number(s.weight) || 0, Number(s.reps));
    if (!best || e1rm > best.e1rm) best = { weight: Number(s.weight) || 0, reps: Number(s.reps), e1rm };
  }
  return best;
}

/** Total weight moved in a workout: sum of weight x reps over completed sets. */
export function tonnage(workout) {
  let total = 0;
  for (const entry of workout?.entries || []) {
    for (const s of entry.sets || []) {
      if (isCompleted(s)) total += (Number(s.weight) || 0) * Number(s.reps);
    }
  }
  return total;
}

/** Completed hard sets in a workout. */
export function setCount(workout) {
  let n = 0;
  for (const entry of workout?.entries || []) {
    for (const s of entry.sets || []) if (isCompleted(s)) n++;
  }
  return n;
}

/* ============================== strength over time ============================== */

/**
 * Estimated-1RM series for one exercise, oldest first, one point per session.
 *
 * Epley drifts badly past ~12 reps, so high-rep sets are excluded rather than
 * quietly plotted — a 20-rep back-off set is not evidence of a new max.
 */
export function e1rmSeries(workouts, exerciseId, opts = {}) {
  const maxReps = opts.maxReps ?? 12;
  const out = [];

  for (const w of workouts || []) {
    for (const entry of w.entries || []) {
      if (entry.exerciseId !== exerciseId) continue;
      const usable = (entry.sets || []).filter((s) => isCompleted(s) && Number(s.reps) <= maxReps);
      const best = bestSet(usable);
      if (best) out.push({ date: w.date, ...best, e1rm: Math.round(best.e1rm * 10) / 10 });
    }
  }
  return out.sort((a, b) => a.date.localeCompare(b.date));
}

/**
 * Personal records for an exercise: heaviest weight, best estimated 1RM, and
 * most reps at any load. Each carries the date it happened.
 */
export function personalRecords(workouts, exerciseId) {
  let heaviest = null, bestE1rm = null, mostReps = null;

  for (const w of workouts || []) {
    for (const entry of w.entries || []) {
      if (entry.exerciseId !== exerciseId) continue;
      for (const s of entry.sets || []) {
        if (!isCompleted(s)) continue;
        const weight = Number(s.weight) || 0;
        const reps = Number(s.reps);
        const e1rm = epley(weight, reps);

        if (!heaviest || weight > heaviest.weight) heaviest = { weight, reps, date: w.date };
        if (!bestE1rm || e1rm > bestE1rm.e1rm) {
          bestE1rm = { weight, reps, e1rm: Math.round(e1rm * 10) / 10, date: w.date };
        }
        if (!mostReps || reps > mostReps.reps) mostReps = { weight, reps, date: w.date };
      }
    }
  }
  return { heaviest, bestE1rm, mostReps };
}

/**
 * Sets in `workout` that beat every prior performance. Drives the "NEW PR"
 * badge, so it deliberately only fires on a strict improvement.
 */
export function newPRsIn(workout, history) {
  const prior = (history || []).filter((w) => w.date < workout.date);
  const prs = [];

  for (const entry of workout.entries || []) {
    const before = personalRecords(prior, entry.exerciseId);
    const best = bestSet(entry.sets);
    if (!best) continue;

    const ex = BY_ID[entry.exerciseId];
    if (!ex) continue;

    if (!before.heaviest || best.weight > before.heaviest.weight) {
      prs.push({ exerciseId: entry.exerciseId, name: ex.name, kind: 'weight',
        value: best.weight, previous: before.heaviest?.weight ?? null });
    } else if (!before.bestE1rm || best.e1rm > before.bestE1rm.e1rm) {
      prs.push({ exerciseId: entry.exerciseId, name: ex.name, kind: 'e1rm',
        value: Math.round(best.e1rm * 10) / 10, previous: before.bestE1rm?.e1rm ?? null });
    }
  }
  return prs;
}

/* ============================== volume ============================== */

/**
 * Hard sets per muscle group from LOGGED work.
 *
 * Mirrors the credit rule in program.js: a primary muscle earns a full set, a
 * secondary earns half, and a group is credited at most once per exercise so a
 * squat cannot bill quads and glutes separately into the same "legs" bucket.
 */
export function volumeByGroup(workouts) {
  const totals = Object.fromEntries(Object.keys(MUSCLE_GROUPS).map((g) => [g, 0]));

  for (const w of workouts || []) {
    for (const entry of w.entries || []) {
      const ex = BY_ID[entry.exerciseId];
      if (!ex || ex.type === 'cardio') continue;
      const sets = (entry.sets || []).filter(isCompleted).length;
      if (!sets) continue;

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

/** Weekly volume-by-group buckets, oldest week first. Feeds the stacked chart. */
export function weeklyVolume(workouts) {
  const byWeek = new Map();
  for (const w of workouts || []) {
    const key = isoWeekKey(new Date(w.date + 'T12:00:00'));
    if (!byWeek.has(key)) byWeek.set(key, []);
    byWeek.get(key).push(w);
  }
  return [...byWeek.entries()]
    .sort((a, b) => a[0].localeCompare(b[0]))
    .map(([week, ws]) => ({
      week,
      groups: volumeByGroup(ws),
      sets: ws.reduce((s, w) => s + setCount(w), 0),
      tonnage: ws.reduce((s, w) => s + tonnage(w), 0),
      sessions: ws.length,
    }));
}

/* ============================== bodyweight ============================== */

/**
 * Centred moving average.
 *
 * Daily scale weight is mostly water and yesterday's sodium. The trend line is
 * the only part worth reacting to, and centring it (rather than trailing) keeps
 * it aligned with the raw points instead of lagging a few days behind.
 */
export function movingAverage(series, window = 7, key = 'value') {
  const n = series?.length || 0;
  if (!n) return [];
  const half = Math.floor(window / 2);

  return series.map((point, i) => {
    const lo = Math.max(0, i - half);
    const hi = Math.min(n - 1, i + half);
    let sum = 0, count = 0;
    for (let j = lo; j <= hi; j++) {
      const v = Number(series[j][key]);
      if (Number.isFinite(v)) { sum += v; count++; }
    }
    return { ...point, trend: count ? Math.round((sum / count) * 100) / 100 : null };
  });
}

/**
 * Bodyweight series with trend line and a rate of change.
 *
 * Rate is measured trend-to-trend, never raw-to-raw, so one heavy dinner cannot
 * masquerade as a change in trajectory.
 */
export function weightTrend(metrics, window = 7) {
  const series = (metrics || [])
    .filter((m) => Number.isFinite(Number(m.weight)))
    .map((m) => ({ date: m.date, value: Number(m.weight) }))
    .sort((a, b) => a.date.localeCompare(b.date));

  const withTrend = movingAverage(series, window);
  if (withTrend.length < 2) return { series: withTrend, perWeek: null, total: null };

  const first = withTrend[0];
  const last = withTrend[withTrend.length - 1];
  const days = (new Date(last.date) - new Date(first.date)) / 86400000;
  const delta = (last.trend ?? last.value) - (first.trend ?? first.value);

  return {
    series: withTrend,
    total: Math.round(delta * 10) / 10,
    perWeek: days >= 7 ? Math.round((delta / days) * 7 * 100) / 100 : null,
  };
}

/* ============================== consistency ============================== */

/**
 * Date -> activity level for the heatmap calendar.
 * 0 nothing, 1 cardio only, 2 lifted, 3 lifted and did cardio.
 */
export function activityMap(workouts, cardio) {
  const map = new Map();
  const bump = (date, level) => map.set(date, Math.max(map.get(date) || 0, level));

  for (const w of workouts || []) bump(w.date, 2);
  for (const c of cardio || []) bump(c.date, map.get(c.date) >= 2 ? 3 : 1);
  return map;
}

/** Every date with any logged activity. Feeds currentStreak() in score.js. */
export function activeDates(workouts, cardio) {
  return [...activityMap(workouts, cardio).keys()].sort();
}

/**
 * Grid for a heatmap ending at `end`, oldest first, aligned so each row is a
 * Monday-to-Sunday week matching the scoring convention.
 */
export function heatmapGrid(workouts, cardio, end = new Date(), weeks = 26) {
  const map = activityMap(workouts, cardio);
  const cursor = new Date(end);
  cursor.setHours(12, 0, 0, 0);

  /* Walk forward to the Sunday that closes the final week. */
  const daysToSunday = (7 - (cursor.getDay() || 7)) % 7;
  cursor.setDate(cursor.getDate() + daysToSunday);

  const cells = [];
  for (let i = weeks * 7 - 1; i >= 0; i--) {
    const d = new Date(cursor);
    d.setDate(cursor.getDate() - i);
    const key = dayKey(d);
    cells.push({ date: key, level: map.get(key) || 0 });
  }
  return cells;
}

/* ============================== nutrition ============================== */

/** Sum the macros of a day's meals. */
export function dayMacros(meals) {
  const t = { calories: 0, protein: 0, carbs: 0, fat: 0 };
  for (const m of meals || []) {
    t.calories += Number(m.calories) || 0;
    t.protein += Number(m.protein) || 0;
    t.carbs += Number(m.carbs) || 0;
    t.fat += Number(m.fat) || 0;
  }
  return t;
}

/**
 * Was a day "on target"?
 *
 * Calories use a symmetric tolerance band; protein only has a floor, because
 * nobody has ever damaged a physique by eating extra protein. This asymmetry is
 * deliberate, not an oversight.
 */
export function isDayOnTarget(totals, targets, tolerance = 0.1) {
  if (!targets?.calories) return false;
  const lo = targets.calories * (1 - tolerance);
  const hi = targets.calories * (1 + tolerance);
  const caloriesOk = totals.calories >= lo && totals.calories <= hi;
  const proteinOk = !targets.protein || totals.protein >= targets.protein * (1 - tolerance);
  return caloriesOk && proteinOk;
}

/** Per-day macro totals and on-target flags for a set of meals. */
export function nutritionDays(meals, targets) {
  const byDay = new Map();
  for (const m of meals || []) {
    if (!byDay.has(m.date)) byDay.set(m.date, []);
    byDay.get(m.date).push(m);
  }

  return [...byDay.entries()]
    .sort((a, b) => a[0].localeCompare(b[0]))
    .map(([date, dayMeals]) => {
      const totals = dayMacros(dayMeals);
      return { date, totals, onTarget: isDayOnTarget(totals, targets), meals: dayMeals.length };
    });
}

/* ============================== targets ============================== */

/**
 * Mifflin-St Jeor BMR, the standard clinical estimate.
 * height in inches, weight in pounds, converted internally to metric.
 */
export function bmr({ weight, height, age, sex }) {
  const kg = (Number(weight) || 0) * 0.453592;
  const cm = (Number(height) || 0) * 2.54;
  const a = Number(age) || 30;
  const base = 10 * kg + 6.25 * cm - 5 * a;
  return sex === 'female' ? base - 161 : base + 5;
}

export const ACTIVITY_FACTORS = {
  sedentary: { factor: 1.2, label: 'Desk job, little movement' },
  light: { factor: 1.375, label: 'Light activity, 1-3 days training' },
  moderate: { factor: 1.55, label: 'Moderate, 3-5 days training' },
  active: { factor: 1.725, label: 'Active, 6-7 days training' },
  very_active: { factor: 1.9, label: 'Physical job plus training' },
};

/** Total daily energy expenditure. */
export function tdee(profile) {
  const f = ACTIVITY_FACTORS[profile?.activity]?.factor ?? 1.55;
  return Math.round(bmr(profile) * f);
}

/**
 * Daily calorie and macro targets from profile and goal.
 *
 * Protein is set per pound of bodyweight and fat gets a floor at 20% of
 * calories (hormone production needs it); carbohydrate takes whatever remains,
 * which is the standard way round because carbs are the flexible lever.
 */
export function macroTargets(profile, goal) {
  const goalDef = GOALS[goal] || GOALS.general_health;

  const maintenance = tdee(profile);
  const calories = Math.round(maintenance * (1 + goalDef.calorieDelta));
  const weight = Number(profile?.weight) || 0;

  const protein = Math.round(weight * goalDef.proteinPerLb);
  const fat = Math.round((calories * 0.25) / 9);
  const carbs = Math.max(0, Math.round((calories - protein * 4 - fat * 9) / 4));

  return { calories, protein, carbs, fat, maintenance };
}
