/* ai.js — every model call the app makes.
 *
 * Talks to the Cloudflare Worker, never to Groq directly: the browser cannot
 * reach api.groq.com (CORS), and the key must stay server-side.
 *
 * MODEL CHOICE IS NOT FREE-FORM. Strict `json_schema` output is only supported
 * on Groq's `openai/gpt-oss-*` models; every other model offers `json_object`,
 * which returns valid JSON with no guarantee it matches the schema. This app
 * parses every response into typed data, so the guarantee is the requirement.
 *
 * TOKEN BUDGET. The free tier allows roughly 8K tokens/minute on gpt-oss-120b.
 * A whole mesocycle emitted in one response would blow through that, so program
 * generation asks for ONE TRAINING DAY per call and program.js expands those
 * templates across the weeks deterministically. Chunking is a hard requirement
 * here, not an optimisation.
 */

export const MODEL = 'openai/gpt-oss-120b';
export const VISION_ROUTE = 'vision';
export const FALLBACK_MODEL = 'openai/gpt-oss-20b';

let config = { workerUrl: '', visionUrl: '', getToken: async () => '' };

/** Wire up the Worker endpoints and a Firebase ID-token getter. */
export function configure({ workerUrl, visionUrl, getToken }) {
  config = { workerUrl, visionUrl: visionUrl || '', getToken };
}

export const isConfigured = () => Boolean(config.workerUrl);

/** Thrown for anything the caller might want to show the user verbatim. */
export class AIError extends Error {
  constructor(message, kind) { super(message); this.kind = kind; }
}

/* ============================== core call ============================== */

/**
 * One structured call. Returns the parsed object matching `schema`.
 *
 * Retries once on a rate limit using the smaller model rather than failing —
 * on a free tier a 429 is an ordinary Tuesday, not an error worth showing.
 */
