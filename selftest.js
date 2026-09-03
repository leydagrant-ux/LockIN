/* selftest.js — regression suite over the pure modules.
 *
 * Runs identically in node (`node selftest.js`) and in the browser via
 * selftest.html. Run it after ANY change to exercises.js, program.js, score.js
 * or stats.js.
 *
 * Two kinds of check live here, deliberately:
 *
 *   1. Hand-computed expectations — a human worked the arithmetic out
 *      independently (Mifflin-St Jeor, Epley, the score components), so the
 *      test can catch the implementation being confidently wrong.
 *   2. Invariants swept over large input ranges — ISO week round-trips across
 *      four years, band boundaries across the whole readiness scale. These
 *      catch the off-by-one and boundary bugs that hand-picked cases miss.
 *
 * Lesson carried over from the poker app's equity suite: do NOT write expected
 * values from memory. Every literal below is either derived from a published
 * formula or forced by a definition (ISO-8601, double progression).
 */

import * as X from './exercises.js';
import * as P from './program.js';
import * as S from './score.js';
import * as T from './stats.js';
import * as A from './anatomy.js';

/* ============================== harness ============================== */

const results = [];
let currentSection = 'general';

const section = (name) => { currentSection = name; };

function check(label, condition, detail = '') {
  results.push({ section: currentSection, label, pass: !!condition, detail });
}

function eq(label, actual, expected, detail = '') {
  const pass = Object.is(actual, expected) ||
    (typeof actual === 'number' && typeof expected === 'number' && actual === expected);
  check(label, pass, pass ? detail : `got ${JSON.stringify(actual)}, expected ${JSON.stringify(expected)}`);
}

function near(label, actual, expected, tolerance = 0.01) {
  const pass = Number.isFinite(actual) && Math.abs(actual - expected) <= tolerance;
  check(label, pass, pass ? '' : `got ${actual}, expected ~${expected} (tol ${tolerance})`);
}

function deepEq(label, actual, expected) {
  const a = JSON.stringify(actual), e = JSON.stringify(expected);
  check(label, a === e, a === e ? '' : `got ${a}, expected ${e}`);
}

/* ============================== exercises.js ============================== */

section('exercises');
{
  const ids = X.EXERCISES.map((e) => e.id);
  eq('exercise ids are unique', new Set(ids).size, ids.length);

  const equipment = new Set(X.ALL_EQUIPMENT);
  const badEquip = X.EXERCISES.flatMap((e) => e.equipment.filter((q) => !equipment.has(q)));
  deepEq('every equipment reference resolves', [...new Set(badEquip)], []);

  const muscles = new Set(X.MUSCLES);
  const badMuscle = X.EXERCISES.flatMap((e) => [...e.primary, ...e.secondary].filter((m) => !muscles.has(m)));
  deepEq('every muscle reference resolves', [...new Set(badMuscle)], []);

  const patterns = new Set(X.PATTERNS);
  const badPattern = X.EXERCISES.filter((e) => !patterns.has(e.pattern));
  deepEq('every pattern resolves', badPattern.map((e) => e.id), []);

  /* Every non-cardio lift must credit at least one muscle, or it contributes
     nothing to volume and silently distorts the charts. */
  const noMuscle = X.EXERCISES.filter((e) => e.type !== 'cardio' && e.primary.length === 0);
  deepEq('every lift has a primary muscle', noMuscle.map((e) => e.id), []);

  /* Every muscle group must be trainable with nothing but a floor, otherwise a
     travel week generates an empty session. */
  for (const g of Object.keys(X.MUSCLE_GROUPS)) {
    check(`bodyweight covers ${g}`, X.availableExercises([], { group: g }).length > 0);
  }

  eq('bodyweight profile excludes barbell work',
    X.availableExercises([]).some((e) => e.equipment.includes('barbell')), false);

  check('commercial gym unlocks everything',
    X.availableExercises(X.PRESET_COMMERCIAL_GYM).length === X.EXERCISES.length);

  /* isAvailable is the gate the whole equipment promise rests on. */
  eq('isAvailable rejects a missing requirement',
    X.isAvailable(X.BY_ID.back_squat, ['barbell']), false, 'needs squat_rack too');
  eq('isAvailable accepts a satisfied requirement',
    X.isAvailable(X.BY_ID.back_squat, ['barbell', 'squat_rack']), true);
  eq('isAvailable always allows bodyweight',
    X.isAvailable(X.BY_ID.pushup, []), true);

  /* Swaps must never return the original, and must respect avoidMuscles. */
  const swaps = X.findSwaps('bench_press', X.PRESET_COMMERCIAL_GYM);
  eq('swaps exclude the original', swaps.some((e) => e.id === 'bench_press'), false);
  check('swaps for bench are chest work', swaps[0].primary.includes('chest'));

  const avoided = X.findSwaps('bench_press', X.PRESET_COMMERCIAL_GYM, { avoidMuscles: ['chest'] });
  eq('swaps honour avoidMuscles', avoided.some((e) => e.primary.includes('chest')), false);

  deepEq('swaps for an unknown id are empty', X.findSwaps('not_an_exercise', []), []);

  /* A swap must train something the original trained. Pattern and type are
     tie-breakers only — when they counted toward qualifying, a Bodyweight Squat
     ranked as a swap for a Push-Up on the strength of both being compound. */
  const original = X.BY_ID.pushup;
  const relevant = (e) => e.primary.some((m) => original.primary.includes(m) || original.secondary.includes(m))
    || e.secondary.some((m) => original.primary.includes(m));
  check('every swap shares muscle with the original',
    X.findSwaps('pushup', X.PRESET_COMMERCIAL_GYM).every(relevant));
  eq('an unrelated lift is never offered as a swap',
    X.findSwaps('pushup', X.PRESET_COMMERCIAL_GYM).some((e) => e.id === 'bodyweight_squat'), false);

  /* When nothing legal remains, the answer is an empty list, not a bad swap. */
  deepEq('no legal swap yields nothing rather than nonsense',
    X.findSwaps('pushup', [], { avoidMuscles: ['chest', 'triceps', 'front_delts', 'side_delts', 'rear_delts', 'biceps', 'forearms'] }), []);

  eq('groupOf maps a muscle to its group', X.groupOf('lats'), 'back');
  eq('groupOf returns null for nonsense', X.groupOf('spleen'), null);
}

/* ============================== program.js: epley ============================== */

section('program / estimated 1RM');
{
  /* Epley: 1RM = w * (1 + r/30). At one rep it must be exact by construction. */
  eq('epley is exact at 1 rep', P.epley(225, 1), 225);
  near('epley 100x10 = 133.33', P.epley(100, 10), 133.333, 0.001);
  near('epley 315x5 = 367.5', P.epley(315, 5), 367.5, 0.001);
  eq('epley rejects zero reps', P.epley(100, 0), 0);
  eq('epley rejects garbage', P.epley(NaN, 5), 0);

  /* loadForReps is the algebraic inverse; a round trip must land where it began. */
  near('loadForReps inverts epley', P.loadForReps(P.epley(200, 8), 8), 200, 0.001);
  eq('loadForReps rejects zero reps', P.loadForReps(300, 0), 0);
}

/* ============================== program.js: progression ============================== */

section('program / double progression');
{
  const block = { exerciseId: 'bench_press', sets: 3, repMin: 6, repMax: 8 };

  /* Increments must reflect what is actually loadable on the equipment. */
  eq('barbell lower body jumps 10', P.incrementFor('back_squat'), 10);
  eq('barbell upper body jumps 5', P.incrementFor('bench_press'), 5);
  eq('dumbbells jump 5', P.incrementFor('db_bench'), 5);
  eq('unknown exercise falls back safely', P.incrementFor('nope'), P.INCREMENTS.isolation);

  /* Top of the range on every set is the ONLY trigger for added weight. */
  const up = P.nextTarget(block, { weight: 185, reps: [8, 8, 8] });
  eq('all sets at top adds weight', up.weight, 190);
  eq('and resets to the bottom of the range', up.reps, 6);
  eq('and reports progression', up.progressed, true);

  const hold = P.nextTarget(block, { weight: 185, reps: [8, 8, 7] });
  eq('one short set holds the weight', hold.weight, 185);
  eq('and targets one more than the worst set', hold.reps, 8);
  eq('and reports no progression', hold.progressed, false);

  /* A set cut short must not be read as failure — but it must not earn a jump
     either, since the prescribed volume was not completed. */
  const partial = P.nextTarget(block, { weight: 185, reps: [8, 8] });
  eq('an incomplete session does not add weight', partial.weight, 185);

  const fresh = P.nextTarget(block, null);
  eq('first-ever session starts at the bottom of the range', fresh.reps, 6);
  eq('and does not invent a weight', fresh.weight, 0);

  /* Target reps must never exceed the top of the prescribed range. */
  const capped = P.nextTarget({ ...block, repMax: 8 }, { weight: 185, reps: [8, 8, 5] });
  check('next rep target never exceeds repMax', capped.reps <= 8);
}

