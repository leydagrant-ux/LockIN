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
  addHealthDoc: (...a) => DB.addHealthDoc(...a),
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
  timer: null,        /* live cardio timer */
  bodyView: 'front',
  sheet: null,
  busy: false,
};

const todayKey = () => SCORE.dayKey(new Date());
const thisWeek = () => SCORE.isoWeekKey(new Date());

/* ============================== unfinished work ============================== */

/*
 * A session in progress lives in localStorage, not Firestore.
 *
 * Half a workout is not a record of anything, and syncing it would put a
 * half-empty session on the partner's leaderboard. It is also the one write
 * that has to survive a phone locking itself in a gym with no signal, which
 * rules out the network. It is per-device on purpose: you finish the workout on
 * the phone you started it on.
 */
const draftKey = () => `lockin.draft.${S.user?.uid || 'anon'}`;
const timerKey = () => `lockin.timer.${S.user?.uid || 'anon'}`;

/* Anything older than this was abandoned, not paused. Restoring yesterday's
   half-finished session onto today's date would log work that never happened. */
const DRAFT_MAX_AGE = 36 * 3600 * 1000;

function stash(key, value) {
  try {
    if (value) localStorage.setItem(key, JSON.stringify(value));
    else localStorage.removeItem(key);
  } catch { /* private browsing or quota: the session still works, it just will
               not survive a reload. Not worth interrupting a workout over. */ }
}

function unstash(key) {
  try {
    const raw = localStorage.getItem(key);
    if (!raw) return null;
    const value = JSON.parse(raw);
    if (!value || Date.now() - (value.startedAt || 0) > DRAFT_MAX_AGE) {
      localStorage.removeItem(key);
      return null;
    }
    return value;
  } catch { return null; }
}

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
  $('#app').innerHTML = view() + (S.user && S.profile?.complete ? tabBar() : '')
    + resumeBar() + sheetHTML();
  /* Every mutation ends in a render, so this one line is the whole persistence
     story for an in-progress session. The typing handler saves separately
     because it deliberately does not re-render. */
  stash(draftKey(), S.session);
  stash(timerKey(), S.timer);
  if (S.timer?.running) startTicking();
}

/** A way back to a workout you walked away from, on every other tab. */
const resumeBar = () => (S.session && S.tab !== 'today' && S.profile?.complete
  ? `<button class="btn primary" data-act="back-to-session"
      style="position:fixed;left:16px;right:16px;bottom:calc(var(--tab-h) + var(--safe-b) + 10px);
      z-index:40;max-width:608px;margin:0 auto;box-shadow:0 8px 24px rgba(0,0,0,.5)">
      Workout in progress &middot; resume</button>`
  : '');

const toast = (msg, kind = 'info') => {
  const el = document.createElement('div');
  el.className = `banner float ${kind}`;
  el.style.cssText = 'position:fixed;left:16px;right:16px;bottom:calc(var(--tab-h) + var(--safe-b) + 14px);z-index:60;max-width:608px;margin:0 auto;box-shadow:0 8px 24px rgba(0,0,0,.5)';
  el.textContent = msg;
  document.body.appendChild(el);
  setTimeout(() => el.remove(), 3200);
};

const exName = (id) => EX.BY_ID[id]?.name || id;

/**
 * A toast that can be taken back.
 *
 * Longer-lived than an ordinary toast, because reading it and deciding takes
 * longer than reading it. Only one is ever on screen: a second removal replaces
 * the first, so an undo button can never refer to the wrong thing.
 */
let undoEl = null;

function undoToast(message, undo) {
  undoEl?.remove();

  const el = document.createElement('div');
  el.className = 'banner float info';
  el.style.cssText = 'position:fixed;left:16px;right:16px;bottom:calc(var(--tab-h) + var(--safe-b) + 14px);z-index:60;max-width:608px;margin:0 auto;box-shadow:0 8px 24px rgba(0,0,0,.5);display:flex;align-items:center;gap:12px';

  const text = document.createElement('span');
  text.style.flex = '1';
  text.textContent = message;

  const btn = document.createElement('button');
  btn.className = 'btn sm';
  btn.textContent = 'Undo';
  btn.addEventListener('click', () => { el.remove(); undoEl = null; undo(); });

  el.append(text, btn);
  document.body.appendChild(el);
  undoEl = el;

  setTimeout(() => { if (undoEl === el) { el.remove(); undoEl = null; } }, 7000);
}

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

/* Undefined means on. Nobody who set up an account before this existed should
   silently stop being scored on something they were tracking. */
const scoresNutrition = () => S.profile?.trackNutrition !== false;

const skippedComponents = () => (scoresNutrition() ? [] : ['nutrition']);

const restAllowance = () =>
  Math.max(0, num(S.profile?.restDaysPerWeek, SCORE.DEFAULT_REST_ALLOWANCE));

/** The streak as it stood on a given day, rest days included. */
const myStreak = (asOf) => SCORE.restStreak(
  STATS.activeDates(S.workouts, S.cardio),
  { allowance: restAllowance(), asOf: asOf || new Date() },
);

/**
 * Score any ISO week, past or present.
 *
 * The upper date bound matters and is easy to leave out: this used to filter
 * `date >= from` only, which is correct for the current week because nothing is
 * logged in the future, and silently wrong for every past week, which would
 * have swept in everything since.
 */
function weekScore(weekKey) {
  const { start, end } = SCORE.weekRange(weekKey);
  const from = SCORE.dayKey(start);
  const to = SCORE.dayKey(end);
  const inWeek = (d) => d >= from && d <= to;

  const workouts = S.workouts.filter((w) => inWeek(w.date));
  const cardio = S.cardio.filter((c) => inWeek(c.date));
  const meals = S.meals.filter((m) => inWeek(m.date));
  const checkins = S.checkins.filter((c) => inWeek(c.date));
  const metrics = S.metrics.filter((m) => inWeek(m.date));

  const targets = STATS.macroTargets(S.profile || {}, S.profile?.goal);
  const days = STATS.nutritionDays(meals, targets);

  const planned = num(S.profile?.daysPerWeek, 4);
  const fromPlan = workouts.filter((w) => w.plannedDay != null).length;

  /* A studio class IS training. Ashtin does four a week, and counting them as
     missed sessions graded her as if she had done nothing. They carry no
     plannedDay, so they are added on top of whatever the program accounted
     for. The clamp in scoreWeek keeps the total honest. */
  const classes = cardio.filter((c) => c.kind === 'class').length;

  /* The streak as it stood when that week closed, not today's. */
  const now = new Date();
  const asOf = end < now ? end : now;

  return SCORE.scoreWeek({
    plannedSessions: planned,
    completedSessions: Math.min((fromPlan || workouts.length) + classes, planned),
    totalSessions: workouts.length + classes,
    nutritionDaysOnTarget: days.filter((d) => d.onTarget).length,
    cardioMinutes: cardio.reduce((s, c) => s + num(c.minutes), 0),
    streak: myStreak(asOf).days,
    checkins: checkins.length + metrics.length,
  }, { plannedSessions: planned }, { skip: skippedComponents() });
}

const myScore = () => weekScore(thisWeek());

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
    case 'cardio': return cardioView();
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
    <label for="o-rest">Rest days a week</label>
    <input id="o-rest" name="restDaysPerWeek" type="number" inputmode="numeric" min="0" max="4"
      required value="${esc(draft.restDaysPerWeek ?? 2)}">
    <p class="tiny faint" style="margin:6px 0 0">How many days off you allow yourself. Your streak
    survives this many in a row, so two means a normal weekend never costs you anything.</p>
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
  const streak = streakLine();
  const loggedToday = S.workouts.some((w) => w.date === todayKey());

  return `<div class="screen">
    <div class="top">
      <div>
        <h1>${greeting()}</h1>
        <div class="sub">${new Date().toLocaleDateString(undefined, { weekday: 'long', month: 'short', day: 'numeric' })}${streak}</div>
      </div>
    </div>

    ${S.session && !S.session.paused ? loggerCard() : ''}

    ${S.session?.paused ? pausedCard() : ''}

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

    ${overloadCard()}

    ${recentCard()}
  </div>`;
}

/**
 * The streak, and what is left of this week's rest budget.
 *
 * Going over the budget is stated, not punished: resting more already means
 * training less, which the adherence component docks on its own. Saying it
 * twice would be double-counting one behaviour.
 */
