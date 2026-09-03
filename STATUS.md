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

- `http://localhost:8777/selftest.html` — **369 / 369 passing**
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
| `selftest.js/.html` | 369 regression checks | Passing |
| `sw.js`, `manifest`, `icons/` | PWA shell | Icons generated |
| `index.html` + `ui.js` | The whole UI: auth, onboarding, logger, body map, food, leaderboard, settings | Driven in a real browser: onboarding walked end to end, a session logged and finished, PR sheet fired, equipment presets, all five tabs |
| `README.md` | Full setup guide | — |

---

## Round two — the gym notes (2026-08-24)

Ten changes Grant wrote down during a session, all built and all driven in a
real browser against `?demo`:

| Asked for | Where it lives | Proven by |
|---|---|---|
| Leave a workout and come back to it | `stash`/`unstash` in `ui.js`, `pausedCard`, the floating resume bar | Typed 185x8, left the tab, reloaded the page: session and typed values both came back |
| Edit the plan after finalising it | `planEditSheet`, `saveDays` | Renamed a day, changed sets 3 to 5, removed one exercise, added another, saved: all five weeks rebuilt around the edit |
| A logged workout becomes that day's new standard | `syncDayFromSession` | Dropped three exercises and swapped a deadlift for a cable fly mid-session; the day template afterwards read exactly what was done |
| Coach grades the session 1-100 against the goal | `AI.gradeWorkout`, `gradeBlock` | Stubbed Worker: correct schema, exercise NAMES not ids in the prompt, and a model returning 118 was clamped to 100 |
| Photograph a machine to add it | `/vision` `subject`, `AI.identifyMachine`, `EX.registerCustom` | Stubbed the whole two-stage call with the real Hoist plate text: name suggested, edited, saved, and the machine then appeared in the picker, the equipment list and the volume charts |
| Notes suggesting weight increases | `PROG.overloadSuggestions`, `overloadCard` | 16 selftest cases, including the three ways a naive version gets it wrong |
| Cardio tab with a live timer | `cardioView`, the `S.timer` object | Started, faked 90 seconds, paused: clock read 1:30; the stair climber offered no distance field, the treadmill did |
| Ashtin's pilates and Solidcore classes | `EX.CLASS_TYPES`, `classSheet` | Logged a 50-minute Solidcore with a studio name |
| Look back at a logged session | `reviewSheet`, `reviewBody` | Opened from the recent list with sets, tonnage, e1RM per set and the grade |
| Log abs | `quick-core`, filtered picker | Opens the ordinary logger filtered to core movements |

**Abs are logged as a workout, not as cardio minutes.** Logged as cardio they
would earn cardio points and contribute nothing to the body map, which is
exactly backwards. The button lives in the Cardio tab because that is where
Grant asked for it.

### Add an exercise by hand (v0.3.1)

Ashtin hit a movement the 149-exercise library does not have. The picker now
carries **+ Add one that is not here** at the top, and a search that finds
nothing offers the same thing. Name it, pick the movement and the muscles, and
it joins the library permanently and lands wherever the picker was opened from.

Hand-added exercises carry **no equipment requirement**, deliberately: the
reason one is being typed in is that the library does not cover it, so gating it
behind an equipment tick would hide it again the moment it was created.

They are stored per account on `profile.customExercises`, the same field the
machine-photo flow writes, so they do not cross between the two accounts.

**A real bug came out of this.** `ped-swap` never passed the `swapIndex` that
`exerciseRows` used to decide its label and action, so the plan editor's Swap
sheet rendered "Add" buttons wired to the add path. The rows now read `pickFor`
directly and there is one placement function, `placeExercise`, instead of two
actions that each knew half the rules. Both swap sheets were verified to
replace rather than append, including when the replacement is an exercise
created on the spot.

### Photographed lab documents (v0.3.2)

Ashtin photographed a lab report and hit "Photos of documents are not supported
yet". They are now, through the same `/vision` route, with a third prompt
subject `document`, which transcribes rather than describes.

**The transcription is shown back for correction before a word of it is
structured, and that step cannot be skipped.** This is the one screen in the app
where a misread digit changes the meaning: a ferritin of 13 and a ferritin of
130 are different conversations. The prompt is told to write `[unclear]` rather
than guess at anything it cannot read. A PDF skips the review entirely, because
a text layer is exact and there is nothing for a human to check.

Multiple files can be picked at once for a multi-page report, and photos go up
at 1600px rather than the 640px a meal photo gets, because small print is the
entire payload here.

Three bugs fixed alongside it:

- **A failed save left a spinner that never stopped**, with the button gone and
  the hand-corrected transcription trapped behind it. It now restores a "Try
  saving again" button and keeps the text.
- **`addHealthDoc` was the only write not going through the `W` facade**, so
  demo mode could not stub it and it hung against an uninitialised Firebase.