/* ============================== program.js: mesocycle ============================== */

section('program / mesocycle expansion');
{
  const template = {
    name: 'Test', goal: 'build_muscle',
    days: [{ name: 'Push', focus: 'chest', blocks: [
      { exerciseId: 'bench_press', sets: 3, repMin: 6, repMax: 10 },
      { exerciseId: 'lateral_raise', sets: 3, repMin: 12, repMax: 15 },
    ] }],
  };

  const meso = P.expandProgram(template, { weeks: 5 });
  eq('produces the requested week count', meso.weeks.length, 5);
  eq('last week is the deload', meso.weeks[4].deload, true);
  eq('earlier weeks are not deloads', meso.weeks[0].deload, false);

  /* Deload must cut volume AND back off the load, or it is not a deload. */
  const deloadBench = meso.weeks[4].days[0].blocks[0];
  check('deload halves the sets', deloadBench.sets < meso.weeks[0].days[0].blocks[0].sets);
  eq('deload backs the load off', deloadBench.loadFactor, 0.9);
  check('deload raises RIR', deloadBench.rir > meso.weeks[0].days[0].blocks[0].rir);

  /* RIR must walk down monotonically across accumulation — that IS the
     intensity progression, so a regression here silently flattens the block. */
  const rirs = meso.weeks.slice(0, 4).map((w) => w.days[0].blocks[0].rir);
  check('RIR is non-increasing through accumulation',
    rirs.every((r, i) => i === 0 || r <= rirs[i - 1]), rirs.join(' -> '));
  check('RIR never goes negative', rirs.every((r) => r >= 0), rirs.join(','));

  /* The extra set lands on compounds only. */
  const lateWeek = meso.weeks[3].days[0];
  const earlyWeek = meso.weeks[0].days[0];
  check('compounds gain a set in the back half',
    lateWeek.blocks[0].sets > earlyWeek.blocks[0].sets);
  eq('isolation work does not gain a set',
    lateWeek.blocks[1].sets, earlyWeek.blocks[1].sets);

  /* A single-week block must not divide by zero in the RIR walk. */
  const single = P.expandProgram(template, { weeks: 1, deload: false });
  eq('a one-week block still expands', single.weeks.length, 1);
  check('and produces a usable RIR', Number.isFinite(single.weeks[0].days[0].blocks[0].rir));
}

/* ============================== program.js: readiness ============================== */

section('program / auto-regulation');
{
  /* All fives means great sleep, great energy, no soreness, no stress. */
  eq('a perfect check-in scores 5',
    P.readinessScore({ sleep: 5, energy: 5, soreness: 1, stress: 1 }), 5);
  eq('the worst check-in scores 1',
    P.readinessScore({ sleep: 1, energy: 1, soreness: 5, stress: 5 }), 1);
  eq('a neutral check-in scores 3',
    P.readinessScore({ sleep: 3, energy: 3, soreness: 3, stress: 3 }), 3);
  eq('missing fields default to neutral', P.readinessScore({}), 3);
  eq('out-of-range input is clamped',
    P.readinessScore({ sleep: 99, energy: 99, soreness: -5, stress: -5 }), 5);

  /* THE property that matters: a neutral check-in must be a neutral day. An
     earlier cut put the `normal` floor at 3.25, so all-threes fell into
     `reduced` and quietly deloaded every ordinary session. */
  eq('a neutral check-in is a normal day',
    P.readinessBand(P.readinessScore({ sleep: 3, energy: 3, soreness: 3, stress: 3 })).id, 'normal');

  /* Boundaries are inclusive at the minimum. */
  eq('4.0 is primed', P.readinessBand(4.0).id, 'primed');
  eq('3.99 is normal', P.readinessBand(3.99).id, 'normal');
  eq('3.0 is normal', P.readinessBand(3.0).id, 'normal');
  eq('2.99 is reduced', P.readinessBand(2.99).id, 'reduced');
  eq('2.0 is reduced', P.readinessBand(2.0).id, 'reduced');
  eq('1.99 is recovery', P.readinessBand(1.99).id, 'recovery');
  eq('the floor is recovery', P.readinessBand(1).id, 'recovery');

  let banded = true;
  for (let s = 1; s <= 5; s = Math.round((s + 0.01) * 100) / 100) {
    if (!P.readinessBand(s)) banded = false;
  }
  check('every score in 1..5 lands in a band', banded);

  const day = { name: 'Push', focus: 'chest', blocks: [
    { exerciseId: 'bench_press', sets: 4, repMin: 6, repMax: 10, rir: 2 },
    { exerciseId: 'lateral_raise', sets: 3, repMin: 12, repMax: 15, rir: 2 },
  ] };
  const gym = X.PRESET_COMMERCIAL_GYM;

  const normal = P.adjustSession(day, { sleep: 3, energy: 3, soreness: 3, stress: 3 }, gym);
  eq('a normal day is left alone', normal.changed, false);
  eq('and keeps the prescribed sets', normal.day.blocks[0].sets, 4);

  const rough = P.adjustSession(day, { sleep: 1, energy: 1, soreness: 5, stress: 5 }, gym);
  eq('a wrecked day drops to recovery', rough.band, 'recovery');
  check('and cuts the volume', rough.day.blocks[0].sets < 4);
  check('and raises RIR', rough.day.blocks[0].rir > 2);

  /* Sore chest must move bench off the chest, not merely reduce it. */
  const sore = P.adjustSession(day, { sleep: 3, energy: 3, soreness: 3, stress: 3, soreGroups: ['chest'] }, gym);
  const swapped = sore.day.blocks[0];
  check('a sore group swaps the exercise', swapped.exerciseId !== 'bench_press');
  eq('and records what it replaced', swapped.swappedFrom, 'bench_press');
  eq('and the replacement avoids the sore muscle',
    X.BY_ID[swapped.exerciseId].primary.includes('chest'), false);
  check('and explains itself', sore.notes.length > 0, sore.notes.join(' | '));

  /* Soreness in an uninvolved group must not touch the session. */
  const unrelated = P.adjustSession(day, { sleep: 3, energy: 3, soreness: 3, stress: 3, soreGroups: ['legs'] }, gym);
  eq('unrelated soreness leaves the session alone', unrelated.day.blocks[0].exerciseId, 'bench_press');

  /* With no equipment there may be no legal swap; the session must degrade
     gracefully rather than throw or silently drop the exercise. */
  const trapped = P.adjustSession(
    { name: 'x', blocks: [{ exerciseId: 'pushup', sets: 4, repMin: 8, repMax: 12, rir: 2 }] },
    { sleep: 3, energy: 3, soreness: 3, stress: 3, soreGroups: ['chest', 'arms', 'shoulders'] },
    []);
  check('an impossible swap still returns a block', trapped.day.blocks.length === 1);
  check('and pulls it back instead of dropping it', trapped.day.blocks[0].sets < 4);

  eq('an unknown sore group is ignored',
    P.adjustSession(day, { soreGroups: ['elbow'] }, gym).day.blocks[0].exerciseId, 'bench_press');
}

/* ============================== program.js: volume ============================== */