function streakLine() {
  const st = myStreak();
  if (!st.alive) return '';

  const allow = restAllowance();
  const left = allow - SCORE.restDaysUsed(STATS.activeDates(S.workouts, S.cardio), thisWeek());

  /* restRun counts today. Once it passes the allowance, today is the last day
     the run can survive, because tomorrow the gap to yesterday breaks it. */
  const tail = st.restRun > allow
    ? 'train today to keep it'
    : left > 0 ? `${plural(left, 'rest day', 'rest days')} left`
      : left === 0 ? 'rest days all used'
        : `${plural(-left, 'day', 'days')} over your rest allowance`;

  return ` · ${plural(st.days, 'day', 'days')} streak · ${tail}`;
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

/*
 * Editing is a MODE, not a control on every row.
 *
 * A remove button beside every set and every exercise is a dozen red crosses
 * sitting under your thumb for the whole workout, and the thing you actually do
 * a hundred times is type numbers. So the removal controls only exist while
 * editing, and they take the place of controls that are already there rather
 * than adding a column, which keeps the rows from reflowing when the mode
 * flips.
 */
let loggerEdit = false;

function loggerCard() {
  const s = S.session;
  const editing = loggerEdit && s.entries.length > 0;
  return `<div class="card">
    <div class="card-title row">
      <span>${esc(s.name || 'Workout')}</span>
      <span class="row" style="gap:10px;align-items:center">
        <span class="faint tiny" id="clock">${elapsed(s.startedAt)}</span>
        ${s.entries.length ? `<button class="btn sm ghost" data-act="logger-edit"
          style="padding:12px 10px;margin:-12px -10px -12px 0;min-height:0;${editing ? 'color:var(--accent)' : ''}">${editing ? 'Done' : 'Edit'}</button>` : ''}
      </span>
    </div>
    ${editing ? '<div class="banner info" style="margin-bottom:14px">Tap the minus on a set, or Remove on an exercise. You get one chance to undo.</div>' : ''}
    ${s.entries.map((entry, ei) => {
      const ex = EX.BY_ID[entry.exerciseId];
      const target = entry.target;
      return `<div style="margin-bottom:16px">
        <div class="list-row" style="border:0;padding-bottom:6px">
          <div class="grow">
            <b class="ellip">${esc(ex?.name || entry.exerciseId)}</b>
            ${target ? `<span class="tiny muted">${esc(target.reason)}</span>` : ''}
          </div>
          ${editing
            ? `<button class="btn sm ghost" data-act="del-entry" data-i="${ei}" style="color:var(--bad)">Remove</button>`
            : `<button class="btn sm ghost" data-act="swap-ex" data-i="${ei}">Swap</button>`}
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
            ${editing
              ? `<button class="chip sm" style="min-width:42px;color:var(--bad)" data-act="del-set"
                  data-i="${ei}" data-j="${si}" aria-label="Remove set ${si + 1}">&minus;</button>`
              : `<button class="chip sm" style="min-width:42px" data-act="toggle-set" data-i="${ei}" data-j="${si}"
                  aria-pressed="${set.done === true}">${set.done ? '✓' : '○'}</button>`}
          </div>`).join('')}
        <button class="btn sm ghost" data-act="add-set" data-i="${ei}">+ set</button>
      </div>`;
    }).join('')}
    <hr class="sep">
    <button class="btn sm ghost wide" data-act="add-exercise">+ add exercise</button>
    <div class="btn-row" style="margin-top:12px">
      <button class="btn" data-act="pause-session">Leave for now</button>
      <button class="btn primary" data-act="finish-session">Finish</button>
    </div>
    <button class="btn ghost wide sm" data-act="cancel-session" style="margin-top:8px;color:var(--bad)">Discard</button>
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
    ${recent.map((w) => `<div class="list-row" data-act="view-workout" data-id="${esc(w.id)}" role="button" tabindex="0">
      <div class="grow">
        <b class="ellip">${esc(w.name || 'Workout')}</b>
        <span class="tiny muted">${esc(w.date)} · ${STATS.setCount(w)} sets · ${Math.round(STATS.tonnage(w)).toLocaleString()} lb</span>
      </div>
      ${w.grade ? `<span class="pill" style="background:var(--surface-2);color:${gradeColor(w.grade.score)}">${w.grade.score}</span>` : ''}
      <span class="faint" aria-hidden="true">›</span>
    </div>`).join('')}
    <p class="tiny faint" style="margin-bottom:0">Tap a session to look back at it.</p>
  </div>`;
}

/* ---------- body ---------- */

function bodyView() {
  const week = weekWorkouts();
  const { start } = SCORE.weekRange(thisWeek());
  const weekCardio = S.cardio.filter((c) => c.date >= SCORE.dayKey(start));

  /* Classes light up the figure too, or a week of Solidcore reads as a body
     that was never trained. */
  const combined = STATS.combinedVolumeByGroup(week, weekCardio);
  const vol = Object.fromEntries(Object.entries(combined).map(([g, v]) => [g, v.total]));
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

    ${pastWeeks().length ? `<div class="card">
      <div class="card-title">Past weeks</div>
      ${pastWeeks().map((k) => {
        const sc = weekScore(k).total;
        return `<div class="list-row" data-act="view-week" data-week="${esc(k)}" role="button" tabindex="0">
          <div class="grow">
            <b>${esc(weekLabel(k))}</b>
            <span class="tiny muted">${esc(k)}</span>
          </div>
          <span class="pill" style="background:var(--surface-2);color:${gradeColor(sc)}">${sc}</span>
          <span class="faint" aria-hidden="true">›</span>
        </div>`;
      }).join('')}
      <p class="tiny faint" style="margin-bottom:0">Tap a week to see what you did and how it graded.</p>
    </div>` : ''}

    <div class="card">
      <div class="card-title">Sets per muscle group</div>
      ${volumeChart(weeks)}
    </div>

    ${volumeTargetCard()}

    ${prBoardCard()}

    ${classSummaryCard()}

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
      ${S.program ? '<button class="btn primary wide" data-act="edit-program" style="margin-top:8px">Edit this plan</button>' : ''}
      <button class="btn ${S.program ? 'ghost wide sm' : 'primary wide'}" data-act="go-program" style="margin-top:8px">
        ${S.program ? 'Rebuild it from scratch' : 'Build a program'}</button>
    </div>

    <div class="card">
      <div class="card-title row"><span>Equipment</span>
        <button class="btn sm" data-act="edit-equipment">Edit</button></div>
      <div class="tiny muted">${equip.length} items · ${EX.availableExercises(equip).length} exercises available</div>
      <hr class="sep">
      <button class="btn wide sm" data-act="scan-machine" ${aiOn ? '' : 'disabled'}>Add a machine by photo</button>
      ${(S.profile?.customExercises || []).map((c) => `<div class="list-row">
        <div class="grow"><b class="ellip">${esc(c.name)}</b>
          <span class="tiny muted">${esc((c.primary || []).map((m) => EX.MUSCLE_LABELS[m]).join(', '))}</span></div>
        <button class="btn sm ghost" data-act="del-custom" data-id="${esc(c.id)}" style="color:var(--bad)">Remove</button>
      </div>`).join('')}
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
      <div class="card-title">Scoring</div>
      <div class="switch">
        <span>Count nutrition<br><span class="tiny faint">Food logging affects your weekly grade</span></span>
        <input type="checkbox" data-toggle="toggle-nutrition" ${scoresNutrition() ? 'checked' : ''}>
      </div>
      <p class="tiny faint" style="margin-bottom:0">Turn this off and those points move onto training,
      cardio and consistency instead. You are still scored out of 100, so the leaderboard stays fair.
      The Food tab keeps working either way.</p>
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
  cardio: '<path d="M20.5 6.5a4 4 0 0 0-6.5-1.3L12 7l-2-1.8A4 4 0 1 0 4.5 11L12 19l7.5-8a4 4 0 0 0 1-4.5z"/>',
  food: '<path d="M6 3v8a3 3 0 0 0 6 0V3M9 3v18M18 3c-1.5 2-2 4-2 6s.5 3 2 3v9"/>',
  stats: '<path d="M4 20V10M10 20V4M16 20v-7M22 20H2"/>',
  more: '<circle cx="5" cy="12" r="1.4"/><circle cx="12" cy="12" r="1.4"/><circle cx="19" cy="12" r="1.4"/>',
};

const tabBar = () => `<nav class="tabs">${
  ['today', 'body', 'cardio', 'food', 'stats', 'more'].map((t) => `
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
    S.session = null; loggerEdit = false; render();
  },

  /* Walking away is the normal case, not the exception: you rack the bar, you
     go to the bathroom, the phone locks. The session stays exactly where it
     was, on this device, until it is finished or explicitly thrown away. */
  'pause-session': () => { S.session.paused = true; loggerEdit = false; render(); },
  'resume-session': () => { S.session.paused = false; render(); },
  'back-to-session': () => { S.tab = 'today'; if (S.session) S.session.paused = false; render(); },

  'logger-edit': () => { loggerEdit = !loggerEdit; render(); },

  /* Both removals are undoable for a few seconds. A set with numbers already
     in it is real work, and this is a control being tapped one-handed, mid
     workout, by someone who has just been under a bar. */
  'del-set': (el) => {
    const i = +el.dataset.i, j = +el.dataset.j;
    const entry = S.session.entries[i];
    const [set] = entry.sets.splice(j, 1);

    /* An exercise with no sets left reads as broken. Removing the last set
       means removing the exercise, which is what was meant anyway. */
    const alsoEntry = entry.sets.length === 0 ? S.session.entries.splice(i, 1)[0] : null;
    if (!S.session.entries.length) loggerEdit = false;
    render();

    undoToast(alsoEntry ? `${exName(alsoEntry.exerciseId)} removed` : 'Set removed', () => {
      if (alsoEntry) S.session.entries.splice(i, 0, alsoEntry);
      S.session.entries[i].sets.splice(j, 0, set);
      loggerEdit = true;
      render();
    });
  },

  'del-entry': (el) => {
    const i = +el.dataset.i;
    const [entry] = S.session.entries.splice(i, 1);
    if (!S.session.entries.length) loggerEdit = false;
    render();

    undoToast(`${exName(entry.exerciseId)} removed`, () => {
      S.session.entries.splice(i, 0, entry);
      loggerEdit = true;
      render();
    });
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
    pickFor = { kind: 'session' };
    openPicker('Add exercise', EX.availableExercises(activeEquipment()));
  },

  /* One picker serves the live session and the plan editor. `pickFor` says
     where the choice lands; without it the two would need duplicate sheets and
     duplicate search boxes that drift apart. */
  'choose-ex': (el) => placeExercise(el.dataset.id),

  'swap-ex': (el) => {
    const i = +el.dataset.i;
    const entry = S.session.entries[i];
    const opts = EX.findSwaps(entry.exerciseId, activeEquipment());
    if (!opts.length) return toast('No swap available with your equipment', 'warn');
    pickFor = { kind: 'session-swap', index: i };
    openPicker('Swap exercise', opts.slice(0, 30));
  },


  /* ---------- an exercise the library does not have ---------- */

  'new-exercise': () => customExerciseSheet(),

  'save-custom-ex': () => guard(async () => {
    const name = ($('#cx-name')?.value || '').trim();
    if (!name) return toast('Give it a name first', 'warn');

    const primary = [...document.querySelectorAll('[data-mc-muscle][aria-pressed="true"]')]
      .map((b) => b.dataset.mcMuscle);
    if (!primary.length) return toast('Pick at least one muscle', 'warn');

    const id = EX.customId(name);
    const existing = S.profile?.customExercises || [];

    /* Already in the library, either as a custom entry or as a built-in whose
       name slugs to the same thing. Placing it is what was wanted anyway. */
    if (EX.BY_ID[id]) {
      toast(`${EX.BY_ID[id].name} is already in the list`, 'warn');
      placeExercise(id);
      return;
    }

    const custom = {
      id,
      name,
      pattern: $('#cx-pattern')?.value || 'isolation',
      type: primary.length > 1 ? 'compound' : 'isolation',
      primary,
      secondary: [],
      /* No equipment on purpose. The whole reason for adding one by hand is
         that the library does not cover it, so gating it behind an equipment
         tick would hide it again the moment it was created. */
      equipment: [],
    };

    const customExercises = [...existing, custom];
    await W.saveProfile({ customExercises });
    S.profile.customExercises = customExercises;
    EX.registerCustom([custom]);

    toast(`${name} added`, 'ok');
    placeExercise(id);
  }, 'Could not add that exercise'),

  'del-workout': (el) => guard(async () => {
    if (!confirm('Delete this session?')) return;
    await W.removeEntry('workouts', el.dataset.id);
    S.workouts = S.workouts.filter((w) => w.id !== el.dataset.id);
    /* The review sheet may be showing the session that just went away. A plain
       render would redraw it from a workout that no longer exists. */
    S.sheet = null;
    await publishScore();
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

  'toggle-nutrition': (el) => guard(async () => {
    const next = el.checked;
    await W.saveProfile({ trackNutrition: next });
    S.profile.trackNutrition = next;
    /* Republish, or the partner's leaderboard keeps showing the old split. */
    await publishScore();
    toast(next ? 'Nutrition counts toward your weekly score'
      : 'Nutrition no longer affects your score', 'ok');
    render();
  }),

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
        <input id="h-file" name="file" type="file" accept="application/pdf,image/*,text/plain" multiple required></div>
      <div class="switch"><span>Share with ${esc(partnerName() || 'partner')}</span>
        <input type="checkbox" name="shared"></div>
      <button class="btn primary wide" type="submit" style="margin-top:12px">Read it</button>
    </form>
    <p class="tiny faint">A PDF is read in your browser and only the text leaves the phone.
    A photo has to be read by the camera model first, and you get to check what it found
    before any of it is saved. Pick more than one file for a multi-page report.</p>`),

  /* Photographed numbers are checked by a human before anything is structured.
     See healthReviewSheet for why this step is not optional. */
  'health-structure': () => guard(async () => {
    const text = ($('#hd-text')?.value || '').trim();
    if (!text) return toast('There is nothing to save', 'warn');

    const out = $('#hd-actions');
    if (out) out.innerHTML = '<div class="center" style="padding:10px"><span class="spinner"></span></div>';

    try {
      const parsed = await AI.parseHealthDocument(text);
      await W.addHealthDoc({
        parsed, rawText: text,
        filename: healthDraft?.filename || 'photo',
        shared: !!healthDraft?.shared,
      });
      S.health = await DB.listEntries('health', { max: 40 });
      healthDraft = null;
      closeSheet();
      toast('Document saved', 'ok');
    } catch (err) {
      /* Put the button back. Without this a failed save leaves a spinner that
         never stops and no way to retry, and the transcription the person just
         corrected by hand is trapped behind it. */
      const slot = $('#hd-actions');
      if (slot) {
        slot.innerHTML = `<button class="btn primary wide" data-act="health-structure">Try saving again</button>`;
      }
      throw err;
    }
  }, 'Could not read that document'),

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

  /* ---------- looking back at a week ---------- */

  'view-week': (el) => weekSheet(el.dataset.week),

  'week-review': (el) => guard(async () => {
    const weekKey = el.dataset.week;
    const slot = $('#wk-review');
    if (slot) slot.innerHTML = '<div class="center" style="padding:18px"><span class="spinner"></span></div>';

    try {
      const d = weekDetail(weekKey);
      const review = await AI.weeklyReview({
        week: weekKey,
        dates: weekLabel(weekKey),
        goal: PROG.GOALS[S.profile?.goal]?.label || 'general fitness',
        score: { total: d.score.total, outOf: d.score.max },
        breakdown: d.score.components.map((c) => `${c.label}: ${c.points}/${c.max} (${c.detail})`),
        activeDays: d.activeDays,
        restDays: { used: d.restUsed, allowed: d.restAllowed },
        sessions: d.workouts.map((w) => ({
          date: w.date, name: w.name || 'Workout',
          sets: STATS.setCount(w), volumeLb: Math.round(STATS.tonnage(w)),
        })),
        cardioMinutes: d.cardio.reduce((n, c) => n + num(c.minutes), 0),
        setsPerMuscleGroup: d.volume,
      });

      weekReviews.set(weekKey, review);
      const after = $('#wk-review');
      if (after) after.innerHTML = weekReviewBlock(weekKey);
    } catch (err) {
      /* Put the button back rather than leaving a spinner that never stops. */
      const after = $('#wk-review');
      if (after) after.innerHTML = weekReviewBlock(weekKey);
      throw err;
    }
  }, 'The coach could not review that week'),

  /* ---------- looking back at a session ---------- */

  'view-workout': (el) => reviewSheet(el.dataset.id),

  'grade-session': (el) => guard(async () => {
    const id = el.dataset.id;
    const w = S.workouts.find((x) => x.id === id);
    if (!w) return;

    const slot = $('#grade-slot');
    if (slot) slot.innerHTML = '<div class="center" style="padding:18px"><span class="spinner"></span></div>';

    const grade = await AI.gradeWorkout({
      text: workoutText(w),
      goalLabel: PROG.GOALS[S.profile?.goal]?.label,
      profile: S.profile || {},
      history: recentHistoryText(id),
    });

    /* Stored on the session, not recomputed on every view: it costs a Groq call
       and the answer would drift between renders of the same workout. */
    await W.updateEntry('workouts', id, { grade });
    w.grade = grade;

    const after = $('#grade-slot');
    if (after) after.innerHTML = gradeBlock(w);
    else render();
  }, 'The coach could not grade that'),

  /* ---------- editing the plan ---------- */

  'edit-program': () => {
    if (!S.program) return toast('Build a program first', 'warn');
    planEdit = programDays();
    planEditSheet();
  },

  'ped-del': (el) => {
    planEdit[+el.dataset.d].blocks.splice(+el.dataset.i, 1);
    $('#ped-body').innerHTML = planEditBody();
  },

  'ped-add': (el) => {
    pickFor = { kind: 'plan', day: +el.dataset.d };
    openPicker('Add to this day', EX.availableExercises(activeEquipment()));
  },

  'ped-swap': (el) => {
    const d = +el.dataset.d, i = +el.dataset.i;
    const opts = EX.findSwaps(planEdit[d].blocks[i].exerciseId, activeEquipment());
    if (!opts.length) return toast('No swap available with your equipment', 'warn');
    pickFor = { kind: 'plan-swap', day: d, index: i };
    openPicker('Swap exercise', opts.slice(0, 30));
  },

  'save-plan-edit': () => guard(async () => {
    const days = planEdit.filter((d) => d.blocks.length);
    if (!days.length) return toast('A plan needs at least one exercise', 'warn');
    await saveDays(days, 'Plan updated');
    planEdit = null;
    closeSheet();
  }, 'Could not save the plan'),

  /* ---------- the cardio timer ---------- */

  'timer-mode': (el) => {
    /* No timer running yet, so this only chooses what the next one will be.
       Held on the profile so tomorrow opens on the same machine. */
    S.profile = { ...(S.profile || {}), lastCardioMode: el.dataset.val };
    render();
  },

  'timer-start': (el) => {
    const mode = el.dataset.val;
    S.timer = { mode, startedAt: Date.now(), since: Date.now(), accum: 0, running: true };
    render();
  },

  'timer-pause': () => {
    S.timer.accum = timerMs();
    S.timer.running = false;
    render();
  },

  'timer-resume': () => {
    S.timer.since = Date.now();
    S.timer.running = true;
    render();
  },

  'timer-stop': () => {
    const minutes = Math.max(1, Math.round(timerMs() / 60000));
    const mode = S.timer.mode;
    S.timer = null;
    render();
    cardioFinishSheet(minutes, mode);
  },

  'timer-discard': () => {
    if (!confirm('Throw this away? Nothing will be logged.')) return;
    S.timer = null; render();
  },

  'log-class': (el) => classSheet(el.dataset.val),

  'del-cardio': (el) => guard(async () => {
    await W.removeEntry('cardio', el.dataset.id);
    S.cardio = S.cardio.filter((c) => c.id !== el.dataset.id);
    await publishScore();
    render();
  }),

  /* Core work opens the ordinary logger, filtered to core movements. It is
     resistance training and belongs in the workout history: logged as cardio
     minutes it would earn cardio points and contribute nothing to the body
     map, which is exactly backwards. */
  'quick-core': () => {
    if (!S.session) S.session = { name: 'Core', startedAt: Date.now(), entries: [] };
    S.tab = 'today';
    render();
    pickFor = { kind: 'session' };
    openPicker('Add core work', EX.CORE_EXERCISES(activeEquipment()));
  },

  /* ---------- photographing a machine ---------- */

  'scan-machine': () => openSheet('Add a machine by photo', `
    <p class="tiny muted" style="margin-top:0">Point the camera at the name plate on the side of the
    machine. The plate is what gets read, so a clear shot of the label beats a shot of the whole rig.</p>
    <form id="machine-form">
      <div class="field"><label for="mf-file">Photo</label>
        <input id="mf-file" name="file" type="file" accept="image/*" capture="environment" required></div>
      <button class="btn primary wide" type="submit">Read the machine</button>
    </form>
    <p class="tiny faint">You get to check and rename it before anything is saved.</p>`),

  'save-machine': () => guard(async () => {
    const m = machineDraft;
    if (!m) return;

    const name = ($('#mc-name')?.value || m.name).trim();
    if (!name) return toast('Give it a name first', 'warn');
    const pattern = $('#mc-pattern')?.value || m.pattern;
    const primary = [...document.querySelectorAll('[data-mc-muscle][aria-pressed="true"]')]
      .map((b) => b.dataset.mcMuscle);
    if (!primary.length) return toast('Pick at least one muscle', 'warn');

    const custom = {
      id: EX.customId(name),
      name,
      pattern,
      type: primary.length > 1 ? 'compound' : 'isolation',
      primary,
      secondary: m.secondary.filter((x) => !primary.includes(x)),
      equipment: m.equipmentIds,
    };

    const existing = S.profile?.customExercises || [];
    if (existing.some((e) => e.id === custom.id)) return toast('That one is already in your list', 'warn');

    const customExercises = [...existing, custom];
    /* Equipment ids the machine implies are ticked off too, so the built-in
       exercises that need them stop being filtered out. */
    const equipment = [...new Set([...activeEquipment(), ...m.equipmentIds])];
    const gymProfiles = [{ id: 'main', name: 'My gym', equipment }];

    await W.saveProfile({ customExercises, gymProfiles, activeGym: 'main' });
    Object.assign(S.profile, { customExercises, gymProfiles, activeGym: 'main' });
    EX.registerCustom([custom]);

    machineDraft = null;
    closeSheet();
    toast(`${name} added`, 'ok');
  }, 'Could not save that machine'),

  'del-custom': (el) => guard(async () => {
    const id = el.dataset.id;
    const customExercises = (S.profile?.customExercises || []).filter((e) => e.id !== id);
    await W.saveProfile({ customExercises });
    S.profile.customExercises = customExercises;
    /* The in-memory library keeps it until reload on purpose: removing it now
       would break any logged session that still references it. */
    toast('Removed. It will disappear from the picker next time the app opens.', 'ok');
    render();
  }),

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
    loggerEdit = false;
    await publishScore();

    /* What you actually did becomes the plan. Changing exercises mid-session is
       not a deviation to be corrected next week, it is the new intent. */
    if (s.plannedDay != null) {
      try { await syncDayFromSession(saved, s.plannedDay); }
      catch (err) { console.warn('could not update the day template', err); }
    }

    render();
    reviewSheet(saved.id, { prs, autoGrade: true });
  }, 'Could not save the session'),
};