- **Toasts were see-through.** The `.banner` tints are 10% alpha, which is right
  inside a card and unreadable floating on top of another control. That is what
  made the message overlap the Share switch in Ashtin's screenshot.
  `.banner.float` carries those same tints composited over the sheet background.

The review textarea sets `font-family` rather than the `font` shorthand. The
shorthand reset the 16px the stylesheet sets, and anything under 16px makes iOS
Safari zoom the page in the moment the field is tapped.

### Removing a set or an exercise mid-workout (v0.3.3)

Grant fat-fingered "add set" during a session and had no way back. Editing is
now a MODE rather than a control on every row: a small **Edit** in the logger
header, and while it is on, each exercise's **Swap** becomes **Remove** and each
set's tick becomes a red minus. Nothing new appears in the normal state, and
because the controls take the place of ones already there, the rows do not
reflow when the mode flips.

Both removals show an **Undo** for seven seconds. A set with numbers in it is
real work, and this is a one-handed tap by someone who has just been under a
bar. Removing the last set of an exercise removes the exercise too, since an
exercise with no sets reads as broken.

The Edit control is 24px of glyph inside a 44px hit box, via negative margins,
so the header stays 20px tall.

**A layout bug came out of this that had been shipping for three versions.**
`.row` was never defined as a flex utility — only `.card-title.row` was — so
every bare `class="row"` was stacking its children into a column. That meant the
review sheet's three stats, the grade block's score, and the plan editor's
"3 sets of 8 to 12" inputs were all stacked vertically on both phones. I had
verified those screens by querying values and never by looking at them. `.row`
is now a real utility and all four sites were checked visually.

`?demo&logger` opens straight into a live session and `?demo&logger=edit` into
its edit mode. Headless Chrome gets a clean profile every run and cannot click,
so without it the logger is the one screen that can never be seen.

### Rest days, and looking back at a week (v0.3.4)

**Streaks now survive rest days.** `currentStreak()` counted consecutive ACTIVE
days, so Grant's Monday-to-Friday split reported a one-day streak every Monday.
`restStreak()` sits beside it — the old function is untouched and its tests are
unchanged — and lets a run survive up to `allowance` rest days **back to back**.

Two decisions Grant made, both worth not re-litigating:

- **Going over the weekly rest budget does not break the streak.** Only too many
  in a row does. Resting more already means training less, which the adherence
  component docks on its own; penalising it twice would be double-counting one
  behaviour. The overage is stated plainly on Today and in the week review.
- **The streak counts calendar days, not training days.** Mon-Fri plus a rested
  weekend reads **8** on Monday, not 6. A number that climbs on a rest day is
  the whole point of allowing rest days.

`restDaysPerWeek` is set in onboarding beside "days per week", 0 to 4, default
2. Profiles that predate it fall through to `DEFAULT_REST_ALLOWANCE`, so neither
account has to do anything.

**Any past week can now be opened** from a Past weeks card on the Stats tab,
directly under This Week rather than below the charts. The sheet carries the
grade out of 100, the six-component breakdown, rest days used against the
allowance, every session (each tappable through to its own review), cardio and
classes, and sets per muscle group. The partner's score for that week comes free
because published scores were already stored per week.

`AI.weeklyReview()` and `REVIEW_SCHEMA` had been sitting in `ai.js` **written and
never called** since the first build. They are now wired to a button. The result
is cached in memory per week rather than persisted: `firestore.rules` denies any
collection it does not name, so a `reviews` collection would fail silently until
the rules were republished by hand, and this way browsing weeks costs nothing.

**The bug that mattered here:** `myScore()` filtered `date >= weekStart` with no
upper bound. Correct for the current week, where nothing is logged in the
future, and silently wrong for every past week. `weekScore(weekKey)` bounds both
ends; `myScore()` is now a one-line wrapper. Verified by asserting no session in
a week sheet falls outside that week's dates.

26 new selftest cases, including both of Grant's worked examples and a proof
that `allowance: 0` reduces exactly to `currentStreak()`.

`?demo&week=last` opens a past week for screenshotting, for the same reason
`?demo&logger` exists.

### Classes count, and the 1RM card is gone (v0.3.5)

**The lift picker never worked, and the cause is worth remembering.** `pick-lift`
was registered twice: once in the `ACTIONS` map and once as a `change` listener.
The click delegation matches any `[data-act]` present in `ACTIONS` and calls
`ev.preventDefault()`, which on a `<select>` stops the native picker opening at
all, so the change event could never fire. Tapping it silently re-rendered.

The durable fix is the delegation guard, not the deletion:

```js
if (ev.target.closest('select, input, textarea, option')) return;
```

Never swallow a click on a native control. Any future `<select data-act=…>`
would have hit exactly this.

**Estimated 1RM is replaced by two cards**, both of which reuse code that was
written, tested, and never called:

- **Are you training enough?** — `PROG.VOLUME_LANDMARKS` has held MEV/MAV/MRV
  since the first build and only ever checked a *generated* plan. It now runs
  against what was actually trained, averaged over 4 weeks so one light week is
  not read as failure, and it says the useful thing: `Chest · 4.5 sets a week ·
  under the 8 set minimum`.
- **Personal records** — `STATS.personalRecords()` had never been called. PRs
  fired a celebration and then vanished with nowhere to see them.

e1RM is not lost: it is in every session review and inside `personalRecords`.

### Ashtin's classes are training now

Solidcore and reformer work logged as cardio minutes and nothing else. It lit up
no muscle, counted for no volume, and read as a **missed session** against her
plan. She trains four times a week and the app graded her as if she had not.

- Logging a class asks **which muscle groups it hit** (pre-ticked from the class
  type, so the common case is still one tap) and **how hard it was**.
- `STATS.classSets()` converts duration and effort into approximate sets, capped
  at 8 per group. **This is a rule of thumb, not a research claim.** It is
  deliberately conservative, the effort call is hers rather than the app's, and
  the number is shown openly, in the toast when she logs and as "about 2.3 from
  classes" on the bar. Do not let it quietly become a measurement.
- The volume bar shows lifted sets solid and class sets faded, so the estimate
  is always visually distinct from counted work.
- Classes credit the body map and **count toward plan adherence**. In the demo
  this moved the week from 3-of-4 planned to 4-of-4, and the score from 49 to 64.
- Classes logged before the questionnaire existed have no `groups` or `effort`
  and fall back to the class type's own groups and `solid`, so the update does
  not silently erase her history. That fallback is a selftest case.

27 new selftest checks. The one that matters most asserts
`combinedVolumeByGroup` equals `volumeByGroup` exactly when no classes exist,
which is what proves none of this changed anything for Grant.

The demo data now contains two classes, because that path cannot be eyeballed
without one.

### Nutrition is optional in the weekly grade (v0.3.6)

Grant does not track food and does not want to. Ashtin does. The weekly score
docked him 20 points every week for a thing he was never going to do, and that
is most of why Ashtin kept winning.

**More -> Scoring -> Count nutrition** switches it off per account.

**The points are redistributed, not deleted.** The two scores sit next to each
other on a leaderboard every week; grading him out of 80 and her out of 100
would make the comparison meaningless and hand her every week by default. So
`componentMaxes(skip)` shares the dropped points across whatever remains, in
proportion to the existing weights, and the table always sums to `MAX_SCORE`:

| | adherence | extra | nutrition | cardio | streak | check-ins |
|---|---|---|---|---|---|---|
| default | 40 | 15 | 20 | 10 | 10 | 5 |
| nutrition off | **50** | **19** | — | **13** | **12** | **6** |

Largest-remainder rounding, because the proportional shares land on halves and
quarters and naive rounding does not add back to 100. Ties break by component
order so the table is deterministic.

A skipped component is **absent** from the breakdown rather than shown as 0/0,
which would read as a failure rather than a setting.

In the demo this took Grant from 64 to 80 and flipped the week from Ashtin
leading 78-64 to Grant leading 80-78. The Food tab is untouched and still works;
this only changes what is graded.

`trackNutrition` defaults to on when the field is absent, so neither existing
account changes behaviour until someone flips the switch.

18 new checks. Two of them assert that passing an empty skip list, or omitting
the option entirely, produces byte-identical output to the old call — which is
what proves this is invisible to Ashtin.

**One wiring note:** the switch is a checkbox, so it is driven by a new
`change` delegation on `[data-toggle]`, not by the click handler. The click
handler now deliberately ignores native controls (see v0.3.5), so a checkbox
carrying `data-act` would never have fired.

### Her profile, and app colours (v0.3.7)

**Tap Ashtin on the Stats leaderboard** to open everything she has logged: her
week's score and streak, muscle groups trained, every session (each opening
read-only, with no delete or grade button on someone else's training), cardio
and classes, plus any photo or document she chose to share.

`DB.listEntries` already took an owner id, and `listSharedPhotos` /
`listSharedHealthDocs` had been written and **never called** since the first
build. This was mostly wiring.

**The privacy split is enforced by `firestore.rules`, not by this code.** Photos
come back only where `private == false` and documents only where
`shared == true`, and `db.js` queries exactly the shapes those rules accept.
The screen cannot show a private photo even if it asked for one. Remember the
standing gotcha: rules cannot filter a list query, so changing either the query
or the rule without the other breaks it with a confusing permissions error.

Her data loads **on demand** when the sheet opens, not at boot. Fetching a second
person's whole history on every launch would slow the start for nothing.

### Themes

**More -> Appearance**: five backgrounds and seven accents, per account.