section('program / volume accounting');
{
  /* Hand-checked. Bench: primary chest (4 sets to chest), secondary triceps and
     front delts (2.0 each to arms and shoulders, half credit).
     Lateral raise: primary side delts, so 3 more to shoulders.
     shoulders = 2.0 + 3 = 5.0, arms = 2.0, chest = 4. */
  const days = [{ blocks: [
    { exerciseId: 'bench_press', sets: 4 },
    { exerciseId: 'lateral_raise', sets: 3 },
  ] }];
  const v = P.weeklyVolumeByGroup(days);
  eq('primary muscle earns full credit', v.chest, 4);
  eq('secondary muscle earns half credit', v.arms, 2);
  eq('credit accumulates across exercises', v.shoulders, 5);
  eq('uninvolved groups stay at zero', v.legs, 0);

  /* A group must be credited at most once per exercise — a squat hits quads and
     glutes, both in "legs", and must bill 3 sets rather than 6. */
  const squatOnly = P.weeklyVolumeByGroup([{ blocks: [{ exerciseId: 'back_squat', sets: 3 }] }]);
  eq('one exercise credits a group once', squatOnly.legs, 3);

  /* Cardio must never inflate lifting volume. */
  const withCardio = P.weeklyVolumeByGroup([{ blocks: [{ exerciseId: 'run_outdoor', sets: 5 }] }]);
  eq('cardio contributes no hard sets', withCardio.legs, 0);

  const empty = P.validateVolume([]);
  eq('an empty week is flagged', empty.ok, false);
  check('and names the starved groups', empty.issues.length > 0);

  const overcooked = P.validateVolume([{ blocks: [{ exerciseId: 'bench_press', sets: 40 }] }]);
  check('excessive volume is flagged', overcooked.issues.some((i) => i.group === 'chest'));
}

/* ============================== score.js: ISO weeks ============================== */

section('score / ISO weeks');
{
  /* ISO-8601 fixes these by definition, independent of implementation. */
  eq('Jan 4 is always in week 01', S.isoWeekKey(new Date(2026, 0, 4)).split('-W')[1], '01');
  eq('Jan 4 2027 is also week 01', S.isoWeekKey(new Date(2027, 0, 4)).split('-W')[1], '01');

  /* Monday and Sunday of one week must agree. */
  eq('a week starts on Monday and ends on Sunday',
    S.isoWeekKey(new Date(2026, 7, 17)), S.isoWeekKey(new Date(2026, 7, 23)));
  check('the next Monday is a different week',
    S.isoWeekKey(new Date(2026, 7, 17)) !== S.isoWeekKey(new Date(2026, 7, 24)));

  /* Sweep four years: every date must fall inside the range of its own key,
     and every range must start on a Monday. This is the check that catches
     year-boundary bugs, which is exactly where week math goes wrong. */
  let roundTripFails = 0, notMonday = 0, checked = 0;
  const cursor = new Date(2024, 0, 1);
  while (cursor < new Date(2028, 0, 1)) {
    const key = S.isoWeekKey(cursor);
    const { start, end } = S.weekRange(key);
    const d = new Date(cursor); d.setHours(12, 0, 0, 0);
    if (d < start || d > end) roundTripFails++;
    if (start.getDay() !== 1) notMonday++;
    checked++;
    cursor.setDate(cursor.getDate() + 1);
  }
  eq(`every date lands inside its own week (${checked} days)`, roundTripFails, 0);
  eq('every week range starts on a Monday', notMonday, 0);

  /* Monday 00:00:00.000 to Sunday 23:59:59.999 is six whole days plus almost
     one more — it must cover seven calendar days without spilling into the
     next Monday. */
  const { start, end } = S.weekRange('2026-W34');
  const spanDays = (end - start) / 86400000;
  eq('a week covers six full days', Math.floor(spanDays), 6);
  check('and stops just short of the next Monday', spanDays < 7, `span ${spanDays}`);
  eq('a week range ends on a Sunday', end.getDay(), 0);

  /* dayKey must be LOCAL — toISOString() would shift late-evening dates. */
  eq('dayKey formats local dates', S.dayKey(new Date(2026, 7, 5, 23, 30)), '2026-08-05');
}

/* ============================== score.js: streaks ============================== */

section('score / streaks');
{
  const asOf = new Date(2026, 7, 23);
  eq('no activity is no streak', S.currentStreak([], asOf), 0);
  eq('today alone is a streak of 1', S.currentStreak(['2026-08-23'], asOf), 1);
  eq('consecutive days accumulate',
    S.currentStreak(['2026-08-21', '2026-08-22', '2026-08-23'], asOf), 3);

  /* Not having trained YET today must not zero an active streak. */
  eq('an untrained today does not break the streak',
    S.currentStreak(['2026-08-21', '2026-08-22'], asOf), 2);

  /* But a gap before yesterday does end it. */
  eq('a gap ends the streak',
    S.currentStreak(['2026-08-19', '2026-08-20'], asOf), 0);
  eq('only the current run counts',
    S.currentStreak(['2026-08-10', '2026-08-11', '2026-08-22', '2026-08-23'], asOf), 2);
  eq('duplicate dates do not double count',
    S.currentStreak(['2026-08-23', '2026-08-23', '2026-08-22'], asOf), 2);
}

/* ============================== score.js: weekly score ============================== */

section('score / weekly score');
{
  eq('components sum to 100', S.MAX_SCORE, 100);

  const perfect = S.scoreWeek({
    plannedSessions: 4, completedSessions: 4, totalSessions: 7,
    nutritionDaysOnTarget: 7, cardioMinutes: 90, streak: 10, checkins: 3,
  });
  eq('a perfect week scores 100', perfect.total, 100);

  const nothing = S.scoreWeek({
    plannedSessions: 4, completedSessions: 0, totalSessions: 0,
    nutritionDaysOnTarget: 0, cardioMinutes: 0, streak: 0, checkins: 0,
  });
  eq('an empty week scores 0', nothing.total, 0);

  /* Half the plan must earn half of the adherence component: 40 / 2 = 20. */
  const half = S.scoreWeek({ plannedSessions: 4, completedSessions: 2, totalSessions: 2 });
  eq('half adherence earns half the points',
    half.components.find((c) => c.id === 'adherence').points, 20);

  /* THE fairness property: different plan sizes, same completion ratio, same
     adherence points. If this ever breaks, the leaderboard stops being fair. */
  const threeDay = S.scoreWeek({ plannedSessions: 3, completedSessions: 3, totalSessions: 3 });
  const sixDay = S.scoreWeek({ plannedSessions: 6, completedSessions: 6, totalSessions: 6 });
  eq('a 3-day plan and a 6-day plan can both max adherence',
    threeDay.components.find((c) => c.id === 'adherence').points,
    sixDay.components.find((c) => c.id === 'adherence').points);

  /* Extra work is capped so nobody wins by overtraining. */
  const grinder = S.scoreWeek({ plannedSessions: 4, completedSessions: 4, totalSessions: 20 });
  eq('extra credit is capped', grinder.components.find((c) => c.id === 'extra').points, 15);

  /* Overshooting a target must not exceed its maximum. */
  const overshoot = S.scoreWeek({
    plannedSessions: 4, completedSessions: 9, totalSessions: 9,
    nutritionDaysOnTarget: 99, cardioMinutes: 9999, streak: 99, checkins: 99,
  });
  eq('no component can exceed its cap', overshoot.total, 100);
  check('and no individual component overflows',
    overshoot.components.every((c) => c.points <= c.max));

  /* A week with nothing planned still needs a meaningful denominator. */
  const unplanned = S.scoreWeek({ plannedSessions: 0, completedSessions: 4, totalSessions: 4 });
  check('an unplanned week still scores adherence',
    unplanned.components.find((c) => c.id === 'adherence').points > 0);

  check('every component carries a readable detail',
    perfect.components.every((c) => typeof c.detail === 'string' && c.detail.length > 0));
}

/* ============================== score.js: leaderboard ============================== */

section('score / leaderboard');
{
  const grant = { name: 'Grant', score: S.scoreWeek({ plannedSessions: 4, completedSessions: 4 }) };
  const ashtin = { name: 'Ashtin', score: S.scoreWeek({ plannedSessions: 4, completedSessions: 2 }) };

  const board = S.leaderboard([ashtin, grant]);
  eq('the higher score ranks first', board[0].name, 'Grant');
  eq('and is marked the leader', board[0].leader, true);
  eq('the gap is reported', board[1].gap, board[0].score.total - board[1].score.total);

  const tie = S.leaderboard([
    { name: 'A', score: S.scoreWeek({ plannedSessions: 4, completedSessions: 4 }) },
    { name: 'B', score: S.scoreWeek({ plannedSessions: 4, completedSessions: 4 }) },
  ]);
  eq('a tie is reported rather than broken', tie[0].tied, true);
  eq('and nobody is crowned', tie[0].leader, false);
  check('the summary calls out the tie', /tie/i.test(S.weekSummary(tie)));

  eq('an empty board is handled', typeof S.weekSummary([]), 'string');
  check('a close week reads as close', /anyone/i.test(S.weekSummary(S.leaderboard([
    { name: 'A', score: { total: 80 } }, { name: 'B', score: { total: 78 } },
  ]))));
}

