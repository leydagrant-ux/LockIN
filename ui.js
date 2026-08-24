/* ui.js — the whole interface.
 *
 * Everything stateful and DOM-facing lives here. The modules it imports are
 * pure or thin wrappers, which is what keeps them testable in node.
 *
 * A deliberate constraint: THE APP MUST WORK WITH NO AI CONFIGURED. Programs
 * can be built from deterministic templates, food can be entered by hand, and
 * every screen renders. The Groq Worker is an enhancement that lights up extra
 * buttons, never a prerequisite for opening the app.
 */

import * as DB from './db.js';
import * as AI from './ai.js';
import * as FOOD from './foods.js';
import * as ANAT from './anatomy.js';
import * as EX from './exercises.js';
import * as PROG from './program.js';
import * as SCORE from './score.js';
import * as STATS from './stats.js';
import { WORKER_URL, MEMBERS, COUPLE_ID } from './config.js';

/* ============================== palette ============================== */

/* Validated categorical palette (dataviz slots 1-6, dark steps) checked against
   this app's card surface #171d26: all six pass the lightness band, chroma
   floor, CVD separation, normal-vision floor and 3:1 contrast. An earlier
   hand-picked set failed three of those — blue and violet were only ΔE 10.9
   apart for normal vision. Do not substitute by eye; re-run the validator. */
export const GROUP_COLOR = {
  chest: '#3987e5', back: '#d95926', shoulders: '#199e70',
  arms: '#c98500', legs: '#d55181', core: '#008300',
};
/* Macros use the first three slots, which clear the stricter all-pairs floors. */
const MACRO_COLOR = { protein: '#3987e5', carbs: '#d95926', fat: '#199e70' };


/* Every WRITE goes through this indirection. An ES module namespace object is
   frozen, so demo mode cannot stub DB.addEntry directly — it replaces these. */
const W = {
  addEntry: (...a) => DB.addEntry(...a),
  updateEntry: (...a) => DB.updateEntry(...a),
  removeEntry: (...a) => DB.removeEntry(...a),
  saveProfile: (...a) => DB.saveProfile(...a),
  saveProgram: (...a) => DB.saveProgram(...a),
  publishScore: (...a) => DB.publishScore(...a),
  rememberFood: (...a) => DB.rememberFood(...a),
  addPhoto: (...a) => DB.addPhoto(...a),
  importAll: (...a) => DB.importAll(...a),
};

/* ============================== state ============================== */

const S = {
  user: null, profile: null,
  partnerUid: null, partnerProfile: null,
  tab: 'today',
  workouts: [], meals: [], cardio: [], metrics: [], checkins: [], photos: [], foods: [],
  program: null, couple: {},
  session: null,      /* live workout being logged */
  bodyView: 'front',
  sheet: null,
  busy: false,
};

const todayKey = () => SCORE.dayKey(new Date());
const thisWeek = () => SCORE.isoWeekKey(new Date());

/* ============================== helpers ============================== */

const $ = (sel, root = document) => root.querySelector(sel);
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) =>
  ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const num = (v, d = 0) => { const n = Number(v); return Number.isFinite(n) ? n : d; };
const round = (n, dp = 0) => { const f = 10 ** dp; return Math.round(n * f) / f; };
const plural = (n, one, many) => `${n} ${n === 1 ? one : many}`;

/** Render the whole app. Cheap enough at this data volume, and removes a whole
    class of stale-view bugs that partial updates invite. */
function render() {
  $('#app').innerHTML = view() + (S.user && S.profile?.complete ? tabBar() : '') + sheetHTML();
}

const toast = (msg, kind = 'info') => {
  const el = document.createElement('div');
  el.className = `banner ${kind}`;
  el.style.cssText = 'position:fixed;left:16px;right:16px;bottom:calc(var(--tab-h) + var(--safe-b) + 14px);z-index:60;max-width:608px;margin:0 auto;box-shadow:0 8px 24px rgba(0,0,0,.5)';
  el.textContent = msg;
  document.body.appendChild(el);
  setTimeout(() => el.remove(), 3200);
};

async function guard(fn, label = 'That did not work') {
  if (S.busy) return;
  S.busy = true;
  try { await fn(); } catch (err) {
    console.error(err);
    toast(err?.message || label, 'bad');
  } finally { S.busy = false; }
}

/* ============================== charts ============================== */

/* Recessive axes, thin marks, direct labels where the series count allows, and
   never two y-scales on one plot. See the dataviz reference. */

function lineChart(series, { w = 320, h = 130, color = '#3987e5', label = '', fmt = (v) => v } = {}) {
  const pts = series.filter((p) => Number.isFinite(p.value));
  if (pts.length < 2) return `<div class="empty tiny">Not enough data yet.</div>`;

  const pad = { l: 34, r: 10, t: 12, b: 20 };
  const xs = (i) => pad.l + (i / (pts.length - 1)) * (w - pad.l - pad.r);
  const lo = Math.min(...pts.map((p) => p.value));
  const hi = Math.max(...pts.map((p) => p.value));
  const span = hi - lo || 1;
  const ys = (v) => pad.t + (1 - (v - lo) / span) * (h - pad.t - pad.b);

  const d = pts.map((p, i) => `${i ? 'L' : 'M'}${xs(i).toFixed(1)},${ys(p.value).toFixed(1)}`).join('');
  const grid = [lo, lo + span / 2, hi].map((v) =>
    `<line class="grid" x1="${pad.l}" y1="${ys(v).toFixed(1)}" x2="${w - pad.r}" y2="${ys(v).toFixed(1)}"/>
     <text class="axis" x="2" y="${(ys(v) + 3).toFixed(1)}">${fmt(round(v, 1))}</text>`).join('');

  const last = pts[pts.length - 1];
  return `<svg class="chart" viewBox="0 0 ${w} ${h}" role="img" aria-label="${esc(label)}">
    ${grid}
    <path class="line" d="${d}" stroke="${color}"/>
    <circle class="dot" cx="${xs(pts.length - 1).toFixed(1)}" cy="${ys(last.value).toFixed(1)}" r="4" fill="${color}"/>
    <text class="axis" x="${pad.l}" y="${h - 5}">${esc(pts[0].date?.slice(5) || '')}</text>
    <text class="axis" x="${w - pad.r}" y="${h - 5}" text-anchor="end">${esc(last.date?.slice(5) || '')}</text>
  </svg>`;
}

/** Grouped bars, one colour per muscle group, always with a legend. */
function volumeChart(weeks, { w = 320, h = 150 } = {}) {
  if (!weeks.length) return `<div class="empty tiny">Log a workout to see volume.</div>`;

  const groups = Object.keys(EX.MUSCLE_GROUPS);
  const shown = weeks.slice(-8);
  const pad = { l: 26, r: 8, t: 10, b: 22 };
  const max = Math.max(1, ...shown.map((wk) => Math.max(...groups.map((g) => wk.groups[g] || 0))));
  const bw = (w - pad.l - pad.r) / shown.length;
  const gw = (bw - 6) / groups.length;

  let bars = '';
  shown.forEach((wk, i) => {
    groups.forEach((g, j) => {
      const v = wk.groups[g] || 0;
      if (!v) return;
      const bh = (v / max) * (h - pad.t - pad.b);
      const x = pad.l + i * bw + 3 + j * gw;
      /* 2px gap between adjacent fills, 4px rounded data-end at the top. */
      bars += `<rect class="mark" x="${x.toFixed(1)}" y="${(h - pad.b - bh).toFixed(1)}"
        width="${Math.max(1, gw - 2).toFixed(1)}" height="${bh.toFixed(1)}"
        rx="2" fill="${GROUP_COLOR[g]}"><title>${esc(wk.week)} ${esc(EX.GROUP_LABELS[g])}: ${v} sets</title></rect>`;
    });
  });

  const ticks = [0, max / 2, max].map((v) => {
    const y = h - pad.b - (v / max) * (h - pad.t - pad.b);
    return `<line class="grid" x1="${pad.l}" y1="${y.toFixed(1)}" x2="${w - pad.r}" y2="${y.toFixed(1)}"/>
            <text class="axis" x="2" y="${(y + 3).toFixed(1)}">${Math.round(v)}</text>`;
  }).join('');

  const labels = shown.map((wk, i) =>
    `<text class="axis" x="${(pad.l + i * bw + bw / 2).toFixed(1)}" y="${h - 6}" text-anchor="middle">${esc(wk.week.slice(-3))}</text>`).join('');

  return `<svg class="chart" viewBox="0 0 ${w} ${h}" role="img" aria-label="Weekly sets per muscle group">
    ${ticks}${bars}${labels}</svg>
    <div class="legend">${groups.map((g) =>
      `<span><i style="background:${GROUP_COLOR[g]}"></i>${esc(EX.GROUP_LABELS[g])}</span>`).join('')}</div>`;
}

/** Hexagon whose six edges are the six muscle groups, filled by progress. */
function targetRing(progress, size = 190) {
  const R = size / 2 - 20, cx = size / 2, cy = size / 2;
  const groups = Object.keys(EX.MUSCLE_GROUPS);
  const vert = (i) => {
    const a = (-90 + i * 60) * Math.PI / 180;
    return [cx + R * Math.cos(a), cy + R * Math.sin(a)];
  };
  let edges = '';
  groups.forEach((g, i) => {
    const [x1, y1] = vert(i), [x2, y2] = vert((i + 1) % 6);
    const t = Math.min(1, progress[g] ?? 0);
    edges += `<line x1="${x1.toFixed(1)}" y1="${y1.toFixed(1)}" x2="${x2.toFixed(1)}" y2="${y2.toFixed(1)}"
      stroke="var(--surface-2)" stroke-width="8" stroke-linecap="round"/>`;
    if (t > 0.01) {
      edges += `<line x1="${x1.toFixed(1)}" y1="${y1.toFixed(1)}"
        x2="${(x1 + (x2 - x1) * t).toFixed(1)}" y2="${(y1 + (y2 - y1) * t).toFixed(1)}"
        stroke="${GROUP_COLOR[g]}" stroke-width="8" stroke-linecap="round"/>`;
    }
  });
  const pct = Math.round(groups.reduce((s, g) => s + Math.min(1, progress[g] ?? 0), 0) / groups.length * 100);
  return `<svg class="chart" viewBox="0 0 ${size} ${size}" style="max-width:${size}px;margin:0 auto"
     role="img" aria-label="Weekly set target progress ${pct} percent">
    ${edges}
    <text x="${cx}" y="${cy + 5}" text-anchor="middle" fill="var(--text)"
      style="font:800 30px system-ui;letter-spacing:-.03em">${pct}%</text>
    <text x="${cx}" y="${cy + 23}" text-anchor="middle" fill="var(--dim)" style="font:500 10px system-ui">of weekly sets</text>
  </svg>`;
}

/** Progress ring for one macro. */
function macroRing(value, target, color, label, unit = 'g') {
  const size = 74, r = 30, c = 2 * Math.PI * r;
  const pct = target ? Math.min(1, value / target) : 0;
  return `<div class="center">
    <svg viewBox="0 0 ${size} ${size}" style="width:100%;max-width:74px" role="img"
      aria-label="${esc(label)} ${Math.round(value)} of ${Math.round(target)} ${unit}">
      <circle cx="37" cy="37" r="${r}" fill="none" stroke="var(--surface-2)" stroke-width="7"/>
      <circle cx="37" cy="37" r="${r}" fill="none" stroke="${color}" stroke-width="7" stroke-linecap="round"
        stroke-dasharray="${(c * pct).toFixed(1)} ${c.toFixed(1)}" transform="rotate(-90 37 37)"/>
      <text x="37" y="41" text-anchor="middle" fill="var(--text)" style="font:700 15px system-ui">${Math.round(value)}</text>
    </svg>
    <div class="tiny muted" style="margin-top:3px">${esc(label)}</div>
    <div class="tiny faint">of ${Math.round(target)}${unit}</div>
  </div>`;
}

function heatmap(cells) {
  return `<div class="heat">${cells.map((c) =>
    `<i data-l="${c.level}" title="${esc(c.date)}"></i>`).join('')}</div>`;
}

/* ============================== derived data ============================== */

const weekWorkouts = () => {
  const { start } = SCORE.weekRange(thisWeek());
  const from = SCORE.dayKey(start);
  return S.workouts.filter((w) => w.date >= from);
};

