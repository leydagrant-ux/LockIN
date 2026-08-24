/* db.js — Firebase auth, Firestore access, and image handling.
 *
 * The only module that talks to Firebase. Everything else takes plain objects,
 * which is what keeps program.js / score.js / stats.js pure and testable.
 *
 * IMAGES LIVE IN FIRESTORE, NOT FIREBASE STORAGE. Storage requires the paid
 * Blaze plan; Firestore's free tier includes 1 GiB. Photos are resized and
 * compressed client-side to roughly 120 KB, comfortably under the 1 MiB
 * document cap, and each photo gets its own document so a big image never
 * bloats a document that is read often.
 */

import {
  initializeApp,
} from 'https://www.gstatic.com/firebasejs/10.12.2/firebase-app.js';
import {
  getAuth, createUserWithEmailAndPassword, signInWithEmailAndPassword,
  sendPasswordResetEmail, signOut as fbSignOut, onAuthStateChanged, updateProfile,
} from 'https://www.gstatic.com/firebasejs/10.12.2/firebase-auth.js';
import {
  getFirestore, doc, getDoc, setDoc, updateDoc, deleteDoc, collection,
  addDoc, getDocs, query, where, orderBy, limit as fsLimit, onSnapshot,
  serverTimestamp, writeBatch, initializeFirestore, persistentLocalCache,
  persistentMultipleTabManager,
} from 'https://www.gstatic.com/firebasejs/10.12.2/firebase-firestore.js';

import { FIREBASE, COUPLE_ID } from './config.js';

let app, auth, db;

/**
 * Start Firebase.
 *
 * Local cache is enabled so the app opens instantly and keeps working in a gym
 * basement with no signal — writes queue and sync when the connection returns,
 * which for a workout logger is the difference between usable and not.
 */
export function init() {
  if (app) return { app, auth, db };
  app = initializeApp(FIREBASE);
  auth = getAuth(app);
  try {
    db = initializeFirestore(app, {
      localCache: persistentLocalCache({ tabManager: persistentMultipleTabManager() }),
    });
  } catch {
    /* Persistence fails in private browsing and some embedded webviews. The app
       is still perfectly usable online, so degrade rather than refuse to load. */
    db = getFirestore(app);
  }
  return { app, auth, db };
}

export const currentUser = () => auth?.currentUser || null;
export const uid = () => auth?.currentUser?.uid || null;

/* ============================== auth ============================== */

export function onAuth(callback) {
  return onAuthStateChanged(auth, callback);
}

export async function signUp(email, password, displayName) {
  const cred = await createUserWithEmailAndPassword(auth, email.trim(), password);
  if (displayName) await updateProfile(cred.user, { displayName });
  return cred.user;
}

export async function signIn(email, password) {
  const cred = await signInWithEmailAndPassword(auth, email.trim(), password);
  return cred.user;
}

export const signOut = () => fbSignOut(auth);

/**
 * Email a password reset link.
 *
 * The way out of auth/invalid-credential when the password is the thing that
 * is wrong. Firebase resolves silently for an unknown address (that is its
 * email-enumeration protection), so the UI says "check your email" either way.
 */
export const resetPassword = (email) => sendPasswordResetEmail(auth, email.trim());

/**
 * A fresh Firebase ID token for the Worker.
 *
 * Not forced to refresh: the SDK already refreshes an hour before expiry, and
 * forcing it on every AI call would add a network round trip to each one.
 */
export const getIdToken = async () => (auth.currentUser ? auth.currentUser.getIdToken() : '');

/** Friendly text for the auth errors that actually happen. */
export function authErrorMessage(err) {
  const code = err?.code || '';
  /* Firebase collapses "no such account" into invalid-credential when email
     enumeration protection is on, so this one message has to cover both. */
  if (code.includes('invalid-credential') || code.includes('wrong-password')) {
    return 'Wrong email or password. Use "Forgot password?" if you are not sure.';
  }
  if (code.includes('user-not-found')) return 'No account with that email.';
  if (code.includes('email-already-in-use')) return 'That email already has an account. Sign in instead.';
  if (code.includes('weak-password')) return 'Password needs to be at least 6 characters.';
  if (code.includes('invalid-email')) return 'That does not look like an email address.';
  if (code.includes('network')) return 'No connection. Try again when you are back online.';
  if (code.includes('too-many-requests')) return 'Too many attempts. Wait a minute and try again.';
  return err?.message || 'Something went wrong signing in.';
}

/* ============================== paths ============================== */

const userDoc = (id) => doc(db, 'users', id);
const sub = (id, name) => collection(db, 'users', id, name);
export const coupleDoc = () => doc(db, 'couple', COUPLE_ID);

/* ============================== profile ============================== */

export async function getProfile(id = uid()) {
  const snap = await getDoc(userDoc(id));
  return snap.exists() ? { id: snap.id, ...snap.data() } : null;
}