/* ============================== stats.js: sets and strength ============================== */

section('stats / logged work');
{
  const sets = [
    { weight: 185, reps: 8, done: true },
    { weight: 185, reps: 6, done: true },
    { weight: 185, reps: 0, done: false },   /* never performed */
  ];
  const best = T.bestSet(sets);
  eq('best set picks the highest estimated 1RM', best.reps, 8);
  eq('incomplete sets are ignored', T.bestSet([{ weight: 100, reps: 0 }]), null);

  const workout = { date: '2026-08-01', entries: [{ exerciseId: 'bench_press', sets }] };
  eq('tonnage sums weight x reps over completed sets', T.tonnage(workout), 185 * 8 + 185 * 6);
  eq('set count ignores unperformed rows', T.setCount(workout), 2);
  eq('tonnage of nothing is zero', T.tonnage({ entries: [] }), 0);

  /* Epley is unreliable past ~12 reps, so those sets must not enter the series
     and pretend to be evidence of a max. */
  const history = [
    { date: '2026-08-01', entries: [{ exerciseId: 'bench_press', sets: [{ weight: 185, reps: 5, done: true }] }] },
    { date: '2026-08-08', entries: [{ exerciseId: 'bench_press', sets: [{ weight: 100, reps: 20, done: true }] }] },
    { date: '2026-08-15', entries: [{ exerciseId: 'bench_press', sets: [{ weight: 195, reps: 5, done: true }] }] },
  ];
  const series = T.e1rmSeries(history, 'bench_press');
  eq('high-rep sets are excluded from the 1RM series', series.length, 2);
  check('the series is chronological', series[0].date < series[1].date);

  const prs = T.personalRecords(history, 'bench_press');
  eq('heaviest weight is found', prs.heaviest.weight, 195);
  eq('most reps is found even at a light load', prs.mostReps.reps, 20);
  eq('and carries its date', prs.heaviest.date, '2026-08-15');

  /* A PR must be a strict improvement on everything prior. */
  const newSession = { date: '2026-08-22', entries: [{ exerciseId: 'bench_press', sets: [{ weight: 205, reps: 5, done: true }] }] };
  const found = T.newPRsIn(newSession, history);
  eq('a heavier lift is a PR', found.length, 1);
  eq('and reports what it beat', found[0].previous, 195);

  const notPR = { date: '2026-08-22', entries: [{ exerciseId: 'bench_press', sets: [{ weight: 135, reps: 5, done: true }] }] };
  eq('a lighter lift is not a PR', T.newPRsIn(notPR, history).length, 0);

  eq('the first ever session is a PR',
    T.newPRsIn({ date: '2026-01-01', entries: [{ exerciseId: 'bench_press', sets: [{ weight: 95, reps: 5, done: true }] }] }, []).length, 1);
}

/* ============================== stats.js: volume ============================== */

section('stats / volume');
{
  /* Logged volume must use the SAME credit rule as planned volume, or
     "planned vs actual" compares two different things and is meaningless. */
  const logged = [{ date: '2026-08-01', entries: [
    { exerciseId: 'bench_press', sets: [
      { weight: 185, reps: 8, done: true }, { weight: 185, reps: 8, done: true },
      { weight: 185, reps: 8, done: true }, { weight: 185, reps: 8, done: true },
    ] },
    { exerciseId: 'lateral_raise', sets: [
      { weight: 20, reps: 12, done: true }, { weight: 20, reps: 12, done: true },
      { weight: 20, reps: 12, done: true },
    ] },
  ] }];

  const actual = T.volumeByGroup(logged);
  const planned = P.weeklyVolumeByGroup([{ blocks: [
    { exerciseId: 'bench_press', sets: 4 }, { exerciseId: 'lateral_raise', sets: 3 },
  ] }]);
  deepEq('logged and planned volume agree on the same work', actual, planned);

  /* Unperformed sets must not count as volume. */
  const partial = T.volumeByGroup([{ date: 'x', entries: [{ exerciseId: 'bench_press', sets: [
    { weight: 185, reps: 8, done: true }, { weight: 185, reps: 0, done: false },
  ] }] }]);
  eq('unperformed sets add no volume', partial.chest, 1);

  const weekly = T.weeklyVolume(logged);
  eq('volume buckets by week', weekly.length, 1);
  eq('and counts the sessions', weekly[0].sessions, 1);
  eq('and totals the sets', weekly[0].sets, 7);
}

/* ============================== stats.js: bodyweight ============================== */

section('stats / bodyweight');
{
  /* A centred average over a constant series must return that constant. */
  const flat = T.movingAverage([1, 2, 3, 4, 5].map((d) => ({ date: `2026-08-0${d}`, value: 200 })), 3);
  check('a flat series has a flat trend', flat.every((p) => p.trend === 200));

  /* Centred, not trailing: the middle of a straight line sits on the line. */
  const ramp = T.movingAverage(
    [200, 201, 202, 203, 204].map((v, i) => ({ date: `2026-08-0${i + 1}`, value: v })), 3);
  eq('a centred average sits on a straight line', ramp[2].trend, 202);

  eq('an empty series is handled', T.movingAverage([], 7).length, 0);

  const metrics = [
    { date: '2026-08-01', weight: 200 }, { date: '2026-08-08', weight: 199 },
    { date: '2026-08-15', weight: 198 }, { date: '2026-08-22', weight: 197 },
  ];
  const trend = T.weightTrend(metrics, 3);
  check('a downward trend reports negative total', trend.total < 0);
  check('and a weekly rate', Number.isFinite(trend.perWeek));

  eq('a single weigh-in has no rate', T.weightTrend([{ date: '2026-08-01', weight: 200 }]).perWeek, null);
  eq('non-numeric weights are dropped', T.weightTrend([{ date: 'x', weight: 'heavy' }]).series.length, 0);
}

/* ============================== stats.js: consistency ============================== */

section('stats / consistency');
{
  const workouts = [{ date: '2026-08-20', entries: [] }];
  const cardio = [{ date: '2026-08-20' }, { date: '2026-08-21' }];

  const map = T.activityMap(workouts, cardio);
  eq('lifting plus cardio is the top level', map.get('2026-08-20'), 3);
  eq('cardio alone is the lowest active level', map.get('2026-08-21'), 1);
  eq('an untouched day is absent', map.get('2026-08-19'), undefined);

  deepEq('active dates are sorted', T.activeDates(workouts, cardio), ['2026-08-20', '2026-08-21']);

  const grid = T.heatmapGrid(workouts, cardio, new Date(2026, 7, 23), 4);
  eq('the grid is a whole number of weeks', grid.length, 28);
  check('the grid is chronological', grid[0].date < grid[grid.length - 1].date);
  /* Row alignment: cell 0 must be a Monday so each row reads Mon-to-Sun. */
  eq('the grid starts on a Monday', new Date(grid[0].date + 'T12:00:00').getDay(), 1);

  /* The heatmap and the streak must agree about what an active day is. */
  eq('heatmap and streak agree on activity',
    S.currentStreak(T.activeDates(workouts, cardio), new Date(2026, 7, 21)), 2);
}

/* ============================== stats.js: nutrition ============================== */