function myScore() {
  const week = thisWeek();
  const { start } = SCORE.weekRange(week);
  const from = SCORE.dayKey(start);

  const workouts = S.workouts.filter((w) => w.date >= from);
  const cardio = S.cardio.filter((c) => c.date >= from);
  const meals = S.meals.filter((m) => m.date >= from);
  const checkins = S.checkins.filter((c) => c.date >= from);
  const metrics = S.metrics.filter((m) => m.date >= from);

  const targets = STATS.macroTargets(S.profile || {}, S.profile?.goal);
  const days = STATS.nutritionDays(meals, targets);

  const planned = num(S.profile?.daysPerWeek, 4);
  const fromPlan = workouts.filter((w) => w.plannedDay != null).length;

  return SCORE.scoreWeek({
    plannedSessions: planned,
    completedSessions: Math.min(fromPlan || workouts.length, planned),
    totalSessions: workouts.length,
    nutritionDaysOnTarget: days.filter((d) => d.onTarget).length,
    cardioMinutes: cardio.reduce((s, c) => s + num(c.minutes), 0),
    streak: SCORE.currentStreak(STATS.activeDates(S.workouts, S.cardio)),
    checkins: checkins.length + metrics.length,
  }, { plannedSessions: planned });
}

/** Today's prescribed session, adjusted for how the person says they feel. */
function todaySession() {
  if (!S.program?.weeks?.length) return null;

  const start = S.program.startDate ? new Date(S.program.startDate) : new Date();
  const weeksIn = Math.floor((Date.now() - start.getTime()) / (7 * 86400000));
  const week = S.program.weeks[Math.min(Math.max(0, weeksIn), S.program.weeks.length - 1)];
  if (!week) return null;

  /* Rotate through the week's days by how many sessions are already logged
     inside this ISO week — simple, and it survives a missed day without
     stranding someone on Monday's workout all week. */
  const done = weekWorkouts().length;
  const day = week.days[done % week.days.length];
  if (!day) return null;

  const checkin = S.checkins.find((c) => c.date === todayKey());
  const equipment = activeEquipment();
  const adjusted = checkin
    ? PROG.adjustSession(day, checkin, equipment)
    : { day, notes: [], changed: false, band: null, bandLabel: null, score: null };

  return { ...adjusted, week: week.label, dayIndex: done % week.days.length };
}

const activeEquipment = () => {
  const profs = S.profile?.gymProfiles || [];
  const active = profs.find((p) => p.id === S.profile?.activeGym) || profs[0];
  return active?.equipment || [];
};

/* ============================== views ============================== */

function view() {
  if (!S.user) return authView();
  if (!S.profile?.complete) return onboardView();
  switch (S.tab) {
    case 'body': return bodyView();
    case 'food': return foodView();
    case 'stats': return statsView();
    case 'more': return moreView();
    default: return todayView();
  }
}

/* ---------- auth ---------- */

let authMode = 'in';

function authView() {
  return `<div class="screen no-tabs" style="max-width:400px;padding-top:calc(56px + var(--safe-t))">
    <div class="center" style="margin-bottom:28px">
      <div style="font:800 34px system-ui;letter-spacing:-.04em">Lock<span style="color:var(--accent)">IN</span></div>
      <div class="muted tiny" style="margin-top:4px">Two people. One scoreboard.</div>
    </div>
    <div class="card">
      <form id="auth-form" autocomplete="on">
        ${authMode === 'up' ? `<div class="field">
          <label for="a-name">Name</label>
          <input id="a-name" name="name" required autocomplete="name" placeholder="Grant">
        </div>` : ''}
        <div class="field">
          <label for="a-email">Email</label>
          <input id="a-email" name="email" type="email" required autocomplete="email" inputmode="email">
        </div>
        <div class="field">
          <label for="a-pass">Password</label>
          <input id="a-pass" name="password" type="password" required minlength="6"
            autocomplete="${authMode === 'up' ? 'new-password' : 'current-password'}">
        </div>
        <button class="btn primary wide" type="submit">${authMode === 'up' ? 'Create account' : 'Sign in'}</button>
      </form>
      <button class="btn ghost wide sm" data-act="auth-toggle" style="margin-top:10px">
        ${authMode === 'up' ? 'I already have an account' : 'Create an account'}
      </button>
      ${authMode === 'up' ? '' : `<button class="btn ghost wide sm" data-act="auth-reset" style="margin-top:8px">
        Forgot password?
      </button>`}
    </div>
  </div>`;
}

/* ---------- onboarding ---------- */

let onboardStep = 0;
const draft = { gymProfiles: [], equipment: [] };

const STEPS = ['You', 'Body', 'Goal', 'Training', 'Equipment'];

function onboardView() {
  const step = STEPS[onboardStep];
  return `<div class="screen no-tabs" style="max-width:460px">
    <div class="top">
      <div>
        <h1>${esc(step)}</h1>
        <div class="sub">Step ${onboardStep + 1} of ${STEPS.length}</div>
      </div>
    </div>
    <div class="bar" style="margin-bottom:16px"><i style="width:${((onboardStep + 1) / STEPS.length) * 100}%;background:var(--accent)"></i></div>
    <form id="onboard-form"><div class="card">${onboardStep === 0 ? stepYou()
      : onboardStep === 1 ? stepBody()
      : onboardStep === 2 ? stepGoal()
      : onboardStep === 3 ? stepTraining()
      : stepEquipment()}</div>
      <div class="btn-row">
        ${onboardStep > 0 ? '<button class="btn" type="button" data-act="ob-back">Back</button>' : ''}
        <button class="btn primary" type="submit">${onboardStep === STEPS.length - 1 ? 'Finish' : 'Next'}</button>
      </div>
    </form>
  </div>`;
}

const stepYou = () => `
  <div class="field">
    <label for="o-name">Your name</label>
    <input id="o-name" name="name" required value="${esc(draft.name || S.user?.displayName || '')}">
  </div>
  <div class="field">
    <label for="o-sex">Body type for the muscle map</label>
    <select id="o-sex" name="sex">
      <option value="male" ${draft.sex === 'male' ? 'selected' : ''}>Male</option>
      <option value="female" ${draft.sex === 'female' ? 'selected' : ''}>Female</option>
    </select>
  </div>
  <p class="tiny faint">This only picks which body diagram gets drawn, and sets the
  Mifflin-St Jeor constant used for your calorie estimate.</p>`;

const stepBody = () => `
  <div class="field-row">
    <div class="field"><label for="o-age">Age</label>
      <input id="o-age" name="age" type="number" inputmode="numeric" min="13" max="99" required value="${esc(draft.age || '')}"></div>
    <div class="field"><label for="o-height">Height (in)</label>
      <input id="o-height" name="height" type="number" inputmode="decimal" min="40" max="90" step="0.5" required value="${esc(draft.height || '')}"></div>
  </div>
  <div class="field-row">
    <div class="field"><label for="o-weight">Weight (lb)</label>
      <input id="o-weight" name="weight" type="number" inputmode="decimal" min="60" max="600" step="0.1" required value="${esc(draft.weight || '')}"></div>
    <div class="field"><label for="o-bodyfat">Body fat % <span class="faint">(optional)</span></label>
      <input id="o-bodyfat" name="bodyfat" type="number" inputmode="decimal" min="3" max="60" step="0.1" value="${esc(draft.bodyfat || '')}"></div>
  </div>
  <div class="field">
    <label for="o-activity">Daily activity, outside training</label>
    <select id="o-activity" name="activity">
      ${Object.entries(STATS.ACTIVITY_FACTORS).map(([k, v]) =>
        `<option value="${k}" ${draft.activity === k ? 'selected' : ''}>${esc(v.label)}</option>`).join('')}
    </select>
  </div>`;

const stepGoal = () => `
  <div class="field">
    <label>What are you training for?</label>
    <div class="chips" data-group="goal">
      ${Object.entries(PROG.GOALS).map(([k, g]) =>
        `<button type="button" class="chip" data-val="${k}" aria-pressed="${draft.goal === k}">${esc(g.label)}</button>`).join('')}
    </div>
    <input type="hidden" name="goal" value="${esc(draft.goal || 'build_muscle')}">
  </div>
  <div class="field">
    <label for="o-target">Target weight (lb) <span class="faint">(optional)</span></label>
    <input id="o-target" name="targetWeight" type="number" inputmode="decimal" step="0.1" value="${esc(draft.targetWeight || '')}">
  </div>
  <div class="field">
    <label for="o-ideal">What do you want to look like? <span class="faint">(optional)</span></label>
    <textarea id="o-ideal" name="ideal" placeholder="Lean and athletic, visible abs, wider shoulders">${esc(draft.ideal || '')}</textarea>
  </div>`;

const stepTraining = () => `
  <div class="field">
    <label>Experience</label>
    <div class="chips" data-group="experience">
      ${['beginner', 'intermediate', 'advanced'].map((k) =>
        `<button type="button" class="chip" data-val="${k}" aria-pressed="${(draft.experience || 'intermediate') === k}">${k[0].toUpperCase() + k.slice(1)}</button>`).join('')}
    </div>
    <input type="hidden" name="experience" value="${esc(draft.experience || 'intermediate')}">
  </div>
  <div class="field-row">
    <div class="field"><label for="o-days">Days per week</label>
      <input id="o-days" name="daysPerWeek" type="number" inputmode="numeric" min="1" max="7" required value="${esc(draft.daysPerWeek || 4)}"></div>
    <div class="field"><label for="o-mins">Minutes per session</label>
      <input id="o-mins" name="minutes" type="number" inputmode="numeric" min="15" max="180" step="5" required value="${esc(draft.minutes || 60)}"></div>
  </div>
  <div class="field">
    <label for="o-lim">Injuries or things to avoid <span class="faint">(optional)</span></label>
    <textarea id="o-lim" name="limitations" placeholder="Cranky left shoulder on overhead pressing">${esc(draft.limitations || '')}</textarea>
  </div>`;

const stepEquipment = () => `
  <p class="tiny muted" style="margin-top:0">Tick what you can actually get to. Every
  workout is filtered to this list, so nothing will ever prescribe a machine you do not have.</p>
  <div class="btn-row" style="margin-bottom:14px">
    <button type="button" class="btn sm" data-act="preset-gym">Full gym</button>
    <button type="button" class="btn sm" data-act="preset-home">Home setup</button>
    <button type="button" class="btn sm" data-act="preset-none">Clear</button>
  </div>
  ${EX.EQUIPMENT_CATEGORIES.map((cat) => `
    <div style="margin-bottom:14px">
      <div class="card-title" style="margin-bottom:8px">${esc(cat.label)}</div>
      <div class="chips">
        ${cat.items.map(([id, label]) =>
          `<button type="button" class="chip sm" data-equip="${id}"
            aria-pressed="${draft.equipment.includes(id)}">${esc(label)}</button>`).join('')}
      </div>
    </div>`).join('')}
  <div class="tiny faint">${draft.equipment.length} selected ·
    ${EX.availableExercises(draft.equipment).length} exercises available</div>`;

/* ---------- today ---------- */

function todayView() {
  const checkin = S.checkins.find((c) => c.date === todayKey());
  const sess = todaySession();
  const streak = SCORE.currentStreak(STATS.activeDates(S.workouts, S.cardio));
  const loggedToday = S.workouts.some((w) => w.date === todayKey());

  return `<div class="screen">
    <div class="top">
      <div>
        <h1>${greeting()}</h1>
        <div class="sub">${new Date().toLocaleDateString(undefined, { weekday: 'long', month: 'short', day: 'numeric' })}
          ${streak ? ` · ${plural(streak, 'day', 'days')} streak` : ''}</div>
      </div>
    </div>

    ${S.session ? loggerCard() : ''}

    ${!S.session && !checkin ? checkinCard() : ''}

    ${!S.session && checkin && sess ? sessionCard(sess) : ''}

    ${!S.session && checkin && !sess ? `<div class="card">
      <div class="card-title">No program yet</div>
      <p class="muted tiny" style="margin-top:0">Build one and it will show up here each day,
      already adjusted for how you said you feel.</p>
      <button class="btn primary wide" data-act="go-program">Build my program</button>
    </div>` : ''}

    ${!S.session ? `<div class="btn-row" style="margin-bottom:12px">
      <button class="btn" data-act="quick-workout">Log a workout</button>
      <button class="btn" data-act="quick-cardio">Log cardio</button>
    </div>` : ''}

    ${loggedToday ? `<div class="banner ok">Session logged today. ${esc(prSummary())}</div>` : ''}

    ${recentCard()}
  </div>`;
}

