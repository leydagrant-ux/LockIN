# LockIN

A two-person fitness app for Grant and Ashtin. Training, nutrition, body
metrics, body-composition and bloodwork context, and a weekly head-to-head
score. Runs at **$0/month**.

Static files on GitHub Pages, Firebase for auth and sync, and one small
Cloudflare Worker that fronts Groq and the free food databases.

---

## Why there is a Worker

The blocker for a serverless static site is **CORS, not cost**. Verified from a
real browser rather than assumed:

| Call | From a browser |
|---|---|
| Groq chat completions | blocked |
| Open Food Facts **search** | blocked |
| USDA FoodData Central search | blocked |
| Open Food Facts **barcode** | **allowed** |

So everything except barcode lookup goes through a Cloudflare Worker (free tier:
100,000 requests/day, this app uses maybe 20). The Worker also keeps the Groq and
USDA keys server-side, where the browser can never see them.

**Groq has no vision model.** Every one was retired during 2026 (Maverick in
March, Scout in July) in favour of the text-only `gpt-oss` family. The meal photo
therefore runs on **Cloudflare Workers AI**, which is on the same account as the
Worker: no extra key, no extra CORS. Free tier is 10,000 neurons/day.

Because those open vision models name food well but judge portions badly, the
photo is a TWO-STAGE flow: the vision model describes the plate, the user
corrects the description, and only then does `gpt-oss-120b` turn that text into
macros under the strict schema. Each model does the part it is good at.

Two other things that were verified the hard way and are easy to regress:

- **USDA returns 404 to any request with no `User-Agent`.** Cloudflare Workers
  send none by default. The Worker sets one explicitly.
- **Strict JSON schema output only works on Groq's `openai/gpt-oss-*` models.**
  Every other Groq model offers `json_object`, which is valid JSON with no
  guarantee it matches the schema. This app parses every response into typed
  data, so the guarantee is a requirement, not a preference.

---

## Setup

Roughly 30 minutes, once.

### 1. Groq (free, no card)

1. Sign up at <https://console.groq.com>.
2. Create an API key. Keep the tab open.

### 2. USDA FoodData Central (free)

1. Get a key at <https://fdc.nal.usda.gov/api-key-signup.html>. It arrives by
   email in seconds.

### 3. Firebase

1. Create a new project at <https://console.firebase.google.com>. Keep it
   separate from the poker Bankroll project.
2. **Authentication → Sign-in method → Email/Password → Enable.**
3. **Firestore Database → Create database → production mode.**
4. **Project settings → General → Your apps → Web (`</>`)** and copy the config
   object into `config.js`.
5. **Authentication → Settings → Authorized domains →** add
   `leydagrant-ux.github.io`.

Do **not** enable Firebase Storage. Photos are stored in Firestore instead,
because Storage needs the paid Blaze plan and Firestore's free tier includes
1 GiB. See `db.js`.

### 4. Cloudflare Worker

```bash
cd worker
npx wrangler login
npx wrangler secret put GROQ_API_KEY
npx wrangler secret put USDA_API_KEY
npx wrangler deploy
```

Then edit `worker/wrangler.toml` and set `FIREBASE_PROJECT_ID` to your Firebase
project id. Put the deployed URL (`https://lockin-api.<you>.workers.dev`) into
`WORKER_URL` in `config.js`.

### 5. GitHub Pages

```bash
git init && git add -A && git commit -m "LockIN"
git remote add origin https://github.com/leydagrant-ux/LockIN.git
git push -u origin main
```

Then **Settings → Pages → Deploy from branch → main / root**.

### 6. Both accounts, then lock the doors

1. Open the live site, sign up as yourself, then have Ashtin sign up.
2. Settings shows each account's uid. Collect both.
3. Put them in **three** places:
   - `MEMBERS` in `config.js`
   - `members()` in `firestore.rules`
   - `ALLOWED_UIDS` in `worker/wrangler.toml`, then `npx wrangler deploy` again
4. Paste `firestore.rules` into **Firestore → Rules → Publish**.

Until step 3 is done the rules deny everyone. That is deliberate: it fails
closed, not open.

---

## Deploying a change

```bash
git add -A && git commit -m "what changed" && git push
```

**Bump `VERSION` in `sw.js` every single time.** Without it the old shell is
served from cache and nothing you changed appears on either phone.

If `index.html` gains or loses a module import, update the `SHELL` list in
`sw.js` to match. `index.html` is a `type="module"`, so a missing file is not a
degraded app, it is a blank one.

---

## Architecture

