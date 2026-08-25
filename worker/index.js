/* LockIN backend — Cloudflare Worker.
 *
 * Two routes, both doing the same three jobs for different upstreams:
 *
 *   POST /ai     -> Groq chat completions
 *   POST /food   -> USDA FoodData Central and Open Food Facts text search
 *   POST /vision -> Workers AI, describes a meal photo
 *
 * Why this exists at all is CORS, not cost. Browsers refuse to call
 * api.groq.com, and they refuse Open Food Facts' search endpoint and USDA's
 * search endpoint too — all three were verified from a real browser before this
 * was written. Open Food Facts BARCODE lookup does send CORS headers, so the
 * app calls that one directly and does not route it through here.
 *
 * The Worker also keeps both API keys server-side, and gates every request on a
 * Firebase ID token belonging to one of two allowlisted accounts. This URL ships
 * inside public GitHub Pages JavaScript; without that gate it would be an open
 * proxy to Grant's Groq quota. Origin checks alone are not enough — Origin is
 * trivially forged outside a browser.
 *
 * Deploy:
 *   npx wrangler secret put GROQ_API_KEY
 *   npx wrangler secret put USDA_API_KEY
 *   npx wrangler deploy
 */

/* Only these models are reachable, so a stolen token cannot select an expensive
   one. Both support strict json_schema, which the app depends on. */
const ALLOWED_MODELS = new Set(['openai/gpt-oss-120b', 'openai/gpt-oss-20b']);

const MAX_TOKENS_CAP = 8000;
const GROQ_URL = 'https://api.groq.com/openai/v1/chat/completions';
const USDA_SEARCH = 'https://api.nal.usda.gov/fdc/v1/foods/search';
const OFF_SEARCH = 'https://world.openfoodfacts.org/cgi/search.pl';
const JWKS_URL = 'https://www.googleapis.com/service_accounts/v1/jwk/securetoken@system.gserviceaccount.com';

/* ============================== helpers ============================== */

const corsHeaders = (origin, allowed) => ({
  'Access-Control-Allow-Origin': allowed ? origin : 'null',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
  'Access-Control-Allow-Headers': 'content-type, authorization',
  'Access-Control-Max-Age': '86400',
  Vary: 'Origin',
});

const json = (body, status, headers) =>
  new Response(JSON.stringify(body), {
    status, headers: { ...headers, 'content-type': 'application/json' },
  });

function b64urlToBytes(s) {
  const pad = s.replace(/-/g, '+').replace(/_/g, '/');
  const bin = atob(pad + '='.repeat((4 - (pad.length % 4)) % 4));
  return Uint8Array.from(bin, (ch) => ch.charCodeAt(0));
}
const b64urlToString = (s) => new TextDecoder().decode(b64urlToBytes(s));

/* Workers reuse an isolate across requests, so caching Google's signing keys in
   module scope avoids refetching them on every call. A `kid` miss forces a
   refresh, which is what handles Google's key rotation. */
let jwksCache = null;
let jwksFetchedAt = 0;
const JWKS_TTL_MS = 6 * 60 * 60 * 1000;

async function getJwks(force = false) {
  if (!jwksCache || Date.now() - jwksFetchedAt > JWKS_TTL_MS || force) {
    const res = await fetch(JWKS_URL);
    if (!res.ok) throw new Error('could not fetch signing keys');
    jwksCache = await res.json();
    jwksFetchedAt = Date.now();
  }
  return jwksCache;
}

