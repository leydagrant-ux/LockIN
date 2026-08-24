/* foods.js — free nutrition lookup.
 *
 * Resolution order, cheapest first. Most entries never reach the AI at all:
 *
 *   1. The user's saved library   — instant, offline, free
 *   2. Barcode -> Open Food Facts — free, no key
 *   3. Text search -> USDA + OFF  — free (USDA needs a free key)
 *   4. "Just describe it" -> ai.js
 *
 * Everything here is normalised to one shape so the UI never has to care which
 * database an entry came from:
 *
 *   { id, name, brand, source, per, servings[], calories, protein, carbs, fat }
 *
 * `calories`/`protein`/`carbs`/`fat` are always PER SERVING as described by
 * `per`. Databases disagree wildly about this — USDA SR Legacy is per 100 g,
 * branded items are per labelled serving, Open Food Facts is per 100 g with an
 * optional serving string — so normalising at the boundary is the only way to
 * keep the rest of the app sane.
 *
 * CORS, verified from a real browser rather than assumed:
 *   Open Food Facts BARCODE  (/api/v2/product) — allowed, called directly here.
 *   Open Food Facts SEARCH   (/cgi/search.pl)  — BLOCKED.
 *   USDA search                                — BLOCKED.
 * So text search goes through the Worker, which also keeps the USDA key off the
 * client. Barcode stays direct because it works and it is the latency-sensitive
 * path — you are standing in a kitchen holding a packet.
 */

let config = { foodUrl: '', getToken: async () => '' };

/** Point the module at the Worker's /food route. */
export function configure({ foodUrl, getToken }) {
  config = { foodUrl, getToken };
}

const OFF_PRODUCT = 'https://world.openfoodfacts.org/api/v2/product';

/* USDA nutrient ids. Stable identifiers, not display names, which is why the
   lookup keys off the number rather than matching on text. */
const N = { calories: 1008, protein: 1003, fat: 1004, carbs: 1005 };

const round = (n, dp = 0) => {
  const f = 10 ** dp;
  return Math.round((Number(n) || 0) * f) / f;
};

/* ============================== normalisers ============================== */

function usdaNutrient(food, id) {
  const hit = (food.foodNutrients || []).find((n) => n.nutrientId === id || n.nutrient?.id === id);
  return Number(hit?.value ?? hit?.amount ?? 0) || 0;
}

function normaliseUsda(food) {
  /* Branded items carry a labelled serving but report per 100 g; scale to the
     serving so the number matches what is printed on the packet. */
  const size = Number(food.servingSize) || 0;
  const unit = (food.servingSizeUnit || '').toLowerCase();
  const scalable = size > 0 && (unit === 'g' || unit === 'ml');
  const factor = scalable ? size / 100 : 1;

  return {
    id: `usda:${food.fdcId}`,
    name: (food.description || '').replace(/\s+/g, ' ').trim(),
    brand: food.brandName || food.brandOwner || '',
    source: 'USDA',
    per: scalable ? `${round(size)} ${unit}` : '100 g',
    calories: round(usdaNutrient(food, N.calories) * factor),
    protein: round(usdaNutrient(food, N.protein) * factor, 1),
    carbs: round(usdaNutrient(food, N.carbs) * factor, 1),
    fat: round(usdaNutrient(food, N.fat) * factor, 1),
  };
}

function normaliseOff(product) {
  const n = product.nutriments || {};
  /* OFF stores kcal under one key and kJ under another; prefer kcal and convert
     only when that is all there is. */
  const kcal = Number(n['energy-kcal_100g']) ||
    (Number(n.energy_100g) ? Number(n.energy_100g) / 4.184 : 0);

  return {
    id: `off:${product.code}`,
    name: (product.product_name || '').trim(),
    brand: (product.brands || '').split(',')[0].trim(),
    source: 'Open Food Facts',
    per: '100 g',
    servingHint: product.serving_size || '',
    calories: round(kcal),
    protein: round(n.proteins_100g, 1),
    carbs: round(n.carbohydrates_100g, 1),
    fat: round(n.fat_100g, 1),
  };
}

/* ============================== remote search ============================== */

