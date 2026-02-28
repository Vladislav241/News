/*
 * CHECKNE Web App — state.js
 * UI config + app state + auth/billing state
 *
 * Split from the former monolithic app.js to keep responsibilities separated.
 * Keep files loaded in order (see index.html).
 */

// UI config
// If score < LOW_SCORE_THRESHOLD => dark card (as in the provided design). Easy to tweak.
const LOW_SCORE_THRESHOLD = 70;
let feedExpanded = false;
const FEED_PAGE_SIZE = 10; // показываем только первые 10 событий, остальное раскрывается кнопкой

// Cache last loaded lists so expand/collapse doesn't need a refetch.
let lastFeedItems = [];
let lastFavItems = [];

// "New" flame badge window (how long the item stays marked as new since first appearance)
const NEW_BADGE_WINDOW_MS = 60 * 60 * 1000; // 1 hour

// Used to avoid marking everything as new on the very first load.
let hasInitialFeedLoaded = false;
let currentFeedKey = "";

// ----------------------------
// Auth state (cookie-based)
// ----------------------------
let authState = {
  authenticated: false,
  user: null,
};

let _resetToken = "";

// ----------------------------
// Billing / Pricing (MVP)
// ----------------------------
let billingInterval = 'monthly';
let pendingCheckout = null; // { plan, interval }
let billingState = { plan: 'free', status: 'active', interval: 'monthly' };

function setFeedExpanded(v) {
  const target = !!v;
  const cardsEl = document.getElementById('cards');

  // Smooth transition: fade list out, swap content, fade back in.
  if (cardsEl) cardsEl.classList.add('is-fading');

  window.setTimeout(() => {
    feedExpanded = target;
    if (state.mode === 'feed') {
      renderCards(lastFeedItems, { incremental: false });
    } else if (state.mode === 'fav') {
      // Tracking doesn't use show more / hide, but keep it safe.
      renderCards(state.trackingItems || [], { incremental: false });
    } else {
      renderCards(lastFavItems, { incremental: false });
    }

    // Next frame: remove fade class so it animates back to normal.
    requestAnimationFrame(() => {
      const el = document.getElementById('cards');
      if (el) el.classList.remove('is-fading');
    });
  }, 120);
}


let state = {
  interests: ["general"],
  country: "world",
  language: "en",
  mode: "feed",
  q: "",
  cooldownUntil: 0,

  // UI preferences
  showThumbs: false,

  filters: {
    sortOrder: 'newest',
    minScore: 0,
    maxScore: 100,
    onlyConfirmed: false, // 2+ sources
    onlyAiSummary: false, // summary text present
  },
};

function qs(id) { return document.getElementById(id); }
function setStatus(text) { qs("status").textContent = text || ""; }
// Keep the page-transition backdrop from covering the footer
function updateFooterShadeGap(){
  const footer = document.querySelector('footer');
  if (!footer) return;
  const h = Math.ceil(footer.getBoundingClientRect().height || 0);
  // footer is intentionally covered during transitions
  document.documentElement.style.setProperty('--footer-h', '0px');
}
window.addEventListener('resize', updateFooterShadeGap, { passive: true });
window.addEventListener('orientationchange', updateFooterShadeGap, { passive: true });
window.addEventListener('load', ()=>{ requestAnimationFrame(updateFooterShadeGap); }, { passive: true });

