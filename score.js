/* score.js — the weekly LockIN score that drives the leaderboard.
 *
 * PURE. No DOM, no network, no Firebase.
 *
 * Design constraint that shaped everything here: Grant and Ashtin will not be
 * running the same program. If the score rewarded raw session count, whoever
 * happened to be on a 5-day split would win every week by default and the
 * competition would be meaningless. So the largest component is ADHERENCE —
 * did you do what YOUR week asked of you — and only a small slice rewards
 * volume above plan. Two people on different programs can both score 100.
 *
 * Weeks are Monday-to-Sunday ISO weeks, the same convention the poker league
 * uses, so "this week" means the same thing in both apps.
 */

/* ============================== ISO weeks ============================== */

/**
 * ISO-8601 week key, e.g. "2026-W34".
 *
 * Uses the standard Thursday rule: the week belongs to whichever year contains
 * its Thursday. That is what keeps the turn of the year from producing a
 * one-day "week 53" that nobody can score.
 */
export function isoWeekKey(d) {
  const date = new Date(Date.UTC(d.getFullYear(), d.getMonth(), d.getDate()));
  const day = date.getUTCDay() || 7;            /* Mon=1 … Sun=7 */
  date.setUTCDate(date.getUTCDate() + 4 - day); /* hop to this week's Thursday */
  const yearStart = new Date(Date.UTC(date.getUTCFullYear(), 0, 1));
  const weekNo = Math.ceil(((date - yearStart) / 86400000 + 1) / 7);
  return `${date.getUTCFullYear()}-W${String(weekNo).padStart(2, '0')}`;
}

/** Monday 00:00 and Sunday 23:59:59.999 local time for a week key. */
export function weekRange(key) {
  const [year, wk] = key.split('-W').map(Number);
  /* Jan 4th is always in ISO week 1. */
  const jan4 = new Date(year, 0, 4);
  const jan4Day = jan4.getDay() || 7;
  const week1Monday = new Date(year, 0, 4 - (jan4Day - 1));
  const start = new Date(week1Monday);
  start.setDate(week1Monday.getDate() + (wk - 1) * 7);
  start.setHours(0, 0, 0, 0);
  const end = new Date(start);
  end.setDate(start.getDate() + 6);
  end.setHours(23, 59, 59, 999);
  return { start, end };
}