async function ask(messages, schema, opts = {}) {
  if (!config.workerUrl) {
    throw new AIError('The AI coach is not set up yet. Add your Worker URL in Settings.', 'unconfigured');
  }

  const body = {
    model: opts.model || MODEL,
    messages,
    temperature: opts.temperature ?? 0.3,
    max_tokens: opts.maxTokens ?? 1800,
    response_format: {
      type: 'json_schema',
      json_schema: { name: schema.name, strict: true, schema: schema.schema },
    },
  };

  let token;
  try {
    token = await config.getToken();
  } catch {
    throw new AIError('Could not verify your login. Sign out and back in.', 'auth');
  }

  let res;
  try {
    res = await fetch(config.workerUrl, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` },
      body: JSON.stringify(body),
    });
  } catch {
    throw new AIError('Could not reach the coach. Check your connection.', 'network');
  }

  if (res.status === 429 && !opts.isRetry) {
    return ask(messages, schema, { ...opts, model: FALLBACK_MODEL, isRetry: true });
  }
  if (res.status === 401 || res.status === 403) {
    throw new AIError('This account is not allowed to use the coach.', 'auth');
  }
  if (!res.ok) {
    const detail = await res.text().catch(() => '');
    throw new AIError(`The coach is unavailable right now (${res.status}). ${detail.slice(0, 120)}`, 'upstream');
  }

  const data = await res.json();
  const text = data?.choices?.[0]?.message?.content;
  if (!text) throw new AIError('The coach returned an empty answer.', 'empty');

  try {
    return JSON.parse(text);
  } catch {
    /* Strict mode should make this impossible; if it happens the model or the
       schema is wrong, and silently swallowing it would corrupt stored data. */
    throw new AIError('The coach returned something unreadable.', 'parse');
  }
}

/* ============================== meal logging ============================== */

const MEAL_SCHEMA = {
  name: 'meal_estimate',
  schema: {
    type: 'object',
    additionalProperties: false,
    required: ['status', 'question', 'choices', 'items', 'total', 'confidence', 'assumptions'],
    properties: {
      status: { type: 'string', enum: ['needs_clarification', 'complete'] },
      question: { type: 'string', description: 'Empty unless status is needs_clarification' },
      choices: {
        type: 'array', description: 'Tappable answers for the question. Empty when complete.',
        items: { type: 'string' },
      },
      items: {
        type: 'array',
        items: {
          type: 'object',
          additionalProperties: false,
          required: ['name', 'portion', 'calories', 'protein', 'carbs', 'fat'],
          properties: {
            name: { type: 'string' },
            portion: { type: 'string' },
            calories: { type: 'number' }, protein: { type: 'number' },
            carbs: { type: 'number' }, fat: { type: 'number' },
          },
        },
      },
      total: {
        type: 'object',
        additionalProperties: false,
        required: ['calories', 'protein', 'carbs', 'fat'],
        properties: {
          calories: { type: 'number' }, protein: { type: 'number' },
          carbs: { type: 'number' }, fat: { type: 'number' },
        },
      },
      confidence: { type: 'string', enum: ['low', 'medium', 'high'] },
      assumptions: { type: 'string' },
    },
  },
};

/* Two questions maximum. Left open-ended a model will happily interrogate
   someone about oil quantities forever; the user wanted a food logger, not a
   deposition. */
export const MAX_MEAL_QUESTIONS = 2;

const MEAL_SYSTEM = `You estimate calories and macros for meals described in plain language.

Return per-item numbers and a total, in grams for macros and kcal for calories.

Ask a clarifying question ONLY when the answer would move calories by more than
about 150 — chain restaurant orders where the protein or base is unstated, or a
portion size that could plausibly differ twofold. Offer 2-4 short tappable
choices with the question. Never ask about trivia like cooking oil or seasoning.

You may ask at most {{MAX}} questions in a conversation. Once you have asked
them, or if the description is already clear, set status to "complete" and give
your best estimate, stating what you assumed.

For well-known chains use their published nutrition. For home-cooked food assume
ordinary home portions. Prefer being slightly generous over understating.`;

/**
 * One turn of the meal conversation.
 *
 * @param {Array}  turns      [{ role: 'user'|'assistant', content }] so far
 * @param {number} asked      clarifying questions already asked
 * @returns the parsed MEAL_SCHEMA object
 */
export async function logMeal(turns, asked = 0) {
  const forceComplete = asked >= MAX_MEAL_QUESTIONS;

  const messages = [
    { role: 'system', content: MEAL_SYSTEM.replace('{{MAX}}', String(MAX_MEAL_QUESTIONS)) },
    ...turns,
  ];
  if (forceComplete) {
    messages.push({
      role: 'system',
      content: 'You have used your questions. Set status to "complete" now and state your assumptions.',
    });
  }

  const out = await ask(messages, MEAL_SCHEMA, { maxTokens: 1200 });

  /* Belt and braces: the cap is a product rule, so enforce it here rather than
     trusting the prompt to hold. */
  if (forceComplete && out.status !== 'complete') {
    out.status = 'complete';
    out.assumptions = out.assumptions || 'Best estimate from the description given.';
  }
  return out;
}

/* ============================== program generation ============================== */

const DAY_SCHEMA = {
  name: 'training_day',
  schema: {
    type: 'object',
    additionalProperties: false,
    required: ['name', 'focus', 'blocks', 'note'],
    properties: {
      name: { type: 'string', description: 'Short day name, e.g. "Push" or "Lower A"' },
      focus: { type: 'string', description: 'Muscle groups this day targets' },
      note: { type: 'string' },
      blocks: {
        type: 'array',
        items: {
          type: 'object',
          additionalProperties: false,
          required: ['exerciseId', 'sets', 'repMin', 'repMax', 'restSec'],
          properties: {
            exerciseId: { type: 'string', description: 'MUST be one of the supplied ids' },
            sets: { type: 'integer' },
            repMin: { type: 'integer' }, repMax: { type: 'integer' },
            restSec: { type: 'integer' },
          },
        },
      },
    },
  },
};

/**
 * Generate ONE training day from a pre-filtered candidate list.
 *
 * The candidate list has already been narrowed to what this person owns, so the
 * model cannot prescribe equipment they do not have — the guarantee comes from
 * the filter, not from asking the model nicely.
 *
 * Any id that still comes back unrecognised is dropped by the caller.
 */
export async function generateTrainingDay({ profile, dayIndex, daysPerWeek, split, candidates, goal, minutes }) {
  const list = candidates
    .map((e) => `${e.id} | ${e.name} | ${e.type} | ${e.primary.join(',')}`)
    .join('\n');

  const messages = [
    {
      role: 'system',
      content: `You are a strength coach building one training day.

Choose exercises ONLY from the supplied list, using the exact id. Never invent an
id. Order compounds before isolation. Fit the session into the stated time,
counting roughly 3 minutes per set including rest.

Prescribe sets, a rep range, and rest in seconds. Do not prescribe weights and do
not mention weeks or progression: the app handles load and periodisation.`,
    },
    {
      role: 'user',
      content: `Day ${dayIndex + 1} of ${daysPerWeek} on a ${split} split.
Goal: ${goal}. Experience: ${profile.experience || 'intermediate'}.
Session length: about ${minutes || 60} minutes.
${profile.limitations ? `Injuries or limitations: ${profile.limitations}` : ''}
${profile.emphasis ? `Wants to emphasise: ${profile.emphasis}` : ''}

Available exercises (id | name | type | primary muscles):
${list}`,
    },
  ];

  return ask(messages, DAY_SCHEMA, { maxTokens: 1400, temperature: 0.4 });
}

/* ============================== health documents ============================== */

const HEALTH_SCHEMA = {
  name: 'health_report',
  schema: {
    type: 'object',
    additionalProperties: false,
    required: ['kind', 'collectedOn', 'markers', 'trainingNotes', 'flags', 'summary'],
    properties: {
      kind: { type: 'string', enum: ['bloodwork', 'body_scan', 'unknown'] },
      collectedOn: { type: 'string', description: 'YYYY-MM-DD if stated, else empty' },
      markers: {
        type: 'array',
        items: {
          type: 'object',
          additionalProperties: false,
          required: ['name', 'value', 'unit', 'referenceRange', 'status'],
          properties: {
            name: { type: 'string' }, value: { type: 'string' }, unit: { type: 'string' },
            referenceRange: { type: 'string' },
            status: { type: 'string', enum: ['low', 'normal', 'high', 'unknown'] },
          },
        },
      },
      trainingNotes: {
        type: 'array', description: 'How these values bear on training only.',
        items: { type: 'string' },
      },
      flags: {
        type: 'array', description: 'Out-of-range values to raise with a doctor.',
        items: { type: 'string' },
      },
      summary: { type: 'string' },
    },
  },
};

/* The guardrail lives in the prompt AND in the UI copy. This is somebody's
   medical record being read by a small open-weights model; it may extract
   numbers, and it may say what a number means for training load. It may not
   diagnose, and it may not suggest treatment. */
const HEALTH_SYSTEM = `You extract values from a lab report or body composition scan.

Transcribe every marker you find with its value, unit and reference range, and
mark each as low, normal or high ACCORDING TO THE RANGE PRINTED IN THE DOCUMENT.
Never invent a value or a range.

You may then describe what the values mean FOR TRAINING ONLY — for example that
low ferritin or haemoglobin limits endurance work, that elevated creatine kinase
suggests incomplete recovery, that fasting glucose or HbA1c bears on carbohydrate
timing, that lean mass informs protein targets.

You must NOT diagnose any condition, name any disease, or suggest any medication,
supplement, or dose. For every out-of-range value, add an entry to "flags" saying
it should be discussed with a doctor. Say nothing about values that are normal
beyond noting they are normal.`;

/** Parse extracted document text into structured markers plus training context. */
export async function parseHealthDocument(text) {
  const clipped = text.length > 12000 ? `${text.slice(0, 12000)}\n[document truncated]` : text;
  return ask(
    [{ role: 'system', content: HEALTH_SYSTEM }, { role: 'user', content: clipped }],
    HEALTH_SCHEMA,
    { maxTokens: 2200, temperature: 0.1 },
  );
}

/* ============================== weekly review ============================== */

const REVIEW_SCHEMA = {
  name: 'weekly_review',
  schema: {
    type: 'object',
    additionalProperties: false,
    required: ['headline', 'wins', 'watchOuts', 'nextWeek'],
    properties: {
      headline: { type: 'string' },
      wins: { type: 'array', items: { type: 'string' } },
      watchOuts: { type: 'array', items: { type: 'string' } },
      nextWeek: { type: 'array', items: { type: 'string' } },
    },
  },
};

/** Short coaching read on the week just finished. */
export async function weeklyReview(summary) {
  return ask([
    {
      role: 'system',
      content: `You are a supportive but honest strength coach reviewing one week.
Be specific and quantitative, referencing the numbers given. Two or three items
per list, one sentence each. No preamble, no praise that the data does not
support, no medical advice.`,
    },
    { role: 'user', content: JSON.stringify(summary) },
  ], REVIEW_SCHEMA, { maxTokens: 1000, temperature: 0.5 });
}



/* ============================== meal photo ============================== */

/**
 * Describe what is on a plate.
 *
 * Runs on Workers AI rather than Groq, because Groq retired every vision model
 * during 2026. The result is deliberately just a DESCRIPTION, not macros: small
 * open vision models identify food well but estimate portions badly, and
 * portion is most of the calories. The user corrects the description, and then
 * logMeal() turns that corrected text into numbers with the strict schema.
 * Each model does the part it is actually good at.
 *
 * @param {string} dataUrl a compressed image/jpeg data URL
 * @returns {{description: string, model: string}}
 */
export async function describeMealPhoto(dataUrl) {
  if (!config.visionUrl) {
    throw new AIError('Photo logging is not set up yet.', 'unconfigured');
  }

  let res;
  try {
    res = await fetch(config.visionUrl, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        authorization: `Bearer ${await config.getToken()}`,
      },
      body: JSON.stringify({ image: dataUrl }),
    });
  } catch {
    throw new AIError('Could not reach the coach. Check your connection.', 'network');
  }

  if (res.status === 413) throw new AIError('That photo is too big. Try again.', 'size');
  if (!res.ok) {
    const detail = await res.json().catch(() => ({}));
    throw new AIError(detail.error || `The photo could not be read (${res.status}).`, 'upstream');
  }

  const data = await res.json();
  if (!data.description) throw new AIError('Nothing recognisable in that photo.', 'empty');
  return data;
}

/* ============================== program planning ============================== */

const PLAN_SCHEMA = {
  name: 'program_plan',
  schema: {
    type: 'object',
    additionalProperties: false,
    required: ['status', 'question', 'summary', 'days', 'learned'],
    properties: {
      status: { type: 'string', enum: ['proposal', 'question'] },
      question: { type: 'string', description: 'Empty unless status is question' },
      summary: { type: 'string', description: 'One short paragraph describing the week' },
      learned: {
        type: 'array',
        description: 'Durable preferences worth remembering next time. Empty if nothing new.',
        items: { type: 'string' },
      },
      days: {
        type: 'array',
        items: {
          type: 'object',
          additionalProperties: false,
          required: ['name', 'focus', 'blocks'],
          properties: {
            name: { type: 'string', description: 'e.g. "Monday - Pull"' },
            focus: { type: 'string' },
            blocks: {
              type: 'array',
              items: {
                type: 'object',
                additionalProperties: false,
                required: ['exerciseId', 'sets', 'repMin', 'repMax', 'restSec'],
                properties: {
                  exerciseId: { type: 'string', description: 'MUST be an id from the supplied list' },
                  sets: { type: 'integer' },
                  repMin: { type: 'integer' },
                  repMax: { type: 'integer' },
                  restSec: { type: 'integer' },
                },
              },
            },
          },
        },
      },
    },
  },
};

const PLAN_SYSTEM = `You are a strength coach building a weekly training plan through conversation.

Honour the person's stated split exactly. If they say Monday pull, Tuesday push,
that is the split; do not substitute a textbook one. If they want the same
muscles every day, vary the VOLUME per muscle across days so each group gets a
lighter day to recover rather than dropping it entirely.

Choose exercises ONLY from the supplied list, by exact id. Never invent an id.
Order compounds before isolation. Respect stated injuries absolutely.

Ask a question ONLY when something would materially change the plan and you
cannot reasonably assume it. Otherwise produce the plan and let them react to
something concrete. Never ask more than one question at a time.

Put anything durable you learn about how they like to train into "learned" as
short standalone sentences. Write preferences, not one-off details: "prefers
dumbbells over barbell for pressing" is durable; "wants 4 sets today" is not.

Do not prescribe weights and do not mention weeks or progression. The app
handles load and periodisation itself.`;

/**
 * One turn of the program conversation.
 *
 * Returns either a question or a full week of day templates. `program.js` then
 * expands whatever comes back across a mesocycle, so the model never has to
 * think about weeks, load, or deloads.
 *
 * The candidate list is pre-filtered to the user's equipment, so a returned id
 * is always something they can actually perform. Callers should still drop any
 * unrecognised id, since strict schema guarantees a string, not a valid one.
 */
export async function planProgram({ turns, profile, prefs, candidates }) {
  const list = candidates
    .map((e) => `${e.id}|${e.name}|${e.primary.join(',')}`)
    .join('\n');

  const context = [
    `Goal: ${profile.goal}. Experience: ${profile.experience || 'intermediate'}.`,
    `Days per week available: ${profile.daysPerWeek}. Session length: about ${profile.minutes || 60} minutes.`,
    profile.limitations ? `Injuries or limitations: ${profile.limitations}` : '',
    prefs?.length ? `Known preferences:\n${prefs.map((x) => `- ${x}`).join('\n')}` : '',
    `\nAvailable exercises (id|name|primary muscles):\n${list}`,
  ].filter(Boolean).join('\n');

  return ask([
    { role: 'system', content: PLAN_SYSTEM },
    { role: 'system', content: context },
    ...turns,
  ], PLAN_SCHEMA, { maxTokens: 3000, temperature: 0.4 });
}

/* ============================== exercise swap ============================== */

const SWAP_SCHEMA = {
  name: 'swap_choice',
  schema: {
    type: 'object',
    additionalProperties: false,
    required: ['exerciseId', 'reason'],
    properties: {
      exerciseId: { type: 'string' },
      reason: { type: 'string' },
    },
  },
};

/**
 * Pick a replacement when the deterministic rules in program.js have several
 * equally good options and the choice depends on stated context (a tweaky
 * shoulder, a crowded gym) that rules cannot see.
 */
export async function chooseSwap({ original, candidates, reason }) {
  const list = candidates.map((e) => `${e.id} | ${e.name} | ${e.primary.join(',')}`).join('\n');
  return ask([
    {
      role: 'system',
      content: 'Pick the single best replacement exercise from the list. Reply with its exact id and one short sentence of reasoning.',
    },
    {
      role: 'user',
      content: `Replacing: ${original.name} (${original.primary.join(', ')})\nWhy: ${reason}\n\nOptions:\n${list}`,
    },
  ], SWAP_SCHEMA, { maxTokens: 400 });
}