function greeting() {
  const h = new Date().getHours();
  const name = (S.profile?.name || '').split(' ')[0];
  const part = h < 12 ? 'Morning' : h < 18 ? 'Afternoon' : 'Evening';
  return name ? `${part}, ${esc(name)}` : part;
}

function prSummary() {
  const w = S.workouts.find((x) => x.date === todayKey());
  if (!w) return '';
  const prs = STATS.newPRsIn(w, S.workouts.filter((x) => x.id !== w.id));
  return prs.length ? `${plural(prs.length, 'new PR', 'new PRs')}.` : '';
}

const checkinCard = () => `<div class="card">
  <div class="card-title">How are you today?</div>
  <form id="checkin-form">
    ${PROG.READINESS_FIELDS.map((f) => `
      <div class="field" style="margin-bottom:14px">
        <label for="c-${f.id}" style="display:flex;justify-content:space-between">
          <span>${esc(f.label)}</span>
          <span class="faint" id="c-${f.id}-out">3</span>
        </label>
        <input id="c-${f.id}" name="${f.id}" type="range" min="1" max="5" step="1" value="3"
          oninput="document.getElementById('c-${f.id}-out').textContent=
            this.value==1?'${esc(f.low)}':this.value==5?'${esc(f.high)}':this.value">
      </div>`).join('')}
    <div class="field">
      <label>Anything sore? <span class="faint">(we will train around it)</span></label>
      <div class="chips" data-group="sore">
        ${Object.entries(EX.GROUP_LABELS).map(([k, l]) =>
          `<button type="button" class="chip sm" data-val="${k}" aria-pressed="false">${esc(l)}</button>`).join('')}
      </div>
    </div>
    <button class="btn primary wide" type="submit">Set up today</button>
  </form>
</div>`;

function sessionCard(sess) {
  const bandClass = sess.band === 'recovery' || sess.band === 'reduced' ? 'warn'
    : sess.band === 'primed' ? 'ok' : 'info';
  return `<div class="card">
    <div class="card-title row">
      <span>${esc(sess.week)} · ${esc(sess.day.name || 'Today')}</span>
      ${sess.bandLabel ? `<span class="pill new" style="background:var(--surface-2);color:var(--dim)">${esc(sess.bandLabel)}</span>` : ''}
    </div>
    ${sess.changed ? `<div class="banner ${bandClass}">
      ${sess.notes.map((n) => esc(n)).join('<br>')}
    </div>` : ''}
    ${sess.day.blocks.map((b) => {
      const ex = EX.BY_ID[b.exerciseId];
      if (!ex) return '';
      return `<div class="list-row">
        <div class="grow">
          <b class="ellip">${esc(ex.name)}</b>
          <span class="tiny muted">${b.sets} × ${b.repMin}-${b.repMax}${b.rir != null ? ` · ${b.rir} RIR` : ''}</span>
        </div>
        ${b.swappedFrom ? '<span class="pill new" style="background:var(--surface-2);color:var(--dim)">swapped</span>' : ''}
      </div>`;
    }).join('')}
    <button class="btn primary wide" data-act="start-session" style="margin-top:12px">Start this session</button>
  </div>`;
}

function loggerCard() {
  const s = S.session;
  return `<div class="card">
    <div class="card-title row">
      <span>${esc(s.name || 'Workout')}</span>
      <span class="faint tiny" id="clock">${elapsed(s.startedAt)}</span>
    </div>
    ${s.entries.map((entry, ei) => {
      const ex = EX.BY_ID[entry.exerciseId];
      const target = entry.target;
      return `<div style="margin-bottom:16px">
        <div class="list-row" style="border:0;padding-bottom:6px">
          <div class="grow">
            <b class="ellip">${esc(ex?.name || entry.exerciseId)}</b>
            ${target ? `<span class="tiny muted">${esc(target.reason)}</span>` : ''}
          </div>
          <button class="btn sm ghost" data-act="swap-ex" data-i="${ei}">Swap</button>
        </div>
        ${entry.sets.map((set, si) => `
          <div class="list-row" style="gap:8px;padding:5px 0;border:0">
            <span class="faint tiny" style="width:16px">${si + 1}</span>
            <input style="flex:1;min-width:0;background:var(--surface-2);border:1px solid var(--line);border-radius:9px;padding:9px;min-height:40px"
              type="number" inputmode="decimal" step="0.5" placeholder="${ex?.bw ? '+lb' : 'lb'}"
              value="${set.weight ?? ''}" data-set="weight" data-i="${ei}" data-j="${si}">
            <input style="flex:1;min-width:0;background:var(--surface-2);border:1px solid var(--line);border-radius:9px;padding:9px;min-height:40px"
              type="number" inputmode="numeric" placeholder="reps"
              value="${set.reps ?? ''}" data-set="reps" data-i="${ei}" data-j="${si}">
            <button class="chip sm" style="min-width:42px" data-act="toggle-set" data-i="${ei}" data-j="${si}"
              aria-pressed="${set.done === true}">${set.done ? '✓' : '○'}</button>
          </div>`).join('')}
        <button class="btn sm ghost" data-act="add-set" data-i="${ei}">+ set</button>
      </div>`;
    }).join('')}
    <hr class="sep">
    <button class="btn sm ghost wide" data-act="add-exercise">+ add exercise</button>
    <div class="btn-row" style="margin-top:12px">
      <button class="btn" data-act="cancel-session">Discard</button>
      <button class="btn primary" data-act="finish-session">Finish</button>
    </div>
  </div>`;
}

const elapsed = (t) => {
  if (!t) return '';
  const m = Math.floor((Date.now() - t) / 60000);
  return `${Math.floor(m / 60)}:${String(m % 60).padStart(2, '0')}`;
};

function recentCard() {
  const recent = S.workouts.slice(0, 5);
  if (!recent.length) return '';
  return `<div class="card">
    <div class="card-title">Recent sessions</div>
    ${recent.map((w) => `<div class="list-row">
      <div class="grow">
        <b class="ellip">${esc(w.name || 'Workout')}</b>
        <span class="tiny muted">${esc(w.date)} · ${STATS.setCount(w)} sets · ${Math.round(STATS.tonnage(w)).toLocaleString()} lb</span>
      </div>
      <button class="btn sm ghost" data-act="del-workout" data-id="${esc(w.id)}">Delete</button>
    </div>`).join('')}
  </div>`;
}

/* ---------- body ---------- */

function bodyView() {
  const week = weekWorkouts();
  const vol = STATS.volumeByGroup(week);
  const sex = S.profile?.sex === 'female' ? 'female' : 'male';

  /* Progress toward each group's weekly target, capped at 1. */
  const progress = Object.fromEntries(Object.entries(vol).map(([g, v]) =>
    [g, v / (PROG.VOLUME_LANDMARKS[g]?.mav || 16)]));

  /* The body is painted against the TARGET, not against the biggest group.
     normalise() scales to whatever is largest, which on a light week lights the
     whole figure up and reads as "you trained everything hard" after three sets.
     Target-relative also makes the figure agree with the ring below it. */
  const values = ANAT.fromGroups(
    Object.fromEntries(Object.entries(progress).map(([g, v]) => [g, Math.min(1, v)])),
    EX.MUSCLE_GROUPS);
  const trend = STATS.weightTrend(S.metrics, 7);
  const latest = S.metrics.find((m) => Number.isFinite(Number(m.weight)));

  return `<div class="screen">
    <div class="top"><div><h1>Body</h1><div class="sub">This week's work, by muscle</div></div></div>

    <div class="card">
      <div class="card-title row">
        <span>Trained this week</span>
        <span class="chips">
          <button class="chip sm" data-act="body-view" data-val="front" aria-pressed="${S.bodyView === 'front'}">Front</button>
          <button class="chip sm" data-act="body-view" data-val="back" aria-pressed="${S.bodyView === 'back'}">Back</button>
        </span>
      </div>
      <div class="body-wrap">
        <figure>${ANAT.bodySVG({ sex, view: S.bodyView, values })}</figure>
      </div>
      <div class="legend" style="justify-content:center">
        <span><i style="background:${ANAT.PALETTES.heat.idle}"></i>not trained</span>
        <span><i style="background:${ANAT.PALETTES.heat.mid}"></i>halfway</span>
        <span><i style="background:${ANAT.PALETTES.heat.hot}"></i>target hit</span>
      </div>
    </div>

    <div class="card">
      <div class="card-title">Weekly set targets</div>
      ${targetRing(progress)}
      ${Object.keys(EX.MUSCLE_GROUPS).map((g) => {
        const t = PROG.VOLUME_LANDMARKS[g]?.mav || 16;
        const v = vol[g] || 0;
        const left = Math.max(0, round(t - v, 1));
        return `<div class="list-row">
          <i style="width:9px;height:9px;border-radius:3px;flex:none;background:${GROUP_COLOR[g]}"></i>
          <div class="grow">
            <div style="display:flex;justify-content:space-between">
              <b>${esc(EX.GROUP_LABELS[g])}</b>
              <span class="tiny muted">${left ? `${left} to go` : 'target hit'}</span>
            </div>
            <div class="bar" style="margin:6px 0 4px"><i style="width:${Math.min(100, (v / t) * 100)}%;background:${GROUP_COLOR[g]}"></i></div>
            <div class="tiny faint">${v} / ${t} sets</div>
          </div>
        </div>`;
      }).join('')}
    </div>

    <div class="card">
      <div class="card-title row">
        <span>Weight</span>
        <button class="btn sm" data-act="add-weight">Weigh in</button>
      </div>
      ${latest ? `<div class="stat">${round(num(latest.weight), 1)} <small>lb</small></div>
        ${trend.perWeek != null ? `<div class="tiny muted" style="margin-top:2px">
          ${trend.perWeek > 0 ? '+' : ''}${trend.perWeek} lb/week trend · ${trend.total > 0 ? '+' : ''}${trend.total} lb overall</div>` : ''}
        <div style="margin-top:12px">${lineChart(
          trend.series.map((p) => ({ date: p.date, value: p.trend ?? p.value })),
          { color: GROUP_COLOR.chest, label: 'Bodyweight trend', fmt: (v) => v })}</div>`
        : '<div class="empty tiny">No weigh-ins yet.</div>'}
    </div>

    <div class="card">
      <div class="card-title row">
        <span>Progress photos</span>
        <button class="btn sm" data-act="add-photo">Add</button>
      </div>
      <p class="tiny faint" style="margin-top:0">Private by default. Tap a photo to share it with
      ${esc(partnerName() || 'your partner')}.</p>
      ${S.photos.length ? `<div class="grid3">${S.photos.slice(0, 9).map((p) => `
        <button data-act="toggle-photo" data-id="${esc(p.id)}" style="position:relative;padding:0;border-radius:10px;overflow:hidden">
          <img src="${esc(p.image)}" alt="${esc(p.pose)} ${esc(p.date)}" style="width:100%;display:block;aspect-ratio:3/4;object-fit:cover">
          <span class="pill" style="position:absolute;left:4px;bottom:4px;background:rgba(0,0,0,.7);color:#fff">
            ${p.private ? 'private' : 'shared'}</span>
        </button>`).join('')}</div>`
        : '<div class="empty tiny">No photos yet.</div>'}
    </div>
  </div>`;
}

const partnerName = () => S.partnerProfile?.name || MEMBERS[S.partnerUid]?.name || '';

/* ---------- food ---------- */