section('stats / nutrition');
{
  const meals = [
    { date: '2026-08-01', calories: 700, protein: 50, carbs: 60, fat: 20 },
    { date: '2026-08-01', calories: 800, protein: 60, carbs: 70, fat: 25 },
    { date: '2026-08-02', calories: 500, protein: 30, carbs: 40, fat: 15 },
  ];
  const totals = T.dayMacros(meals.filter((m) => m.date === '2026-08-01'));
  eq('macros sum across a day', totals.calories, 1500);
  eq('and so does protein', totals.protein, 110);

  const targets = { calories: 1500, protein: 100 };
  eq('hitting the targets is on target', T.isDayOnTarget(totals, targets), true);
  eq('being well under is off target',
    T.isDayOnTarget({ calories: 800, protein: 100 }, targets), false);
  eq('being well over is off target',
    T.isDayOnTarget({ calories: 2200, protein: 100 }, targets), false);

  /* Deliberate asymmetry: extra protein must never fail a day. */
  eq('extra protein does not fail a day',
    T.isDayOnTarget({ calories: 1500, protein: 300 }, targets), true);
  eq('short protein does fail a day',
    T.isDayOnTarget({ calories: 1500, protein: 40 }, targets), false);

  const days = T.nutritionDays(meals, targets);
  eq('days are grouped', days.length, 2);
  eq('and sorted', days[0].date, '2026-08-01');
  eq('and counted', days[0].meals, 2);
  eq('with no targets nothing is on target', T.isDayOnTarget(totals, {}), false);
}

/* ============================== stats.js: targets ============================== */

section('stats / calorie targets');
{
  /* Mifflin-St Jeor, worked by hand for a 30yo male, 180 lb, 70 in:
       kg = 180 * 0.453592     = 81.6466
       cm = 70 * 2.54          = 177.8
       10*kg + 6.25*cm - 5*age = 816.466 + 1111.25 - 150 = 1777.716
       male adds 5             = 1782.72                                    */
  const profile = { weight: 180, height: 70, age: 30, sex: 'male', activity: 'moderate' };
  near('BMR matches Mifflin-St Jeor', T.bmr(profile), 1782.72, 0.05);

  /* Female uses the same base minus 161, so the two must differ by exactly 166. */
  near('the female equation differs by 166',
    T.bmr({ ...profile, sex: 'male' }) - T.bmr({ ...profile, sex: 'female' }), 166, 0.001);

  near('TDEE applies the activity factor', T.tdee(profile), 1782.72 * 1.55, 1);

  const cut = T.macroTargets(profile, 'lose_fat');
  const bulk = T.macroTargets(profile, 'build_muscle');
  check('a cut sits below maintenance', cut.calories < cut.maintenance);
  check('a bulk sits above maintenance', bulk.calories > bulk.maintenance);
  eq('protein scales with bodyweight', cut.protein, 180);

  /* The macro split must actually reconstruct the calorie target. */
  const reconstructed = cut.protein * 4 + cut.carbs * 4 + cut.fat * 9;
  near('macros add back up to the calorie target', reconstructed, cut.calories, 5);

  check('carbohydrate never goes negative',
    T.macroTargets({ weight: 400, height: 60, age: 70, sex: 'female', activity: 'sedentary' }, 'lose_fat').carbs >= 0);

  eq('an unknown goal falls back safely',
    T.macroTargets(profile, 'nonsense').calories, T.macroTargets(profile, 'general_health').calories);

  /* GOALS is shared, so a goal added to program.js must work here immediately. */
  check('every goal produces usable targets',
    Object.keys(P.GOALS).every((g) => T.macroTargets(profile, g).calories > 0));
}

/* ============================== anatomy.js ============================== */

section('anatomy');
{
  /* The artwork is third-party (react-native-body-highlighter, MIT) so its
     shapes are not this suite's business. What IS this suite's business is that
     the muscle ids it paints still line up with exercises.js — a rename there
     would otherwise silently stop lighting a muscle up. */
  const muscles = new Set(X.MUSCLES);

  for (const sex of A.SEXES) {
    for (const view of A.VIEWS) {
      const ids = A.musclesInView(view, sex);
      check(`${sex} ${view} paints muscles`, ids.length > 0);
      const unknown = ids.filter((m) => !muscles.has(m));
      deepEq(`${sex} ${view} muscle ids all exist in exercises.js`, unknown, []);

      const svg = A.bodySVG({ sex, view });
      check(`${sex} ${view} renders an svg`, svg.startsWith('<svg') && svg.endsWith('</svg>'));
      check(`${sex} ${view} has no undefined in output`, !/undefined|NaN/.test(svg));
    }
  }

  /* Every muscle group must be visible somewhere across the two views, or a
     trained group would have nowhere to show up. */
  const painted = new Set([...A.musclesInView('front'), ...A.musclesInView('back')]);
  for (const [group, members] of Object.entries(X.MUSCLE_GROUPS)) {
    check(`${group} is visible on some view`, members.some((m) => painted.has(m)));
  }

  /* Colour: idle at zero, hot at one, and monotonic in between. */
  const idle = A.bodySVG({ view: 'front', values: {} });
  const lit = A.bodySVG({ view: 'front', values: { chest: 1 } });
  check('an untrained body uses the idle tone', idle.includes(A.PALETTES.heat.idle));
  check('a fully trained muscle uses the hot tone', lit.includes(A.PALETTES.heat.hot));
  check('lighting one muscle does not light them all',
    (lit.match(new RegExp(A.PALETTES.heat.hot, 'g')) || []).length < 4);

  eq('lerpColor at 0 returns the start', A.lerpColor('#000000', '#ffffff', 0), '#000000');
  eq('lerpColor at 1 returns the end', A.lerpColor('#000000', '#ffffff', 1), '#ffffff');
  eq('lerpColor clamps beyond 1', A.lerpColor('#000000', '#ffffff', 5), '#ffffff');

  /* normalise scales against the biggest value present, so the body always uses
     its full range rather than rendering a flat grey early week. */
  const n = A.normalise({ chest: 5, back: 10 });
  eq('normalise puts the max at 1', n.back, 1);
  eq('and scales the rest', n.chest, 0.5);
  deepEq('normalise handles all-zero input', A.normalise({ a: 0, b: 0 }), { a: 0, b: 0 });
  deepEq('normalise handles empty input', A.normalise({}), {});

  const spread = A.fromGroups({ legs: 7 }, X.MUSCLE_GROUPS);
  eq('fromGroups fans a group out to its muscles', spread.quads, 7);
  eq('and covers every member', spread.calves, 7);

  const f = A.freshness({ chest: 0, back: 3, arms: 9 });
  eq('just-trained is not fresh', f.chest, 0);
  eq('fully recovered is fresh', f.back, 1);
  eq('freshness caps at 1', f.arms, 1);
}

/* ============================== progressive overload ============================== */

{
  section('overload suggestions');

  /* One session per week at an unchanged 135, three weeks apart. Reps at the
     top of the range, so the answer should be "add weight". */
  const sess = (date, weight, reps) => ({
    date, entries: [{ exerciseId: 'bench_press', sets: [{ weight, reps }, { weight, reps }] }],
  });

  const stalled = [sess('2026-08-01', 135, 10), sess('2026-08-08', 135, 10), sess('2026-08-15', 135, 11)];
  const out = P.overloadSuggestions(stalled);
  eq('a three-week plateau is flagged', out.length, 1);
  eq('flags the right lift', out[0]?.exerciseId, 'bench_press');
  eq('reports the stuck weight', out[0]?.weight, 135);
  eq('counts every session in the run', out[0]?.sessions, 3);
  eq('measures the span in days', out[0]?.days, 14);
  check('top of the rep range means ready', out[0]?.ready === true);
  eq('suggests one increment up', out[0]?.suggested, 135 + P.incrementFor('bench_press'));

  /* Same plateau, but the reps never got there. Adding weight to a set you
     cannot finish is how people get hurt, so this must NOT say add weight. */
  const shortOfReps = [sess('2026-08-01', 135, 6), sess('2026-08-08', 135, 7), sess('2026-08-15', 135, 7)];
  const short = P.overloadSuggestions(shortOfReps);
  eq('a stall below the rep target still surfaces', short.length, 1);
  check('but is not marked ready', short[0]?.ready === false);
  eq('and suggests the same weight', short[0]?.suggested, 135);
  eq('reporting the best reps reached', short[0]?.bestReps, 7);

  /* Three sessions inside one week is not a plateau, it is a training week. */
  const tooSoon = [sess('2026-08-10', 135, 10), sess('2026-08-12', 135, 10), sess('2026-08-14', 135, 10)];
  eq('three sessions in four days is not a plateau', P.overloadSuggestions(tooSoon).length, 0);

  /* Still climbing. The most recent weight differs, so the run is length one. */
  const climbing = [sess('2026-08-01', 135, 10), sess('2026-08-08', 140, 10), sess('2026-08-15', 145, 10)];
  eq('a lift that is still climbing is left alone', P.overloadSuggestions(climbing).length, 0);

  /* An older plateau at the same weight must not resurrect itself after a
     heavier session breaks the run. Newest first: 135, 145, 135, 135, 135. */
  const broken = [
    sess('2026-09-05', 135, 10), sess('2026-08-29', 145, 8),
    sess('2026-08-22', 135, 10), sess('2026-08-15', 135, 10), sess('2026-08-08', 135, 10),
  ];
  eq('a broken run does not count the older stretch', P.overloadSuggestions(broken).length, 0);

  /* The top set is the heaviest one, not the first or the last. */
  const mixed = [
    { date: '2026-08-15', entries: [{ exerciseId: 'bench_press', sets: [{ weight: 95, reps: 12 }, { weight: 135, reps: 10 }] }] },
    { date: '2026-08-08', entries: [{ exerciseId: 'bench_press', sets: [{ weight: 135, reps: 10 }, { weight: 95, reps: 12 }] }] },
    { date: '2026-08-01', entries: [{ exerciseId: 'bench_press', sets: [{ weight: 135, reps: 10 }] }] },
  ];
  eq('warm-up sets do not break the run', P.overloadSuggestions(mixed).length, 1);

  /* Sets with no reps were never performed. */
  const empty = [{ date: '2026-08-15', entries: [{ exerciseId: 'bench_press', sets: [{ weight: 135, reps: 0 }] }] }];
  eq('an unperformed set contributes nothing', P.overloadSuggestions(empty).length, 0);
  eq('no history means no advice', P.overloadSuggestions([]).length, 0);
}