/** Verify a Firebase ID token and return its claims. Throws on any failure. */
async function verifyFirebaseToken(token, projectId) {
  const parts = token.split('.');
  if (parts.length !== 3) throw new Error('malformed token');

  const header = JSON.parse(b64urlToString(parts[0]));
  const claims = JSON.parse(b64urlToString(parts[1]));
  if (header.alg !== 'RS256') throw new Error('unexpected token algorithm');

  let jwks = await getJwks();
  let jwk = jwks.keys.find((k) => k.kid === header.kid);
  if (!jwk) {
    jwks = await getJwks(true);
    jwk = jwks.keys.find((k) => k.kid === header.kid);
  }
  if (!jwk) throw new Error('unknown signing key');

  const key = await crypto.subtle.importKey(
    'jwk', jwk, { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' }, false, ['verify']);
  const signed = new TextEncoder().encode(`${parts[0]}.${parts[1]}`);
  if (!await crypto.subtle.verify('RSASSA-PKCS1-v1_5', key, b64urlToBytes(parts[2]), signed)) {
    throw new Error('bad signature');
  }

  const now = Math.floor(Date.now() / 1000);
  if (claims.exp <= now) throw new Error('token expired');
  if (claims.iat > now + 300) throw new Error('token issued in the future');
  if (claims.aud !== projectId) throw new Error('wrong audience');
  if (claims.iss !== `https://securetoken.google.com/${projectId}`) throw new Error('wrong issuer');
  if (!claims.sub) throw new Error('no subject');
  return claims;
}

/* ============================== routes ============================== */

async function handleAI(body, env, cors) {
  const model = ALLOWED_MODELS.has(body.model) ? body.model : 'openai/gpt-oss-120b';
  const payload = {
    model,
    messages: Array.isArray(body.messages) ? body.messages : [],
    temperature: typeof body.temperature === 'number' ? body.temperature : 0.3,
    max_tokens: Math.min(Number(body.max_tokens) || 2000, MAX_TOKENS_CAP),
  };
  if (body.response_format) payload.response_format = body.response_format;
  if (payload.messages.length === 0) return json({ error: 'no messages' }, 400, cors);

  let upstream;
  try {
    upstream = await fetch(GROQ_URL, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${env.GROQ_API_KEY}` },
      body: JSON.stringify(payload),
    });
  } catch {
    return json({ error: 'could not reach Groq' }, 502, cors);
  }

  const text = await upstream.text();
  const headers = { ...cors, 'content-type': 'application/json' };
  /* Forwarded so the app can tell a rate limit apart from a real failure and
     retry on the smaller model. */
  const retryAfter = upstream.headers.get('retry-after');
  if (retryAfter) headers['retry-after'] = retryAfter;
  return new Response(text, { status: upstream.status, headers });
}

async function handleFood(body, env, cors) {
  const query = String(body.query || '').trim().slice(0, 120);
  const limit = Math.min(Number(body.limit) || 12, 25);
  if (!query) return json({ usda: [], off: [] }, 200, cors);

  const usdaUrl = `${USDA_SEARCH}?api_key=${encodeURIComponent(env.USDA_API_KEY || 'DEMO_KEY')}` +
    `&query=${encodeURIComponent(query)}&pageSize=${limit}` +
    `&dataType=${encodeURIComponent('Branded,SR Legacy,Foundation')}`;

  const offUrl = `${OFF_SEARCH}?search_terms=${encodeURIComponent(query)}` +
    `&search_simple=1&action=process&json=1&page_size=${limit}` +
    '&fields=code,product_name,brands,serving_size,nutriments';

  /* allSettled, not all: one database being down or rate-limited must not take
     the other's results with it. */
  /* USDA 404s on any request with no User-Agent — verified directly, and
     Workers' fetch sends none by default. Open Food Facts asks for an
     identifying UA in its terms. Both get one. */
  const headers = { 'user-agent': 'LockIN/1.0 (personal fitness app)' };

  const [usda, off] = await Promise.allSettled([
    fetch(usdaUrl, { headers }).then((r) => (r.ok ? r.json() : { foods: [] })),
    fetch(offUrl, { headers }).then((r) => (r.ok ? r.json() : { products: [] })),
  ]);

  return json({
    usda: usda.status === 'fulfilled' ? (usda.value.foods || []) : [],
    off: off.status === 'fulfilled' ? (off.value.products || []) : [],
    errors: [usda, off].filter((r) => r.status === 'rejected').map((r) => String(r.reason).slice(0, 120)),
  }, 200, cors);
}


/* ============================== vision ============================== */

/* Groq retired every vision model during 2026 (Maverick in March, Scout in
   July), so the meal photo runs on Workers AI instead. It is on the same
   account as this Worker, which means no extra key and no CORS at all.
 *
 * Two calling conventions exist and the docs do not say which applies to which
 * model, so both are tried in order:
 *   1. "Text Generation" multimodal models take OpenAI-style messages with an
 *      image_url data URI.
 *   2. "Image-to-Text" models take raw bytes plus a prompt.
 * Whichever answers first wins. The model that worked is returned so the app
 * can show it and so this can be simplified once it is known.
 */
const VISION_ATTEMPTS = [
  { model: '@cf/meta/llama-3.2-11b-vision-instruct', style: 'messages' },
  { model: '@cf/mistralai/mistral-small-3.1-24b-instruct', style: 'messages' },
  { model: '@cf/llava-hf/llava-1.5-7b-hf', style: 'bytes' },
];

const VISION_PROMPTS = {
  meal:
    'List the foods on this plate and estimate the portion of each. Be concrete: ' +
    'name each item and give a rough amount, like "about 6 oz grilled chicken, ' +
    '1 cup white rice, half an avocado". Do not give calories. Do not add ' +
    'commentary. If it is not food, say so in one short sentence.',

  /* Gym machines are usually photographed for their NAME PLATE, so reading the
     text on the machine matters as much as recognising the shape of it. */
  equipment:
    'This is a photo taken in a gym. Say what piece of equipment it is. If there ' +
    'is a name or label printed on the machine, read it out exactly. Then name ' +
    'the movement it is used for in plain gym language, for example "seated leg ' +
    'curl machine", "cable crossover", "hack squat sled". Two sentences at most. ' +
    'If it is not gym equipment, say so in one short sentence.',

  /* Transcription, NOT interpretation. A lab result is numbers, units and
     reference ranges, and every one of them has to survive the trip
     unchanged — a model that "tidies" 13.8 to 13.5 has invented a result. The
     app shows this text back for correction before anything is structured. */
  document:
    'Transcribe every piece of text in this photo of a document, exactly as it ' +
    'is printed. Keep numbers, units and reference ranges character for ' +
    'character. Keep the line and column order. Do not summarise, do not ' +
    'interpret, do not correct anything, and do not add commentary. If part of ' +
    'it is unreadable, write [unclear] in its place rather than guessing. If ' +
    'this is not a document, say so in one short sentence.',
};

function dataUrlToBytes(dataUrl) {
  const comma = dataUrl.indexOf(',');
  const b64 = comma >= 0 ? dataUrl.slice(comma + 1) : dataUrl;
  const bin = atob(b64);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

async function handleVision(body, env, cors) {
  if (!env.AI) return json({ error: 'Workers AI is not bound to this Worker' }, 500, cors);

  const dataUrl = String(body.image || '');
  if (!dataUrl.startsWith('data:image/')) {
    return json({ error: 'image must be a data: URL' }, 400, cors);
  }
  /* Roughly 1.5 MB of base64. The app compresses well below this; the cap is
     here so a stray upload cannot burn the daily neuron allowance. */
  if (dataUrl.length > 1_500_000) {
    return json({ error: 'image too large' }, 413, cors);
  }

  /* Two subjects share this route because they share the hard part: reaching a
     multimodal model at all. Only the prompt differs. */
  const prompt = VISION_PROMPTS[body.subject] || VISION_PROMPTS.meal;

  const errors = [];
  for (const attempt of VISION_ATTEMPTS) {
    try {
      /* A lab page is far more text than a plate of food. */
      const maxTokens = body.subject === 'document' ? 1200 : 300;

      const input = attempt.style === 'messages'
        ? {
          messages: [{
            role: 'user',
            content: [
              { type: 'text', text: prompt },
              { type: 'image_url', image_url: { url: dataUrl } },
            ],
          }],
          max_tokens: maxTokens,
        }
        : { image: [...dataUrlToBytes(dataUrl)], prompt, max_tokens: maxTokens };

      const res = await env.AI.run(attempt.model, input);
      const text = (res?.response ?? res?.result?.response ?? res?.description ?? '').trim();
      if (text) return json({ description: text, model: attempt.model }, 200, cors);
      errors.push(`${attempt.model}: empty response`);
    } catch (err) {
      errors.push(`${attempt.model}: ${String(err?.message || err).slice(0, 120)}`);
    }
  }

  return json({ error: 'No vision model could read that photo.', tried: errors }, 502, cors);
}

/* ============================== handler ============================== */

export default {
  async fetch(request, env) {
    const origin = request.headers.get('Origin') || '';
    const allowedOrigins = (env.ALLOWED_ORIGINS || '').split(',').map((s) => s.trim()).filter(Boolean);
    const originOk = allowedOrigins.includes(origin);
    const cors = corsHeaders(origin, originOk);

    if (request.method === 'OPTIONS') return new Response(null, { status: 204, headers: cors });
    if (request.method !== 'POST') return json({ error: 'POST only' }, 405, cors);
    if (!originOk) return json({ error: 'origin not allowed' }, 403, cors);

    const auth = request.headers.get('Authorization') || '';
    const token = auth.startsWith('Bearer ') ? auth.slice(7) : '';
    if (!token) return json({ error: 'missing token' }, 401, cors);

    let claims;
    try {
      claims = await verifyFirebaseToken(token, env.FIREBASE_PROJECT_ID);
    } catch (err) {
      return json({ error: `auth failed: ${err.message}` }, 401, cors);
    }

    const allowedUids = (env.ALLOWED_UIDS || '').split(',').map((s) => s.trim()).filter(Boolean);
    if (allowedUids.length && !allowedUids.includes(claims.sub)) {
      return json({ error: 'account not permitted' }, 403, cors);
    }

    let body;
    try {
      body = await request.json();
    } catch {
      return json({ error: 'body must be JSON' }, 400, cors);
    }

    const path = new URL(request.url).pathname.replace(/\/+$/, '');
    if (path === '/food') return handleFood(body, env, cors);
    if (path === '/vision') return handleVision(body, env, cors);
    return handleAI(body, env, cors);   /* '' and '/ai' both mean the AI route */
  },
};