function foodView() {
  const targets = STATS.macroTargets(S.profile || {}, S.profile?.goal);
  const today = S.meals.filter((m) => m.date === todayKey());
  const totals = STATS.dayMacros(today);
  const onTarget = STATS.isDayOnTarget(totals, targets);

  return `<div class="screen">
    <div class="top"><div><h1>Food</h1><div class="sub">${esc(PROG.GOALS[S.profile?.goal]?.label || 'Today')}</div></div></div>

    <div class="card">
      <div class="card-title row">
        <span>Today</span>
        ${onTarget ? '<span class="pill" style="background:rgba(70,211,154,.15);color:var(--good)">on target</span>' : ''}
      </div>
      <div class="stat">${Math.round(totals.calories)} <small>/ ${targets.calories} kcal</small></div>
      <div class="bar" style="margin:10px 0 16px">
        <i style="width:${Math.min(100, (totals.calories / targets.calories) * 100)}%;background:${totals.calories > targets.calories * 1.1 ? 'var(--warn)' : 'var(--accent)'}"></i>
      </div>
      <div class="grid3">
        ${macroRing(totals.protein, targets.protein, MACRO_COLOR.protein, 'Protein')}
        ${macroRing(totals.carbs, targets.carbs, MACRO_COLOR.carbs, 'Carbs')}
        ${macroRing(totals.fat, targets.fat, MACRO_COLOR.fat, 'Fat')}
      </div>
    </div>

    <div class="btn-row" style="margin-bottom:12px">
      <button class="btn primary" data-act="add-food">Add food</button>
      <button class="btn" data-act="describe-food">Describe</button>
      ${WORKER_URL ? '<button class="btn" data-act="photo-meal">Photo</button>' : ''}
    </div>

    <div class="card">
      <div class="card-title">Today's meals</div>
      ${today.length ? today.map((m) => `<div class="list-row">
        <div class="grow">
          <b class="ellip">${esc(m.name)}</b>
          <span class="tiny muted">${Math.round(num(m.calories))} kcal · P${round(num(m.protein), 1)} C${round(num(m.carbs), 1)} F${round(num(m.fat), 1)}</span>
        </div>
        <button class="btn sm ghost" data-act="del-meal" data-id="${esc(m.id)}">Remove</button>
      </div>`).join('') : '<div class="empty tiny">Nothing logged yet today.</div>'}
    </div>

    ${S.foods.length ? `<div class="card">
      <div class="card-title">Quick add <span class="faint">· free, no lookup</span></div>
      ${S.foods.slice(0, 8).map((f) => `<div class="list-row">
        <div class="grow"><b class="ellip">${esc(f.name)}</b>
          <span class="tiny muted">${Math.round(num(f.calories))} kcal · ${esc(f.per || 'serving')}</span></div>
        <button class="btn sm" data-act="requick" data-id="${esc(f.id)}">Add</button>
      </div>`).join('')}
    </div>` : ''}
  </div>`;
}

/* ---------- stats ---------- */

function statsView() {
  const mine = myScore();
  const week = thisWeek();
  const theirs = S.couple?.scores?.[week]?.[S.partnerUid];

  const entries = [{ name: S.profile?.name || 'You', score: mine, me: true }];
  if (theirs) entries.push({ name: partnerName() || 'Partner', score: theirs, me: false });
  const board = SCORE.leaderboard(entries);

  const weeks = STATS.weeklyVolume(S.workouts);
  const cells = STATS.heatmapGrid(S.workouts, S.cardio, new Date(), 18);

  const lifts = [...new Set(S.workouts.flatMap((w) => (w.entries || []).map((e) => e.exerciseId)))]
    .filter((id) => EX.BY_ID[id]);
  const pick = S.statLift && lifts.includes(S.statLift) ? S.statLift : lifts[0];
  const series = pick ? STATS.e1rmSeries(S.workouts, pick) : [];

  return `<div class="screen">
    <div class="top"><div><h1>Stats</h1><div class="sub">${esc(week)} · ${esc(SCORE.weekSummary(board))}</div></div></div>

    <div class="card">
      <div class="card-title">This week</div>
      ${board.map((e) => `<div style="margin-bottom:14px">
        <div style="display:flex;justify-content:space-between;align-items:baseline">
          <b>${esc(e.name)}${e.leader ? ' 👑' : ''}</b>
          <span class="stat" style="font-size:22px">${e.score.total}<small>/100</small></span>
        </div>
        <div class="bar" style="margin:6px 0"><i style="width:${e.score.total}%;background:${e.me ? 'var(--accent)' : GROUP_COLOR.shoulders}"></i></div>
      </div>`).join('')}
      ${!theirs ? `<p class="tiny faint">${esc(partnerName() || 'Your partner')} has not posted a score this week.</p>` : ''}
      <hr class="sep">
      <div class="card-title">Your breakdown</div>
      ${mine.components.map((c) => `<div class="list-row">
        <div class="grow">
          <div style="display:flex;justify-content:space-between">
            <b>${esc(c.label)}</b><span class="tiny muted">${c.points}/${c.max}</span>
          </div>
          <div class="bar" style="margin:6px 0 4px"><i style="width:${(c.points / c.max) * 100}%;background:var(--accent-dim)"></i></div>
          <div class="tiny faint">${esc(c.detail)}</div>
        </div>
      </div>`).join('')}
    </div>

    <div class="card">
      <div class="card-title">Sets per muscle group</div>
      ${volumeChart(weeks)}
    </div>

    ${lifts.length ? `<div class="card">
      <div class="card-title">Estimated 1RM</div>
      <div class="field">
        <select data-act="pick-lift">
          ${lifts.map((id) => `<option value="${esc(id)}" ${id === pick ? 'selected' : ''}>${esc(EX.BY_ID[id].name)}</option>`).join('')}
        </select>
      </div>
      ${series.length ? `<div class="stat">${round(series[series.length - 1].e1rm, 1)} <small>lb estimated max</small></div>` : ''}
      ${lineChart(series.map((p) => ({ date: p.date, value: p.e1rm })),
        { color: GROUP_COLOR.chest, label: 'Estimated one rep max' })}
    </div>` : ''}

    <div class="card">
      <div class="card-title">Consistency <span class="faint">· last 18 weeks</span></div>
      ${heatmap(cells)}
      <div class="legend" style="margin-top:8px">
        <span><i style="background:var(--surface-2)"></i>rest</span>
        <span><i style="background:#2f4a44"></i>cardio</span>
        <span><i style="background:#2b6b57"></i>lifted</span>
        <span><i style="background:var(--good)"></i>both</span>
      </div>
    </div>
  </div>`;
}

/* ---------- more ---------- */

function moreView() {
  const equip = activeEquipment();
  const aiOn = Boolean(WORKER_URL);
  return `<div class="screen">
    <div class="top"><div><h1>More</h1><div class="sub">${esc(S.profile?.name || '')}</div></div></div>

    ${!aiOn ? `<div class="banner info">
      The AI coach is not connected yet. Everything else works: programs build from
      templates, and food can be searched by hand. Add your Worker URL to
      <b>config.js</b> to switch it on.</div>` : ''}

    <div class="card">
      <div class="card-title">Program</div>
      ${S.program ? `<div class="list-row">
        <div class="grow"><b>${esc(S.program.name || 'Current block')}</b>
        <span class="tiny muted">${S.program.weeks?.length || 0} weeks · ${S.program.days?.length || S.program.weeks?.[0]?.days?.length || 0} days a week</span></div>
      </div>` : '<p class="muted tiny" style="margin-top:0">No program yet.</p>'}
      <button class="btn primary wide" data-act="go-program" style="margin-top:8px">
        ${S.program ? 'Rebuild program' : 'Build a program'}</button>
    </div>

    <div class="card">
      <div class="card-title row"><span>Equipment</span>
        <button class="btn sm" data-act="edit-equipment">Edit</button></div>
      <div class="tiny muted">${equip.length} items · ${EX.availableExercises(equip).length} exercises available</div>
    </div>

    <div class="card">
      <div class="card-title row"><span>Health documents</span>
        <button class="btn sm" data-act="add-health" ${aiOn ? '' : 'disabled'}>Upload</button></div>
      <p class="tiny faint" style="margin-top:0">Bloodwork and body scans. Private unless you share them.
      Training context only, never medical advice.</p>
      ${(S.health || []).length ? (S.health).map((h) => `<div class="list-row">
        <div class="grow"><b class="ellip">${esc(h.kind)} · ${esc(h.date)}</b>
          <span class="tiny muted">${(h.parsed?.markers || []).length} markers</span></div>
        <span class="pill" style="background:var(--surface-2);color:var(--dim)">${h.shared ? 'shared' : 'private'}</span>
      </div>`).join('') : '<div class="empty tiny">Nothing uploaded.</div>'}
    </div>

    <div class="card">
      <div class="card-title">Profile</div>
      <div class="list-row"><div class="grow"><b>Goal</b>
        <span class="tiny muted">${esc(PROG.GOALS[S.profile?.goal]?.label || '')}</span></div>
        <button class="btn sm ghost" data-act="edit-profile">Edit</button></div>
      <div class="list-row"><div class="grow"><b>Daily target</b>
        <span class="tiny muted">${STATS.macroTargets(S.profile || {}, S.profile?.goal).calories} kcal ·
        ${STATS.macroTargets(S.profile || {}, S.profile?.goal).protein}g protein</span></div></div>
    </div>

    <div class="card">
      <div class="card-title">Account</div>
      <div class="list-row"><div class="grow"><b>Your user id</b>
        <span class="tiny faint" style="word-break:break-all">${esc(S.user?.uid || '')}</span></div>
        <button class="btn sm ghost" data-act="copy-uid">Copy</button></div>
      <p class="tiny faint">Paste this into <b>config.js</b>, <b>firestore.rules</b> and
      <b>wrangler.toml</b> to finish setup.</p>
      <hr class="sep">
      <div class="btn-row">
        <button class="btn sm" data-act="export">Export data</button>
        <button class="btn sm" data-act="import">Import</button>
      </div>
      <button class="btn ghost wide sm" data-act="signout" style="margin-top:10px;color:var(--bad)">Sign out</button>
    </div>

    <p class="tiny faint center">${esc(ANAT.ATTRIBUTION)}</p>
  </div>`;
}

/* ---------- tab bar ---------- */

const ICONS = {
  today: '<path d="M4 7h16M4 12h16M4 17h10"/>',
  body: '<circle cx="12" cy="5" r="2.6"/><path d="M12 8v7M12 15l-3 6M12 15l3 6M6 10h12"/>',
  food: '<path d="M6 3v8a3 3 0 0 0 6 0V3M9 3v18M18 3c-1.5 2-2 4-2 6s.5 3 2 3v9"/>',
  stats: '<path d="M4 20V10M10 20V4M16 20v-7M22 20H2"/>',
  more: '<circle cx="5" cy="12" r="1.4"/><circle cx="12" cy="12" r="1.4"/><circle cx="19" cy="12" r="1.4"/>',
};

const tabBar = () => `<nav class="tabs">${
  ['today', 'body', 'food', 'stats', 'more'].map((t) => `
    <button data-tab="${t}" ${S.tab === t ? 'aria-current="page"' : ''}>
      <svg viewBox="0 0 24 24">${ICONS[t]}</svg>
      <span>${t[0].toUpperCase() + t.slice(1)}</span>
    </button>`).join('')}</nav>`;

/* ============================== sheets ============================== */

function sheetHTML() {
  if (!S.sheet) return '';
  const s = S.sheet;
  return `<div class="sheet-back" data-act="close-sheet">
    <div class="sheet" role="dialog" aria-modal="true">
      <div class="sheet-head">
        <h2>${esc(s.title)}</h2>
        <button class="btn sm ghost" data-act="close-sheet">Close</button>
      </div>
      <div class="sheet-body">${s.body}</div>
      ${s.foot ? `<div class="sheet-foot">${s.foot}</div>` : ''}
    </div>
  </div>`;
}

const openSheet = (title, body, foot = '') => { S.sheet = { title, body, foot }; render(); };
const closeSheet = () => { S.sheet = null; render(); };

/* ============================== program building ============================== */

/* Deterministic templates. The AI path (ai.generateTrainingDay) produces nicer
   selections, but the app must build a real program with no Worker configured,
   so this is the floor rather than a stopgap. */
const SPLITS = {
  3: { name: 'Full body', days: [['squat', 'horizontal_push', 'horizontal_pull'], ['hinge', 'vertical_push', 'vertical_pull'], ['lunge', 'horizontal_push', 'horizontal_pull']] },
  4: { name: 'Upper / lower', days: [['horizontal_push', 'horizontal_pull', 'vertical_push'], ['squat', 'hinge', 'lunge'], ['vertical_pull', 'horizontal_push', 'horizontal_pull'], ['hinge', 'squat', 'lunge']] },
  5: { name: 'Push / pull / legs', days: [['horizontal_push', 'vertical_push'], ['horizontal_pull', 'vertical_pull'], ['squat', 'hinge', 'lunge'], ['horizontal_push', 'vertical_push'], ['horizontal_pull', 'squat']] },
  6: { name: 'Push / pull / legs ×2', days: [['horizontal_push', 'vertical_push'], ['horizontal_pull', 'vertical_pull'], ['squat', 'hinge'], ['horizontal_push', 'vertical_push'], ['horizontal_pull', 'vertical_pull'], ['lunge', 'hinge']] },
};

