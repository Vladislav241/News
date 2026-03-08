/*
 * CHECKNE Web App — core.js
 * Config + utils + deep links + share modal + i18n
 *
 * Split from the former monolithic app.js to keep responsibilities separated.
 * Keep files loaded in order (see index.html).
 */

const API_BASE = ""; // same-origin

function isUrlQuery(q) {
  try {
    const s = String(q || "").trim();
    if (!s) return false;
    if (!(s.startsWith("http://") || s.startsWith("https://"))) return false;
    new URL(s);
    return true;
  } catch {
    return false;
  }
}


// --- Deep-link support (shared URLs) ---
// We keep the shared URL as /share/<id> for OG meta tags, but users get
// redirected to /?open=<id>&shared=1. Here we auto-open that card.
let pendingOpenClusterId = null;
let pendingOpenRequiresAuth = false; // true when coming from a shared link

function __checkneNormalizeStoryTitle(value) {
  return String(value || '')
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/[‘’´`]/g, "'")
    .replace(/[“”]/g, '"')
    .replace(/&amp;/gi, '&')
    .replace(/[^\p{L}\p{N}]+/gu, ' ')
    .trim()
    .toLowerCase();
}
window.__checkneNormalizeStoryTitle = __checkneNormalizeStoryTitle;

function __checkneFindCardInFeed({ clusterId = null, title = '' } = {}) {
  const cards = document.getElementById('cards');
  if (!cards) return null;
  if (clusterId != null && clusterId !== '' && !Number.isNaN(Number(clusterId))) {
    const exact = cards.querySelector(`.newsCard[data-id="${String(clusterId)}"], .newsCard[data-cluster-id="${String(clusterId)}"]`);
    if (exact) return exact;
  }

  const normalizedTitle = __checkneNormalizeStoryTitle(title);
  if (!normalizedTitle) return null;

  const list = Array.from(cards.querySelectorAll('.newsCard'));
  let best = null;
  let bestScore = -1;
  for (const card of list) {
    const cardNorm = String(card.getAttribute('data-title-normalized') || '').trim() || __checkneNormalizeStoryTitle(card.getAttribute('data-title') || card.querySelector('.newsTitle')?.textContent || '');
    if (!cardNorm) continue;
    if (cardNorm === normalizedTitle) return card;
    let score = -1;
    if (cardNorm.includes(normalizedTitle) || normalizedTitle.includes(cardNorm)) score = Math.min(cardNorm.length, normalizedTitle.length);
    else {
      const words = normalizedTitle.split(/\s+/).filter(Boolean);
      const hits = words.filter(w => w.length >= 4 && cardNorm.includes(w)).length;
      if (hits) score = hits;
    }
    if (score > bestScore) { bestScore = score; best = card; }
  }
  return bestScore > 0 ? best : null;
}

function __checkneOpenCardElement(card) {
  if (!card) return false;
  const details = card.querySelector('details.newsDetails');
  if (details && !details.open) {
    const body = details.querySelector('.newsOpenBody');
    if (body && typeof window.__checkneAnimateDetails === 'function') {
      try { window.__checkneAnimateDetails(details, body, true); } catch { details.open = true; }
    } else {
      details.open = true;
    }
  }
  try { card.scrollIntoView({ behavior: 'smooth', block: 'start' }); } catch { try { card.scrollIntoView(); } catch {} }
  card.classList.add('isDeepLinked');
  setTimeout(() => card.classList.remove('isDeepLinked'), 1600);
  return true;
}

async function openStoryInFeed({ clusterId = null, title = '' } = {}) {
  const found = __checkneFindCardInFeed({ clusterId, title });
  if (found) return __checkneOpenCardElement(found);
  if (clusterId != null && clusterId !== '' && !Number.isNaN(Number(clusterId))) {
    try {
      return await ensureItemInFeedAndOpen(Number(clusterId));
    } catch {}
  }
  return false;
}
window.openStoryInFeed = openStoryInFeed;
window.__checkneOpenStoryInFeed = openStoryInFeed;

function readDeepLinkParams() {
  try {
    const url = new URL(window.location.href);
    const open = url.searchParams.get('open');
    const shared = url.searchParams.get('shared');
    const id = open && /^\d+$/.test(open) ? Number(open) : null;
    return { id, shared: shared === '1' || shared === 'true' };
  } catch {
    return { id: null, shared: false };
  }
}

function clearDeepLinkParams() {
  try {
    const url = new URL(window.location.href);
    url.searchParams.delete('open');
    url.searchParams.delete('shared');
    window.history.replaceState({}, '', url.toString());
  } catch {}
}

function openCardInDOM(clusterId) {
  const card = __checkneFindCardInFeed({ clusterId });
  if (!card) return false;
  return __checkneOpenCardElement(card);
}

async function ensureItemInFeedAndOpen(clusterId) {
  // 1) If already rendered -> open
  if (openCardInDOM(clusterId)) return true;

  // 2) Try to fetch this single item and inject into current feed
  try {
    const interests = encodeURIComponent((state.interests || []).join(","));
    const country = encodeURIComponent(state.country || "world");
    const language = "all";
    const uiLang = encodeURIComponent(state.language || "en");
    const r = await fetch(
      `${API_BASE}/api/news/by_ids?ids=${encodeURIComponent(String(clusterId))}` +
        `&interests=${interests}&country=${country}&language=${language}&ui_lang=${uiLang}`
    );

    if (!r.ok) return false;
    const j = await r.json();
    const item = (j?.items && j.items[0]) ? j.items[0] : null;
    if (!item) return false;

    // Prepend and re-render (keep existing order after the injected item)
    const existing = Array.isArray(lastFeedItems) ? lastFeedItems : [];
    const seen = new Set([String(clusterId)]);
    const merged = [item];
    for (const it of existing) {
      const id = String(it?.cluster_id ?? it?.event_id ?? '');
      if (!id || seen.has(id)) continue;
      seen.add(id);
      merged.push(it);
    }
    lastFeedItems = merged;
    renderCards(merged, {
      nowTs: Date.now(),
      newIds: new Set(),
      suppressNewBadges: true,
      incremental: false,
      animate: false,
    });

    // Open after render
    return openCardInDOM(clusterId);
  } catch {
    return false;
  }
}

async function maybeOpenDeepLinkedArticle() {
  if (!pendingOpenClusterId) return;

  // If it is a shared link, require auth first (your requirement).
  if (pendingOpenRequiresAuth && !authState?.authenticated) {
    openAuthModal('login');
    return;
  }

  const id = pendingOpenClusterId;
  pendingOpenClusterId = null;
  pendingOpenRequiresAuth = false;

  await ensureItemInFeedAndOpen(id);
  clearDeepLinkParams();
}

// --- Share (OG card page) ---

async function shareCluster(item) {
  const id = item?.id ?? item?.cluster_id ?? item?.clusterId;
  if (!id) return;

  const baseUrl = location.origin;
  const updatedAt = item?.updated_at || item?.computed_at || item?.created_at || "";
  const v = updatedAt ? String(Date.parse(updatedAt) || Date.now()) : String(Date.now());

  const url = `${baseUrl}/share/${id}?v=${encodeURIComponent(v)}`;


  // Best practice: share the URL; social apps render the preview card via OG/Twitter meta tags.
  openShareModal({
    url,
    v,
    id,
    title: item?.title || 'CHECKNE.',
    score: item?.score ?? item?.trust_score ?? null,
    outlets: item?.sources_count ?? item?.outlet_count ?? null,
  });
}

function openShareModal(data) {
  const backdrop = document.getElementById('shareBackdrop');
  const closeBtn = document.getElementById('shareCloseBtn'); // may be null if removed in UI
  const noThanks = document.getElementById('shareNoThanks');
  const img = document.getElementById('sharePreviewImg');
  const headline = document.getElementById('shareHeadline');
  const toX = document.getElementById('shareToXBtn');
  const toThreads = document.getElementById('shareToThreadsBtn');
  const copyBtn = document.getElementById('shareCopyBtn');

  if (!backdrop || !img || !headline || !toX || !toThreads || !copyBtn) {
    // Safety fallback: just copy link
    return copyShareLink(data.url);
  }

  // Populate UI
  headline.textContent = data.title || 'Share';
  img.src = `/api/share-image/${encodeURIComponent(data.id)}.png?dpr=2&v=${encodeURIComponent(data.v || Date.now())}`;


  img.onerror = () => {
    // If image generator fails, still allow share
    img.removeAttribute('src');
    img.style.display = 'none';
  };

  const encodedUrl = encodeURIComponent(data.url);
  const tweetText = encodeURIComponent(`Trust score • ${data.title || 'CHECKNE.'}`);
  const xUrl = `https://twitter.com/intent/tweet?url=${encodedUrl}&text=${tweetText}`;

  toX.onclick = () => window.open(xUrl, '_blank', 'noopener,noreferrer');

  // Threads doesn't provide a fully reliable web intent. Best UX: open Threads and copy the link.
  toThreads.onclick = async () => {
    await copyShareLink(data.url);
    window.open('https://www.threads.net/', '_blank', 'noopener,noreferrer');
  };

  copyBtn.onclick = () => copyShareLink(data.url);

  const close = () => closeShareModal();
  if (closeBtn) closeBtn.onclick = close;
  if (noThanks) noThanks.onclick = close;
  if (noThanks) noThanks.onkeydown = (e)=>{ if(e.key==='Enter' || e.key===' ') close(); };

  backdrop.onclick = (e) => {
    if (e.target === backdrop) close();
  };

  document.addEventListener('keydown', function esc(e){
    if (e.key === 'Escape') {
      document.removeEventListener('keydown', esc);
      close();
    }
  });

  backdrop.classList.add('isOpen');
  backdrop.setAttribute('aria-hidden', 'false');
}

function closeShareModal(){
  const backdrop = document.getElementById('shareBackdrop');
  if (!backdrop) return;
  backdrop.classList.remove('isOpen');
  backdrop.setAttribute('aria-hidden', 'true');
}

async function copyShareLink(url){
  try{
    await navigator.clipboard.writeText(url);
    if (typeof toast === 'function') toast('Link copied');
    else alert('Link copied');
  }catch(e){
    prompt('Copy link:', url);
  }
}


const DEFAULT_INTERESTS = [
  "general",
  "business",
  "technology",
  "politics",
  "science",
  "sports",
  "health",
];

const STORAGE_KEY = "news_prefs_v1";
const FAV_KEY = "news_favs_v1";
const DEVICE_KEY = "news_device_id_v1";
const SEEN_KEY = "news_seen_state_v1";
const TRACKING_DELTA_KEY = "news_tracking_deltas_v1";
const TRACKING_HISTORY_KEY = "news_tracking_history_v1";
const FILTERS_KEY = "news_filters_v1";
const THUMBS_KEY = "news_thumbs_v1";

// ---------------------------------
// Scoped storage (per-account safely)
// ---------------------------------
// Problem this solves:
// - Without scoping, localStorage favorites/seen/deltas leak between accounts
//   on the same device and can even overwrite another user's server favorites.
//
// We scope ONLY tracking-related keys (favorites + seen/deltas).
// Preferences/filters stay per-device.

function __isAuthed() {
  try {
    if (typeof authState !== 'undefined' && authState && authState.authenticated) return true;
  } catch {}
  try { return document.documentElement?.dataset?.authed === '1'; } catch {}
  return false;
}

function __userStorageId() {
  try {
    const u = (typeof authState !== 'undefined' && authState) ? (authState.user || null) : null;
    const id = u?.id ?? u?.user_id ?? null;
    if (id !== null && id !== undefined && String(id).trim()) return String(id).trim();
    const email = (u?.email || '').trim().toLowerCase();
    if (email) return email;
  } catch {}
  return '';
}

function getDeviceId() {
  try {
    let id = localStorage.getItem(DEVICE_KEY);
    if (id && String(id).trim()) return String(id);
    // Simple random id; good enough for storage scoping.
    id = (Math.random().toString(36).slice(2) + Date.now().toString(36)).slice(0, 20);
    localStorage.setItem(DEVICE_KEY, id);
    return id;
  } catch {
    return 'device';
  }
}

function scopedKey(baseKey, scope = null) {
  // explicit scope (used for migrations)
  const s = scope || (__isAuthed() ? (`u:${__userStorageId()}`) : (`g:${getDeviceId()}`));
  return `${baseKey}__${s}`;
}

function migrateScopedKey(baseKey, fromScope, toScope) {
  // Move baseKey__fromScope -> baseKey__toScope if target doesn't exist.
  try {
    const fromK = scopedKey(baseKey, fromScope);
    const toK = scopedKey(baseKey, toScope);
    if (localStorage.getItem(toK) != null) return;
    const val = localStorage.getItem(fromK);
    if (val == null) return;
    localStorage.setItem(toK, val);
    localStorage.removeItem(fromK);
  } catch {}
}

function readJSONStorage(key, fallback) {
  try {
    const raw = localStorage.getItem(key);
    if (!raw) return fallback;
    return JSON.parse(raw);
  } catch {
    return fallback;
  }
}

function writeJSONStorage(key, value) {
  try { localStorage.setItem(key, JSON.stringify(value)); } catch {}
}

// Convenience helpers for tracking-related keys
function getScopedFavKey() { return scopedKey(FAV_KEY, __isAuthed() ? (`u:${__userStorageId()}`) : null); }
function getScopedSeenKey() { return scopedKey(SEEN_KEY, __isAuthed() ? (`u:${__userStorageId()}`) : null); }
function getScopedDeltaKey() { return scopedKey(TRACKING_DELTA_KEY, __isAuthed() ? (`u:${__userStorageId()}`) : null); }
function getScopedHistoryKey() { return scopedKey(TRACKING_HISTORY_KEY, __isAuthed() ? (`u:${__userStorageId()}`) : null); }

// Guest keys are still used ONLY for a one-time migration into the first login.
function getGuestScope() { return `g:${getDeviceId()}`; }
function getUserScope() { return __isAuthed() ? (`u:${__userStorageId()}`) : ''; }

// ----------------------
// i18n (UI + AI summaries)
// ----------------------
const SUPPORTED_LANGS = ["en", "de", "fr"]; // "uk" == Ukrainian (UA label in UI)

function normalizeLang(code) {
  const raw = String(code || "").trim().toLowerCase();
  if (!raw) return "en";
  const base = raw.split("-")[0];
  //if (base === "ua") return "uk";
  if (SUPPORTED_LANGS.includes(base)) return base;
  // common fallbacks
  if (base === "gb") return "en";
  return "en";
}

function detectBrowserLang() {
  const langs = (navigator.languages && navigator.languages.length ? navigator.languages : [navigator.language]).filter(Boolean);
  for (const l of langs) {
    const n = normalizeLang(l);
    if (SUPPORTED_LANGS.includes(n)) return n;
  }
  return "en";
}

let I18N_LANG = "en";
let I18N_DICT = null;

async function loadI18n(lang) {
  const n = normalizeLang(lang);
  if (I18N_DICT && I18N_LANG === n) return;
  try {
    const r = await fetch(`${API_BASE}/static/i18n/${encodeURIComponent(n)}.json`, { cache: "no-store" });
    if (!r.ok) throw new Error("i18n fetch failed");
    I18N_DICT = await r.json();
    I18N_LANG = n;
    document.documentElement.setAttribute("lang", n);
  } catch (e) {
    // hard fallback to EN if file missing
    if (n !== "en") return loadI18n("en");
  }
}

function t(key, fallback = "") {
  try {
    const parts = String(key).split(".");
    let cur = I18N_DICT;
    for (const p of parts) cur = cur?.[p];
    if (typeof cur === "string") return cur;
  } catch {}
  return fallback || key;
}

function applyI18nToDOM() {
  document.querySelectorAll("[data-i18n]").forEach((el) => {
    const k = el.getAttribute("data-i18n");
    if (!k) return;
    el.textContent = t(k, el.textContent || "");
  });
  document.querySelectorAll("[data-i18n-html]").forEach((el) => {
    const k = el.getAttribute("data-i18n-html");
    if (!k) return;
    el.innerHTML = t(k, el.innerHTML || "");
  });
  document.querySelectorAll("[data-i18n-placeholder]").forEach((el) => {
    const k = el.getAttribute("data-i18n-placeholder");
    if (!k) return;
    el.setAttribute("placeholder", t(k, el.getAttribute("placeholder") || ""));
  });
  document.querySelectorAll("[data-i18n-aria]").forEach((el) => {
    const k = el.getAttribute("data-i18n-aria");
    if (!k) return;
    el.setAttribute("aria-label", t(k, el.getAttribute("aria-label") || ""));
  });
  document.querySelectorAll("[data-i18n-title]").forEach((el) => {
    const k = el.getAttribute("data-i18n-title");
    if (!k) return;
    el.setAttribute("title", t(k, el.getAttribute("title") || ""));
  });
}

async function setLanguage(lang, { persist = true, refetch = true } = {}) {
  state.language = normalizeLang(lang);

  // UI texts
  await loadI18n(state.language);
  applyI18nToDOM();


  // Update controls
  const sel = document.getElementById("language");
  if (sel) sel.value = state.language;

  // Re-render UI bits
  renderTags();
  syncThumbToggleUI();

  if (persist) savePrefs();

  // ✅ Главное: язык влияет на перевод заголовков/summary на сервере -> надо перезапросить ленту
  if (refetch) {
    setFeedExpanded(false);
    // чтобы точно не было "инкрементального" мусора
    lastFeedItems = [];
    feedRenderedSet = new Set();
    feedRenderedOrder = [];
    await fetchFeed({ reset: true });
  }
}




// =========================
// Premium upgrade modal (Tracking limit)
// =========================
(function(){
  function _planLabel(p){
    const s = String(p||'free').toLowerCase();
    if(s==='analyst') return 'Analyst';
    if(s==='pro') return 'Pro';
    return 'Free';
  }
  function _recommend(plan){
    const p = String(plan||'free').toLowerCase();
    if(p==='free') return 'pro';
    if(p==='pro') return 'analyst';
    return null;
  }

  function closeUpgradeModal(){
    const m = document.getElementById('upgradeModal');
    if(!m) return;
    m.classList.remove('is-open');
    m.setAttribute('aria-hidden','true');
    document.body.classList.remove('ckModalOpen');
  }

  function openUpgradeModal(opts){
    const m = document.getElementById('upgradeModal');
    if(!m) return;

    const plan = (opts && opts.plan) ? String(opts.plan).toLowerCase() : (billingState?.plan || 'free');
    const max  = (opts && Object.prototype.hasOwnProperty.call(opts,'max')) ? opts.max : null;

    const reco = (opts && opts.recommend) ? String(opts.recommend).toLowerCase() : _recommend(plan);
    const planLabel = _planLabel(plan);
    const recoLabel = reco ? _planLabel(reco) : '—';

    const titleEl = document.getElementById('upgradeModalTitle');
    const descEl  = document.getElementById('upgradeModalDesc');
    const eyebrow = document.getElementById('upgradeModalEyebrow');
    const planPill = document.getElementById('upgradeModalPlanPill');
    const limitEl = document.getElementById('upgradeModalLimit');
    const recoPill = document.getElementById('upgradeModalRecoPill');
    const cta = document.getElementById('upgradeModalCta');

    if(eyebrow) eyebrow.textContent = 'Tracking limit reached';

    if(titleEl){
      if(reco){
        titleEl.textContent = `Upgrade to ${_planLabel(reco)}`;
      }else{
        titleEl.textContent = 'Tracking limit reached';
      }
    }

    if(descEl){
      if(reco){
        descEl.textContent = `You’ve hit your ${planLabel} limit. Upgrade to ${_planLabel(reco)} to track more stories without removing anything.`;
      }else{
        descEl.textContent = `You’ve hit your current plan limit.`;
      }
    }

    if(planPill) planPill.textContent = planLabel;
    if(recoPill) recoPill.textContent = recoLabel;

    if(limitEl){
      if(max === null || typeof max === 'undefined'){
        limitEl.textContent = '—';
      }else if(max === 0){
        limitEl.textContent = '0';
      }else if(max === -1){
        limitEl.textContent = 'Unlimited';
      }else{
        limitEl.textContent = (max === null) ? 'Unlimited' : String(max);
      }
      if(max === null) limitEl.textContent = 'Unlimited';
    }

    if(cta){
      cta.textContent = reco ? `See ${_planLabel(reco)} plans` : 'See plans';
      cta.onclick = ()=> {
        closeUpgradeModal();
        try{
          // Prefer existing router if present
          if(typeof window.__setMainPage === 'function'){
            window.history.pushState({}, '', '/pricing');
            window.__setMainPage('pricing');
          }else{
            window.location.href = '/pricing';
          }
        }catch{
          window.location.href = '/pricing';
        }
      };
    }

    // Open
    m.classList.add('is-open');
    m.setAttribute('aria-hidden','false');
    document.body.classList.add('ckModalOpen');

    // close handlers
    const closers = m.querySelectorAll('[data-ck-close="1"]');
    closers.forEach(el => {
      el.onclick = (e)=>{ e.preventDefault(); closeUpgradeModal(); };
    });

    // Escape key
    function onKey(e){
      if(e.key === 'Escape'){
        closeUpgradeModal();
        window.removeEventListener('keydown', onKey, true);
      }
    }
    window.addEventListener('keydown', onKey, true);
  }

  window.openUpgradeModal = openUpgradeModal;
  window.closeUpgradeModal = closeUpgradeModal;
})();

document.addEventListener('click', async (e) => {
  const link = e.target && typeof e.target.closest === 'function'
    ? e.target.closest('[data-open-feed-title], [data-open-feed-cluster-id], a[href^="#open-feed"]')
    : null;
  if (!link) return;
  e.preventDefault();
  e.stopPropagation();
  const clusterId = link.getAttribute('data-open-feed-cluster-id') || link.getAttribute('data-cluster-id') || null;
  const title = link.getAttribute('data-open-feed-title') || link.getAttribute('data-title') || link.textContent || '';
  try {
    await openStoryInFeed({ clusterId, title });
  } catch {}
}, { capture: true });