export async function saveProfile(patch, id = uid()) {
  await setDoc(userDoc(id), { ...patch, updatedAt: serverTimestamp() }, { merge: true });
}

/** Live profile updates, so the partner's name and goals stay current. */
export function watchProfile(id, callback) {
  return onSnapshot(userDoc(id), (snap) => callback(snap.exists() ? { id: snap.id, ...snap.data() } : null));
}

/* ============================== generic collection helpers ============================== */

/* Every logged collection has the same shape — a date-stamped document owned by
   one user — so one set of helpers covers workouts, meals, cardio and metrics
   instead of four near-identical copies. */

export async function addEntry(name, data, id = uid()) {
  const ref = await addDoc(sub(id, name), {
    ...data, createdAt: serverTimestamp(),
  });
  return ref.id;
}

export async function updateEntry(name, entryId, patch, id = uid()) {
  await updateDoc(doc(db, 'users', id, name, entryId), patch);
}

export async function removeEntry(name, entryId, id = uid()) {
  await deleteDoc(doc(db, 'users', id, name, entryId));
}

/**
 * Read a date-ranged slice of a collection.
 *
 * `date` is a plain 'YYYY-MM-DD' string throughout the app rather than a
 * Timestamp: string comparison sorts and ranges correctly for ISO dates, it
 * survives the JSON export unchanged, and it sidesteps a whole category of
 * timezone bugs where a late-evening workout lands on tomorrow.
 */
export async function listEntries(name, { from, to, max = 500, id = uid() } = {}) {
  const clauses = [];
  if (from) clauses.push(where('date', '>=', from));
  if (to) clauses.push(where('date', '<=', to));

  const snap = await getDocs(query(sub(id, name), ...clauses, orderBy('date', 'desc'), fsLimit(max)));
  return snap.docs.map((d) => ({ id: d.id, ...d.data() }));
}

export function watchEntries(name, callback, { from, max = 200, id = uid() } = {}) {
  const clauses = from ? [where('date', '>=', from)] : [];
  return onSnapshot(
    query(sub(id, name), ...clauses, orderBy('date', 'desc'), fsLimit(max)),
    (snap) => callback(snap.docs.map((d) => ({ id: d.id, ...d.data() }))),
  );
}

/* ============================== photos ============================== */

/**
 * Shrink an image for storage.
 *
 * Targets roughly 120 KB at 1000px, which keeps a photo well under Firestore's
 * 1 MiB document limit even after base64 inflates it by a third. Quality steps
 * down until the result fits rather than guessing a single quality value that
 * would be too big for a detailed photo and wasteful for a plain one.
 */
export function compressImage(file, { maxSize = 1000, maxBytes = 160_000 } = {}) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onerror = () => reject(new Error('Could not read that image.'));
    reader.onload = () => {
      const img = new Image();
      img.onerror = () => reject(new Error('That file is not an image.'));
      img.onload = () => {
        const scale = Math.min(1, maxSize / Math.max(img.width, img.height));
        const w = Math.round(img.width * scale);
        const h = Math.round(img.height * scale);

        const canvas = document.createElement('canvas');
        canvas.width = w; canvas.height = h;
        canvas.getContext('2d').drawImage(img, 0, 0, w, h);

        let quality = 0.82;
        let out = canvas.toDataURL('image/jpeg', quality);
        while (out.length > maxBytes && quality > 0.4) {
          quality -= 0.1;
          out = canvas.toDataURL('image/jpeg', quality);
        }
        resolve({ dataUrl: out, width: w, height: h, bytes: out.length });
      };
      img.src = reader.result;
    };
    reader.readAsDataURL(file);
  });
}

/**
 * Save a progress photo.
 *
 * `private` defaults to TRUE. Progress photos are the one thing Grant asked to
 * be able to keep back, and a privacy default that has to be remembered is not
 * a privacy default.
 */
export async function addPhoto(file, { pose = 'front', date, isPrivate = true, note = '' } = {}) {
  const { dataUrl, width, height } = await compressImage(file);
  return addEntry('photos', {
    date: date || new Date().toISOString().slice(0, 10),
    pose, note, image: dataUrl, width, height,
    private: isPrivate !== false,
  });
}

/**
 * Photos visible to the partner.
 *
 * The `where` clause is not optional decoration: Firestore rules cannot filter
 * a list query, so a query that would match a private document fails outright
 * rather than returning a subset. The query shape and the rule have to agree.
 */
export async function listSharedPhotos(ownerId, max = 100) {
  const snap = await getDocs(query(
    sub(ownerId, 'photos'), where('private', '==', false), orderBy('date', 'desc'), fsLimit(max)));
  return snap.docs.map((d) => ({ id: d.id, ...d.data() }));
}

/* ============================== health documents ============================== */