/** Text search across USDA and Open Food Facts, via the Worker. */
export async function searchRemote(query, { limit = 12, signal } = {}) {
  if (!config.foodUrl || !query.trim()) return { results: [], errors: [] };

  const res = await fetch(config.foodUrl, {
    method: 'POST', signal,
    headers: {
      'content-type': 'application/json',
      authorization: `Bearer ${await config.getToken()}`,
    },
    body: JSON.stringify({ query, limit }),
  });
  if (!res.ok) throw new Error(`Food search failed (${res.status})`);

  const data = await res.json();
  const results = [
    ...(data.usda || []).map(normaliseUsda),
    ...(data.off || []).map(normaliseOff),
  ].filter((f) => f.name && f.calories > 0);

  return { results, errors: data.errors || [] };
}

/**
 * Look a barcode up directly against Open Food Facts.
 * Highest-confidence free path, and the only one that does not need the Worker.
 */
export async function lookupBarcode(barcode, { signal } = {}) {
  const clean = String(barcode).replace(/\D/g, '');
  if (!clean) return null;

  const res = await fetch(
    `${OFF_PRODUCT}/${clean}.json?fields=code,product_name,brands,serving_size,nutriments`,
    { signal });
  if (!res.ok) return null;

  const data = await res.json();
  if (data.status !== 1 || !data.product) return null;

  const food = normaliseOff(data.product);
  return food.calories > 0 ? food : null;
}

/* ============================== saved library ============================== */

/**
 * Match against foods the user has already logged.
 *
 * Ranks a prefix match above a substring match so typing "chick" surfaces
 * "Chicken bowl" before "Orange chicken". Free, instant, and after a few weeks
 * this answers most lookups on its own.
 */
export function searchLibrary(library, query) {
  const q = query.trim().toLowerCase();
  if (!q) return [];

  return (library || [])
    .map((food) => {
      const name = `${food.name} ${food.brand || ''}`.toLowerCase();
      if (name.startsWith(q)) return { food, rank: 0 };
      if (name.includes(q)) return { food, rank: 1 };
      return null;
    })
    .filter(Boolean)
    /* Within a rank, most-used first — habits are the best predictor here. */
    .sort((a, b) => a.rank - b.rank || (b.food.uses || 0) - (a.food.uses || 0))
    .map((m) => ({ ...m.food, source: 'Saved' }));
}

/* ============================== combined ============================== */

/**
 * Search everything, saved foods first.
 *
 * A remote failure is reported but never fatal: the saved library still answers,
 * which means the food logger keeps working on a bad connection or if a database
 * is down.
 */
export async function searchAll(query, { library = [], limit = 10, signal } = {}) {
  const saved = searchLibrary(library, query).slice(0, 5);

  let remote = { results: [], errors: [] };
  try {
    remote = await searchRemote(query, { limit, signal });
  } catch (err) {
    remote = { results: [], errors: [err.message] };
  }

  /* The same packaged food appears in both databases constantly. */
  const seen = new Set(saved.map((f) => `${f.name}|${f.brand}`.toLowerCase()));
  const deduped = remote.results.filter((f) => {
    const key = `${f.name}|${f.brand}`.toLowerCase();
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });

  return { results: [...saved, ...deduped].slice(0, limit + 5), errors: remote.errors };
}

/* ============================== portions ============================== */

/** Scale a food's macros by a multiplier, e.g. 1.5 servings. */
export function scaleFood(food, multiplier) {
  const m = Number(multiplier) || 1;
  return {
    ...food,
    servings: m,
    calories: round(food.calories * m),
    protein: round(food.protein * m, 1),
    carbs: round(food.carbs * m, 1),
    fat: round(food.fat * m, 1),
  };
}

/**
 * Turn a finished entry into a library record.
 *
 * `uses` is what makes the library get faster the more it is used — it feeds the
 * ranking in searchLibrary, so frequently eaten foods rise to the top and stop
 * needing a search at all.
 */
export function toLibraryEntry(food, existing) {
  return {
    id: food.id || `custom:${Date.now()}`,
    name: food.name,
    brand: food.brand || '',
    per: food.per || 'serving',
    calories: food.calories, protein: food.protein,
    carbs: food.carbs, fat: food.fat,
    uses: (existing?.uses || 0) + 1,
    lastUsed: new Date().toISOString(),
  };
}

/**
 * A hand-entered food, for a label the databases do not have.
 * Always available, so the app is never a dead end without a network.
 */
export function manualFood({ name, calories, protein, carbs, fat, per = 'serving' }) {
  return {
    id: `custom:${Date.now()}`,
    name: (name || 'Food').trim(),
    brand: '', source: 'Manual', per,
    calories: round(calories), protein: round(protein, 1),
    carbs: round(carbs, 1), fat: round(fat, 1),
  };
}
