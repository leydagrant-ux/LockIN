# LockIN — build status

**Last worked: 2026-08-24. DEPLOYED AND LIVE.**

- App: **https://leydagrant-ux.github.io/LockIN/**  (`?demo` runs it on fake data)
- Worker: **https://lockin-api.leydagrant.workers.dev**
- Firebase: **lockin-dffd9** · Repo: **github.com/leydagrant-ux/LockIN**

Both accounts are wired through all three gates and the Firestore rules are
published. Setup is finished; from here it is ordinary feature work.

| Account | uid |
|---|---|
| leydagrant@gmail.com | `ktqSNUWrW4ZF5cH7wzOED362Saf1` |
| ashtinsmith73571@gmail.com | `v1Foijd9ZagOEhIu8TFQIHhq0513` |

Both Worker secrets (`GROQ_API_KEY`, `USDA_API_KEY`) are set as Cloudflare
secrets. They exist nowhere on disk — to rotate one, run
`npx wrangler secret put <NAME>` from `worker/`.

## Verified after deploy

- Worker fails closed: 405 on GET, 403 without an allowed Origin, 401 without a
  valid Firebase token, CORS returns `null` to a hostile origin.
- Firestore denies every unauthenticated read AND write (probed by REST against
  both users' docs, subcollections and the couple doc — all 403).
- **Still unverified:** a signed-in read by a real account, and a live Groq call.
  Both need a real session; check them the first time the app is used.

## Local development

```bash
python -m http.server 8777 --directory LockIN
```

- `http://localhost:8777/selftest.html` — **221 / 221 passing**
- `http://localhost:8777/index.html?demo` — whole app on generated data,
  `&tab=body` jumps to a screen

## Deploying a change

`git push`, and **bump `VERSION` in `sw.js` every time** or the old shell is
served from cache. Worker changes need `npx wrangler deploy` from `worker/`.

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
| `index.html` + `ui.js` | The whole UI: auth, onboarding, logger, body map, food, leaderboard, settings | Driven in a real browser: onboarding walked end to end, a session logged and finished, PR sheet fired, equipment presets, all five tabs |
| `README.md` | Full setup guide | — |

---

## What is left

1. **Deploy** — the three steps above.
2. **Live verification** — `ai.js`, `db.js` and the Worker have never run against
   live services. In particular the Worker's Firebase JWT verification has never
   seen a real token.
3. **Firestore rules probe** — sign up a throwaway third account by REST and
   assert it can read nothing; assert the partner can read shared photos but not
   private ones. Same approach that worked on the Bankroll app.
4. **Not built yet, deliberately deferred:** barcode scanning (needs a JS scanner
   library), AI program generation wired to the Build screen (templates cover it),
   couple challenges beyond the weekly score.

---

## Bugs the browser testing caught

None of these would have been found by reading the code, and all three shipped
silently in the first cut:

- **Event listeners accumulated on every render.** `render()` re-attached the
  delegated handlers, so by the third render one tap fired three handlers: a set
  toggle flipped back to where it started and one "add set" produced three.
- **A typed set that was never ticked was thrown away.** Sets saved with
  `done: false`, and `stats.js` treats that as never performed — so it vanished
  from PRs, volume and tonnage. Every stat silently undercounted.
- **`stopPropagation` on the sheet killed everything inside it.** No control in
  any sheet worked. The backdrop-target guard in `wire()` is the mechanism; the
  stopPropagation was both redundant and fatal.
- **Equipment presets appeared to do nothing.** A sheet body is a snapshot, so a
  full `render()` redrew stale markup. `setEquipment()` repaints in place.

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