`themes.css` is **generated** by `gen_theme.py` in the scratchpad, and generated
for two reasons that matter:

1. Each background's `--surface`, `--surface-2` and `--line` are the original
   palette's *exact* depth deltas re-applied to the new base, so cards, borders
   and layering look identical in every theme rather than being re-eyeballed.
2. `--on-accent` is measured, not chosen. White text lands at **2.15 on amber,
   2.28 on green and 2.49 on teal**, which is unreadable, so those get near-black
   ink instead. Crimson, blue, violet and pink keep white, which preserves the
   look the app already had. `.btn.primary`, pressed chips and `.pill.new` all
   read `var(--on-accent)` rather than assuming `#fff`.

The choice is saved on the profile so it follows the account, and **mirrored to
localStorage** so it applies before Firebase answers. Without the mirror every
cold start flashes the default theme, which looks like a bug.

`?demo&partner` opens her sheet and `?demo&bg=forest&accent=teal` renders a
theme, both so headless screenshots can prove the screens still use the tokens.

**Wiring note:** the theme controls are `<select>`s, so they use the `change`
delegation on `[data-change]` (renamed from `data-toggle`, which read wrong on a
select). The click delegation deliberately ignores native controls since v0.3.5,
so a select carrying `data-act` would never fire, which is the original lift
picker bug.

### The schedule knows what day it is (v0.3.8)

**The bug Grant hit.** `todaySession()` picked the day like this:

```js
const done = weekWorkouts().length;
const day = week.days[done % week.days.length];
```

`weekWorkouts()` filters to the current ISO week, so at midnight on Sunday that
counter dropped to zero and the program snapped back to day one. It was also
advanced by **any** logged workout, so an ad-hoc session or a core session
silently skipped a day of the split, and two sessions in one day skipped two.
The day shown depended on a count, never on the calendar.

**The model now.** Each program day owns a weekday. A day is due once its
weekday arrives, and days are worked through in order. `PROG.dueDay(days, {
weekday, completed })` returns what is due or `null` for a rest day, where
`completed` counts only sessions that came from the program (`plannedDay != null`).

Miss a day and it stays at the front of the queue, so everything after it slides
forward. The queue is measured against the current week only, so the whole plan
**re-anchors to real weekdays every Monday** and can never drift more than a
week. A carried-over session is labelled as such on the card.

A missed day needs no special handling: a day with nothing logged is already a
rest day to `score.js`, which is what consumes the rest allowance and keeps the
streak alive.

Weekdays are picked **per day in the plan editor**, next to the name. New plans
default to a sensible spread: five days is Mon-Fri, three is Mon/Wed/Fri, four
avoids four in a row.

Plans saved before this existed have no weekdays at all. `dueDay` falls back to
"everything is due", which reproduces the old rotation rather than declaring
every day a rest day, and `expandProgram` fills them in on the next save.

**Days are no longer named after weekdays.** `buildTemplate` used to call them
"Monday", "Tuesday" and so on, which double-encodes the schedule: move one to
Wednesday and it is still called "Thursday" on screen. They are now named for
what they train ("Chest and Back", "Legs"), and the weekday picker owns the
when. The rest-day copy also drops the name when a user-written one already IS
a weekday, so it never reads "Next up is Friday on Friday".

35 new checks including every case Grant described, plus the ad-hoc session that
used to skip a day and the two-sessions-in-a-day case.

`?demo&plan` opens the editor for screenshotting.

### Needs a Worker redeploy

`worker/index.js` gained a `subject` field on `/vision`. Until it is deployed,
a photographed machine comes back described as food:

```bash
cd worker && npx wrangler deploy
```

### Still unverified

- The machine scan and the grader have only ever run against a stubbed Worker.
  The contracts are right; the live models have not been asked.
- `safe-area-inset-top` still needs a real notched iPhone.

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
- **Long heredocs via Bash hit a command-length limit** (`ENAMETOOLONG`), and
  worse, they EAT BACKSLASHES. `.join('\n')` arrived as a real newline inside a
  string literal, which is an unterminated string. It has now happened twice.
  Use the Write tool for anything large, and for anything containing a
  backslash, always.
- **This machine's Bash tool does not honour a quoted heredoc delimiter.**
  `<<'EOF'` still performs command substitution and still collapses
  backslashes, so backticks in a commit message run as commands and a `\n`
  arrives as a real newline. It has now silently corrupted a source file and a
  markdown file. Write anything containing a backtick or a backslash to a file
  with the Write tool and run that instead.
- **`node --check` is not a syntax check here.** It parses as a script, and it
  happily passed the exact file the browser refused to load. Import it as a
  module instead; see the Tests section of the README.
- **Python patch scripts write CRLF on Windows.** That leaves the tree mixed and
  makes the next exact-match patch fail against its own output. Normalise to LF
  after any scripted edit.
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