/* Where the next exercise choice should land. */
let pickFor = { kind: 'session' };

/**
 * The shared exercise picker.
 *
 * The search box filters in place rather than re-rendering, because a render
 * would rebuild the input and drop focus after the first keystroke.
 */
/**
 * Put a chosen exercise wherever the picker was opened from.
 *
 * All four cases live together because they used to live in two actions that
 * each knew about half of `pickFor`, and adding a fifth entry point (an
 * exercise typed in by hand) would have meant teaching a third caller the same
 * four rules.
 */
function placeExercise(id) {
  const where = pickFor?.kind;

  if (where === 'plan') {
    planEdit[pickFor.day].blocks.push({ exerciseId: id, sets: 3, repMin: 8, repMax: 12 });
    planEditSheet();
    return;
  }

  if (where === 'plan-swap') {
    planEdit[pickFor.day].blocks[pickFor.index].exerciseId = id;
    planEditSheet();
    return;
  }

  if (where === 'session-swap' && S.session?.entries[pickFor.index]) {
    S.session.entries[pickFor.index].exerciseId = id;
    closeSheet();
    return;
  }

  if (!S.session) S.session = { name: 'Workout', startedAt: Date.now(), entries: [] };
  const last = lastPerformance(id);
  S.session.entries.push({
    exerciseId: id,
    target: PROG.nextTarget({ exerciseId: id, sets: 3, repMin: 8, repMax: 12 }, last),
    sets: Array.from({ length: 3 }, () => ({ weight: last?.weight ?? '', reps: '', done: false })),
  });
  closeSheet();
}

