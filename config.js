/* config.js — the values you fill in once during setup.
 *
 * None of this is secret. The Firebase web config is public by design; access
 * is controlled by firestore.rules, not by hiding these strings. The Groq and
 * USDA keys are NOT here — those live as Cloudflare Worker secrets and never
 * reach the browser.
 *
 * See README.md for where each value comes from.
 */

export const FIREBASE = {
  apiKey: 'AIzaSyDTon-z4fXRvGcfJqL9NTpJ3_GG368ZL9k',
  authDomain: 'lockin-dffd9.firebaseapp.com',
  projectId: 'lockin-dffd9',
  storageBucket: 'lockin-dffd9.firebasestorage.app',
  messagingSenderId: '797698767776',
  appId: '1:797698767776:web:b4ffd0cbea4472c76e02c5',
};

/* Your deployed Cloudflare Worker, no trailing slash.
   e.g. 'https://lockin-api.yourname.workers.dev' */
export const WORKER_URL = 'https://lockin-api.leydagrant.workers.dev';

/* The two people using this app. Fill in each uid after the account exists —
   Settings shows you your own uid once you are signed in. Everything is shared
   between these two accounts (progress photos and health documents excepted,
   which are private unless explicitly shared). */
export const MEMBERS = {
  'ktqSNUWrW4ZF5cH7wzOED362Saf1': { name: 'Grant', sex: 'male' },
  // Ashtin's uid goes here once she signs up. Until then the app simply has no
  // partner to show, which every screen already handles.
  // 'her-uid-here': { name: 'Ashtin', sex: 'female' },
};

/* Shared id for the couple document that holds challenges and weekly scores.
   Any stable string works; both accounts must use the same one. */
export const COUPLE_ID = 'lockin';