function buildTemplate(profile) {
  const days = Math.min(6, Math.max(3, num(profile.daysPerWeek, 4)));
  const split = SPLITS[days] || SPLITS[4];
  const equipment = activeEquipment();
  const goal = PROG.GOALS[profile.goal] || PROG.GOALS.build_muscle;
  const [repMin, repMax] = goal.repRange;
  const minutes = num(profile.minutes, 60);
  const slots = Math.max(4, Math.min(8, Math.floor(minutes / 9)));

  const used = new Set();
  const pick = (opts) => {
    const fresh = opts.find((e) => !used.has(e.id));
    const chosen = fresh || opts[0];
    if (chosen) used.add(chosen.id);
    return chosen;
  };

  const out = split.days.slice(0, days).map((patterns, i) => {
    const blocks = [];

    for (const pattern of patterns) {
      const ex = pick(EX.availableExercises(equipment, { pattern, type: 'compound' })
        .concat(EX.availableExercises(equipment, { pattern })));
      if (ex) blocks.push({ exerciseId: ex.id, sets: 3, repMin, repMax, restSec: 150 });
    }

    /* Fill the rest with isolation for whatever the compounds already hit, so a
       short session is still balanced rather than three big lifts and nothing. */
    const groups = [...new Set(blocks.flatMap((b) =>
      (EX.BY_ID[b.exerciseId]?.primary || []).map(EX.groupOf).filter(Boolean)))];
    let gi = 0;
    while (blocks.length < slots && gi < groups.length * 3) {
      const g = groups[gi % groups.length];
      const ex = pick(EX.availableExercises(equipment, { group: g, type: 'isolation' }));
      if (ex) blocks.push({ exerciseId: ex.id, sets: 3, repMin: repMax, repMax: repMax + 5, restSec: 75 });
      gi++;
    }

    return { name: `Day ${i + 1}`, focus: groups.map((g) => EX.GROUP_LABELS[g]).join(', '), blocks };
  });

  return { id: 'current', name: split.name, goal: profile.goal, days: out, startDate: todayKey() };
}

/* The planning conversation. Kept at module scope so the sheet can be re-rendered
   without losing the thread. */
const planChat = { turns: [], proposal: null, busy: false };

/**
 * Candidates handed to the planner.
 *
 * Filtered to the user's equipment first, so a returned id is always something
 * they own. Capped and biased toward compounds because the whole list would eat
 * a large slice of the free tier's per-minute token budget on every turn.
 */
function planCandidates() {
  const equipment = activeEquipment();
  const all = EX.availableExercises(equipment);
  const compounds = all.filter((e) => e.type === 'compound');
  const isolation = all.filter((e) => e.type === 'isolation');
  return [...compounds, ...isolation].slice(0, 90);
}

const prefsList = () => S.profile?.coachPrefs || [];