/** Name it, say what it hits, and it joins the library for good. */
function customExerciseSheet() {
  const typed = ($('#ex-q')?.value || '').trim();

  openSheet('Add your own exercise', `
    <p class="tiny muted" style="margin-top:0">For anything the list does not have.
    It gets saved for next time and counts towards your volume and body map like
    any other exercise.</p>

    <div class="field">
      <label for="cx-name">Call it</label>
      <input id="cx-name" value="${esc(typed)}" autocomplete="off" placeholder="Reformer Footwork">
    </div>

    <div class="field">
      <label for="cx-pattern">Movement</label>
      <select id="cx-pattern">
        ${EX.PATTERNS.map((p) => `<option value="${p}" ${p === 'isolation' ? 'selected' : ''}>${esc(EX.PATTERN_LABELS[p] || p)}</option>`).join('')}
      </select>
    </div>

    <div class="field">
      <label>Muscles it hits <span class="faint">(pick at least one)</span></label>
      <div class="chips">
        ${EX.MUSCLES.map((mu) => `<button type="button" class="chip sm" data-mc-muscle="${mu}"
          aria-pressed="false">${esc(EX.MUSCLE_LABELS[mu])}</button>`).join('')}
      </div>
    </div>`,
  `<button class="btn primary wide" data-act="save-custom-ex">Add it</button>`);
}

function openPicker(title, list) {
  openSheet(title, `
    <div class="field"><input id="ex-q" placeholder="Search exercises" autocomplete="off"
      oninput="window.__filterEx(this.value)"></div>
    <button class="btn wide sm" data-act="new-exercise" style="margin-bottom:12px">
      + Add one that is not here</button>
    <div id="ex-list">${exerciseRows(list.slice(0, 60))}</div>`);

  window.__filterEx = (q) => {
    const t = q.trim().toLowerCase();
    const hits = t ? list.filter((e) => e.name.toLowerCase().includes(t)) : list;
    const target = $('#ex-list');
    if (target) {
      target.innerHTML = hits.length
        ? exerciseRows(hits.slice(0, 60))
        : `<div class="empty tiny">Nothing called "${esc(q.trim())}".
           <br><button class="btn sm" data-act="new-exercise" style="margin-top:10px">Add it yourself</button></div>`;
    }
  };
}

/*
 * One action, one source of truth for where the choice lands.
 *
 * These rows used to take a `swapIndex` argument that decided both the label
 * and the action, which meant every caller had to remember to pass it.
 * `ped-swap` did not, so the plan's swap sheet rendered "Add" buttons wired to
 * the add path. `pickFor` already knows; the rows read it directly.
 */
const exerciseRows = (list) => {
  const swapping = String(pickFor?.kind || '').endsWith('-swap');
  return list.map((e) => `
  <div class="list-row">
    <div class="grow"><b class="ellip">${esc(e.name)}</b>
      <span class="tiny muted">${esc(e.primary.map((m) => EX.MUSCLE_LABELS[m]).join(', '))}</span></div>
    <button class="btn sm" data-act="choose-ex" data-id="${e.id}">${swapping ? 'Use' : 'Add'}</button>
  </div>`).join('') || '<div class="empty tiny">Nothing matches.</div>';
};

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

/* Chip rows where more than one answer is legitimate. Anything not listed here
   behaves as a radio group and writes to a hidden input. */