/** Local YYYY-MM-DD. Deliberately not toISOString(), which shifts to UTC. */
export function dayKey(d) {
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

/* ============================== streaks ============================== */

/**
 * Consecutive active days ending at `asOf`.
 *
 * Today not being logged yet does not break a streak — at 9am you have not
 * trained yet and it would be absurd to zero someone out. So if `asOf` is
 * missing from the set we start counting at yesterday; only a gap before that
 * ends the run.
 *
 * @param {string[]} activeDates YYYY-MM-DD strings, any order, duplicates fine
 */
export function currentStreak(activeDates, asOf = new Date()) {
  const active = new Set(activeDates || []);
  if (active.size === 0) return 0;

  const cursor = new Date(asOf);
  cursor.setHours(12, 0, 0, 0); /* midday avoids DST arithmetic surprises */
  if (!active.has(dayKey(cursor))) cursor.setDate(cursor.getDate() - 1);

  let streak = 0;
  while (active.has(dayKey(cursor))) {
    streak++;
    cursor.setDate(cursor.getDate() - 1);
  }
  return streak;
}

/* ============================== scoring ============================== */

/* Points available per component. Adherence dominates by design; see the file
   header for why. These sum to 100. */
export const COMPONENTS = [
  { id: 'adherence', label: 'Plan adherence', max: 40,
    hint: 'Sessions your program asked for that you actually did' },
  { id: 'extra', label: 'Extra work', max: 15,
    hint: 'Training above what your plan required' },
  { id: 'nutrition', label: 'Nutrition', max: 20,
    hint: 'Days you logged food and landed near your targets' },
  { id: 'cardio', label: 'Cardio', max: 10,
    hint: 'Minutes against your weekly cardio target' },
  { id: 'streak', label: 'Streak', max: 10,
    hint: 'Consecutive active days, capped at 10' },
  { id: 'checkin', label: 'Check-ins', max: 5,
    hint: 'Weigh-ins and readiness check-ins logged' },
];

export const MAX_SCORE = COMPONENTS.reduce((s, c) => s + c.max, 0);

const clamp01 = (n) => (Number.isFinite(n) ? Math.min(1, Math.max(0, n)) : 0);
const pts = (fraction, max) => Math.round(clamp01(fraction) * max);

/** Default weekly targets, overridable per user in settings. */
export const DEFAULT_TARGETS = {
  plannedSessions: 4,
  cardioMinutes: 90,
  nutritionDays: 7,
  checkins: 3,
};

/**
 * Score one person's week.
 *
 * Every input is already filtered to the week in question by the caller, which
 * keeps this function free of date logic and therefore trivially testable.
 *
 * @param {object}   w
 * @param {number}   w.plannedSessions   sessions the program prescribed
 * @param {number}   w.completedSessions prescribed sessions actually done
 * @param {number}   w.totalSessions     all sessions logged, including extras
 * @param {number}   w.nutritionDaysOnTarget days logged AND within target band
 * @param {number}   w.cardioMinutes
 * @param {number}   w.streak
 * @param {number}   w.checkins          weigh-ins + readiness check-ins
 * @param {object}  [targets]
 * @returns {{total:number, components:Array, max:number}}
 */
export function scoreWeek(w, targets = DEFAULT_TARGETS) {
  const t = { ...DEFAULT_TARGETS, ...targets };

  const planned = Math.max(0, Number(w.plannedSessions) || 0);
  const completed = Math.max(0, Number(w.completedSessions) || 0);
  const total = Math.max(0, Number(w.totalSessions) || 0);

  /* A week with nothing prescribed (rest week, or program not set up yet)
     should not hand out a free 40 points, nor punish with a zero. Fall back to
     the target session count so the number still means something. */
  const denominator = planned > 0 ? planned : t.plannedSessions;

  /* Adherence cannot exceed the plan by definition — you cannot complete five
     of four prescribed sessions. Clamping here matters for more than tidiness:
     the surplus below is measured against this value, so leaving it unclamped
     made a big overshoot (9 done, 4 planned) report ZERO extra work. */
  const credited = Math.min(completed, denominator);
  const adherence = pts(credited / denominator, 40);

  /* Everything above the plan is extra credit, capped so nobody wins the week
     by grinding themselves into the ground. Three bonus sessions maxes it. */
  const extras = Math.max(0, total - credited);
  const extra = pts(extras / 3, 15);

  const nutrition = pts((Number(w.nutritionDaysOnTarget) || 0) / t.nutritionDays, 20);
  const cardio = pts((Number(w.cardioMinutes) || 0) / t.cardioMinutes, 10);
  const streak = pts((Number(w.streak) || 0) / 10, 10);
  const checkin = pts((Number(w.checkins) || 0) / t.checkins, 5);

  const scores = { adherence, extra, nutrition, cardio, streak, checkin };
  const details = {
    adherence: `${credited} of ${denominator} planned`,
    extra: extras > 0 ? `${extras} extra session${extras === 1 ? '' : 's'}` : 'none',
    nutrition: `${Number(w.nutritionDaysOnTarget) || 0} of ${t.nutritionDays} days`,
    cardio: `${Number(w.cardioMinutes) || 0} of ${t.cardioMinutes} min`,
    streak: `${Number(w.streak) || 0} day${(Number(w.streak) || 0) === 1 ? '' : 's'}`,
    checkin: `${Number(w.checkins) || 0} of ${t.checkins}`,
  };

  return {
    total: Object.values(scores).reduce((a, b) => a + b, 0),
    max: MAX_SCORE,
    components: COMPONENTS.map((c) => ({
      ...c, points: scores[c.id], detail: details[c.id],
    })),
  };
}

/**
 * Build the two-person leaderboard.
 *
 * Ties are real and common at this scale, so they are reported rather than
 * broken arbitrarily — "you both hit 84" is a better week than a coin flip.
 */
export function leaderboard(entries) {
  const ranked = [...(entries || [])].sort((a, b) => b.score.total - a.score.total);
  const top = ranked[0]?.score.total ?? 0;
  const tied = ranked.filter((e) => e.score.total === top).length > 1;

  return ranked.map((e, i) => ({
    ...e,
    rank: i + 1,
    leader: e.score.total === top && !tied,
    tied: e.score.total === top && tied,
    gap: top - e.score.total,
  }));
}

/**
 * The one-line summary shown under the leaderboard.
 * Reads the week rather than just restating the numbers.
 */
export function weekSummary(ranked) {
  if (!ranked || ranked.length === 0) return 'No scores yet this week.';
  if (ranked.length === 1) return `${ranked[0].name}: ${ranked[0].score.total} points.`;

  const [first, second] = ranked;
  if (first.tied) return `Dead tie at ${first.score.total}. Somebody do a set of curls.`;
  if (first.score.total - second.score.total <= 3) {
    return `${first.name} leads by ${first.score.total - second.score.total}. Anyone's week.`;
  }
  return `${first.name} leads ${first.score.total} to ${second.score.total}.`;
}