/**
 * Store a parsed lab report or body scan.
 *
 * `shared` defaults to false for the same reason photos are private: these are
 * medical records, and sharing them should be a decision rather than an
 * oversight. The raw extracted text is kept so a re-parse never needs the
 * original file again.
 */
export async function addHealthDoc({ parsed, rawText, filename, shared = false }) {
  return addEntry('health', {
    date: parsed?.collectedOn || new Date().toISOString().slice(0, 10),
    kind: parsed?.kind || 'unknown',
    filename: filename || '',
    parsed, rawText: (rawText || '').slice(0, 20000),
    shared: shared === true,
  });
}

export async function listSharedHealthDocs(ownerId, max = 50) {
  const snap = await getDocs(query(
    sub(ownerId, 'health'), where('shared', '==', true), orderBy('date', 'desc'), fsLimit(max)));
  return snap.docs.map((d) => ({ id: d.id, ...d.data() }));
}

/* ============================== couple / leaderboard ============================== */

/**
 * Publish this week's score for the partner to see.
 *
 * Scores live on the shared couple document rather than being recomputed from
 * the other person's raw logs. That keeps the leaderboard to a single small
 * read instead of pulling their entire workout history on every render.
 */
export async function publishScore(weekKey, payload, id = uid()) {
  await setDoc(coupleDoc(), {
    scores: { [weekKey]: { [id]: { ...payload, updatedAt: Date.now() } } },
  }, { merge: true });
}

export function watchCouple(callback) {
  return onSnapshot(coupleDoc(), (snap) => callback(snap.exists() ? snap.data() : {}));
}

export async function saveChallenge(challenge) {
  await setDoc(coupleDoc(), {
    challenges: { [challenge.id]: challenge },
  }, { merge: true });
}

/* ============================== programs ============================== */

export async function saveProgram(program, id = uid()) {
  const ref = doc(db, 'users', id, 'programs', program.id || 'current');
  await setDoc(ref, { ...program, updatedAt: serverTimestamp() });
  return ref.id;
}

export async function getProgram(id = uid()) {
  const snap = await getDoc(doc(db, 'users', id, 'programs', 'current'));
  return snap.exists() ? { id: snap.id, ...snap.data() } : null;
}

/* ============================== food library ============================== */

export async function getFoodLibrary(id = uid()) {
  const snap = await getDocs(query(sub(id, 'foods'), orderBy('uses', 'desc'), fsLimit(400)));
  return snap.docs.map((d) => ({ id: d.id, ...d.data() }));
}

/**
 * Remember a food.
 *
 * Keyed by a sanitised food id so re-logging the same thing increments its use
 * count instead of piling up duplicates — the use count is what makes the
 * library rank well and eventually replace searching entirely.
 */
export async function rememberFood(food, id = uid()) {
  const key = String(food.id || food.name).replace(/[^a-zA-Z0-9_-]/g, '_').slice(0, 90);
  const ref = doc(db, 'users', id, 'foods', key);
  const existing = await getDoc(ref);
  await setDoc(ref, {
    ...food,
    uses: (existing.exists() ? existing.data().uses || 0 : 0) + 1,
    lastUsed: new Date().toISOString(),
  }, { merge: true });
}

/* ============================== export and import ============================== */

/**
 * Everything this account owns, as one JSON object.
 *
 * Grant has been burned before by data living in exactly one place, so this is
 * a first-class feature rather than a debugging aid.
 */
export async function exportAll(id = uid()) {
  const names = ['workouts', 'metrics', 'meals', 'cardio', 'checkins', 'foods', 'photos', 'health'];
  const out = { exportedAt: new Date().toISOString(), uid: id, profile: await getProfile(id) };

  for (const name of names) {
    const snap = await getDocs(query(sub(id, name), fsLimit(2000)));
    out[name] = snap.docs.map((d) => ({ id: d.id, ...d.data() }));
  }
  out.program = await getProgram(id);
  return out;
}

/**
 * Restore an export.
 *
 * Uses each entry's original document id, so importing the same file twice
 * overwrites rather than duplicating. Batches are capped at 400 because
 * Firestore refuses a batch above 500 writes.
 */
export async function importAll(data, id = uid()) {
  const names = ['workouts', 'metrics', 'meals', 'cardio', 'checkins', 'foods', 'photos', 'health'];
  let written = 0;

  if (data.profile) await saveProfile(data.profile, id);
  if (data.program) await saveProgram(data.program, id);

  for (const name of names) {
    const rows = data[name] || [];
    for (let i = 0; i < rows.length; i += 400) {
      const batch = writeBatch(db);
      for (const row of rows.slice(i, i + 400)) {
        const { id: rowId, ...rest } = row;
        batch.set(doc(db, 'users', id, name, rowId || crypto.randomUUID()), rest, { merge: true });
        written++;
      }
      await batch.commit();
    }
  }
  return written;
}
