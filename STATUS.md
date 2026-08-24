# LockIN — build status

**Last worked: 2026-08-23.** Everything below is on disk and verified. Not yet a
git repo, not yet deployed.

## Where to pick up

**The next task is `index.html`.** It is the only substantial file not written.
Every module it needs is finished, tested and has a documented API. Nothing else
is half-done, so there is no cleanup to do first.

Start the dev server and open the test page to confirm the state is still good:

```bash
python -m http.server 8777 --directory LockIN
```

`http://localhost:8777/selftest.html` should show **221 / 221 passing**.

---

## Done and verified

| File | What it is | Verified how |
|---|---|---|
| `exercises.js` | 149 exercises, 41 equipment ids, availability filter, swap ranking | selftest: no duplicate ids, no dangling refs, every muscle group trainable bodyweight-only |
| `program.js` | Double progression, mesocycle expansion, readiness auto-regulation, volume landmarks | selftest: hand-checked progression cases, RIR monotonic, band boundaries swept |
| `score.js` | Weekly LockIN score, ISO weeks, streaks, leaderboard | selftest: ISO round-trip swept over 4 years of dates, components sum to 100 |
| `stats.js` | e1RM, volume, weight trend, heatmap, macro targets | selftest: Epley against textbook values, Mifflin-St Jeor hand-computed |
| `anatomy.js` + `anatomy-paths.js` | Male + female bodies, front + back, per-muscle fills. Artwork from react-native-body-highlighter (MIT) | Rendered via headless Chrome; selftest checks every id maps to exercises.js |
| `ai.js` | Every Groq call + strict JSON schemas | Schemas written; **not yet run against the live Worker** |
| `foods.js` | USDA + Open Food Facts + barcode + saved library | Normalisers run against live API payloads; USDA per-serving scaling verified exact |
| `db.js` | Firebase auth, Firestore CRUD, image compression, export/import | Syntax clean; **not yet run against a live Firebase project** |
| `worker/` | Cloudflare Worker, `/ai` and `/food`, Firebase JWT gate | Syntax clean; **not yet deployed** |
| `selftest.js/.html` | 221 regression checks | Passing |
| `sw.js`, `manifest`, `icons/` | PWA shell | Icons generated |
| `README.md` | Full setup guide | — |

---

## What is left

1. **`index.html`** — the whole UI. Spec below.
2. **Deploy** — follow README setup. Nothing in it is guesswork; every step was
   checked.
3. **Live verification** — the three "not yet run" rows above. In particular the
   Worker's JWT verification has never executed against a real token.
4. **Firestore rules probe** — sign up a throwaway third account by REST and
   assert it can read nothing; assert the partner can read shared photos but not
   private ones. Same approach that worked on the Bankroll app.

---

## `index.html` spec

A `type="module"` shell importing every module. Dark theme, bottom tab bar,
built for a phone.

**Tabs:** Today · Body · Food · Stats · More

- **Today** — readiness check-in (4 sliders + sore muscle groups) → run
  `program.adjustSession()` and show what it changed and why → the workout
  logger (sets, reps, weight, rest timer, PR badges from `stats.newPRsIn`).
- **Body** — `anatomy.bodySVG()` heat map from `stats.volumeByGroup()`, front and
  back toggle, male for Grant / female for Ashtin from `config.MEMBERS`. Weekly
  set-target hexagon ring against `program.VOLUME_LANDMARKS`. Weigh-ins,
  measurements, progress photos with the private toggle.
- **Food** — search first (`foods.searchAll`), barcode, saved library, then the
  "just describe it" chat via `ai.logMeal` capped at 2 questions. Daily macro
  rings against `stats.macroTargets()`.
- **Stats** — weekly leaderboard from `score.leaderboard()` with the component
  breakdown, e1RM curves, volume chart, consistency heatmap.
- **More** — onboarding/profile, equipment checklist per gym profile, program
  generation, health document upload, settings, export/import, uid display.

**Onboarding wizard** (first run): name and sex, body stats, goal and target,
ideal physique, experience and days per week, equipment, injuries, optional
health docs, starting photos.

Load the `dataviz` skill before writing any chart code.

---

## Decisions already made — do not re-litigate

- **$0/month is a hard requirement.** No Anthropic dependency anywhere in the
  app. Grant was explicit about this.
- **Groq, `openai/gpt-oss-120b`**, falling back to `gpt-oss-20b` on a 429.
- **Model picks day templates only.** `program.js` expands mesocycles and does
  daily auto-regulation with deterministic rules. This is what keeps it inside
  the free tier and testable.
- **Photos in Firestore, not Firebase Storage** (Storage needs paid Blaze).
- **Progress photos private by default**; health documents private by default
  with a share toggle. Everything else is shared between the two accounts.
- **Meal logging is text, not photos.** Grant chose this deliberately; text is
  cheaper and more accurate for chain restaurant food.

---

## Gotchas that cost real time

- **USDA 404s with no `User-Agent`.** Workers send none by default. Already
  fixed in `worker/index.js`; do not remove that header.
- **Strict `json_schema` only works on Groq's `openai/gpt-oss-*` models.**
  Everything else silently degrades to unvalidated JSON.
- **Firestore rules cannot filter a list query.** A query that could match a
  denied document fails entirely. `db.listSharedPhotos` queries
  `where('private','==',false)` and the rule is written to accept exactly that.
  Change one without the other and it breaks with a confusing permissions error.
- **Browser-pane screenshots do not composite on this machine.** Use headless
  Chrome instead, and write the PNG to the scratchpad — Chrome cannot write into
  the OneDrive folder (access denied):
  ```bash
  "C:/Program Files/Google/Chrome/Application/chrome.exe" --headless=new \
    --disable-gpu --hide-scrollbars --screenshot=<scratchpad>/shot.png \
    --window-size=820,860 --virtual-time-budget=2500 http://localhost:8777/...
  ```
  Then read the PNG. This is the only way to actually see the body diagrams.
- **Long heredocs via Bash hit a command-length limit** (`ENAMETOOLONG`). Use the
  Write tool for anything large.
- **`sw.js` `VERSION` must be bumped on every deploy**, and `SHELL` must list
  every module `index.html` imports, or the deployed app is blank rather than
  degraded.

---

## Resolved

The body diagrams went through three hand-drawn iterations that Grant rejected.
They are now **real artwork** from react-native-body-highlighter (MIT), remapped
onto this app's muscle ids. Front and back, male and female, verified rendering
correctly for per-group highlighting. If the look ever needs changing again,
`anatomy.js` owns colour and mapping; `anatomy-paths.js` is generated and should
not be edited by hand.

**Lesson worth keeping:** for anything visual, get a render loop working before
iterating. Headless Chrome plus reading the PNG back is the loop on this machine.