function programSheet() {
  const prefs = prefsList();
  const p = planChat.proposal;
  const said = planChat.turns.filter((t) => t.role === 'user');

  const body = `
    ${!WORKER_URL ? `<div class="banner warn">The AI coach is not connected, so this
      builds from a template instead. Tell me and I can switch it on.</div>` : ''}

    ${prefs.length ? `<div class="card tight" style="margin-bottom:12px">
      <div class="card-title row"><span>What it knows about you</span>
        <button class="btn sm ghost" data-act="clear-prefs">Clear</button></div>
      ${prefs.map((x, i) => `<div class="list-row" style="padding:6px 0">
        <span class="grow tiny">${esc(x)}</span>
        <button class="btn sm ghost" data-act="drop-pref" data-i="${i}">&times;</button>
      </div>`).join('')}
    </div>` : `<p class="tiny faint" style="margin-top:0">Tell it how you like to train.
      For example: "Monday pull, Tuesday push, Wednesday legs, Thursday arms, Friday
      back and chest" or "full body every day, rotate which muscles get the volume so
      everything recovers".</p>`}

    ${said.map((t) => `<div class="banner info" style="text-align:right">${esc(t.content)}</div>`).join('')}

    ${p?.status === 'question' ? `<div class="banner warn">${esc(p.question)}</div>` : ''}

    ${p?.status === 'proposal' ? `
      <div class="banner ok">${esc(p.summary)}</div>
      ${p.days.map((d) => `<div class="card tight" style="margin-bottom:8px">
        <div class="card-title" style="margin-bottom:6px">${esc(d.name)}
          <span class="faint" style="text-transform:none;letter-spacing:0"> · ${esc(d.focus)}</span></div>
        ${d.blocks.map((b) => {
          const ex = EX.BY_ID[b.exerciseId];
          return ex ? `<div class="tiny" style="padding:2px 0">${esc(ex.name)}
            <span class="faint">${b.sets} × ${b.repMin}-${b.repMax}</span></div>` : '';
        }).join('')}
      </div>`).join('')}
      ${p.learned?.length ? `<p class="tiny faint">Will remember: ${p.learned.map(esc).join(' · ')}</p>` : ''}
    ` : ''}

    <div class="field" style="margin-top:12px">
      <label for="pl-q">${planChat.turns.length ? 'What should change?' : 'How do you want to train?'}</label>
      <textarea id="pl-q" placeholder="${planChat.turns.length
        ? 'Swap the leg day to Thursday, and less calf work'
        : 'Monday pull, Tuesday push, Wednesday legs, Thursday arms, Friday back and chest'}"></textarea>
    </div>
    <div id="pl-out"></div>`;

  const foot = `
    <div class="btn-row">
      ${WORKER_URL
        ? `<button class="btn ${p?.status === 'proposal' ? '' : 'primary'}" data-act="do-plan">
             ${planChat.turns.length ? 'Revise' : 'Build it'}</button>`
        : `<button class="btn primary" data-act="build-template">Use a template</button>`}
      ${p?.status === 'proposal'
        ? '<button class="btn primary" data-act="save-plan">Save this program</button>' : ''}
    </div>`;

  openSheet('Build a program', body, foot);
}

/* ============================== food flows ============================== */

function foodSearchSheet() {
  openSheet('Add food', `
    <div class="field">
      <label for="f-q">Search</label>
      <input id="f-q" placeholder="greek yogurt" autocomplete="off">
    </div>
    <div class="btn-row" style="margin-bottom:12px">
      <button class="btn sm" data-act="do-food-search">Search</button>
      <button class="btn sm" data-act="manual-food">Enter by hand</button>
    </div>
    <div id="f-results"></div>
  `);
}

function manualFoodSheet() {
  openSheet('Enter by hand', `
    <form id="manual-food-form">
      <div class="field"><label for="m-name">Name</label><input id="m-name" name="name" required></div>
      <div class="field-row">
        <div class="field"><label for="m-cal">Calories</label>
          <input id="m-cal" name="calories" type="number" inputmode="numeric" required></div>
        <div class="field"><label for="m-pro">Protein (g)</label>
          <input id="m-pro" name="protein" type="number" inputmode="decimal" step="0.1"></div>
      </div>
      <div class="field-row">
        <div class="field"><label for="m-carb">Carbs (g)</label>
          <input id="m-carb" name="carbs" type="number" inputmode="decimal" step="0.1"></div>
        <div class="field"><label for="m-fat">Fat (g)</label>
          <input id="m-fat" name="fat" type="number" inputmode="decimal" step="0.1"></div>
      </div>
      <button class="btn primary wide" type="submit">Log it</button>
    </form>`);
}

/* The clarify-or-commit meal chat. Capped at two questions by ai.js, and the
   result is always editable before it is saved. */
const mealChat = { turns: [], asked: 0 };

function describeSheet() {
  if (!WORKER_URL) {
    openSheet('Describe a meal', `<div class="banner warn">The AI coach is not connected yet.
      Add your Cloudflare Worker URL to <b>config.js</b> to use this.</div>
      <button class="btn wide" data-act="manual-food">Enter it by hand instead</button>`);
    return;
  }
  const last = mealChat.turns[mealChat.turns.length - 1];
  let pending = '';
  try { pending = last?.role === 'assistant' ? JSON.parse(last.content) : ''; } catch { pending = ''; }

  openSheet('Describe a meal', `
    ${mealChat.turns.filter((t) => t.role === 'user').map((t) =>
      `<div class="banner info" style="text-align:right">${esc(t.content)}</div>`).join('')}
    ${pending && pending.status === 'needs_clarification' ? `
      <div class="banner info">${esc(pending.question)}</div>
      <div class="chips" style="margin-bottom:12px">
        ${(pending.choices || []).map((c) => `<button class="chip sm" data-act="meal-choice" data-val="${esc(c)}">${esc(c)}</button>`).join('')}
      </div>` : ''}
    <div class="field">
      <label for="d-q">${mealChat.turns.length ? 'Your answer' : 'What did you eat?'}</label>
      <input id="d-q" placeholder="chipotle chicken bowl" autocomplete="off">
    </div>
    <button class="btn primary wide" data-act="do-describe">${mealChat.turns.length ? 'Answer' : 'Work it out'}</button>
    <div id="d-out" style="margin-top:12px"></div>`);
}

function confirmMealSheet(result) {
  const t = result.total || {};
  openSheet('Check the numbers', `
    ${result.assumptions ? `<div class="banner info">${esc(result.assumptions)}</div>` : ''}
    ${(result.items || []).map((i) => `<div class="list-row">
      <div class="grow"><b class="ellip">${esc(i.name)}</b>
        <span class="tiny muted">${esc(i.portion)} · ${Math.round(num(i.calories))} kcal</span></div>
    </div>`).join('')}
    <hr class="sep">
    <form id="confirm-meal-form">
      <div class="field"><label for="cm-name">Save as</label>
        <input id="cm-name" name="name" required value="${esc((result.items || [])[0]?.name || 'Meal')}"></div>
      <div class="field-row">
        <div class="field"><label for="cm-cal">Calories</label>
          <input id="cm-cal" name="calories" type="number" value="${Math.round(num(t.calories))}"></div>
        <div class="field"><label for="cm-pro">Protein</label>
          <input id="cm-pro" name="protein" type="number" step="0.1" value="${round(num(t.protein), 1)}"></div>
      </div>
      <div class="field-row">
        <div class="field"><label for="cm-carb">Carbs</label>
          <input id="cm-carb" name="carbs" type="number" step="0.1" value="${round(num(t.carbs), 1)}"></div>
        <div class="field"><label for="cm-fat">Fat</label>
          <input id="cm-fat" name="fat" type="number" step="0.1" value="${round(num(t.fat), 1)}"></div>
      </div>
      <p class="tiny faint">Confidence: ${esc(result.confidence || 'medium')}. Edit anything that looks off.</p>
      <button class="btn primary wide" type="submit">Log it</button>
    </form>`);
}


/** Save an expanded program, warn about obvious volume problems, and land on Today. */
async function commitProgram(expanded, days) {
  const check = PROG.validateVolume(days);
  const program = { ...expanded, id: 'current', startDate: todayKey() };
  await W.saveProgram(program);
  S.program = program;
  closeSheet();
  toast(check.ok ? 'Program saved' : `Saved. ${check.issues[0].message}`, check.ok ? 'ok' : 'warn');
  S.tab = 'today';
  render();
}

/* ============================== actions ============================== */

const ACTIONS = {
  'auth-toggle': () => { authMode = authMode === 'in' ? 'up' : 'in'; render(); },
  'auth-reset': () => guard(async () => {
    const email = document.getElementById('a-email')?.value.trim();
    if (!email) return toast('Type your email above first', 'warn');
    try { await DB.resetPassword(email); } catch (err) { throw new Error(DB.authErrorMessage(err)); }
    toast('Reset link sent. Check your email.', 'ok');
  }),
  'close-sheet': closeSheet,

  'body-view': (el) => { S.bodyView = el.dataset.val; render(); },
  'go-program': programSheet,
  'add-food': foodSearchSheet,
  'manual-food': manualFoodSheet,
  'describe-food': () => { mealChat.turns = []; mealChat.asked = 0; describeSheet(); },

  /* A sheet's body is a snapshot captured when it opened, so a full render()
     would redraw the STALE markup and the presets would appear to do nothing.
     Repaint the equipment block in place when it is on screen. */
  'preset-gym': () => setEquipment([...EX.PRESET_COMMERCIAL_GYM]),
  'preset-home': () => setEquipment([...EX.PRESET_HOME_GYM]),
  'preset-none': () => setEquipment([]),

  'ob-back': () => { onboardStep = Math.max(0, onboardStep - 1); render(); },

  'copy-uid': async () => {
    try { await navigator.clipboard.writeText(S.user.uid); toast('User id copied', 'ok'); }
    catch { toast('Select and copy it by hand', 'warn'); }
  },

  'signout': async () => { await DB.signOut(); location.reload(); },

  'start-session': () => {
    const sess = todaySession();
    if (!sess) return;
    S.session = {
      name: sess.day.name, startedAt: Date.now(), plannedDay: sess.dayIndex,
      entries: sess.day.blocks.map((b) => {
        const last = lastPerformance(b.exerciseId);
        const target = PROG.nextTarget(b, last);
        return {
          exerciseId: b.exerciseId, target,
          sets: Array.from({ length: b.sets }, () => ({ weight: target.weight || '', reps: '', done: false })),
        };
      }),
    };
    render();
  },

  'quick-workout': () => {
    S.session = { name: 'Workout', startedAt: Date.now(), entries: [] };
    render();
    ACTIONS['add-exercise']();
  },

  'cancel-session': () => {
    if (!confirm('Discard this session? Nothing will be saved.')) return;
    S.session = null; render();
  },

  'add-set': (el) => {
    const entry = S.session.entries[+el.dataset.i];
    const last = entry.sets[entry.sets.length - 1];
    entry.sets.push({ weight: last?.weight ?? '', reps: '', done: false });
    render();
  },

  'toggle-set': (el) => {
    const set = S.session.entries[+el.dataset.i].sets[+el.dataset.j];
    set.done = !set.done;
    render();
  },

  'add-exercise': () => {
    const equipment = activeEquipment();
    const list = EX.availableExercises(equipment);
    openSheet('Add exercise', `
      <div class="field"><input id="ex-q" placeholder="Search exercises" autocomplete="off"
        oninput="window.__filterEx(this.value)"></div>
      <div id="ex-list">${exerciseRows(list.slice(0, 60))}</div>`);
    window.__allEx = list;
    window.__filterEx = (q) => {
      const t = q.trim().toLowerCase();
      const hits = t ? list.filter((e) => e.name.toLowerCase().includes(t)) : list;
      $('#ex-list').innerHTML = exerciseRows(hits.slice(0, 60));
    };
  },

  'choose-ex': (el) => {
    const id = el.dataset.id;
    if (!S.session) S.session = { name: 'Workout', startedAt: Date.now(), entries: [] };
    const last = lastPerformance(id);
    S.session.entries.push({
      exerciseId: id,
      target: PROG.nextTarget({ exerciseId: id, sets: 3, repMin: 8, repMax: 12 }, last),
      sets: Array.from({ length: 3 }, () => ({ weight: last?.weight ?? '', reps: '', done: false })),
    });
    closeSheet();
  },

  'swap-ex': (el) => {
    const i = +el.dataset.i;
    const entry = S.session.entries[i];
    const opts = EX.findSwaps(entry.exerciseId, activeEquipment());
    if (!opts.length) return toast('No swap available with your equipment', 'warn');
    openSheet('Swap exercise', exerciseRows(opts.slice(0, 30), i));
  },

  'do-swap': (el) => {
    S.session.entries[+el.dataset.i].exerciseId = el.dataset.id;
    closeSheet();
  },

  'del-workout': (el) => guard(async () => {
    if (!confirm('Delete this session?')) return;
    await W.removeEntry('workouts', el.dataset.id);
    S.workouts = S.workouts.filter((w) => w.id !== el.dataset.id);
    render();
  }),

  'del-meal': (el) => guard(async () => {
    await W.removeEntry('meals', el.dataset.id);
    S.meals = S.meals.filter((m) => m.id !== el.dataset.id);
    render();
  }),

  'add-weight': () => openSheet('Weigh in', `
    <form id="weight-form">
      <div class="field"><label for="w-val">Weight (lb)</label>
        <input id="w-val" name="weight" type="number" inputmode="decimal" step="0.1" required autofocus></div>
      <div class="field"><label for="w-bf">Body fat % <span class="faint">(optional)</span></label>
        <input id="w-bf" name="bodyfat" type="number" inputmode="decimal" step="0.1"></div>
      <button class="btn primary wide" type="submit">Save</button>
    </form>`),

  'add-photo': () => openSheet('Progress photo', `
    <form id="photo-form">
      <div class="field"><label for="p-file">Photo</label>
        <input id="p-file" name="file" type="file" accept="image/*" required></div>
      <div class="field"><label for="p-pose">Pose</label>
        <select id="p-pose" name="pose"><option>front</option><option>side</option><option>back</option></select></div>
      <div class="switch"><span>Keep private<br><span class="tiny faint">Only you can see it</span></span>
        <input type="checkbox" name="private" checked></div>
      <button class="btn primary wide" type="submit" style="margin-top:12px">Save</button>
    </form>`),

  'toggle-photo': (el) => guard(async () => {
    const p = S.photos.find((x) => x.id === el.dataset.id);
    if (!p) return;
    const next = !p.private;
    await W.updateEntry('photos', p.id, { private: next });
    p.private = next;
    toast(next ? 'Photo is private' : `Shared with ${partnerName() || 'your partner'}`, 'ok');
    render();
  }),

  'edit-equipment': () => {
    draft.equipment = [...activeEquipment()];
    openSheet('Equipment', `<div id="eq-body">${stepEquipment()}</div>`,
      `<button class="btn primary wide" data-act="save-equipment">Save</button>`);
  },

  'save-equipment': () => guard(async () => {
    const profiles = [{ id: 'main', name: 'My gym', equipment: [...draft.equipment] }];
    await W.saveProfile({ gymProfiles: profiles, activeGym: 'main' });
    S.profile.gymProfiles = profiles; S.profile.activeGym = 'main';
    toast('Equipment saved', 'ok');
    closeSheet();
  }),

  'edit-profile': () => {
    Object.assign(draft, S.profile);
    onboardStep = 0;
    S.profile.complete = false;
    render();
  },

  /* Template fallback, used when there is no Worker configured. */
  'build-template': () => guard(async () => {
    const template = buildTemplate(S.profile);
    await commitProgram(PROG.expandProgram(template, { weeks: 5 }), template.days);
  }, 'Could not build the program'),

  'do-plan': () => guard(async () => {
    const text = $('#pl-q')?.value?.trim();
    if (!text) return toast('Say how you want to train first', 'warn');

    const out = $('#pl-out');
    out.innerHTML = '<div class="center" style="padding:10px"><span class="spinner"></span></div>';

    planChat.turns.push({ role: 'user', content: text });
    const result = await AI.planProgram({
      turns: planChat.turns,
      profile: S.profile,
      prefs: prefsList(),
      candidates: planCandidates(),
    });

    /* Strict schema guarantees a string id, not a REAL one. Anything the
       library does not recognise is dropped rather than saved and then
       exploding later when the logger tries to render it. */
    if (result.status === 'proposal') {
      result.days = (result.days || []).map((d) => ({
        ...d, blocks: (d.blocks || []).filter((b) => EX.BY_ID[b.exerciseId]),
      })).filter((d) => d.blocks.length);
      if (!result.days.length) throw new Error('The coach proposed exercises you do not have. Try again.');
    }

    planChat.turns.push({ role: 'assistant', content: JSON.stringify(result) });
    planChat.proposal = result;
    programSheet();
  }, 'The coach could not build that'),

  'save-plan': () => guard(async () => {
    const p = planChat.proposal;
    if (p?.status !== 'proposal') return;

    const template = {
      id: 'current', name: 'Custom plan', goal: S.profile.goal,
      days: p.days, startDate: todayKey(),
    };
    /* Anything durable the conversation surfaced is remembered, deduped so the
       same preference does not pile up across rebuilds. */
    const merged = [...new Set([...prefsList(), ...(p.learned || [])])].slice(0, 25);
    await W.saveProfile({ coachPrefs: merged });
    S.profile.coachPrefs = merged;

    await commitProgram(PROG.expandProgram(template, { weeks: 5 }), p.days);
    planChat.turns = []; planChat.proposal = null;
  }, 'Could not save the program'),

  'drop-pref': (el) => guard(async () => {
    const next = prefsList().filter((_, i) => i !== +el.dataset.i);
    await W.saveProfile({ coachPrefs: next });
    S.profile.coachPrefs = next;
    programSheet();
  }),

  'clear-prefs': () => guard(async () => {
    await W.saveProfile({ coachPrefs: [] });
    S.profile.coachPrefs = [];
    programSheet();
  }),

  'photo-meal': () => openSheet('Photograph a meal', `
    <p class="tiny muted" style="margin-top:0">The photo is read on Cloudflare, which
    is free but small. It is good at naming food and poor at judging portions, so it
    gives you a description to correct before any numbers are worked out.</p>
    <form id="photo-meal-form">
      <div class="field"><label for="pm-file">Photo</label>
        <input id="pm-file" name="file" type="file" accept="image/*" capture="environment" required></div>
      <button class="btn primary wide" type="submit">Read the plate</button>
    </form>
    <div id="pm-out"></div>`),

  'do-food-search': () => guard(async () => {
    const q = $('#f-q')?.value?.trim();
    if (!q) return;
    const out = $('#f-results');
    out.innerHTML = '<div class="center"><span class="spinner"></span></div>';
    const { results, errors } = await FOOD.searchAll(q, { library: S.foods, limit: 12 });
    out.innerHTML = results.length
      ? results.map((f, i) => {
          window.__foodHits = results;
          return `<div class="list-row">
            <div class="grow"><b class="ellip">${esc(f.name)}</b>
              <span class="tiny muted">${esc(f.brand || f.source)} · ${Math.round(num(f.calories))} kcal / ${esc(f.per)}</span></div>
            <button class="btn sm" data-act="pick-food" data-i="${i}">Add</button>
          </div>`;
        }).join('')
      : `<div class="empty tiny">Nothing found.${errors?.length ? ' Search may be offline.' : ''}
         <br><button class="btn sm" data-act="manual-food" style="margin-top:10px">Enter by hand</button></div>`;
  }),

  'pick-food': (el) => {
    const f = (window.__foodHits || [])[+el.dataset.i];
    if (!f) return;
    openSheet('Portion', `
      <div class="card tight"><b>${esc(f.name)}</b>
        <div class="tiny muted">${Math.round(num(f.calories))} kcal per ${esc(f.per)}</div></div>
      <form id="portion-form">
        <div class="field"><label for="po-x">How many servings?</label>
          <input id="po-x" name="servings" type="number" inputmode="decimal" step="0.25" value="1" required></div>
        <input type="hidden" name="idx" value="${+el.dataset.i}">
        <button class="btn primary wide" type="submit">Log it</button>
      </form>`);
  },

  'requick': (el) => guard(async () => {
    const f = S.foods.find((x) => x.id === el.dataset.id);
    if (!f) return;
    await logMeal(f);
  }),

  'meal-choice': (el) => { $('#d-q').value = el.dataset.val; ACTIONS['do-describe'](); },

  'do-describe': () => guard(async () => {
    const text = $('#d-q')?.value?.trim();
    if (!text) return;
    const out = $('#d-out');
    out.innerHTML = '<div class="center"><span class="spinner"></span></div>';

    mealChat.turns.push({ role: 'user', content: text });
    const result = await AI.logMeal(mealChat.turns, mealChat.asked);
    mealChat.turns.push({ role: 'assistant', content: JSON.stringify(result) });

    if (result.status === 'needs_clarification') {
      mealChat.asked++;
      describeSheet();
    } else {
      confirmMealSheet(result);
    }
  }, 'The coach could not work that out'),


  'photo-to-macros': () => guard(async () => {
    const text = $('#pm-desc')?.value?.trim();
    if (!text) return toast('Describe what is on the plate', 'warn');

    mealChat.turns = [{ role: 'user', content: text }];
    mealChat.asked = 0;
    const result = await AI.logMeal(mealChat.turns, mealChat.asked);
    mealChat.turns.push({ role: 'assistant', content: JSON.stringify(result) });

    if (result.status === 'needs_clarification') { mealChat.asked++; describeSheet(); }
    else confirmMealSheet(result);
  }, 'Could not work out the macros'),

  'pick-lift': (el) => { S.statLift = el.value; render(); },

  'export': () => guard(async () => {
    const data = await DB.exportAll();
    const blob = new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = `lockin-${todayKey()}.json`;
    a.click();
    setTimeout(() => URL.revokeObjectURL(a.href), 1000);
  }),

  'import': () => openSheet('Import', `
    <p class="muted tiny" style="margin-top:0">Restores a LockIN export. Entries with the same
    id are overwritten rather than duplicated, so importing twice is safe.</p>
    <form id="import-form">
      <div class="field"><input type="file" name="file" accept="application/json" required></div>
      <button class="btn primary wide" type="submit">Import</button>
    </form>`),

  'add-health': () => openSheet('Health document', `
    <div class="banner warn">Training context only. This never diagnoses anything and never
    suggests medication or supplements. Anything out of range gets flagged for your doctor.</div>
    <form id="health-form">
      <div class="field"><label for="h-file">Lab PDF or photo</label>
        <input id="h-file" name="file" type="file" accept="application/pdf,image/*,text/plain" required></div>
      <div class="switch"><span>Share with ${esc(partnerName() || 'partner')}</span>
        <input type="checkbox" name="shared"></div>
      <button class="btn primary wide" type="submit" style="margin-top:12px">Read it</button>
    </form>
    <p class="tiny faint">Text is pulled from the file in your browser. Only the extracted text
    is sent for structuring, never the original file.</p>`),

  'quick-cardio': () => openSheet('Log cardio', `
    <form id="cardio-form">
      <div class="field"><label for="cd-type">Activity</label>
        <select id="cd-type" name="exerciseId">
          ${EX.availableExercises(activeEquipment(), { type: 'cardio' })
            .map((e) => `<option value="${e.id}">${esc(e.name)}</option>`).join('')}
        </select></div>
      <div class="field-row">
        <div class="field"><label for="cd-min">Minutes</label>
          <input id="cd-min" name="minutes" type="number" inputmode="numeric" required></div>
        <div class="field"><label for="cd-dist">Distance (mi)</label>
          <input id="cd-dist" name="distance" type="number" inputmode="decimal" step="0.01"></div>
      </div>
      <button class="btn primary wide" type="submit">Save</button>
    </form>`),

  'finish-session': () => guard(async () => {
    const s = S.session;
    /* A set with reps in it WAS performed, whether or not the tick was tapped.
       The tick is a progress affordance during the session, not a data gate.
       Saving `done: x.done !== false` here meant an untapped set was stored as
       done:false, and stats.js treats that as never performed — so it vanished
       from PRs, volume and tonnage. Rows without reps are already filtered out,
       so everything that survives is real work. */
    const entries = s.entries
      .map((e) => ({
        exerciseId: e.exerciseId,
        sets: e.sets.filter((x) => num(x.reps) > 0).map((x) => ({
          weight: num(x.weight), reps: num(x.reps), done: true,
        })),
      }))
      .filter((e) => e.sets.length);

    if (!entries.length) return toast('Log at least one set first', 'warn');

    const workout = {
      date: todayKey(), name: s.name, entries,
      startedAt: s.startedAt, endedAt: Date.now(),
      ...(s.plannedDay != null ? { plannedDay: s.plannedDay } : {}),
    };
    const id = await W.addEntry('workouts', workout);
    const saved = { id, ...workout };

    const prs = STATS.newPRsIn(saved, S.workouts);
    S.workouts = [saved, ...S.workouts];
    S.session = null;
    await publishScore();
    render();

    if (prs.length) {
      openSheet('New personal record', `
        <div class="center" style="padding:10px 0 6px"><div style="font-size:44px">🏆</div></div>
        ${prs.map((p) => `<div class="center" style="margin-bottom:14px">
          <div class="card-title" style="margin-bottom:4px">${esc(p.name)}</div>
          <div class="stat">${round(p.value, 1)} <small>${p.kind === 'weight' ? 'lb' : 'lb est. max'}</small></div>
          ${p.previous ? `<div class="tiny faint">previous best ${round(p.previous, 1)}</div>` : '<div class="tiny faint">first time logged</div>'}
        </div>`).join('')}`);
    } else {
      toast('Session saved', 'ok');
    }
  }, 'Could not save the session'),
};

const exerciseRows = (list, swapIndex) => list.map((e) => `
  <div class="list-row">
    <div class="grow"><b class="ellip">${esc(e.name)}</b>
      <span class="tiny muted">${esc(e.primary.map((m) => EX.MUSCLE_LABELS[m]).join(', '))}</span></div>
    <button class="btn sm" data-act="${swapIndex != null ? 'do-swap' : 'choose-ex'}"
      data-id="${e.id}" ${swapIndex != null ? `data-i="${swapIndex}"` : ''}>${swapIndex != null ? 'Use' : 'Add'}</button>
  </div>`).join('') || '<div class="empty tiny">Nothing matches.</div>';

function lastPerformance(exerciseId) {
  for (const w of S.workouts) {
    const entry = (w.entries || []).find((e) => e.exerciseId === exerciseId);
    if (!entry) continue;
    const sets = entry.sets.filter((s) => num(s.reps) > 0);
    if (sets.length) return { weight: num(sets[0].weight), reps: sets.map((s) => num(s.reps)) };
  }
  return null;
}

async function logMeal(food) {
  const meal = {
    date: todayKey(), name: food.name,
    calories: num(food.calories), protein: num(food.protein),
    carbs: num(food.carbs), fat: num(food.fat),
  };
  const id = await W.addEntry('meals', meal);
  S.meals = [{ id, ...meal }, ...S.meals];
  await W.rememberFood(FOOD.toLibraryEntry(food, S.foods.find((f) => f.id === food.id)));
  S.foods = await DB.getFoodLibrary();
  closeSheet();
  toast('Logged', 'ok');
}

/** Push this week's score to the shared doc so the partner's leaderboard updates. */
async function publishScore() {
  try {
    const s = myScore();
    await W.publishScore(thisWeek(), {
      total: s.total, max: s.max,
      components: s.components.map((c) => ({ id: c.id, points: c.points, max: c.max, detail: c.detail })),
      name: S.profile?.name || '',
    });
  } catch (err) { console.warn('score publish failed', err); }
}


/** Replace the equipment selection and repaint whichever surface is showing it. */
function setEquipment(list) {
  draft.equipment = list;
  const inSheet = $('#eq-body');
  if (inSheet) inSheet.innerHTML = stepEquipment();
  else render();
}

/* ============================== event wiring ============================== */

let wired = false;

/**
 * Attach the delegated listeners. Call once and only once.
 *
 * This used to run at the end of every render(), which added a fresh set of
 * listeners each time: by the third render a single tap fired three handlers,
 * so a toggle flipped back to where it started and one "add set" produced
 * three. #app is never replaced, only its innerHTML, so one wiring holds.
 */
function wire(root) {
  if (wired) return;
  wired = true;

  root.addEventListener('click', (ev) => {
    const tab = ev.target.closest('[data-tab]');
    if (tab) { S.tab = tab.dataset.tab; render(); return; }

    const chip = ev.target.closest('[data-equip]');
    if (chip) {
      const id = chip.dataset.equip;
      const i = draft.equipment.indexOf(id);
      if (i < 0) draft.equipment.push(id); else draft.equipment.splice(i, 1);
      chip.setAttribute('aria-pressed', i < 0);
      const body = $('#eq-body');
      if (body) body.innerHTML = stepEquipment();
      else render();
      return;
    }

    const groupChip = ev.target.closest('[data-group] [data-val]');
    if (groupChip) {
      const group = groupChip.closest('[data-group]').dataset.group;
      if (group === 'sore') {
        groupChip.setAttribute('aria-pressed', groupChip.getAttribute('aria-pressed') !== 'true');
      } else {
        [...groupChip.parentElement.children].forEach((c) => c.setAttribute('aria-pressed', 'false'));
        groupChip.setAttribute('aria-pressed', 'true');
        const hidden = groupChip.closest('.field')?.querySelector('input[type=hidden]');
        if (hidden) hidden.value = groupChip.dataset.val;
      }
      return;
    }

    const act = ev.target.closest('[data-act]');
    if (act && ACTIONS[act.dataset.act]) {
      /* The sheet backdrop carries close-sheet too; only honour it when the
         backdrop ITSELF was hit, not a click that bubbled up from inside.
         This guard is why the sheet must not stopPropagation — doing that
         killed delegation for every control inside the sheet. */
      if (act.dataset.act === 'close-sheet' && act.classList.contains('sheet-back') && ev.target !== act) return;
      ev.preventDefault();
      ACTIONS[act.dataset.act](act);
    }
  });

  root.addEventListener('change', (ev) => {
    const sel = ev.target.closest('[data-act="pick-lift"]');
    if (sel) { S.statLift = sel.value; render(); }
  });

  root.addEventListener('input', (ev) => {
    const f = ev.target.closest('[data-set]');
    if (f && S.session) {
      const set = S.session.entries[+f.dataset.i].sets[+f.dataset.j];
      set[f.dataset.set] = f.value;
      /* Deliberately no re-render: it would blur the field mid-typing. */
    }
  });

  root.addEventListener('submit', (ev) => {
    ev.preventDefault();
    const form = ev.target;
    const data = Object.fromEntries(new FormData(form).entries());
    const handler = FORMS[form.id];
    if (handler) guard(() => handler(data, form));
  });
}

/* ============================== forms ============================== */

const FORMS = {
  'auth-form': async (d) => {
    /* Firebase's own message ("Firebase: Error (auth/invalid-credential).")
       tells nobody anything, so every auth failure goes through the mapper. */
    try {
      if (authMode === 'up') {
        await DB.signUp(d.email, d.password, d.name);
        draft.name = d.name;
      } else {
        await DB.signIn(d.email, d.password);
      }
    } catch (err) {
      throw new Error(DB.authErrorMessage(err));
    }
  },

  'onboard-form': async (d) => {
    Object.assign(draft, d);
    if (onboardStep < STEPS.length - 1) { onboardStep++; render(); return; }

    const profile = {
      name: draft.name, sex: draft.sex || 'male',
      age: num(draft.age, 30), height: num(draft.height, 68), weight: num(draft.weight, 170),
      bodyfat: num(draft.bodyfat) || null, activity: draft.activity || 'moderate',
      goal: draft.goal || 'build_muscle', targetWeight: num(draft.targetWeight) || null,
      ideal: draft.ideal || '', experience: draft.experience || 'intermediate',
      daysPerWeek: num(draft.daysPerWeek, 4), minutes: num(draft.minutes, 60),
      limitations: draft.limitations || '',
      gymProfiles: [{ id: 'main', name: 'My gym', equipment: [...draft.equipment] }],
      activeGym: 'main', complete: true,
    };
    await W.saveProfile(profile);
    S.profile = profile;
    if (num(draft.weight)) {
      const m = { date: todayKey(), weight: num(draft.weight), bodyfat: num(draft.bodyfat) || null };
      const id = await W.addEntry('metrics', m);
      S.metrics = [{ id, ...m }, ...S.metrics];
    }
    onboardStep = 0;
    render();
  },

  'checkin-form': async (d, form) => {
    const soreGroups = [...form.querySelectorAll('[data-group="sore"] [aria-pressed="true"]')]
      .map((b) => b.dataset.val);
    const checkin = {
      date: todayKey(),
      sleep: num(d.sleep, 3), energy: num(d.energy, 3),
      soreness: num(d.soreness, 3), stress: num(d.stress, 3),
      soreGroups,
    };
    const id = await W.addEntry('checkins', checkin);
    S.checkins = [{ id, ...checkin }, ...S.checkins];
    await publishScore();
    render();
  },

  'weight-form': async (d) => {
    const m = { date: todayKey(), weight: num(d.weight), bodyfat: num(d.bodyfat) || null };
    const id = await W.addEntry('metrics', m);
    S.metrics = [{ id, ...m }, ...S.metrics].sort((a, b) => b.date.localeCompare(a.date));
    await publishScore();
    closeSheet();
    toast('Saved', 'ok');
  },

  'photo-form': async (d, form) => {
    const file = form.querySelector('input[type=file]').files[0];
    if (!file) return;
    toast('Compressing…');
    const id = await W.addPhoto(file, { pose: d.pose, isPrivate: !!d.private });
    S.photos = await DB.listEntries('photos', { max: 60 });
    closeSheet();
    toast('Photo saved', 'ok');
  },

  'manual-food-form': async (d) => {
    await logMeal(FOOD.manualFood({
      name: d.name, calories: num(d.calories),
      protein: num(d.protein), carbs: num(d.carbs), fat: num(d.fat),
    }));
  },

  'portion-form': async (d) => {
    const f = (window.__foodHits || [])[num(d.idx)];
    if (!f) return;
    await logMeal(FOOD.scaleFood(f, num(d.servings, 1)));
  },

  'confirm-meal-form': async (d) => {
    await logMeal({
      id: `ai:${Date.now()}`, name: d.name, per: 'meal',
      calories: num(d.calories), protein: num(d.protein), carbs: num(d.carbs), fat: num(d.fat),
    });
    mealChat.turns = []; mealChat.asked = 0;
  },


  'photo-meal-form': async (d, form) => {
    const file = form.querySelector('input[type=file]').files[0];
    if (!file) return;
    const out = $('#pm-out');
    out.innerHTML = '<div class="center" style="padding:10px"><span class="spinner"></span>'
      + '<div class="tiny muted" style="margin-top:8px">Reading the plate…</div></div>';

    /* 640px is plenty for identifying food and keeps the upload small, which
       matters because the vision free tier is a shared daily neuron budget. */
    const { dataUrl } = await DB.compressImage(file, { maxSize: 640, maxBytes: 110_000 });
    const { description } = await AI.describeMealPhoto(dataUrl);

    openSheet('Is this right?', `
      <img src="${dataUrl}" alt="the meal" style="width:100%;max-height:200px;object-fit:cover;border-radius:12px;margin-bottom:12px">
      <div class="field">
        <label for="pm-desc">What it saw. Fix anything wrong, especially portions.</label>
        <textarea id="pm-desc" style="min-height:100px">${esc(description)}</textarea>
      </div>
      <p class="tiny faint">Portion size is where a small vision model struggles, and
      portion is most of the calories. Worth a glance.</p>
      <button class="btn primary wide" data-act="photo-to-macros">Work out the macros</button>`);
  },

  'cardio-form': async (d) => {
    const c = {
      date: todayKey(), exerciseId: d.exerciseId,
      minutes: num(d.minutes), distance: num(d.distance) || null,
    };
    const id = await W.addEntry('cardio', c);
    S.cardio = [{ id, ...c }, ...S.cardio];
    await publishScore();
    closeSheet();
    toast('Cardio logged', 'ok');
  },

  'import-form': async (d, form) => {
    const file = form.querySelector('input[type=file]').files[0];
    if (!file) return;
    const data = JSON.parse(await file.text());
    const n = await W.importAll(data);
    closeSheet();
    toast(`Imported ${n} records`, 'ok');
    await loadAll();
    render();
  },

  'health-form': async (d, form) => {
    const file = form.querySelector('input[type=file]').files[0];
    if (!file) return;
    toast('Reading the document…');
    const text = await extractText(file);
    if (!text.trim()) throw new Error('Could not read any text from that file.');
    const parsed = await AI.parseHealthDocument(text);
    await DB.addHealthDoc({ parsed, rawText: text, filename: file.name, shared: !!d.shared });
    S.health = await DB.listEntries('health', { max: 40 });
    closeSheet();
    toast('Document saved', 'ok');
  },
};

/**
 * Pull text out of an uploaded document, in the browser.
 *
 * Plain text and most lab PDFs carry a text layer, which covers the common case
 * without shipping an OCR engine. A scanned image has no text layer, and rather
 * than silently returning nothing it says so.
 */
async function extractText(file) {
  if (file.type === 'text/plain') return file.text();
  if (file.type === 'application/pdf') {
    const pdfjs = await import('https://cdn.jsdelivr.net/npm/pdfjs-dist@4.6.82/build/pdf.min.mjs');
    pdfjs.GlobalWorkerOptions.workerSrc = 'https://cdn.jsdelivr.net/npm/pdfjs-dist@4.6.82/build/pdf.worker.min.mjs';
    const pdf = await pdfjs.getDocument({ data: await file.arrayBuffer() }).promise;
    let out = '';
    for (let p = 1; p <= Math.min(pdf.numPages, 20); p++) {
      const content = await (await pdf.getPage(p)).getTextContent();
      out += content.items.map((i) => i.str).join(' ') + '\n';
    }
    return out;
  }
  throw new Error('Photos of documents are not supported yet. Upload the PDF, or paste the numbers by hand.');
}


/* ============================== demo mode ============================== */

/* `?demo` renders every screen against generated data with Firebase bypassed.
 * It exists so the app can be reviewed before any setup is finished, and so a
 * change to a view can be eyeballed without signing in. Nothing it does touches
 * the network, and every write is a no-op.
 */
function demoData() {
  const day = (n) => SCORE.dayKey(new Date(Date.now() - n * 86400000));
  const lifts = ['bench_press', 'back_squat', 'barbell_row', 'ohp', 'deadlift', 'lat_pulldown_m'];

  const workouts = [];
  for (let i = 0; i < 24; i++) {
    if (i % 7 === 3 || i % 7 === 6) continue;          /* two rest days a week */
    const picks = lifts.slice((i % 3) * 2, (i % 3) * 2 + 2);
    workouts.push({
      id: `w${i}`, date: day(i), name: ['Push', 'Pull', 'Legs'][i % 3], plannedDay: i % 3,
      startedAt: Date.now() - i * 86400000, endedAt: Date.now() - i * 86400000 + 3.4e6,
      entries: picks.map((id) => ({
        exerciseId: id,
        /* A slow upward drift so the 1RM chart has a real trend to draw. */
        sets: [0, 1, 2].map(() => ({ weight: 135 + Math.round((24 - i) / 3) * 5, reps: 8, done: true })),
      })),
    });
  }

  const metrics = Array.from({ length: 18 }, (_, i) => ({
    id: `m${i}`, date: day(i * 2),
    weight: 183 + Math.sin(i / 2) * 1.4 + i * 0.22,
  }));

  const meals = [
    { id: 'x1', date: day(0), name: 'Greek yogurt and berries', calories: 320, protein: 28, carbs: 34, fat: 8 },
    { id: 'x2', date: day(0), name: 'Chipotle chicken bowl', calories: 815, protein: 54, carbs: 82, fat: 27 },
    { id: 'x3', date: day(0), name: 'Whey shake', calories: 180, protein: 32, carbs: 6, fat: 2 },
  ];

  return {
    workouts, metrics, meals,
    cardio: [{ id: 'c1', date: day(1), exerciseId: 'incline_walk', minutes: 32 }],
    checkins: [{ id: 'k1', date: day(0), sleep: 4, energy: 4, soreness: 2, stress: 2, soreGroups: [] }],
    photos: [], foods: [
      { id: 'f1', name: 'Chipotle chicken bowl', calories: 815, protein: 54, carbs: 82, fat: 27, per: 'bowl', uses: 6 },
      { id: 'f2', name: 'Whey shake', calories: 180, protein: 32, carbs: 6, fat: 2, per: 'scoop', uses: 11 },
    ],
    health: [],
  };
}

function bootDemo() {
  S.user = { uid: 'demo-grant', displayName: 'Grant' };
  S.profile = {
    name: 'Grant', sex: 'male', age: 24, height: 71, weight: 186, activity: 'moderate',
    goal: 'build_muscle', experience: 'intermediate', daysPerWeek: 4, minutes: 60,
    gymProfiles: [{ id: 'main', name: 'My gym', equipment: [...EX.PRESET_COMMERCIAL_GYM] }],
    activeGym: 'main', complete: true,
  };
  Object.assign(S, demoData());

  /* ?demo&tab=body jumps straight to a screen, which is how each one gets
     screenshotted during review. */
  const wanted = new URLSearchParams(location.search).get('tab');
  if (wanted) S.tab = wanted;

  S.partnerUid = 'demo-ashtin';
  S.partnerProfile = { name: 'Ashtin', sex: 'female' };
  S.couple = { scores: { [thisWeek()]: { 'demo-ashtin': { total: 78, max: 100, name: 'Ashtin' } } } };

  const template = buildTemplate(S.profile);
  S.program = { ...PROG.expandProgram(template, { weeks: 5 }), id: 'current', startDate: SCORE.dayKey(new Date(Date.now() - 9 * 86400000)) };

  /* Every write becomes a no-op so the demo cannot reach the network. */
  for (const k of Object.keys(W)) W[k] = async () => 'demo';

  /* Demo only: exposes state so a browser session can inspect it. */
  window.__S = S;
  render();
}

/* ============================== boot ============================== */

async function loadAll() {
  const [workouts, metrics, meals, cardio, checkins, photos, foods, program, health] = await Promise.all([
    DB.listEntries('workouts', { max: 400 }),
    DB.listEntries('metrics', { max: 400 }),
    DB.listEntries('meals', { max: 400 }),
    DB.listEntries('cardio', { max: 300 }),
    DB.listEntries('checkins', { max: 200 }),
    DB.listEntries('photos', { max: 60 }),
    DB.getFoodLibrary(),
    DB.getProgram(),
    DB.listEntries('health', { max: 40 }),
  ]);
  Object.assign(S, { workouts, metrics, meals, cardio, checkins, photos, foods, program, health });
}

function findPartner() {
  const uids = Object.keys(MEMBERS);
  S.partnerUid = uids.find((u) => u !== S.user?.uid) || null;
}

async function boot() {
  wire($('#app'));

  if (new URLSearchParams(location.search).has('demo')) return bootDemo();

  DB.init();

  /* Both modules reach the Worker with the same auth, so they are configured
     together. With no WORKER_URL they simply stay dormant. */
  const getToken = () => DB.getIdToken();
  AI.configure({
    workerUrl: WORKER_URL ? `${WORKER_URL}/ai` : '',
    visionUrl: WORKER_URL ? `${WORKER_URL}/vision` : '',
    getToken,
  });
  FOOD.configure({ foodUrl: WORKER_URL ? `${WORKER_URL}/food` : '', getToken });

  DB.onAuth(async (user) => {
    S.user = user;
    if (!user) { render(); return; }

    try {
      S.profile = await DB.getProfile();
      findPartner();
      if (S.profile?.complete) {
        await loadAll();
        if (S.partnerUid) {
          DB.watchProfile(S.partnerUid, (p) => { S.partnerProfile = p; render(); });
          DB.watchCouple((c) => { S.couple = c; render(); });
        }
        publishScore();
      } else {
        Object.assign(draft, S.profile || {});
        draft.equipment = S.profile?.gymProfiles?.[0]?.equipment || [];
      }
    } catch (err) {
      console.error(err);
      /* A permission error here almost always means firestore.rules still has
         placeholder uids, which is a setup step rather than a code bug. */
      const denied = /permission|insufficient/i.test(err?.message || '');
      $('#app').innerHTML = `<div class="screen no-tabs">
        <div class="banner bad"><b>Could not load your data.</b><br>${esc(err.message || '')}</div>
        ${denied ? `<div class="card"><div class="card-title">Almost certainly the rules</div>
          <p class="tiny muted">Firestore is denying reads. Put this user id into
          <b>firestore.rules</b> and publish it in the Firebase console:</p>
          <p class="tiny" style="word-break:break-all"><b>${esc(user.uid)}</b></p></div>` : ''}
        <button class="btn wide" data-act="signout">Sign out</button></div>`;
      wire($('#app'));
      return;
    }
    render();
  });

  /* Keep the live-session clock moving without re-rendering the whole logger. */
  setInterval(() => {
    const c = document.getElementById('clock');
    if (c && S.session) c.textContent = elapsed(S.session.startedAt);
  }, 30000);
}

boot();