/* ============================== custom machines ============================== */

{
  section('custom machines');

  eq('a name plate becomes a safe id',
    X.customId('HOIST ROC-IT Seated Mid Row RS-2203'),
    'custom_hoist_roc_it_seated_mid_row_rs_2203');
  check('custom ids are namespaced', X.isCustom(X.customId('Anything')));
  check('built-in ids are not', !X.isCustom('bench_press'));
  eq('an unnameable machine still gets an id', X.customId('!!!'), 'custom_machine');

  const before = X.EXERCISES.length;
  const added = X.registerCustom([{
    id: 'custom_test_row', name: 'Test Row', pattern: 'horizontal_pull',
    type: 'compound', primary: ['lats'], secondary: ['biceps', 'not_a_muscle'],
    equipment: ['row_machine', 'not_a_thing'],
  }]);
  eq('one machine registers', added, 1);
  eq('and joins the library', X.EXERCISES.length, before + 1);
  check('and is reachable by id', !!X.BY_ID.custom_test_row);
  eq('invented muscles are dropped', X.BY_ID.custom_test_row.secondary.length, 1);
  eq('invented equipment is dropped', X.BY_ID.custom_test_row.equipment.length, 1);
  eq('registering twice is a no-op', X.registerCustom([{ id: 'custom_test_row', name: 'Test Row' }]), 0);

  /* The whole point of merging into the real library: everything downstream
     has to see it. A machine that logs but never appears in a chart is worse
     than no machine at all, because it looks like it worked. */
  const withEquip = X.availableExercises(['row_machine']);
  check('a custom machine shows up in the picker',
    withEquip.some((e) => e.id === 'custom_test_row'));
  const vol = T.volumeByGroup([{ date: '2026-08-20', entries: [{ exerciseId: 'custom_test_row', sets: [{ weight: 100, reps: 10 }] }] }]);
  check('and counts towards volume', (vol.back || 0) > 0);

  /* A machine with no muscle attached would be invisible to every chart. */
  X.registerCustom([{ id: 'custom_bare', name: 'Bare', pattern: 'isolation', primary: [] }]);
  check('a machine with no muscles still gets one', X.BY_ID.custom_bare.primary.length === 1);

  eq('an entry with no name is refused', X.registerCustom([{ id: 'custom_nameless' }]), 0);

  /* An exercise typed in by hand carries NO equipment, deliberately. The reason
     it is being typed in is that the library does not cover it, so requiring a
     piece of kit would hide it again the moment it was created. */
  X.registerCustom([{ id: 'custom_reformer_footwork', name: 'Reformer Footwork',
    pattern: 'squat', primary: ['quads'], equipment: [] }]);
  check('a hand-added exercise shows up with no equipment ticked at all',
    X.availableExercises([]).some((e) => e.id === 'custom_reformer_footwork'));
  check('and still shows up in a fully kitted gym',
    X.availableExercises(X.ALL_EQUIPMENT).some((e) => e.id === 'custom_reformer_footwork'));
}

/* ============================== classes and cardio ============================== */

{
  section('classes and cardio');

  check('Solidcore is loggable', !!X.CLASS_BY_ID.solidcore);
  check('reformer pilates is loggable', !!X.CLASS_BY_ID.reformer_pilates);
  eq('every class id is unique',
    new Set(X.CLASS_TYPES.map((c) => c.id)).size, X.CLASS_TYPES.length);

  check('a treadmill run measures distance', X.tracksDistance('treadmill_run'));
  check('a stair climber does not', !X.tracksDistance('stairmaster_c'));
  check('every distance mode is a real exercise',
    [...X.DISTANCE_MODES].every((id) => !!X.BY_ID[id]));
  check('every cardio mode is typed as cardio',
    X.CARDIO_MODES().every((e) => e.type === 'cardio'));
  check('core work is offered with no equipment at all',
    X.CORE_EXERCISES([]).length > 0);
  check('every core exercise really trains the core',
    X.CORE_EXERCISES().every((e) => e.pattern === 'core'));
}

/* ============================== rest-day streaks ============================== */

{
  section('rest-day streaks');

  /* A real calendar week, so the day names in the comments below are true:
     Mon 2026-08-24 through Sun 2026-08-30, with Mon 2026-08-31 following. */
  const MON = '2026-08-24', TUE = '2026-08-25', WED = '2026-08-26';
  const THU = '2026-08-27', FRI = '2026-08-28', SAT = '2026-08-29', SUN = '2026-08-30';
  const NEXT_MON = new Date('2026-08-31T09:00:00');
  const NEXT_TUE = new Date('2026-09-01T09:00:00');

  /* Grant's first case: lift Monday to Friday, rest the weekend, and on Monday
     morning before training the run is still alive and reads EIGHT — five
     training days plus two rested plus today. */
  const weekdays = [MON, TUE, WED, THU, FRI];
  const a = S.restStreak(weekdays, { asOf: NEXT_MON });
  check('a rested weekend does not break the run', a.alive);
  eq('and the run counts calendar days, not training days', a.days, 8);
  eq('training days are still reported', a.activeDays, 5);
  eq('as are the rest days inside it', a.restDays, 3);

  /* Grant's second case: rest Friday because he is sore, train Saturday, rest
     Sunday. Never two off in a row, so the run is untouched. */
  const split = [MON, TUE, WED, THU, SAT];
  const b = S.restStreak(split, { asOf: NEXT_MON });
  check('rest days split around a session keep the run', b.alive);
  eq('and it spans the same eight days', b.days, 8);

  /* Three off in a row is where it ends. */
  const c = S.restStreak(weekdays, { asOf: NEXT_TUE });
  check('three rest days in a row breaks it', !c.alive);
  eq('and a broken run is zero, not negative', c.days, 0);

  /* The boundary, checked from both sides rather than assumed. */
  eq('exactly the allowance survives',
    S.restStreak([MON], { asOf: new Date('2026-08-27T09:00:00'), allowance: 2 }).days, 4);
  check('one past the allowance does not',
    !S.restStreak([MON], { asOf: new Date('2026-08-28T09:00:00'), allowance: 2 }).alive);

  /* Today being unlogged must never zero someone out at 9am. */
  const todayOnly = S.restStreak([FRI], { asOf: new Date('2026-08-29T09:00:00') });
  eq('an untrained today does not end yesterday-s run', todayOnly.days, 2);
  check('and it is still alive', todayOnly.alive);

  /* allowance 0 has to reduce exactly to the old rule, which is what makes it
     safe to keep both functions in the file. */
  const strict = (dates, asOf) => S.restStreak(dates, { allowance: 0, asOf }).days;
  eq('allowance 0 matches currentStreak on an unbroken run',
    strict(weekdays, new Date('2026-08-28T09:00:00')),
    S.currentStreak(weekdays, new Date('2026-08-28T09:00:00')));
  eq('allowance 0 matches currentStreak across a gap',
    strict(weekdays, NEXT_MON),
    S.currentStreak(weekdays, NEXT_MON));

  eq('no history is a zero streak', S.restStreak([], { asOf: NEXT_MON }).days, 0);
  eq('one session today is a one day streak',
    S.restStreak([FRI], { asOf: new Date('2026-08-28T09:00:00') }).days, 1);
  eq('a session three weeks ago is not a streak',
    S.restStreak([MON], { asOf: new Date('2026-09-20T09:00:00') }).days, 0);

  /* restRun drives the "train today or lose it" warning, so it counts today. */
  eq('a rest run counts today', S.restStreak(weekdays, { asOf: NEXT_MON }).restRun, 3);
  eq('and is zero on a day that was trained',
    S.restStreak(weekdays, { asOf: new Date('2026-08-28T09:00:00') }).restRun, 0);

  /* Duplicates and unsorted input are what activeDates can actually contain. */
  eq('order and duplicates do not matter',
    S.restStreak([FRI, MON, WED, MON, TUE, THU], { asOf: NEXT_MON }).days, 8);
}