```
index.html      shell, design tokens, styles
ui.js           views, state, charts, all interaction
config.js       Firebase config, Worker URL, the two member uids
db.js           Firebase auth + Firestore + image compression
ai.js           every Groq call, with the JSON schemas
foods.js        USDA / Open Food Facts / barcode / saved library
anatomy.js      body diagram renderer, palettes, data mapping   [pure]
anatomy-paths.js  generated muscle geometry (MIT, see Credits)  [pure]
exercises.js    149 exercises + equipment taxonomy              [pure]
program.js      overload, mesocycle expansion, auto-regulation,
                stall detection for progressive overload         [pure]
score.js        weekly LockIN score, ISO weeks, streaks         [pure]
stats.js        e1RM, volume, trends, macro targets             [pure]
selftest.js     221 regression checks over the pure modules
worker/         Cloudflare Worker: /ai and /food
```

The six `[pure]` modules have no DOM, no network and no Firebase, which is what
lets `selftest.js` check them exhaustively in node.

### Sessions in progress live on the phone, not in Firestore

Half a workout is not a record of anything. Syncing it would put a half-empty
session on the partner's leaderboard, and it is the one write that has to
survive a phone locking itself in a gym with no signal, which rules out the
network. So the live session and the cardio timer are held in `localStorage`,
per device and per account, and are restored on the next load. Anything older
than 36 hours is treated as abandoned rather than paused, because restoring
yesterday's half-finished session onto today's date would log work that never
happened.

The cardio timer stores *when it started* and *how much time was banked before
the last pause* rather than counting seconds up, so it stays accurate through a
locked screen, a backgrounded tab and a full reload.

### The plan follows the person

Swapping an exercise mid-session is a decision, not a slip. When a session that
came from the program is finished, that day's template is rewritten to match
what was actually done. The rep range is left alone when the reps landed inside
it, so hitting 9 in an 8-12 range does not quietly narrow the range to 9-9 and
freeze progression.

### Machines added by photograph

Point the camera at the name plate. The Worker's `/vision` route takes a
`subject` field — `meal` or `equipment` — which only changes the prompt; a
gym machine is photographed for its label, so reading the text matters as much
as recognising the shape. The description then goes to `gpt-oss-120b` along with
the real equipment and muscle id lists, and everything that comes back is
filtered against those lists rather than trusted: a hallucinated equipment id
would silently unlock exercises the person cannot do, and a hallucinated muscle
id would land in the body heat map as a muscle that does not exist.

The suggested name is always shown in an editable field before anything is
saved, because a plate that reads `RS-2203` is a part number, not a name.

Custom machines are merged into the SAME arrays the built-in library uses. Every
consumer reads `EX.BY_ID`, so a parallel list would mean a machine you added
showed up when logging and then contributed nothing to any chart.

### The split that keeps this free

The AI does **not** generate whole programs. It picks exercises for a handful of
**day templates**, and `program.js` expands those across a mesocycle and adapts
them day to day using deterministic rules. That matters for three reasons:

- Groq's free tier allows roughly 8K tokens/minute; a whole mesocycle in one
  response would exceed it.
- Rules are testable. Generation is not.
- The daily adjustment runs instantly and offline, in a gym with no signal.

---

## Tests

```bash
node selftest.js
```

Or open `/selftest.html` in a browser for the same suite with a pass/fail
breakdown. Run it after any change to `exercises.js`, `program.js`, `score.js`
or `stats.js`.

**`node --check` is not a syntax check for these files.** It parses as a script,
not a module, and a file that passes it can still be rejected outright by the
browser. Check as a module instead:

```bash
node --input-type=module -e "import('./ai.js').catch(e => { console.log(e.message); process.exit(1) })"
```

`ui.js` and `db.js` will report an unresolved `https:` specifier under node —
that is the Firebase CDN import, and it means the file parsed.

Three real bugs it has already caught, all of which would have shipped:

- A neutral all-threes readiness check-in landed in the "reduced" band and
  quietly cut volume on every ordinary training day.
- Doing 9 sessions against a plan of 4 scored **zero** extra credit, because the
  surplus was measured against an unclamped completion count.
- A Bodyweight Squat qualified as a swap for a Push-Up, because matching
  `type` scored points on its own without any shared muscle.

---

## Local development

```bash
python -m http.server 8777 --directory LockIN
```

Then <http://localhost:8777>. That origin is already in the Worker's
`ALLOWED_ORIGINS`.

**`?demo` runs the whole app against generated data with Firebase bypassed** —
useful before setup is finished, and the fastest way to eyeball a change to a
screen. `?demo&tab=body` jumps straight to one. Every write is a no-op, so it
cannot touch the network.

---

## Credits

Body diagrams come from
[react-native-body-highlighter](https://github.com/HichamELBSI/react-native-body-highlighter)
by ELABBASSI Hicham, MIT licence, with the upstream licence kept in
`LICENSE-body-highlighter`. `anatomy-paths.js` is generated from its four asset
files and remaps their slugs onto the muscle ids used in `exercises.js`.

Hand-drawn anatomy was attempted first and abandoned. Producing a figure that
reads as a real body at thumbnail size is an illustration job, and iterating
bezier curves without a fast visual loop was converging far too slowly. Using
proper artwork under a permissive licence was both faster and much better.