const MULTI_CHIP_GROUPS = new Set(['sore', 'classgroups']);

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
      if (MULTI_CHIP_GROUPS.has(group)) {
        groupChip.setAttribute('aria-pressed', groupChip.getAttribute('aria-pressed') !== 'true');
      } else {
        [...groupChip.parentElement.children].forEach((c) => c.setAttribute('aria-pressed', 'false'));
        groupChip.setAttribute('aria-pressed', 'true');
        const hidden = groupChip.closest('.field')?.querySelector('input[type=hidden]');
        if (hidden) hidden.value = groupChip.dataset.val;
      }
      return;
    }

    /* Never swallow a click on a native control. preventDefault() below stops
       a <select> from opening its picker at all, which is exactly how the lift
       chooser came to do nothing: it carried a data-act, so the delegation
       claimed the click and the change event never happened. Anything that
       needs native behaviour is left alone; its own change/input listener
       handles it. */
    if (ev.target.closest('select, input, textarea, option')) return;

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
    const toggle = ev.target.closest('[data-toggle]');
    if (toggle && ACTIONS[toggle.dataset.toggle]) ACTIONS[toggle.dataset.toggle](toggle);
  });

  root.addEventListener('click', (ev) => {
    const muscle = ev.target.closest('[data-mc-muscle]');
    if (muscle) muscle.setAttribute('aria-pressed', muscle.getAttribute('aria-pressed') !== 'true');
  });

  root.addEventListener('input', (ev) => {
    /* The plan editor writes straight into the working copy. No re-render, for
       the same reason the set fields do not: it would blur the field. */
    const ped = ev.target.closest('[data-ped]');
    if (ped && planEdit) {
      const day = planEdit[+ped.dataset.d];
      if (day) {
        if (ped.dataset.ped === 'name') day.name = ped.value;
        else if (day.blocks[+ped.dataset.i]) day.blocks[+ped.dataset.i][ped.dataset.ped] = num(ped.value, 1);
      }
      return;
    }

    const f = ev.target.closest('[data-set]');
    if (f && S.session) {
      const set = S.session.entries[+f.dataset.i].sets[+f.dataset.j];
      set[f.dataset.set] = f.value;
      /* Deliberately no re-render: it would blur the field mid-typing. Which
         means this is the one mutation render() cannot persist for us. */
      stash(draftKey(), S.session);
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
      restDaysPerWeek: Math.min(4, Math.max(0, num(draft.restDaysPerWeek, 2))),
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

  'cardio-timer-form': async (d) => {
    const c = {
      date: todayKey(), exerciseId: d.exerciseId,
      minutes: num(d.minutes), distance: num(d.distance) || null,
    };
    const id = await W.addEntry('cardio', c);
    S.cardio = [{ id, ...c }, ...S.cardio];
    await W.saveProfile({ lastCardioMode: d.exerciseId });
    S.profile.lastCardioMode = d.exerciseId;
    await publishScore();
    closeSheet();
    toast('Cardio logged', 'ok');
  },

  'class-form': async (d, form) => {
    const groups = [...form.querySelectorAll('[data-group="classgroups"] [aria-pressed="true"]')]
      .map((b) => b.dataset.val);

    const c = {
      date: todayKey(), kind: 'class', classId: d.classId,
      name: EX.CLASS_BY_ID[d.classId]?.label || 'Class',
      minutes: num(d.minutes),
      groups,
      effort: STATS.CLASS_EFFORT[d.effort] ? d.effort : STATS.DEFAULT_EFFORT,
      studio: (d.studio || '').trim() || null,
      note: (d.note || '').trim() || null,
    };
    const id = await W.addEntry('cardio', c);
    S.cardio = [{ id, ...c }, ...S.cardio];
    await publishScore();
    closeSheet();

    /* Say what it was worth, so the estimate is never invisible. */
    const sets = STATS.classSets(c);
    toast(sets ? `${c.name} logged. About ${sets} sets per muscle.` : `${c.name} logged`, 'ok');
  },

  'machine-form': async (d, form) => {
    const file = form.querySelector('input[type=file]').files[0];
    if (!file) return;
    form.insertAdjacentHTML('afterend',
      '<div class="center" id="mf-wait" style="padding:14px"><span class="spinner"></span></div>');

    /* Compressed before it leaves the phone: the Worker caps the upload and a
       modern camera photo is several times that cap on its own. */
    const { dataUrl } = await DB.compressImage(file, { maxSize: 900, maxBytes: 140_000 });
    machineDraft = await AI.identifyMachine(dataUrl, {
      equipment: EX.ALL_EQUIPMENT.map((id) => ({ id, label: EX.EQUIPMENT_LABELS[id] })),
      muscles: EX.MUSCLES.map((id) => ({ id, label: EX.MUSCLE_LABELS[id] })),
    });
    document.getElementById('mf-wait')?.remove();
    machineConfirmSheet();
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
    const files = [...form.querySelector('input[type=file]').files];
    if (!files.length) return;

    const photos = files.filter((f) => f.type.startsWith('image/'));
    toast(photos.length ? 'Reading the photo…' : 'Reading the document…');

    const parts = [];
    for (const file of files) parts.push(await extractText(file));
    const text = parts.join('\n\n').trim();
    if (!text) throw new Error('Could not read any text from that file.');

    healthDraft = { text, shared: !!d.shared, filename: files.map((f) => f.name).join(', ') };

    /* A PDF's text layer is exact, so there is nothing for a human to check.
       A photo went through a small vision model, so there is. */
    if (photos.length) return healthReviewSheet();

    const parsed = await AI.parseHealthDocument(text);
    await W.addHealthDoc({ parsed, rawText: text, filename: healthDraft.filename, shared: healthDraft.shared });
    S.health = await DB.listEntries('health', { max: 40 });
    healthDraft = null;
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
  if (file.type.startsWith('image/')) {
    /* Compressed harder on size than a meal photo and not at all on quality:
       small print is the entire payload here, and a soft JPEG of a lab table
       is a page of guesses. */
    const { dataUrl } = await DB.compressImage(file, { maxSize: 1600, maxBytes: 900_000 });
    const seen = await AI.describePhoto(dataUrl, 'document');
    return seen.description || '';
  }

  throw new Error('That file type cannot be read. Use a PDF, a photo, or paste the numbers by hand.');
}

/* Survives the trip from the upload form to the review sheet. */
let healthDraft = null;

/**
 * Show a photographed document back before a word of it is structured.
 *
 * This step is deliberately not skippable. The vision model is a small free one
 * and this is the one screen in the app where a misread digit matters: a
 * ferritin of 13 and a ferritin of 130 are different conversations. A PDF skips
 * this, because a text layer is exact.
 */
function healthReviewSheet() {
  openSheet('Check what it read', `
    <div class="banner warn">Check the numbers against the paper before saving.
    This was read by a camera, and a misread digit here is worse than no reading at all.</div>
    <div class="field">
      <label for="hd-text">What it found <span class="faint">(edit anything wrong)</span></label>
      <!-- font-family, NOT the font shorthand: the shorthand would reset the
           16px the stylesheet sets, and anything under 16px makes iOS Safari
           zoom the page in the moment the field is tapped. Monospace because
           lab results are columns and they only line up in a fixed pitch. -->
      <textarea id="hd-text" style="min-height:220px;line-height:1.5;
        font-family:ui-monospace,SFMono-Regular,Menlo,monospace">${esc(healthDraft?.text || '')}</textarea>
    </div>
    <div id="hd-actions">
      <button class="btn primary wide" data-act="health-structure">This is right, save it</button>
    </div>
    <p class="tiny faint">Anything marked [unclear] could not be read. Type it in yourself
    or delete the line.</p>`);
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
    cardio: [
      { id: 'c1', date: day(1), exerciseId: 'incline_walk', minutes: 32 },
      /* Classes are in the demo on purpose: they are the only path that turns
         cardio into muscle volume, and without one it cannot be eyeballed. */
      { id: 'c2', date: day(2), kind: 'class', classId: 'solidcore', minutes: 50,
        effort: 'brutal', groups: ['core', 'legs'], studio: 'Solidcore Fort Worth' },
      { id: 'c3', date: day(5), kind: 'class', classId: 'reformer_pilates', minutes: 55,
        effort: 'solid', groups: ['core', 'glutes'] },
    ],
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
  const params = new URLSearchParams(location.search);
  const wanted = params.get('tab');
  if (wanted) S.tab = wanted;

  S.partnerUid = 'demo-ashtin';
  S.partnerProfile = { name: 'Ashtin', sex: 'female' };
  S.couple = { scores: { [thisWeek()]: { 'demo-ashtin': { total: 78, max: 100, name: 'Ashtin' } } } };

  const template = buildTemplate(S.profile);
  S.program = { ...PROG.expandProgram(template, { weeks: 5 }), id: 'current', startDate: SCORE.dayKey(new Date(Date.now() - 9 * 86400000)) };

  EX.registerCustom(S.profile.customExercises || []);
  S.session = unstash(draftKey());
  S.timer = unstash(timerKey());

  /* Every write becomes a no-op so the demo cannot reach the network. */
  for (const k of Object.keys(W)) W[k] = async () => 'demo';

  /* Demo only: exposes state so a browser session can inspect it. */
  window.__S = S;
  render();

  /* ?demo&logger opens straight into a live session, and &logger=edit into its
     edit mode. Headless Chrome gets a clean profile every run and cannot click,
     so without this the logger is the one screen that can never be looked at. */
  const logger = params.get('logger');
  if (logger !== null) {
    ACTIONS['start-session']();
    if (S.session && logger === 'edit') ACTIONS['logger-edit']();
  }

  /* ?demo&week=last opens the most recent past week, for the same reason: a
     sheet cannot be opened by a headless screenshot that cannot click. */
  const wk = params.get('week');
  if (wk) weekSheet(wk === 'last' ? pastWeeks()[0] : wk);
}


/* ============================== unfinished session ============================== */

function pausedCard() {
  const s = S.session;
  const done = s.entries.reduce((n, e) => n + e.sets.filter((x) => num(x.reps) > 0).length, 0);
  return `<div class="card">
    <div class="card-title row">
      <span>${esc(s.name || 'Workout')} in progress</span>
      <span class="faint tiny">${elapsed(s.startedAt)}</span>
    </div>
    <p class="muted tiny" style="margin-top:0">${plural(done, 'set', 'sets')} logged so far.
    Nothing reaches your history until you finish.</p>
    <button class="btn primary wide" data-act="resume-session">Pick up where I left off</button>
    <button class="btn ghost wide sm" data-act="cancel-session" style="margin-top:8px;color:var(--bad)">Discard it</button>
  </div>`;
}

/* ============================== overload notes ============================== */

/*
 * Only shown when there is something to say. A card that reads "nothing to
 * report" every day is a card people stop reading, and then they miss the day
 * it does say something.
 */
function overloadCard() {
  const notes = PROG.overloadSuggestions(S.workouts);
  if (!notes.length) return '';

  return `<div class="card">
    <div class="card-title">Time to add weight</div>
    ${notes.slice(0, 4).map((n) => {
      const ex = EX.BY_ID[n.exerciseId];
      if (!ex) return '';
      return `<div class="list-row">
        <div class="grow">
          <b class="ellip">${esc(ex.name)}</b>
          <span class="tiny muted">${round(n.weight, 1)} lb for ${plural(n.sessions, 'session', 'sessions')}
            over ${plural(n.days, 'day', 'days')}</span>
        </div>
        <span class="pill" style="background:var(--surface-2);color:${n.ready ? 'var(--ok)' : 'var(--dim)'}">
          ${n.ready ? `&rarr; ${round(n.suggested, 1)} lb` : `${n.bestReps} of ${n.repTarget} reps`}
        </span>
      </div>`;
    }).join('')}
    <p class="tiny faint" style="margin-bottom:0">A weight means you have earned the jump.
    A rep count means finish the range you are on first.</p>
  </div>`;
}

/* ============================== session review ============================== */

/* Bands, not a gradient: a 78 and an 81 are the same session, and colouring
   them differently would invent a distinction the score does not carry. */
const gradeColor = (n) => (n >= 85 ? 'var(--ok)' : n >= 70 ? 'var(--accent)' : n >= 50 ? 'var(--warn)' : 'var(--bad)');

const gradeWord = (n) => (n >= 85 ? 'Excellent' : n >= 70 ? 'Solid' : n >= 50 ? 'Fair' : 'Weak');

/** The session as prose, because exercise ids mean nothing to a language model. */
function workoutText(w) {
  const mins = w.endedAt && w.startedAt ? Math.round((w.endedAt - w.startedAt) / 60000) : null;
  const lines = (w.entries || []).map((e) => {
    const ex = EX.BY_ID[e.exerciseId];
    const sets = e.sets.map((x) => `${num(x.weight) ? `${round(num(x.weight), 1)}lb` : 'bodyweight'} x ${num(x.reps)}`).join(', ');
    const muscles = (ex?.primary || []).map((m) => EX.MUSCLE_LABELS[m]).join('/');
    return `- ${ex?.name || e.exerciseId}${muscles ? ` (${muscles})` : ''}: ${sets}`;
  });
  return [
    `${w.name || 'Workout'} on ${w.date}${mins ? `, ${mins} minutes` : ''}`,
    ...lines,
    `Total volume ${Math.round(STATS.tonnage(w)).toLocaleString()} lb across ${STATS.setCount(w)} sets.`,
  ].join('\n');
}

/** The last few sessions, one line each, so the grade can see a trend. */
function recentHistoryText(excludeId) {
  return S.workouts.filter((w) => w.id !== excludeId).slice(0, 6)
    .map((w) => `${w.date}: ${w.name || 'Workout'}, ${STATS.setCount(w)} sets, ${Math.round(STATS.tonnage(w)).toLocaleString()} lb`)
    .join('\n');
}

function reviewBody(w, prs = []) {
  const mins = w.endedAt && w.startedAt ? Math.round((w.endedAt - w.startedAt) / 60000) : null;

  return `
    ${prs.length ? `<div class="card tight center" style="margin-bottom:12px">
      <div style="font-size:34px">&#127942;</div>
      ${prs.map((p) => `<div style="margin-bottom:8px">
        <div class="card-title" style="margin-bottom:2px">${esc(p.name)}</div>
        <div class="stat">${round(p.value, 1)} <small>${p.kind === 'weight' ? 'lb' : 'lb est. max'}</small></div>
        ${p.previous ? `<div class="tiny faint">previous best ${round(p.previous, 1)}</div>`
          : '<div class="tiny faint">first time logged</div>'}
      </div>`).join('')}
    </div>` : ''}

    <div class="row" style="gap:18px;margin-bottom:14px">
      <div><div class="stat">${STATS.setCount(w)}</div><div class="tiny faint">sets</div></div>
      <div><div class="stat">${Math.round(STATS.tonnage(w)).toLocaleString()}</div><div class="tiny faint">lb moved</div></div>
      ${mins ? `<div><div class="stat">${mins}</div><div class="tiny faint">minutes</div></div>` : ''}
    </div>

    <div id="grade-slot">${gradeBlock(w)}</div>

    ${(w.entries || []).map((e) => {
      const ex = EX.BY_ID[e.exerciseId];
      return `<div style="margin-bottom:14px">
        <b>${esc(ex?.name || e.exerciseId)}</b>
        ${e.sets.map((x, i) => `<div class="list-row" style="padding:4px 0;border:0">
          <span class="faint tiny" style="width:16px">${i + 1}</span>
          <span class="grow tiny">${num(x.weight) ? `${round(num(x.weight), 1)} lb` : 'bodyweight'} &times; ${num(x.reps)}</span>
          <span class="tiny faint">${num(x.weight) ? `${round(PROG.epley(num(x.weight), num(x.reps)), 0)} e1RM` : ''}</span>
        </div>`).join('')}
      </div>`;
    }).join('')}

    <hr class="sep">
    <button class="btn ghost wide sm" data-act="del-workout" data-id="${esc(w.id)}" style="color:var(--bad)">Delete this session</button>`;
}

function gradeBlock(w) {
  const g = w.grade;
  if (!g) {
    return `<div class="card tight" style="margin-bottom:12px">
      <div class="card-title" style="margin-bottom:4px">Coach's grade</div>
      <p class="tiny muted" style="margin-top:0">Scored out of 100 against your goal, with what to change next time.</p>
      <button class="btn wide sm" data-act="grade-session" data-id="${esc(w.id)}"
        ${AI.isConfigured() ? '' : 'disabled'}>Grade this session</button>
      ${AI.isConfigured() ? '' : '<p class="tiny faint" style="margin-bottom:0">The coach is not connected yet.</p>'}
    </div>`;
  }

  const alignLabel = { yes: 'On plan for your goal', partly: 'Partly on plan', no: 'Off plan for your goal' }[g.aligned] || '';
  return `<div class="card tight" style="margin-bottom:12px">
    <div class="row" style="align-items:center;gap:14px">
      <div style="font:800 40px/1 system-ui;letter-spacing:-.04em;color:${gradeColor(g.score)}">${g.score}</div>
      <div class="grow">
        <b>${gradeWord(g.score)}</b>
        <div class="tiny muted">${esc(alignLabel)}</div>
      </div>
    </div>
    <p class="tiny" style="margin:10px 0 0">${esc(g.headline || '')}</p>
    ${(g.strengths || []).length ? `<div style="margin-top:10px">
      <div class="tiny faint">What worked</div>
      ${g.strengths.map((t) => `<div class="tiny">&bull; ${esc(t)}</div>`).join('')}
    </div>` : ''}
    ${(g.fixes || []).length ? `<div style="margin-top:10px">
      <div class="tiny faint">Next time</div>
      ${g.fixes.map((t) => `<div class="tiny">&bull; ${esc(t)}</div>`).join('')}
    </div>` : ''}
    ${g.longTerm ? `<p class="tiny faint" style="margin:10px 0 0">${esc(g.longTerm)}</p>` : ''}
    <button class="btn ghost wide sm" data-act="grade-session" data-id="${esc(w.id)}" style="margin-top:10px">Grade it again</button>
  </div>`;
}

function reviewSheet(id, { prs = [], autoGrade = false } = {}) {
  const w = S.workouts.find((x) => x.id === id);
  if (!w) return;
  openSheet(`${w.name || 'Workout'} · ${w.date}`, reviewBody(w, prs));
  if (autoGrade && AI.isConfigured() && !w.grade) ACTIONS['grade-session']({ dataset: { id } });
}

/* ============================== plan editing ============================== */

/** The program's day TEMPLATES, detached so edits cannot mutate live state. */
const programDays = () => JSON.parse(JSON.stringify(
  S.program?.days || S.program?.weeks?.[0]?.days || [],
));

/** Re-expand a set of edited day templates and store the result. */
async function saveDays(days, message) {
  const template = {
    id: 'current',
    name: S.program?.name || 'Custom plan',
    goal: S.profile?.goal,
    days,
    startDate: S.program?.startDate || todayKey(),
  };
  const program = { ...PROG.expandProgram(template, { weeks: 5 }), id: 'current', startDate: template.startDate };
  await W.saveProgram(program);
  S.program = program;
  if (message) toast(message, 'ok');
}

const blockKey = (b) => `${b.exerciseId}:${b.sets}:${b.repMin}-${b.repMax}`;
const sameBlocks = (a, b) => a.length === b.length && a.every((x, i) => blockKey(x) === blockKey(b[i]));

/**
 * Rewrite a day template to match what was actually done.
 *
 * Swapping an exercise mid-session is a decision, not a slip, so the plan
 * follows the person rather than the other way round. The rep range is left
 * alone when the reps landed inside it: hitting 9 in an 8-12 range should not
 * quietly narrow that range to 9-9 and freeze progression.
 */
async function syncDayFromSession(workout, dayIndex) {
  const days = programDays();
  const day = days[dayIndex];
  if (!day) return;

  const blocks = workout.entries.map((e) => {
    const reps = e.sets.map((x) => num(x.reps)).filter((r) => r > 0);
    const prior = day.blocks.find((b) => b.exerciseId === e.exerciseId);
    const lo = Math.min(...reps);
    const hi = Math.max(...reps);
    const insidePrior = prior && lo >= prior.repMin && hi <= prior.repMax;
    return {
      exerciseId: e.exerciseId,
      sets: e.sets.length,
      repMin: insidePrior ? prior.repMin : lo,
      repMax: insidePrior ? prior.repMax : Math.max(hi, lo + 2),
    };
  });

  if (!blocks.length || sameBlocks(day.blocks, blocks)) return;
  days[dayIndex] = { ...day, blocks };
  await saveDays(days, `"${day.name || 'That day'}" now matches what you did`);
}

/* The working copy for the editor, at module scope so the sheet can be
   repainted in place. Same reason planChat lives out here. */
let planEdit = null;

const repInput = (value, field, d, i, label) => `<input type="number" inputmode="numeric" min="1" max="50"
  value="${value}" data-ped="${field}" data-d="${d}" data-i="${i}" aria-label="${label}"
  style="width:54px;background:var(--surface-2);border:1px solid var(--line);border-radius:8px;padding:6px;min-height:38px">`;

function planEditBody() {
  if (!planEdit?.length) return '<div class="empty tiny">This program has no days in it.</div>';

  return planEdit.map((day, d) => `
    <div class="card tight" style="margin-bottom:12px">
      <div class="field" style="margin-bottom:10px">
        <input value="${esc(day.name || `Day ${d + 1}`)}" data-ped="name" data-d="${d}"
          aria-label="Day name" style="font-weight:700">
      </div>
      ${day.blocks.length ? day.blocks.map((b, i) => {
        const ex = EX.BY_ID[b.exerciseId];
        return `<div class="list-row" style="gap:6px;align-items:flex-start">
          <div class="grow" style="min-width:0">
            <b class="ellip">${esc(ex?.name || b.exerciseId)}</b>
            <div class="row" style="gap:6px;margin-top:6px;align-items:center">
              ${repInput(b.sets, 'sets', d, i, 'Sets')}
              <span class="tiny faint">sets of</span>
              ${repInput(b.repMin, 'repMin', d, i, 'Minimum reps')}
              <span class="tiny faint">to</span>
              ${repInput(b.repMax, 'repMax', d, i, 'Maximum reps')}
            </div>
          </div>
          <button class="btn sm ghost" data-act="ped-swap" data-d="${d}" data-i="${i}">Swap</button>
          <button class="btn sm ghost" data-act="ped-del" data-d="${d}" data-i="${i}" style="color:var(--bad)">Remove</button>
        </div>`;
      }).join('') : '<div class="empty tiny">No exercises on this day.</div>'}
      <button class="btn sm ghost wide" data-act="ped-add" data-d="${d}" style="margin-top:10px">+ add exercise</button>
    </div>`).join('');
}

function planEditSheet() {
  openSheet('Edit your plan', `<div id="ped-body">${planEditBody()}</div>
    <p class="tiny faint">Changes apply from today onwards. Weeks are rebuilt around them,
    so progression and the deload still line up.</p>`,
  `<button class="btn primary wide" data-act="save-plan-edit">Save changes</button>`);
}

/* ============================== cardio ============================== */

/*
 * The timer is a stored object, not a running interval.
 *
 * It keeps when the current run began and how much time was banked before the
 * last pause, so elapsed time is DERIVED from the clock rather than counted up.
 * That is what lets it survive a locked phone, a backgrounded tab and a full
 * reload, none of which let a setInterval keep counting.
 */
let tickHandle = null;

const timerMs = () => (S.timer
  ? num(S.timer.accum) + (S.timer.running ? Date.now() - num(S.timer.since) : 0)
  : 0);

const clockText = (ms) => {
  const total = Math.max(0, Math.floor(ms / 1000));
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const sec = total % 60;
  const mm = h ? String(m).padStart(2, '0') : String(m);
  return `${h ? `${h}:` : ''}${mm}:${String(sec).padStart(2, '0')}`;
};

/** Repaint just the clock. A full render every second would blur any focused
    field and rebuild the whole screen sixty times a minute for one number. */
function startTicking() {
  if (tickHandle) return;
  tickHandle = setInterval(() => {
    if (!S.timer?.running) { clearInterval(tickHandle); tickHandle = null; return; }
    const el = document.getElementById('cd-clock');
    if (el) el.textContent = clockText(timerMs());
  }, 1000);
}

const cardioLabel = (c) => (c.kind === 'class'
  ? (EX.CLASS_BY_ID[c.classId]?.label || c.name || 'Class')
  : (EX.BY_ID[c.exerciseId]?.name || c.name || 'Cardio'));

function cardioView() {
  const t = S.timer;
  const mode = t?.mode || S.profile?.lastCardioMode || 'treadmill_run';
  const week = S.cardio.filter((c) => c.date >= SCORE.dayKey(SCORE.weekRange(thisWeek()).start));
  const weekMin = week.reduce((n, c) => n + num(c.minutes), 0);

  return `<div class="screen">
    <div class="top">
      <div><h1>Cardio</h1>
        <div class="sub">${weekMin ? `${plural(weekMin, 'minute', 'minutes')} this week` : 'Nothing logged this week yet'}</div>
      </div>
    </div>

    <div class="card">
      <div class="card-title">${t ? esc(EX.BY_ID[mode]?.name || 'Session') : 'Start a session'}</div>

      ${t ? `
        <div class="center" style="padding:12px 0 4px">
          <div id="cd-clock" style="font:700 54px/1 system-ui;letter-spacing:-.04em;font-variant-numeric:tabular-nums">${clockText(timerMs())}</div>
          <div class="tiny faint" style="margin-top:6px">${t.running ? 'running' : 'paused'}</div>
        </div>
        <div class="btn-row" style="margin-top:14px">
          <button class="btn" data-act="${t.running ? 'timer-pause' : 'timer-resume'}">${t.running ? 'Pause' : 'Resume'}</button>
          <button class="btn primary" data-act="timer-stop">Finish</button>
        </div>
        <button class="btn ghost wide sm" data-act="timer-discard" style="margin-top:8px;color:var(--bad)">Throw it away</button>
      ` : `
        <div class="chips" style="margin-bottom:14px">
          ${EX.CARDIO_MODES().map((m) => `<button type="button" class="chip sm" data-act="timer-mode" data-val="${m.id}"
            aria-pressed="${m.id === mode}">${esc(m.name)}</button>`).join('')}
        </div>
        <button class="btn primary wide" data-act="timer-start" data-val="${esc(mode)}">Start the clock</button>
        <button class="btn ghost wide sm" data-act="quick-cardio" style="margin-top:8px">Log one I already did</button>
      `}
    </div>

    <div class="card">
      <div class="card-title">Classes</div>
      <p class="muted tiny" style="margin-top:0">Pilates, reformer, Solidcore, barre, spin. Logged by time,
      because the instructor picks the work and there is no load to progress.</p>
      <div class="chips">
        ${EX.CLASS_TYPES.map((c) => `<button type="button" class="chip sm" data-act="log-class" data-val="${c.id}">${esc(c.label)}</button>`).join('')}
      </div>
    </div>

    <div class="card">
      <div class="card-title">Abs and core</div>
      <p class="muted tiny" style="margin-top:0">Logged as real sets and reps rather than minutes, so it
      counts towards your volume and shows up on the body map. Abs are training, not cardio.</p>
      <button class="btn wide" data-act="quick-core">Log a core session</button>
    </div>

    ${S.cardio.length ? `<div class="card">
      <div class="card-title">Recent</div>
      ${S.cardio.slice(0, 12).map((c) => `<div class="list-row">
        <div class="grow">
          <b class="ellip">${esc(cardioLabel(c))}</b>
          <span class="tiny muted">${esc(c.date)} &middot; ${num(c.minutes)} min${
            c.distance ? ` &middot; ${round(num(c.distance), 2)} mi` : ''}${
            c.studio ? ` &middot; ${esc(c.studio)}` : ''}</span>
        </div>
        <button class="btn sm ghost" data-act="del-cardio" data-id="${esc(c.id)}" style="color:var(--bad)">Remove</button>
      </div>`).join('')}
    </div>` : ''}
  </div>`;
}

function cardioFinishSheet(minutes, exerciseId) {
  const ex = EX.BY_ID[exerciseId];
  openSheet('Finish cardio', `
    <div class="card tight"><b>${esc(ex?.name || 'Cardio')}</b>
      <div class="tiny muted">${plural(minutes, 'minute', 'minutes')} on the clock</div></div>
    <form id="cardio-timer-form">
      <input type="hidden" name="exerciseId" value="${esc(exerciseId)}">
      <div class="field-row">
        <div class="field"><label for="ct-min">Minutes</label>
          <input id="ct-min" name="minutes" type="number" inputmode="numeric" value="${minutes}" required></div>
        ${EX.tracksDistance(exerciseId) ? `<div class="field"><label for="ct-dist">Distance (mi)</label>
          <input id="ct-dist" name="distance" type="number" inputmode="decimal" step="0.01"></div>` : ''}
      </div>
      <button class="btn primary wide" type="submit">Save it</button>
    </form>`);
}

/*
 * Logging a class asks two extra questions, and they are the whole reason a
 * class counts for anything: which muscles it worked, and how hard it was.
 *
 * Both are pre-answered from the class type so the common case is still one
 * tap on Log it. The effort call is hers rather than the app's, which is what
 * makes the set estimate defensible at all.
 */
function classSheet(classId) {
  const cls = EX.CLASS_BY_ID[classId];
  if (!cls) return;
  const preset = new Set(cls.groups || []);

  openSheet(cls.label, `
    <form id="class-form">
      <input type="hidden" name="classId" value="${esc(classId)}">
      <div class="field-row">
        <div class="field"><label for="cl-min">Minutes</label>
          <input id="cl-min" name="minutes" type="number" inputmode="numeric" value="50" required></div>
        <div class="field"><label for="cl-studio">Studio <span class="faint">(optional)</span></label>
          <input id="cl-studio" name="studio" autocomplete="off" placeholder="Solidcore Fort Worth"></div>
      </div>

      <div class="field">
        <label>What did it work? <span class="faint">(this is what makes it count)</span></label>
        <div class="chips" data-group="classgroups">
          ${Object.entries(EX.GROUP_LABELS).map(([k, l]) =>
            `<button type="button" class="chip sm" data-val="${k}" aria-pressed="${preset.has(k)}">${esc(l)}</button>`).join('')}
        </div>
      </div>

      <div class="field">
        <label>How hard?</label>
        <div class="chips" data-group="effort">
          ${Object.keys(STATS.CLASS_EFFORT).map((k) =>
            `<button type="button" class="chip sm" data-val="${k}" aria-pressed="${k === STATS.DEFAULT_EFFORT}">${k[0].toUpperCase() + k.slice(1)}</button>`).join('')}
        </div>
        <input type="hidden" name="effort" value="${esc(STATS.DEFAULT_EFFORT)}">
      </div>

      <div class="field"><label for="cl-note">Anything to remember? <span class="faint">(optional)</span></label>
        <input id="cl-note" name="note" autocomplete="off" placeholder="New instructor, hardest one yet"></div>
      <button class="btn primary wide" type="submit">Log it</button>
    </form>`);
}

/* ============================== machine scan ============================== */

/* Held at module scope because a sheet body is a snapshot: the parsed result
   has to outlive the render that drew it. */
let machineDraft = null;

function machineConfirmSheet() {
  const m = machineDraft;
  if (!m) return;
  const known = m.equipmentIds.map((id) => EX.EQUIPMENT_LABELS[id]).filter(Boolean);

  openSheet('Is this right?', `
    <div class="field">
      <label for="mc-name">Call it</label>
      <input id="mc-name" value="${esc(m.name)}" data-mc="name" autocomplete="off">
    </div>
    ${m.plateText ? `<p class="tiny faint" style="margin-top:-8px">Read off the machine: &ldquo;${esc(m.plateText)}&rdquo;</p>` : ''}

    <div class="field">
      <label for="mc-pattern">Movement</label>
      <select id="mc-pattern" data-mc="pattern">
        ${EX.PATTERNS.map((p) => `<option value="${p}" ${p === m.pattern ? 'selected' : ''}>${esc(EX.PATTERN_LABELS[p] || p)}</option>`).join('')}
      </select>
    </div>

    <div class="field">
      <label>Muscles it trains</label>
      <div class="chips">
        ${EX.MUSCLES.map((mu) => `<button type="button" class="chip sm" data-mc-muscle="${mu}"
          aria-pressed="${m.primary.includes(mu)}">${esc(EX.MUSCLE_LABELS[mu])}</button>`).join('')}
      </div>
    </div>

    ${known.length
      ? `<p class="tiny muted">This also ticks <b>${esc(known.join(', '))}</b> off in your equipment,
         which unlocks the built-in exercises that use it.</p>`
      : `<p class="tiny muted">Nothing in the standard equipment list matched, so this is saved as its
         own exercise. That is fine, it still logs and still counts towards your volume.</p>`}
    ${m.note ? `<p class="tiny faint">${esc(m.note)}</p>` : ''}
    ${m.confidence === 'low' ? '<div class="banner warn">The photo was hard to read. Check the name and the muscles before you save.</div>' : ''}

    <button class="btn primary wide" data-act="save-machine" style="margin-top:6px">Add it to my gym</button>
    <details style="margin-top:14px"><summary class="tiny faint">What the camera made of it</summary>
      <p class="tiny faint">${esc(m.description)}</p></details>`);
}


/* ============================== looking back at a week ============================== */

/* Coach reviews are kept for the session only. Persisting them would need a new
   Firestore collection, and firestore.rules denies anything it does not name
   explicitly, so it would fail silently until the rules were republished by
   hand. Caching here means browsing back and forth spends nothing; a reload
   costs one call if you ask again. */
const weekReviews = new Map();

const weekLabel = (key) => {
  const { start, end } = SCORE.weekRange(key);
  const fmt = (d) => d.toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
  return `${fmt(start)} to ${fmt(end)}`;
};

/** Every ISO week with something logged in it, newest first, current week aside. */
function pastWeeks(limit = 12) {
  const keys = new Set();
  const add = (date) => {
    if (!date) return;
    const d = new Date(`${date}T12:00:00`);
    if (!Number.isNaN(d.getTime())) keys.add(SCORE.isoWeekKey(d));
  };
  S.workouts.forEach((w) => add(w.date));
  S.cardio.forEach((c) => add(c.date));

  const now = thisWeek();
  /* Week keys are zero padded, so a string sort is a date sort. */
  return [...keys].filter((k) => k !== now).sort().reverse().slice(0, limit);
}

/** Everything that happened in one week, gathered once for the sheet and the coach. */
function weekDetail(weekKey) {
  const { start, end } = SCORE.weekRange(weekKey);
  const from = SCORE.dayKey(start);
  const to = SCORE.dayKey(end);
  const inWeek = (d) => d >= from && d <= to;

  const workouts = S.workouts.filter((w) => inWeek(w.date)).sort((a, b) => a.date.localeCompare(b.date));
  const cardio = S.cardio.filter((c) => inWeek(c.date)).sort((a, b) => a.date.localeCompare(b.date));

  const active = STATS.activeDates(S.workouts, S.cardio)
    .filter((d) => inWeek(d));

  return {
    weekKey,
    score: weekScore(weekKey),
    workouts,
    cardio,
    volume: STATS.volumeByGroup(workouts),
    activeDays: active.length,
    restUsed: SCORE.restDaysUsed(STATS.activeDates(S.workouts, S.cardio), weekKey),
    restAllowed: restAllowance(),
    partner: S.couple?.scores?.[weekKey]?.[S.partnerUid] || null,
  };
}

function weekSheetBody(weekKey) {
  const d = weekDetail(weekKey);
  const g = d.score.total;
  const overRest = d.restUsed > d.restAllowed;
  const groups = Object.entries(d.volume).filter(([, sets]) => sets > 0)
    .sort((a, b) => b[1] - a[1]);
  const topSets = groups.length ? groups[0][1] : 0;

  return `
    <div class="row" style="gap:14px;margin-bottom:14px">
      <div style="font:800 44px/1 system-ui;letter-spacing:-.04em;color:${gradeColor(g)}">${g}</div>
      <div class="grow">
        <b>${gradeWord(g)}</b>
        <div class="tiny muted">${esc(weekLabel(weekKey))} &middot; ${plural(d.activeDays, 'active day', 'active days')}</div>
      </div>
      ${d.partner ? `<div style="text-align:right">
        <div class="tiny faint">${esc(partnerName() || 'Partner')}</div>
        <b style="color:${gradeColor(d.partner.total)}">${d.partner.total}</b>
      </div>` : ''}
    </div>

    <div class="banner ${overRest ? 'warn' : 'info'}" style="margin-bottom:14px">
      ${d.restUsed} of ${d.restAllowed} rest ${d.restAllowed === 1 ? 'day' : 'days'} used${
        overRest ? '. Over your allowance, which is already reflected in the adherence score below.' : '.'}
    </div>

    <div class="card-title">Breakdown</div>
    ${d.score.components.map((c) => `<div class="list-row">
      <div class="grow">
        <div style="display:flex;justify-content:space-between">
          <b>${esc(c.label)}</b><span class="tiny muted">${c.points}/${c.max}</span>
        </div>
        <div class="bar" style="margin:6px 0 4px"><i style="width:${(c.points / c.max) * 100}%;background:var(--accent-dim)"></i></div>
        <div class="tiny faint">${esc(c.detail)}</div>
      </div>
    </div>`).join('')}

    <hr class="sep">
    <div class="card-title">Sessions</div>
    ${d.workouts.length ? d.workouts.map((w) => `<div class="list-row" data-act="view-workout" data-id="${esc(w.id)}" role="button" tabindex="0">
      <div class="grow">
        <b class="ellip">${esc(w.name || 'Workout')}</b>
        <span class="tiny muted">${esc(w.date)} &middot; ${STATS.setCount(w)} sets &middot; ${Math.round(STATS.tonnage(w)).toLocaleString()} lb</span>
      </div>
      ${w.grade ? `<span class="pill" style="background:var(--surface-2);color:${gradeColor(w.grade.score)}">${w.grade.score}</span>` : ''}
      <span class="faint" aria-hidden="true">&rsaquo;</span>
    </div>`).join('') : '<div class="empty tiny">No sessions logged that week.</div>'}

    ${d.cardio.length ? `<hr class="sep">
    <div class="card-title">Cardio and classes</div>
    ${d.cardio.map((c) => `<div class="list-row">
      <div class="grow"><b class="ellip">${esc(cardioLabel(c))}</b>
        <span class="tiny muted">${esc(c.date)} &middot; ${num(c.minutes)} min${
          c.distance ? ` &middot; ${round(num(c.distance), 2)} mi` : ''}</span></div>
    </div>`).join('')}` : ''}

    ${groups.length ? `<hr class="sep">
    <div class="card-title">Sets per muscle group</div>
    ${groups.map(([group, sets]) => `<div class="list-row" style="border:0;padding:4px 0">
      <span class="tiny" style="width:74px">${esc(EX.GROUP_LABELS[group] || group)}</span>
      <div class="bar grow"><i style="width:${(sets / topSets) * 100}%;background:${GROUP_COLOR[group] || 'var(--accent-dim)'}"></i></div>
      <span class="tiny faint" style="width:22px;text-align:right">${sets}</span>
    </div>`).join('')}` : ''}

    <hr class="sep">
    <div id="wk-review">${weekReviewBlock(weekKey)}</div>`;
}

function weekReviewBlock(weekKey) {
  const r = weekReviews.get(weekKey);
  if (!r) {
    return `<div class="card-title">What the coach thinks</div>
      <p class="tiny muted" style="margin-top:0">Everything above is worked out on your phone.
      This part asks the coach.</p>
      <button class="btn wide sm" data-act="week-review" data-week="${esc(weekKey)}"
        ${AI.isConfigured() ? '' : 'disabled'}>Ask the coach about this week</button>`;
  }

  const list = (title, items) => (items || []).length
    ? `<div style="margin-top:10px"><div class="tiny faint">${title}</div>
       ${items.map((t) => `<div class="tiny">&bull; ${esc(t)}</div>`).join('')}</div>`
    : '';

  return `<div class="card-title">What the coach thinks</div>
    <p class="tiny" style="margin-top:0"><b>${esc(r.headline || '')}</b></p>
    ${list('Went well', r.wins)}
    ${list('Watch out', r.watchOuts)}
    ${list('Next week', r.nextWeek)}`;
}

const weekSheet = (weekKey) => openSheet(`Week of ${weekLabel(weekKey)}`, weekSheetBody(weekKey));


/* ============================== volume against targets ============================== */

/*
 * The one question a hypertrophy programme actually turns on: are you doing
 * enough for each muscle?
 *
 * PROG.VOLUME_LANDMARKS has held MEV / MAV / MRV since the first build and was
 * only ever used to check a GENERATED plan. It was never shown against what was
 * really trained, which is the comparison that matters.
 *
 * Four weeks, not one. A single light week is noise, and reading it as failure
 * would make the card cry wolf. It also keeps this distinct from the Body tab,
 * which maps the current week anatomically.
 */
const VOLUME_WINDOW_WEEKS = 4;

function volumeTargetCard() {
  const cutoff = SCORE.dayKey(new Date(Date.now() - VOLUME_WINDOW_WEEKS * 7 * 86400000));
  const workouts = S.workouts.filter((w) => w.date >= cutoff);
  const cardio = S.cardio.filter((c) => c.date >= cutoff);
  const vol = STATS.combinedVolumeByGroup(workouts, cardio);

  if (!workouts.length && !cardio.some((c) => c.kind === 'class')) return '';

  const rows = Object.keys(PROG.VOLUME_LANDMARKS).map((group) => {
    const mark = PROG.VOLUME_LANDMARKS[group];
    const v = vol[group] || { sets: 0, classSets: 0, classes: 0, total: 0 };
    const perWeek = round(v.total / VOLUME_WINDOW_WEEKS, 1);
    const liftedPerWeek = round(v.sets / VOLUME_WINDOW_WEEKS, 1);
    const classPerWeek = round(v.classSets / VOLUME_WINDOW_WEEKS, 1);

    const verdict = perWeek === 0 ? 'nothing logged'
      : perWeek < mark.mev ? `under the ${mark.mev} set minimum`
        : perWeek < mark.mav ? 'enough to grow'
          : perWeek <= mark.mrv ? 'growing well'
            : 'more than you can recover from';

    const colour = perWeek === 0 || perWeek < mark.mev ? 'var(--warn)'
      : perWeek > mark.mrv ? 'var(--bad)' : 'var(--good)';

    /* Scaled against MRV so every group shares one axis and the bars are
       comparable to each other, not just to their own target. */
    const pct = (n) => Math.min(100, (n / mark.mrv) * 100);

    return `<div class="list-row">
      <div class="grow">
        <div style="display:flex;justify-content:space-between">
          <b>${esc(EX.GROUP_LABELS[group] || group)}</b>
          <span class="tiny muted">${perWeek} ${perWeek === 1 ? 'set' : 'sets'} a week</span>
        </div>
        <div class="bar split" style="margin:6px 0 4px">
          <i style="width:${pct(liftedPerWeek)}%;background:${colour}"></i>
          ${classPerWeek > 0 ? `<i style="width:${pct(classPerWeek)}%;background:${colour};opacity:.45"></i>` : ''}
        </div>
        <div class="tiny faint">${esc(verdict)}${
          classPerWeek > 0 ? ` &middot; about ${classPerWeek} from classes` : ''}</div>
      </div>
    </div>`;
  }).join('');

  return `<div class="card">
    <div class="card-title">Are you training enough? <span class="faint">· 4 week average</span></div>
    ${rows}
    <p class="tiny faint" style="margin-bottom:0">Targets are the usual weekly set ranges per muscle.
    The faded part of a bar is an estimate from classes, not counted sets.</p>
  </div>`;
}

/* ============================== personal records ============================== */

/*
 * STATS.personalRecords has been written and tested since the first build and
 * had never been called. A PR fired a celebration sheet and then vanished;
 * there was nowhere to see what your bests actually are.
 */
function prBoardCard(limit = 10) {
  const lifts = [...new Set(S.workouts.flatMap((w) => (w.entries || []).map((e) => e.exerciseId)))]
    .filter((id) => EX.BY_ID[id]);

  const rows = lifts
    .map((id) => ({ id, name: EX.BY_ID[id].name, bw: EX.BY_ID[id].bw, ...STATS.personalRecords(S.workouts, id) }))
    .filter((r) => r.heaviest)
    .sort((a, b) => String(b.bestE1rm?.date || '').localeCompare(String(a.bestE1rm?.date || '')))
    .slice(0, limit);

  if (!rows.length) return '';

  return `<div class="card">
    <div class="card-title">Personal records</div>
    ${rows.map((r) => {
      /* A bodyweight lift logs 0 lb, so its "heaviest" is meaningless and the
         real record is the rep count. */
      const loaded = num(r.heaviest.weight) > 0;
      const headline = loaded
        ? `${round(r.heaviest.weight, 1)} lb × ${r.heaviest.reps}`
        : `${r.mostReps.reps} reps`;
      const sub = loaded
        ? `${round(r.bestE1rm.e1rm, 1)} lb estimated max · ${esc(r.bestE1rm.date)}`
        : `bodyweight · ${esc(r.mostReps.date)}`;

      return `<div class="list-row">
        <div class="grow">
          <b class="ellip">${esc(r.name)}</b>
          <span class="tiny muted">${esc(sub)}</span>
        </div>
        <b class="tiny">${esc(headline)}</b>
      </div>`;
    }).join('')}
  </div>`;
}

/* ============================== classes ============================== */

const CLASS_WINDOW_WEEKS = 8;

function classSummaryCard() {
  const cutoff = SCORE.dayKey(new Date(Date.now() - CLASS_WINDOW_WEEKS * 7 * 86400000));
  const classes = S.cardio.filter((c) => c.kind === 'class' && c.date >= cutoff);
  if (!classes.length) return '';

  const sum = STATS.classSummary(classes);
  const vol = STATS.classVolumeByGroup(classes);
  const hit = Object.entries(vol).filter(([, v]) => v.classes > 0)
    .sort((a, b) => b[1].sets - a[1].sets);
  const most = sum.types[0]?.count || 1;

  return `<div class="card">
    <div class="card-title">Classes <span class="faint">· last ${CLASS_WINDOW_WEEKS} weeks</span></div>
    <div class="row" style="gap:18px;margin-bottom:14px">
      <div><div class="stat">${sum.total}</div><div class="tiny faint">classes</div></div>
      <div><div class="stat">${Math.round(sum.minutes / 60)}</div><div class="tiny faint">hours</div></div>
    </div>
    ${sum.types.map((t) => `<div class="list-row" style="border:0;padding:4px 0">
      <span class="tiny" style="width:104px">${esc(EX.CLASS_BY_ID[t.classId]?.label || t.classId)}</span>
      <div class="bar grow"><i style="width:${(t.count / most) * 100}%;background:var(--accent-dim)"></i></div>
      <span class="tiny faint" style="width:22px;text-align:right">${t.count}</span>
    </div>`).join('')}
    ${hit.length ? `<p class="tiny faint" style="margin-bottom:0">Mostly working
      ${esc(hit.slice(0, 3).map(([g]) => (EX.GROUP_LABELS[g] || g).toLowerCase()).join(', '))}.</p>` : ''}
  </div>`;
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

      /* Machines added by photo have to be in the library BEFORE anything
         renders. Every screen resolves exercises through EX.BY_ID, so a logged
         set referencing a custom id would otherwise draw as a raw slug. */
      EX.registerCustom(S.profile?.customExercises || []);

      if (S.profile?.complete) {
        await loadAll();

        /* A workout and a cardio timer both survive the app being closed. They
           are restored here rather than at module load because the key is
           per-account and there is no account until now. */
        S.session = unstash(draftKey());
        S.timer = unstash(timerKey());
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