/* ============================== the weekly rest budget ============================== */

{
  section('rest budget');

  const WEEK = '2026-W35';                       /* Mon 2026-08-24 to Sun 2026-08-30 */
  const weekdays = ['2026-08-24', '2026-08-25', '2026-08-26', '2026-08-27', '2026-08-28'];
  const after = new Date('2026-09-10T09:00:00'); /* well past the week */

  eq('a finished week reports every day off', S.restDaysUsed(weekdays, WEEK, after), 2);
  eq('a fully trained week used none',
    S.restDaysUsed([...weekdays, '2026-08-29', '2026-08-30'], WEEK, after), 0);
  eq('an empty week is all seven', S.restDaysUsed([], WEEK, after), 7);

  /* A week in progress must count only as far as today, or Monday morning
     would report six rest days already taken. */
  eq('a week in progress stops at today',
    S.restDaysUsed(weekdays, WEEK, new Date('2026-08-26T09:00:00')), 0);
  eq('and counts the days actually missed so far',
    S.restDaysUsed(['2026-08-24'], WEEK, new Date('2026-08-26T09:00:00')), 2);

  /* Activity outside the week must not leak into it. */
  eq('days from other weeks are ignored',
    S.restDaysUsed(['2026-08-23', '2026-08-31'], WEEK, after), 7);
}

/* ============================== classes as volume ============================== */

{
  section('classes as volume');

  const cls = (over) => ({ date: '2026-08-24', kind: 'class', classId: 'solidcore',
    minutes: 50, effort: 'solid', ...over });

  /* Solidcore is typed as core + legs, so a 50 minute class at normal effort is
     50/10 = 5 notional sets split two ways. */
  eq('a class splits its work across the groups it hit', T.classSets(cls()), 2.5);
  eq('effort scales it down', T.classSets(cls({ effort: 'easy' })), 1.5);
  eq('and up', T.classSets(cls({ effort: 'brutal' })), 3.5);
  eq('an unknown effort falls back to solid', T.classSets(cls({ effort: 'nonsense' })), 2.5);
  eq('a longer class is worth more', T.classSets(cls({ minutes: 100 })), 5);
  eq('hitting one group concentrates it', T.classSets(cls({ groups: ['core'] })), 5);

  /* No class may claim a whole week of one muscle on its own. */
  eq('the per-group credit is capped',
    T.classSets(cls({ minutes: 600, groups: ['core'], effort: 'brutal' })), 8);

  eq('a class with no minutes is worth nothing', T.classSets(cls({ minutes: 0 })), 0);
  eq('a class naming no real group is worth nothing',
    T.classSets({ kind: 'class', classId: 'nope', minutes: 50, groups: ['nonsense'] }), 0);

  /* Classes logged before the questionnaire shipped carry neither field. They
     must keep counting, or updating the app would silently erase her history. */
  const legacy = { date: '2026-08-24', kind: 'class', classId: 'reformer_pilates', minutes: 50 };
  check('a class logged before the questionnaire still credits its type-s groups',
    T.classSets(legacy) > 0);
  eq('using the class type-s own groups', T.classGroups(legacy).join(','), 'core,legs');

  /* Group totals. */
  const vol = T.classVolumeByGroup([cls(), cls({ date: '2026-08-26' })]);
  eq('two classes credit the group twice', vol.core.classes, 2);
  eq('and their sets add up', vol.core.sets, 5);
  eq('a group the class never touched stays empty', vol.chest.sets, 0);
  eq('non-class cardio is ignored',
    T.classVolumeByGroup([{ date: '2026-08-24', exerciseId: 'treadmill_run', minutes: 40 }]).legs.sets, 0);

  /* THE important one: with no classes, the combined view must equal the
     lifted view exactly. This is what proves the change is invisible to Grant,
     who never logs a class. */
  const workouts = [{
    date: '2026-08-24',
    entries: [{ exerciseId: 'bench_press', sets: [{ weight: 135, reps: 8 }, { weight: 135, reps: 8 }] }],
  }];
  const lifted = T.volumeByGroup(workouts);
  const combined = T.combinedVolumeByGroup(workouts, []);
  check('with no classes, combined volume equals lifted volume exactly',
    Object.keys(lifted).every((g) => combined[g].total === lifted[g]));
  eq('and every group is still present',
    Object.keys(combined).length, Object.keys(lifted).length);

  /* And with classes, the two contributions stay separately readable, so a bar
     can show real sets and estimated ones as different things. */
  const both = T.combinedVolumeByGroup(workouts, [cls()]);
  eq('lifted sets stay lifted sets', both.core.sets, lifted.core);
  eq('class sets are reported apart', both.core.classSets, 2.5);
  eq('and the total is their sum', both.core.total, Math.round((lifted.core + 2.5) * 10) / 10);
  eq('a lifted-only group is untouched by classes', both.chest.total, lifted.chest);
}

/* ============================== class summary ============================== */

{
  section('class summary');

  const c = (classId, minutes) => ({ date: '2026-08-24', kind: 'class', classId, minutes });
  const summary = T.classSummary([
    c('solidcore', 50), c('solidcore', 50), c('reformer_pilates', 55),
    { date: '2026-08-25', exerciseId: 'treadmill_run', minutes: 30 },
  ]);

  eq('counts every class', summary.total, 3);
  eq('and only classes', summary.minutes, 155);
  eq('most frequent type first', summary.types[0].classId, 'solidcore');
  eq('with its own count', summary.types[0].count, 2);
  eq('and its own minutes', summary.types[0].minutes, 100);
  eq('an empty log summarises to nothing', T.classSummary([]).total, 0);
}

/* ============================== switching a component off ============================== */

{
  section('scoring without nutrition');

  const sum = (o) => Object.values(o).reduce((a, b) => a + b, 0);

  /* The whole reason this redistributes rather than subtracts: the two scores
     sit next to each other on a leaderboard every week. Grading one person out
     of 80 and the other out of 100 would hand her every week by default. */
  eq('the default table still sums to 100', sum(S.componentMaxes([])), S.MAX_SCORE);
  eq('and so does the table without nutrition',
    sum(S.componentMaxes(['nutrition'])), S.MAX_SCORE);
  eq('dropping two components still sums to 100',
    sum(S.componentMaxes(['nutrition', 'cardio'])), S.MAX_SCORE);
  eq('dropping every component falls back rather than scoring zero',
    sum(S.componentMaxes(S.COMPONENTS.map((c) => c.id))), S.MAX_SCORE);

  const off = S.componentMaxes(['nutrition']);
  eq('a skipped component is absent, not zero', off.nutrition, undefined);
  check('the points land on training', off.adherence > 40);
  check('every remaining component keeps a whole number of points',
    Object.values(off).every((n) => Number.isInteger(n)));
  check('and none of them lose points', S.COMPONENTS
    .filter((c) => c.id !== 'nutrition')
    .every((c) => off[c.id] >= c.max));

  /* Redistribution is proportional, so the biggest component gains the most. */
  check('adherence gains more than check-ins do',
    (off.adherence - 40) > (off.checkin - 5));

  const week = {
    plannedSessions: 4, completedSessions: 4, totalSessions: 7,
    nutritionDaysOnTarget: 7, cardioMinutes: 90, streak: 10, checkins: 3,
  };
  eq('a perfect week is 100 with nutrition counted', S.scoreWeek(week).total, 100);
  eq('and still 100 without it',
    S.scoreWeek(week, undefined, { skip: ['nutrition'] }).total, 100);

  /* Grant's actual case: he trains hard and never logs a meal. */
  const noFood = { ...week, nutritionDaysOnTarget: 0 };
  eq('never logging food costs 20 points while it is counted',
    S.scoreWeek(noFood).total, 80);
  eq('and costs nothing once it is switched off',
    S.scoreWeek(noFood, undefined, { skip: ['nutrition'] }).total, 100);

  const shown = S.scoreWeek(noFood, undefined, { skip: ['nutrition'] }).components;
  eq('the breakdown drops the row entirely', shown.length, S.COMPONENTS.length - 1);
  check('so nothing reads as a 0 out of 0',
    !shown.some((c) => c.id === 'nutrition'));
  eq('and the rows carry their new maxima',
    shown.find((c) => c.id === 'adherence').max, off.adherence);

  /* Skipping nothing must be byte-identical to not passing opts at all, which
     is what proves this is invisible to anyone who leaves it on. */
  eq('an empty skip list changes nothing',
    JSON.stringify(S.scoreWeek(week, undefined, { skip: [] })),
    JSON.stringify(S.scoreWeek(week)));
  eq('and neither does omitting opts',
    JSON.stringify(S.scoreWeek(noFood, undefined, {})),
    JSON.stringify(S.scoreWeek(noFood)));
}

/* ============================== the weekly schedule ============================== */

{
  section('weekday schedule');

  /* Grant's actual split. */
  const split = ['Pull', 'Push', 'Legs', 'Arms', 'Back and chest']
    .map((name, i) => ({ name, weekday: i + 1, blocks: [] }));
  const due = (weekday, completed) => {
    const r = P.dueDay(split, { weekday, completed });
    return r ? r.day.name : 'REST';
  };

  eq('Monday with nothing done is the first day', due(1, 0), 'Pull');
  eq('Tuesday after Monday is the second', due(2, 1), 'Push');
  eq('Thursday on schedule is the fourth', due(4, 3), 'Arms');

  /* The whole point: a missed day slides rather than vanishing. */
  eq('a missed Monday slides to Tuesday', due(2, 0), 'Pull');
  eq('and the rest of the week slides with it', due(3, 1), 'Push');
  eq('two missed days slide two', due(3, 0), 'Pull');

  /* Caught up means rest, not a seventh workout. */
  eq('Saturday with the week finished is a rest day', due(6, 5), 'REST');
  eq('so is Sunday', due(7, 5), 'REST');
  eq('and so is a Wednesday you are already ahead of', due(3, 3), 'REST');

  /* THE BUG: the day used to come from a count that reset every Monday, so the
     program snapped back to day one overnight. A new week starting at zero is
     correct; what was wrong was that mid-week progress was measured by the same
     resetting counter. Re-anchoring on Monday is now deliberate. */
  eq('a new week re-anchors to the first day', due(1, 0), 'Pull');

  /* Training twice in one day should not desynchronise the split. */
  eq('being ahead on Monday just means rest', due(1, 2), 'REST');
  eq('and Wednesday picks up where that left off', due(3, 2), 'Legs');

  /* Days need not be consecutive. */
  const mwf = [
    { name: 'A', weekday: 1, blocks: [] },
    { name: 'B', weekday: 3, blocks: [] },
    { name: 'C', weekday: 5, blocks: [] },
  ];
  eq('Tuesday is a rest day on a Mon/Wed/Fri plan',
    P.dueDay(mwf, { weekday: 2, completed: 1 }), null);
  eq('Wednesday is the second session',
    P.dueDay(mwf, { weekday: 3, completed: 1 }).day.name, 'B');
  eq('a missed Monday still slides onto Wednesday',
    P.dueDay(mwf, { weekday: 3, completed: 0 }).day.name, 'A');

  /* Order of the array must not matter; the weekday decides. */
  const shuffled = [split[2], split[0], split[4], split[1], split[3]];
  eq('the weekday decides, not the array order',
    P.dueDay(shuffled, { weekday: 1, completed: 0 }).day.name, 'Pull');
  eq('and the index returned points into the ORIGINAL array',
    P.dueDay(shuffled, { weekday: 1, completed: 0 }).index,
    shuffled.findIndex((d) => d.name === 'Pull'));

  /* A plan saved before weekdays existed has none at all. Treating those as
     "never due" would declare every day a rest day and silently stop the app
     prescribing anything. */
  const legacy = [{ name: 'A', blocks: [] }, { name: 'B', blocks: [] }];
  eq('a plan with no weekdays still prescribes',
    P.dueDay(legacy, { weekday: 1, completed: 0 }).day.name, 'A');
  eq('and still advances', P.dueDay(legacy, { weekday: 1, completed: 1 }).day.name, 'B');
  eq('and still finishes', P.dueDay(legacy, { weekday: 7, completed: 2 }), null);

  eq('an empty plan prescribes nothing', P.dueDay([], { weekday: 1, completed: 0 }), null);
  eq('a missing plan prescribes nothing', P.dueDay(null, { weekday: 1 }), null);
}

/* ============================== assigning weekdays ============================== */

{
  section('default weekdays');

  eq('five days is the working week', P.defaultWeekdays(5).join(','), '1,2,3,4,5');
  eq('three days spreads across the week', P.defaultWeekdays(3).join(','), '1,3,5');
  eq('four days avoids four in a row', P.defaultWeekdays(4).join(','), '1,2,4,5');
  eq('seven days is every day', P.defaultWeekdays(7).length, 7);
  eq('more than seven is clamped', P.defaultWeekdays(12).length, 7);
  eq('zero still yields one day', P.defaultWeekdays(0).length, 1);

  const filled = P.withWeekdays([{ name: 'A' }, { name: 'B' }, { name: 'C' }]);
  eq('every day comes back with a weekday', filled.filter((d) => d.weekday).length, 3);
  eq('using the spread pattern', filled.map((d) => d.weekday).join(','), '1,3,5');

  const partial = P.withWeekdays([{ name: 'A', weekday: 6 }, { name: 'B' }]);
  eq('an existing choice is left alone', partial[0].weekday, 6);
  check('and the rest are filled in', !!partial[1].weekday);

  const bogus = P.withWeekdays([{ name: 'A', weekday: 99 }]);
  eq('an impossible weekday is replaced', bogus[0].weekday, 1);

  /* Expansion must carry weekdays through, or every generated week loses them
     and the schedule falls back to the legacy rotation. */
  const expanded = P.expandProgram({
    goal: 'build_muscle',
    days: [{ name: 'A', blocks: [] }, { name: 'B', blocks: [] }],
  }, { weeks: 2 });
  check('expandProgram assigns weekdays',
    expanded.weeks.every((w) => w.days.every((d) => !!d.weekday)));
  eq('and keeps them identical across weeks',
    expanded.weeks[0].days.map((d) => d.weekday).join(','),
    expanded.weeks[1].days.map((d) => d.weekday).join(','));
}

/* ============================== report ============================== */

export function runAll() {
  const passed = results.filter((r) => r.pass).length;
  return { results, passed, failed: results.length - passed, total: results.length };
}

export function textReport() {
  const { results: rs, passed, failed, total } = runAll();
  const lines = [];
  let section = null;
  for (const r of rs) {
    if (r.section !== section) { section = r.section; lines.push(`\n── ${section} ──`); }
    lines.push(`${r.pass ? '  ok  ' : ' FAIL '} ${r.label}${r.detail ? `  (${r.detail})` : ''}`);
  }
  lines.push(`\n${passed}/${total} passed${failed ? `, ${failed} FAILED` : ''}`);
  return lines.join('\n');
}

/* Running under node prints the report and sets the exit code. */
if (typeof process !== 'undefined' && process.argv?.[1] && /selftest\.js$/.test(process.argv[1])) {
  console.log(textReport());
  process.exit(runAll().failed ? 1 : 0);
}
