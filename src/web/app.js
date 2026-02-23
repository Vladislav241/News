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
  const cards = document.getElementById('cards');
  if (!cards) return false;
  const card = cards.querySelector(`.newsCard[data-id="${String(clusterId)}"]`);
  if (!card) return false;
  const details = card.querySelector('details.newsDetails');
  if (details) details.open = true;
  // Scroll the opened card into view (nicely)
  try {
    card.scrollIntoView({ behavior: 'smooth', block: 'start' });
  } catch {
    card.scrollIntoView();
  }
  // Brief highlight so user notices the opened item
  card.classList.add('isDeepLinked');
  setTimeout(() => card.classList.remove('isDeepLinked'), 1400);
  return true;
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
  document.querySelectorAll("[data-i18n-placeholder]").forEach((el) => {
    const k = el.getAttribute("data-i18n-placeholder");
    if (!k) return;
    el.setAttribute("placeholder", t(k, el.getAttribute("placeholder") || ""));
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

// =========================
// Premium mode transition (Feed <-> Tracking) + swipe navigation
// =========================
let __modeAnimating = false;
let __modeLastTarget = null;

function _sleep(ms){ return new Promise(r=>setTimeout(r, ms)); }

function beginModeTransition(toMode){
  const wrap = qs('feedView');
  if(!wrap) return;
  __modeLastTarget = toMode;
  document.body.classList.add('view-switching');
  wrap.classList.remove('page-in','page-transition','to-feed','to-tracking');
  wrap.classList.add('page-transition', (toMode === 'fav') ? 'to-tracking' : 'to-feed');
}



function endModeTransition(){
  const wrap = qs('feedView');
  if(!wrap) return;

  // Apple-like “sheet/page” entrance: minimal, smooth, spring-ish easing.
  const enteringFromRight = (__modeLastTarget === 'fav');

  // Small offset + tiny scale for depth (no blur/3D rotate).
  const startX = enteringFromRight ? '36px' : '-36px';

  // Set start state (no transition)
  wrap.classList.add('page-in');
  wrap.style.transition = 'none';
  wrap.style.transform = `translate3d(${startX},0,0) scale(.985)`;
  wrap.style.opacity = '0';

  // Next frame -> let CSS transitions take over (to normal)
  requestAnimationFrame(()=>{
    wrap.style.transition = '';
    wrap.style.transform = '';
    wrap.style.opacity = '';
  });

  window.setTimeout(()=>{
    wrap.classList.remove('page-in','page-transition','to-feed','to-tracking');
    wrap.style.transition = '';
    wrap.style.transform = '';
    wrap.style.opacity = '';
    document.body.classList.remove('view-switching');
  }, 560);
}

async function switchMode(targetMode){
  if(__modeAnimating) return;
  if(state.mode === targetMode) return;

  __modeAnimating = true;


  try{
    // 1) “page out” анимация
    beginModeTransition(targetMode);
    await _sleep(140);

    // 2) меняем режим
    state.mode = targetMode;

    // 3) ВАЖНО: переносим cards туда, где они должны быть
    // Если у тебя нет новых mounts (cardsMountFeed/cardsMountTracking) — просто пропусти.
    // Но если ты делал разметку как я писал раньше — это MUST.
    const cards = document.getElementById("cards");
    const feedMount = document.getElementById("cardsMountFeed");
    const trackMount = document.getElementById("cardsMountTracking");

    if (cards && feedMount && trackMount) {
      if (targetMode === "fav") trackMount.appendChild(cards);
      else feedMount.appendChild(cards);
    }

    // 4) обновляем UI + грузим данные
    applyTabs();

    if(targetMode === 'fav'){
      await fetchFavorites();
    } else {
      // IMPORTANT: when returning from Tracking -> Feed we must fully reset the cards DOM.
      // Otherwise incremental rendering can keep Tracking-only blocks (graph/drag UI) in the feed
      // until a hard reload.
      await fetchFeed({ quiet: true, reset: true });
    }


    // 6) “page in” анимация
    endModeTransition();

    // 6) скролл вверх
    window.scrollTo({ top: 0, behavior: 'smooth' });

  } finally {
    window.setTimeout(()=>{ __modeAnimating = false; }, 180);
  }
}


function setupSwipeNavigation(){
  const wrap = qs('feedView');
  if(!wrap) return;

  const shade = document.getElementById('viewShade');

  let startX = 0, startY = 0, dx = 0, dy = 0, active = false;
  let dragging = false;
  const MAX_PULL = 220; // px (bigger = more “page” movement)

  function clamp(n, a, b){ return Math.max(a, Math.min(b, n)); }

  function resetInline(){
    wrap.classList.remove('gesture-dragging');
    wrap.style.transform = '';
    wrap.style.opacity = '';
    wrap.style.filter = '';
    wrap.style.transition = '';
    document.body.classList.remove('view-switching');
    if(shade) shade.style.opacity = '';
  }

  wrap.addEventListener('touchstart', (e)=>{
    if(!e.touches || !e.touches[0]) return;
    active = true;
    dragging = false;
    startX = e.touches[0].clientX;
    startY = e.touches[0].clientY;
    dx = dy = 0;
  }, { passive: true });

  // NOTE: passive:false so we can preventDefault when it's a horizontal swipe
  wrap.addEventListener('touchmove', (e)=>{
    if(!active || !e.touches || !e.touches[0]) return;
    dx = e.touches[0].clientX - startX;
    dy = e.touches[0].clientY - startY;

    // Decide when this becomes a horizontal gesture (don't fight vertical scroll)
    if(!dragging){
      if(Math.abs(dx) < 12) return;
      if(Math.abs(dx) < Math.abs(dy)) return;
      dragging = true;
      wrap.classList.add('gesture-dragging');
      document.body.classList.add('view-switching');
    }

    if(dragging){
      e.preventDefault();
      const pull = clamp(dx, -MAX_PULL, MAX_PULL);
      const t = Math.min(1, Math.abs(pull) / MAX_PULL);
      const dir = pull < 0 ? -1 : 1;
      // Live feedback: iOS-like slide + tiny scale + subtle lift (premium, not flashy)
      const scale = 1 - t * 0.018;
      const lift = (t * 6).toFixed(1);
      wrap.style.transform = `translate3d(${pull}px, ${lift}px, 0) scale(${scale})`;
      wrap.style.opacity = String(1 - t*0.06);
      wrap.style.filter = '';
      if(shade){
        shade.style.opacity = String(Math.min(1, 0.15 + t*0.55));
      }
    }
  }, { passive: false });

  wrap.addEventListener('touchend', ()=>{
    if(!active) return;
    active = false;

    const isHorizontal = dragging && (Math.abs(dx) >= 90) && (Math.abs(dx) > Math.abs(dy));

    // If not a committed swipe -> snap back smoothly
    if(!isHorizontal){
      if(dragging){
        wrap.style.transition = 'transform 260ms cubic-bezier(0.22,1,0.36,1), opacity 260ms cubic-bezier(0.22,1,0.36,1)';
        wrap.style.transform = 'translate3d(0,0,0) scale(1)';
        wrap.style.opacity = '1';
        wrap.style.filter = '';
        window.setTimeout(resetInline, 240);
      }
      dragging = false;
      return;
    }

    // Commit swipe
    resetInline();
    dragging = false;

    if(dx < 0){
      // swipe left -> Tracking
      switchMode('fav');
    }else{
      // swipe right -> Feed
      switchMode('feed');
    }
  }, { passive: true });

  wrap.addEventListener('touchcancel', ()=>{
    active = false;
    dragging = false;
    resetInline();
  }, { passive: true });
}

function escapeHtml(s) {
  return (s || "").replace(/[&<>"']/g, (c) => ({
    "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;",
  }[c]));
}

function getDeviceId() {
  let id = localStorage.getItem(DEVICE_KEY);
  if (!id) {
    id = (crypto.randomUUID ? crypto.randomUUID() : String(Date.now()) + Math.random());
    localStorage.setItem(DEVICE_KEY, id);
  }
  return id;
}
const DEVICE_ID = getDeviceId();

// Feed policy: when sorting by "Newest", push low-credibility items to the bottom
// so the top of the list stays "confirmed".
const CONFIRMED_SCORE_THRESHOLD = 55;

function loadPrefs() {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return;
    const p = JSON.parse(raw);
    // Keep interests deterministic & deduplicated (prevents duplicate chips like "technology" twice)
    const ints = Array.isArray(p.interests) ? p.interests : state.interests;
    state.interests = [...new Set(ints.map(String))].filter(Boolean);
    state.country = p.country || state.country;
    state.language = p.language || state.language;
  } catch {}
}

function savePrefs() {
  const interests = [...new Set((state.interests || []).map(String))].filter(Boolean);
  localStorage.setItem(STORAGE_KEY, JSON.stringify({
    interests,
    country: state.country,
    language: state.language,
  }));
}

function loadFilters() {
  try {
    const raw = localStorage.getItem(FILTERS_KEY);
    if (!raw) return;
    const f = JSON.parse(raw);
    const so = String(f.sortOrder || 'newest');
    state.filters.sortOrder = (so === 'low' || so === 'high' || so === 'newest') ? so : 'newest';
    state.filters.minScore = clamp(Number(f.minScore ?? 0), 0, 100);
    state.filters.maxScore = clamp(Number(f.maxScore ?? 100), 0, 100);
    state.filters.onlyConfirmed = !!f.onlyConfirmed;
    state.filters.onlyAiSummary = !!f.onlyAiSummary;
  } catch {}
}

function saveFilters() {
  localStorage.setItem(FILTERS_KEY, JSON.stringify(state.filters));
}

function loadThumbPrefs() {
  try {
    const raw = localStorage.getItem(THUMBS_KEY);
    if (raw === null) return;
    state.showThumbs = raw === '1' || raw === 'true';
  } catch {}
}

function saveThumbPrefs() {
  try {
    localStorage.setItem(THUMBS_KEY, state.showThumbs ? '1' : '0');
  } catch {}
}

function applyFiltersUIToState() {
  const minEl = qs('scoreMin');
  const maxEl = qs('scoreMax');
  const minV = clamp(Number(minEl ? minEl.value : 0), 0, 100);
  const maxV = clamp(Number(maxEl ? maxEl.value : 100), 0, 100);

  // Ensure min <= max
  const a = Math.min(minV, maxV);
  const b = Math.max(minV, maxV);

  state.filters.minScore = a;
  state.filters.maxScore = b;
  if (minEl) minEl.value = String(a);
  if (maxEl) maxEl.value = String(b);

  const checked = document.querySelector('input[name="sortOrder"]:checked');
  const so = String(checked ? checked.value : 'newest');
  state.filters.sortOrder = (so === 'low' || so === 'high' || so === 'newest') ? so : 'newest';

  const label = qs('sortBtnValue');
  if (label) {
    label.textContent = (state.filters.sortOrder === 'newest') ? 'Newest'
      : (state.filters.sortOrder === 'low') ? 'Low to High'
      : 'High to Low';
  }

  // Extra filters
  const onlyConfirmedEl = qs('onlyConfirmed');
  const onlyAiSummaryEl = qs('onlyAiSummary');
  state.filters.onlyConfirmed = !!(onlyConfirmedEl && onlyConfirmedEl.checked);
  state.filters.onlyAiSummary = !!(onlyAiSummaryEl && onlyAiSummaryEl.checked);

  saveFilters();
}

function syncFiltersStateToUI() {
  const minEl = qs('scoreMin');
  const maxEl = qs('scoreMax');
  if (minEl) minEl.value = String(clamp(Number(state.filters.minScore ?? 0), 0, 100));
  if (maxEl) maxEl.value = String(clamp(Number(state.filters.maxScore ?? 100), 0, 100));

  const so = String(state.filters.sortOrder || 'newest');
  const input = document.querySelector('input[name="sortOrder"][value="' + so + '"]');
  if (input) input.checked = true;

  const label = qs('sortBtnValue');
  if (label) {
    label.textContent = (so === 'newest') ? 'Newest' : (so === 'low') ? 'Low to High' : 'High to Low';
  }

  const onlyConfirmedEl = qs('onlyConfirmed');
  const onlyAiSummaryEl = qs('onlyAiSummary');
  if (onlyConfirmedEl) onlyConfirmedEl.checked = !!state.filters.onlyConfirmed;
  if (onlyAiSummaryEl) onlyAiSummaryEl.checked = !!state.filters.onlyAiSummary;
}

function syncThumbToggleUI() {
  const el = document.getElementById("thumbToggle");
  if (!el) return;

  // Checkbox switch (same style as email toggle)
  el.checked = !!state.showThumbs;

  const label = document.querySelector(".thumbToggleLabel");
  if (label) {
    label.textContent = state.showThumbs ? t("ui.hide_thumbs","Hide thumbnails") : t("ui.show_thumbs","Show thumbnails");
  }
}

function getFavIds() {
  try {
    const raw = localStorage.getItem(FAV_KEY);
    const arr = raw ? JSON.parse(raw) : [];
    const ids = Array.isArray(arr) ? arr.map((x) => Number(x)).filter((x) => Number.isFinite(x)) : [];
    return [...new Set(ids)];
  } catch { return []; }
}

function setFavIds(ids) {
  const uniq = [...new Set((ids || []).map((x) => Number(x)).filter((x) => Number.isFinite(x)))];
  localStorage.setItem(FAV_KEY, JSON.stringify(uniq));
  // legacy counter (hidden)
  const favCountEl = document.getElementById("favCount");
  if (favCountEl) favCountEl.textContent = String(uniq.length);

  // new header badge
  const trackingCountEl = document.getElementById("trackingCount");
  if (trackingCountEl) trackingCountEl.textContent = String(uniq.length);
}

function isFav(id) { return getFavIds().includes(Number(id)); }

function toggleFav(id) {
  if (!authState.authenticated) {
    openAuthModal('tracking');
    return isFav(id);
  }
  id = Number(id);
  const ids = getFavIds();
  if (ids.includes(id)) {
    setFavIds(ids.filter((x) => x !== id));
    syncFavoritesToServer().catch(() => {});
    return false;
  } else {
    ids.unshift(id);
    setFavIds(ids);
    syncFavoritesToServer().catch(() => {});
    return true;
  }
}

function removeFav(id) {
  if (!authState.authenticated) {
    openAuthModal('tracking');
    return false;
  }
  // getFavIds() returns numeric ids; keep comparisons numeric
  id = Number(id);
  const ids = getFavIds();
  if (!ids.includes(id)) return false;
  setFavIds(ids.filter((x) => x !== id));
  syncFavoritesToServer().catch(() => {});
  return true;
}

function loadSeenState() {
  try { return JSON.parse(localStorage.getItem(SEEN_KEY) || "{}") || {}; }
  catch { return {}; }
}
function saveSeenState(obj) { localStorage.setItem(SEEN_KEY, JSON.stringify(obj || {})); }
// --- Tracking delta persistence ---
// We keep the latest non-zero delta received from the server and keep showing it
// until the user opens the card (so the indicator doesn't disappear on refresh).
function loadTrackingDeltaState() {
  try { return JSON.parse(localStorage.getItem(TRACKING_DELTA_KEY) || "{}") || {}; }
  catch { return {}; }
}
function saveTrackingDeltaState(obj) {
  try { localStorage.setItem(TRACKING_DELTA_KEY, JSON.stringify(obj || {})); }
  catch {}
}


// --- Trust score history (server-side, per cluster) ---
// History points are stored on the backend (PostgreSQL) so they are stable across devices.
const TRUST_HISTORY_CACHE = new Map(); // clusterId -> { items, fetchedAt }
async function fetchTrustHistory(clusterId, limit = 60) {
  const cid = Number(clusterId);
  if (!Number.isFinite(cid)) return [];

  const cached = TRUST_HISTORY_CACHE.get(cid);
  // short cache (20s) to avoid spamming when user opens/closes cards
  if (cached && (Date.now() - cached.fetchedAt) < 20_000) return cached.items || [];

  try {
    const r = await fetch(`/api/trust-history/${cid}?limit=${encodeURIComponent(String(limit))}`, {
      credentials: 'include'
    });
    const data = await r.json().catch(() => ({}));
    const items = Array.isArray(data.items) ? data.items : [];
    TRUST_HISTORY_CACHE.set(cid, { items, fetchedAt: Date.now() });
    return items;
  } catch {
    return cached?.items || [];
  }
}


// Build SVG line chart for trust score history (0..100)
function _monotoneXToBezierPath(coords) {
  // Monotone cubic interpolation in X (like d3.curveMonotoneX)
  // Prevents overshoot/loops and avoids the line 'going backwards'.
  if (!coords || coords.length < 2) return '';
  const pts = coords;
  if (pts.length === 2) {
    const a = pts[0], b = pts[1];
    return `M ${a.x.toFixed(2)} ${a.y.toFixed(2)} L ${b.x.toFixed(2)} ${b.y.toFixed(2)}`;
  }

  // Ensure increasing X (fallback: sort + stable tie-break)
  const sorted = pts.slice().sort((a, b) => (a.x - b.x) || (a.y - b.y));

  const n = sorted.length;
  const dx = new Array(n - 1);
  const dy = new Array(n - 1);
  const slope = new Array(n - 1);
  for (let i = 0; i < n - 1; i++) {
    dx[i] = sorted[i + 1].x - sorted[i].x;
    dy[i] = sorted[i + 1].y - sorted[i].y;
    slope[i] = dx[i] ? (dy[i] / dx[i]) : 0;
  }

  // Tangents
  const m = new Array(n);
  m[0] = slope[0];
  for (let i = 1; i < n - 1; i++) m[i] = (slope[i - 1] + slope[i]) / 2;
  m[n - 1] = slope[n - 2];

  // Fritsch–Carlson adjustment (keeps the curve from overshooting)
  for (let i = 0; i < n - 1; i++) {
    if (slope[i] === 0) {
      m[i] = 0;
      m[i + 1] = 0;
      continue;
    }
    const a = m[i] / slope[i];
    const b = m[i + 1] / slope[i];
    const h = Math.hypot(a, b);
    if (h > 3) {
      const t = 3 / h;
      m[i] = t * a * slope[i];
      m[i + 1] = t * b * slope[i];
    }
  }

  let d = `M ${sorted[0].x.toFixed(2)} ${sorted[0].y.toFixed(2)}`;
  for (let i = 0; i < n - 1; i++) {
    const p0 = sorted[i];
    const p1 = sorted[i + 1];
    const h = (p1.x - p0.x);
    const c1x = p0.x + h / 3;
    const c1y = p0.y + m[i] * h / 3;
    const c2x = p1.x - h / 3;
    const c2y = p1.y - m[i + 1] * h / 3;
    d += ` C ${c1x.toFixed(2)} ${c1y.toFixed(2)} ${c2x.toFixed(2)} ${c2y.toFixed(2)} ${p1.x.toFixed(2)} ${p1.y.toFixed(2)}`;
  }
  return d;
}

function _fmtTickDate(ts) {
  try {
    const d = new Date(ts);
    // like "07 Feb"
    return d.toLocaleDateString('en-US', { day: '2-digit', month: 'short' });
  } catch {
    return '';
  }
}

let _trustChartUid = 0;

function buildTrustHistorySvg(points) {
  const ptsRaw = Array.isArray(points) ? points : [];
  if (!ptsRaw.length) return '';

  // Sort by timestamp so the line never jumps 'back in time'.
  // Also drop invalid timestamps.
  const pts = ptsRaw
    .map(p => ({ ...p, _t: Date.parse(p.ts) }))
    .filter(p => Number.isFinite(p._t))
    .sort((a, b) => a._t - b._t);
  if (!pts.length) return '';

  const isSmall = (typeof window !== 'undefined' && window.matchMedia && window.matchMedia('(max-width: 720px)').matches);
  const W = isSmall ? 560 : 620;
  const H = isSmall ? 220 : 260;
  // Tighter left padding so the chart + stats block can sit closer to the left edge.
  const padL = isSmall ? 40 : 44, padR = 18, padT = 18, padB = isSmall ? 32 : 36;

  const tsVals = pts.map(p => Date.parse(p.ts)).filter(Number.isFinite);
  const minT = tsVals.length ? Math.min(...tsVals) : Date.now();
  const maxT = tsVals.length ? Math.max(...tsVals) : minT;

  function xFor(ts) {
    const t = Date.parse(ts);
    if (!Number.isFinite(t) || maxT === minT) return padL + (W - padL - padR) / 2;
    return padL + ((t - minT) / (maxT - minT)) * (W - padL - padR);
  }
  function yFor(score) {
    // Fixed axis like in the reference: 40..100 with evenly spaced ticks.
    const MIN_Y = 40;
    const MAX_Y = 100;
    const sRaw = Number(score);
    const s = Math.max(MIN_Y, Math.min(MAX_Y, Number.isFinite(sRaw) ? sRaw : MIN_Y));
    return padT + ((MAX_Y - s) / (MAX_Y - MIN_Y)) * (H - padT - padB);
  }

  const gridYs = [100, 80, 60, 40];
  const grid = gridYs.map((v) => {
    const y = yFor(v);
    return `
      <line class="gridLine" x1="${padL}" y1="${y}" x2="${W - padR}" y2="${y}"></line>
      <text x="${padL - 8}" y="${y + 4}" text-anchor="end">${v}</text>
    `;
  }).join('');

  const coords = pts.map((p) => ({ x: xFor(p.ts), y: yFor(p.score), meta: p }));
  // Monotone curve (no overshoot, no backtracking)
  const pathD = _monotoneXToBezierPath(coords);

  const uid = (++_trustChartUid);
  const clipId = `trustClip_${uid}`;

  // x-axis ticks: time-based + collision-avoidance (prevents label stacking)
  const maxTickCount = isSmall ? 4 : 5;
  const minPx = isSmall ? 78 : 92;

  const tickTimes = [];
  if (maxT === minT) {
    tickTimes.push(minT);
  } else {
    for (let i = 0; i < maxTickCount; i++) {
      const t = minT + (i / (maxTickCount - 1)) * (maxT - minT);
      tickTimes.push(t);
    }
  }

  const ticks = [];
  let lastX = -Infinity;
  let lastLabel = null;
  for (const t of tickTimes) {
    const x = padL + ((t - minT) / (maxT - minT || 1)) * (W - padL - padR);
    const label = _fmtTickDate(t);
    if (!label) continue;
    if (label === lastLabel) continue;
    if (x - lastX < minPx) continue;
    ticks.push({ x, label });
    lastX = x;
    lastLabel = label;
  }

  // Always keep first + last visible
  if (ticks.length >= 2) {
    ticks[0].x = padL;
    ticks[ticks.length - 1].x = W - padR;
  } else if (ticks.length === 1) {
    ticks[0].x = padL + (W - padL - padR) / 2;
  } else {
    ticks.push({ x: padL + (W - padL - padR) / 2, label: _fmtTickDate(minT) });
  }

  const xTicks = ticks.map((t) => {
    return `
      <text class="xTick" x="${t.x.toFixed(2)}" y="${(H - 10).toFixed(2)}" text-anchor="middle">${escapeHtml(t.label)}</text>
    `;
  }).join('');

  const circles = coords.map((c, i) => {
    const meta = {
      ts: c.meta.ts,
      score: c.meta.score,
      sources_added: c.meta.sources_added ?? 0,
      sources_count: c.meta.sources_count ?? null,
      idx: i,
    };
    const enc = encodeURIComponent(JSON.stringify(meta));
    return `
      <g class="pt" data-meta="${enc}">
        <circle class="ptHalo" cx="${c.x}" cy="${c.y}" r="0"></circle>
        <circle class="ptDot" cx="${c.x}" cy="${c.y}" r="9"></circle>
      </g>
    `;
  }).join('');

  const plotX = padL;
  const plotY = padT;
  const plotW = (W - padL - padR);
  const plotH = (H - padT - padB);

  return `
  <svg class="trustChartSvg" viewBox="0 0 ${W} ${H}" width="100%" height="260" role="img" aria-label="Trust score history chart"
       data-plot-left="${plotX}" data-plot-right="${plotX + plotW}" data-view-w="${W}" data-view-h="${H}">
    <defs>
      <clipPath id="${clipId}">
        <rect x="${plotX}" y="${plotY}" width="${plotW}" height="${plotH}" rx="12" ry="12"></rect>
      </clipPath>
    </defs>

    ${grid}
    <line class="axisLine" x1="${padL}" y1="${padT}" x2="${padL}" y2="${H - padB}"></line>

    <!-- Pan/zoom gesture layer (behind dots) -->
    <rect class="trustPanLayer" x="${plotX}" y="${plotY}" width="${plotW}" height="${plotH}" fill="transparent"></rect>

    <!-- Plot layer is clipped + transformed for zoom/pan -->
    <g class="trustPlot" clip-path="url(#${clipId})">
      <g class="trustPlotXform" transform="matrix(1 0 0 1 0 0)">
        <line class="hoverLine" vector-effect="non-scaling-stroke" x1="${padL}" y1="${padT}" x2="${padL}" y2="${H - padB}" style="display:none;"></line>
        <path class="line" vector-effect="non-scaling-stroke" d="${pathD}"></path>
        ${circles}
      </g>
    </g>

    ${xTicks}
  </svg>`;
}

function buildTrustHistorySectionHtml(item) {
  const cid = Number(item.cluster_id ?? item.event_id);
  if (!Number.isFinite(cid)) return '';

  // We render a placeholder, then hydrate asynchronously from the server.
  return `
    <div class="trustHistoryWrap" data-trust-cid="${cid}">
      <div class="trustHistoryHeader">
        <div class="trustHistoryTitle">${t("ui.trust_score_history","Trust score history")}</div>
        <div class="trustChartControlsSlot" aria-hidden="true"></div>
      </div>
      <div class="trustHistoryGrid">
        <div class="trustChartCard">
          <div class="trustChartLoading"></div>
          <div class="trustTooltip" aria-hidden="true"></div>
        </div>
        <div class="trustStatsCard">
          <div class="trustStatsRow"><span class="trustStatsLabel">${t("ui.current","Current")}</span><span class="trustStatsVal">—</span></div>
          <div class="trustStatsRow"><span class="trustStatsLabel">${t("ui.highest","Highest")}</span><span class="trustStatsVal">—</span></div>
          <div class="trustStatsRow"><span class="trustStatsLabel">${t("ui.lowest","Lowest")}</span><span class="trustStatsVal">—</span></div>
          <div class="trustStatsDivider"></div>
          <div class="trustStatsRow"><span class="trustStatsLabel">${t("ui.change","Change")}</span><span class="trustStatsVal">—</span></div>
          <div class="trustStatsSub">${t("ui.since_publication","Since publication")}</div>
        </div>
      </div>
      <div class="trustChartHint">${t("ui.chart_hint","Tip: scroll/pinch or use + / − to zoom, drag to pan, then tap a dot for details")}</div>
    </div>
  `;
}



function applyTrackingStickyDeltas(items) {
  const now = Date.now();
  const map = loadTrackingDeltaState();
  let changed = false;

  for (const it of (items || [])) {
    const id = Number(it?.cluster_id ?? it?.event_id);
    if (!Number.isFinite(id)) continue;
    const key = String(id);

    const delta = Number(it?.delta_score ?? it?.delta ?? it?.credibility_delta ?? 0);
    const hasDelta = Number.isFinite(delta) && delta !== 0;

    if (hasDelta) {
      map[key] = {
        delta_score: delta,
        ts: now,
        updated_at: String(it?.updated_at ?? it?.latest_published_at ?? it?.created_at ?? ""),
      };
      changed = true;
    } else if (map[key] && Number.isFinite(Number(map[key].delta_score)) && Number(map[key].delta_score) !== 0) {
      // Re-apply sticky delta if server returns 0 on subsequent refreshes.
      it.delta_score = Number(map[key].delta_score);
    }
  }

  if (changed) saveTrackingDeltaState(map);
  return items;
}

function clearTrackingDelta(id) {
  const key = String(id);
  const map = loadTrackingDeltaState();
  if (map && Object.prototype.hasOwnProperty.call(map, key)) {
    delete map[key];
    saveTrackingDeltaState(map);
  }

  // Update current DOM card instantly (no full re-render needed).
  const el = document.querySelector(`.newsCard[data-id="${CSS.escape(key)}"]`);
  if (el) {
    const deltaEl = el.querySelector('.delta');
    if (deltaEl) deltaEl.remove();

    const wrap = el.querySelector('.trackIconWrap');
    if (wrap) {
      wrap.classList.remove('red', 'green');
      wrap.classList.add('neutral');
    }
    const icon = el.querySelector('img.trackIcon');
    if (icon) icon.src = '/static/icons/Tracking.svg';
  }
}

function updateSeenStateFromItems(items) {
  const now = Date.now();
  const seen = loadSeenState();
  const newIds = new Set();

  for (const it of (items || [])) {
    const key = String(it.cluster_id ?? it.event_id ?? "");
    if (!key) continue;

    const prev = seen[key] || {};

    const wasKnown = Number.isFinite(Number(prev.first_seen_at));
    if (!wasKnown) newIds.add(key);

    // Keep the first time the item was seen in the feed so it won't "jump" to top on updates.
    const firstSeenAt = Number.isFinite(Number(prev.first_seen_at)) ? Number(prev.first_seen_at) : now;

    const newScore = Number(it.credibility_score ?? it.credibility ?? it.score ?? it.rating);
    const oldScore = Number(prev.credibility_score);
    const oldUpdatedAt = prev.updated_at || "";
    const newUpdatedAt = it.updated_at || oldUpdatedAt || "";

    // If score changed, remember the delta so Tracking can show ▲/▼.
    const hasOld = Number.isFinite(oldScore);
    const hasNew = Number.isFinite(newScore);
    const delta = (hasOld && hasNew) ? (newScore - oldScore) : 0;
    const scoreChanged = (hasOld && hasNew && delta !== 0);

    seen[key] = {
      ...prev,
      first_seen_at: firstSeenAt,
      last_seen_at: now,
      sources_count: Number(it.sources_count ?? prev.sources_count ?? 0),
      credibility_score: hasNew ? newScore : Number(prev.credibility_score ?? 0),
      updated_at: newUpdatedAt,

      // Delta fields (optional)
      ...(scoreChanged ? {
        prev_credibility_score: oldScore,
        credibility_delta: delta,
        delta_at: now,
        delta_updated_at: newUpdatedAt,
      } : {}),

      // If the item updated but score didn't, keep previous delta (do not wipe it).
    };
  }

  saveSeenState(seen);
  return newIds;
}

// Backward-compatible alias
function markSeen(items) {
  updateSeenStateFromItems(items);
}



async function syncFavoritesToServer() {
  if (!authState.authenticated) return;
  const ids = getFavIds();
  await fetch(`${API_BASE}/api/favorites/sync`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ ids }),
  });
}

async function pullFavoritesFromServerAndMerge() {
  try {
    if (!authState.authenticated) return;
    const res = await fetch(`${API_BASE}/api/favorites`);
    if (!res.ok) return;
    const data = await res.json();
    const serverIds = Array.isArray(data.ids) ? data.ids.map(Number).filter(Number.isFinite) : [];
    const localIds = getFavIds();
    const merged = [...new Set([...serverIds, ...localIds])];
    setFavIds(merged);
  } catch {}
}

// ----------------------------
// Auth modal helpers
// ----------------------------

function _showAuthError(elId, msg, asHtml = false) {
  const el = document.getElementById(elId);
  if (!el) return;
  el.classList.toggle('isShow', !!msg);
  if (!msg) {
    el.textContent = '';
    return;
  }
  if (asHtml) el.innerHTML = msg;
  else el.textContent = msg;
}

function setAuthStep(step) {
  const steps = {
    choose: 'authStepChoose',
    email: 'authStepEmail',
    forgot: 'authStepForgot',
    reset: 'authStepReset',
  };
  for (const k of Object.values(steps)) {
    const el = document.getElementById(k);
    if (el) el.style.display = 'none';
  }
  const id = steps[step] || steps.choose;
  const target = document.getElementById(id);
  if (target) target.style.display = '';

  // Clear errors
  _showAuthError('authError', '');
  _showAuthError('authForgotError', '');
  _showAuthError('authResetError', '');
}

function openAuthModal(reason = 'login') {
  const back = document.getElementById('authBackdrop');
  if (!back) return;
  back.classList.add('isOpen');
  back.setAttribute('aria-hidden', 'false');

  // Default step
  setAuthStep('choose');

  if (reason === 'verify_required') {
    setAuthStep('email');
    const emailEl = document.getElementById('authEmail');
    if (emailEl && authState.user?.email) emailEl.value = authState.user.email;
    _showAuthError(
      'authError',
      `Please verify your email to use Tracking and saving.\n\nCheck your inbox for a verification link.\n\n` +
        `<a href="#" id="authResendVerify" class="authLink">Resend verification email</a>`,
      true,
    );
    const a = document.getElementById('authResendVerify');
    if (a) {
      a.onclick = async (e) => {
        e.preventDefault();
        const em = (document.getElementById('authEmail')?.value || authState.user?.email || '').trim();
        if (!em) {
          _showAuthError('authError', 'Enter your email first.');
          return;
        }
        try {
          await fetch(`${API_BASE}/api/auth/verify/resend`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ email: em }),
          });
          _showAuthError('authError', 'Verification email sent. Check your inbox (and spam).');
        } catch {
          _showAuthError('authError', 'Failed to send email. Try again later.');
        }
      };
    }
  }
}

function closeAuthModal() {
  const back = document.getElementById('authBackdrop');
  if (!back) return;
  back.classList.remove('isOpen');
  back.setAttribute('aria-hidden', 'true');
  setAuthStep('choose');
}

function updateAccountPlanPill() {
  const pill = document.getElementById('accountPlanPill');
  const menuBadge = document.getElementById('menuPlanBadge');

  // Not logged in -> hide both
  if (!authState.authenticated) {
    if (pill) pill.style.display = 'none';
    if (menuBadge) menuBadge.style.display = 'none';
    return;
  }

  const plan = String((billingState && billingState.plan) ? billingState.plan : 'free').toLowerCase();

  // Header pill: only show for paid plans (keeps header clean on mobile)
  if (pill) {
    if (plan === 'pro') {
      pill.textContent = 'PRO';
      pill.style.display = 'inline-flex';
    } else if (plan === 'analyst') {
      pill.textContent = 'ANALYST';
      pill.style.display = 'inline-flex';
    } else {
      pill.style.display = 'none';
    }
  }

  // Account menu badge: show for ALL plans (Free/Pro/Analyst) incl. mobile
  if (menuBadge) {
    menuBadge.classList.remove('isPro', 'isAnalyst');
    if (plan === 'pro') {
      menuBadge.textContent = 'PRO';
      menuBadge.classList.add('isPro');
    } else if (plan === 'analyst') {
      menuBadge.textContent = 'ANALYST';
      menuBadge.classList.add('isAnalyst');
    } else {
      menuBadge.textContent = 'FREE';
    }
    menuBadge.style.display = 'inline-flex';
  }
}

function _titleCaseWord(w){
  if(!w) return "";
  return w.charAt(0).toUpperCase() + w.slice(1).toLowerCase();
}
function displayNameFromUser(user){
  const full = (user?.full_name || user?.name || user?.display_name || "").trim();
  if(full) return full;

  const email = (user?.email || "").trim();
  if(!email) return "Account";
  let local = (email.split("@")[0] || "").trim();
  // remove digits
  local = local.replace(/\d+/g, "");
  const parts = local.split(/[._\-]+/).filter(Boolean).slice(0,2);
  if(parts.length === 0) return _titleCaseWord((email[0]||"A"));
  if(parts.length === 1) return _titleCaseWord(parts[0]);
  return parts.map(_titleCaseWord).join(" ");
}
function initialsFromName(name){
  const parts = (name||"").trim().split(/\s+/).filter(Boolean);
  if(parts.length===0) return "?";
  const a = parts[0][0] || "?";
  const b = (parts.length>1 ? parts[parts.length-1][0] : "");
  return (a + b).toUpperCase();
}

function updateAuthUI() {
  const btnAccount  = document.getElementById('btnAccount');
  const accountMenu = document.getElementById('accountMenu');
  const menuLogout  = document.getElementById('menuLogout');

  const avatar = document.getElementById('accountAvatar');

  const btnName =
    document.getElementById('accountBtnName') ||
    document.getElementById('accountName') ||
    document.getElementById('accountLabelText');

  const menuAvatar = document.getElementById('menuAvatar');
  const menuName   = document.getElementById('menuName');
  const menuEmail  = document.getElementById('menuEmail'); // ✅ добавили
  const menuPlan   = document.getElementById('menuPlan');

  const isAuthed = !!authState?.authenticated;
  const user = authState?.user || null;

  const name = isAuthed ? displayNameFromUser(user) : 'Login';
  const initials = isAuthed ? initialsFromName(name) : '';
  const email = isAuthed ? String(user?.email || '').trim() : '';

  if (btnAccount) {
    btnAccount.setAttribute('aria-label', name);
    btnAccount.classList.toggle('isAuth', isAuthed);
  }

  if (btnName) btnName.textContent = name;

  if (avatar) {
    if (isAuthed) {
      avatar.textContent = initials;
      avatar.style.display = 'grid';
    } else {
      avatar.textContent = '';
      avatar.style.display = 'none';
    }
  }

  // dropdown header
  if (menuName) menuName.textContent = isAuthed ? name : '—';
  if (menuAvatar) menuAvatar.textContent = isAuthed ? initials : '?';

  // ✅ email в dropdown
  if (menuEmail) {
    menuEmail.textContent = isAuthed ? email : '';
    menuEmail.style.display = (isAuthed && email) ? 'block' : 'none';
  }

  // plan label in dropdown
  if (menuPlan) {
    if (!isAuthed) {
      menuPlan.textContent = '';
    } else {
      const p = String(billingState?.plan || 'free').toLowerCase();
      menuPlan.textContent =
        (p === 'pro') ? 'Plus' :
        (p === 'analyst') ? 'Analyst' :
        'Free';
    }
  }

  if (!isAuthed) {
    if (accountMenu) accountMenu.classList.remove('open');
    if (menuLogout) menuLogout.style.display = 'none';
  } else {
    if (menuLogout) menuLogout.style.display = '';
  }

  updateAccountPlanPill();

  try{ updateProfileUI(); }catch{}
}




async function refreshAuthState() {
  try {
    const res = await fetch(`${API_BASE}/api/auth/me`);
    const data = await res.json();
    authState = {
      authenticated: !!data?.authenticated,
      user: data?.user || null,
    };
  } catch {
    authState = { authenticated: false, user: null };
  }
  updateAuthUI();

  if (authState.authenticated) {
    await pullFavoritesFromServerAndMerge();
    await syncFavoritesToServer();
  }

  // Billing state depends on auth
  await refreshBillingState();
}

async function refreshBillingState() {
  // If not logged in, treat as free.
  if (!authState.authenticated) {
    billingState = { plan: 'free', status: 'active', interval: 'monthly', current_period_end: null, cancel_at_period_end: false };
    updatePricingUI();
    try{ updateProfileUI(); }catch{}
    return;
  }
  try {
    const r = await fetch(`${API_BASE}/api/billing/me`);
    const j = await r.json();
    billingState = {
      plan: j?.plan || 'free',
      status: j?.status || 'active',
      interval: j?.interval || 'monthly',
      current_period_end: j?.current_period_end || null,
      cancel_at_period_end: !!j?.cancel_at_period_end,
    };
  } catch {
    billingState = { plan: 'free', status: 'active', interval: 'monthly' };
  }
  updatePricingUI();
  updateAccountPlanPill();
  try{ updateProfileUI(); }catch{}
}

function bindAuthModalUI() {
  const back = document.getElementById('authBackdrop');
  if (!back) return;

  const closeBtn = document.getElementById('authClose');
  if (closeBtn) closeBtn.onclick = closeAuthModal;
  back.addEventListener('click', (e) => {
    if (e.target === back) closeAuthModal();
  });

  const btnGoogle = document.getElementById('btnGoogle');
  if (btnGoogle) {
    btnGoogle.onclick = async () => {
      try {
        const r = await fetch(`${API_BASE}/api/auth/oauth/google/start`);
        const j = await r.json();
        if (j?.url) window.location.href = j.url;
      } catch {
        // noop
      }
    };
  }

  const btnEmail = document.getElementById('btnEmail');
  if (btnEmail) btnEmail.onclick = () => setAuthStep('email');

  const backLink = document.getElementById('authBack');
  if (backLink) backLink.onclick = (e) => { e.preventDefault(); setAuthStep('choose'); };

  const forgotLink = document.getElementById('authForgot');
  if (forgotLink) forgotLink.onclick = (e) => { e.preventDefault(); setAuthStep('forgot'); };

  const forgotBack = document.getElementById('authForgotBack');
  if (forgotBack) forgotBack.onclick = (e) => { e.preventDefault(); setAuthStep('email'); };

  const submit = document.getElementById('authSubmit');
  if (submit) {
    submit.onclick = async () => {
      const email = (document.getElementById('authEmail')?.value || '').trim();
      const password = (document.getElementById('authPassword')?.value || '').trim();
      if (!email || !password) {
        _showAuthError('authError', 'Enter email and password.');
        return;
      }

      // Try login first. If 401/404-ish -> register.
      try {
        let r = await fetch(`${API_BASE}/api/auth/login`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ email, password }),
        });

        if (r.ok) {
          await refreshAuthState();
          closeAuthModal();
          if (pendingCheckout) {
            const pc = pendingCheckout;
            pendingCheckout = null;
            await startCheckout(pc.plan, pc.interval);
            return;
          }
          // Reload feed so paywall disappears
          await fetchFeed({ reset: true });

          // If user came from a shared deep-link, open the requested article now.
          await maybeOpenDeepLinkedArticle();
          return;
        }

        const err = await safeReadError(r);

        // If invalid credentials -> attempt register (only if it's likely a new user)
        if (r.status === 401) {
          r = await fetch(`${API_BASE}/api/auth/register`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ email, password }),
          });
          if (r.ok) {
            _showAuthError('authError', 'Account created. Check your email to verify before using Tracking/saving.');
            return;
          }
          const err2 = await safeReadError(r);
          _showAuthError('authError', err2 || 'Registration failed.');
          return;
        }

        _showAuthError('authError', err || 'Login failed.');
      } catch {
        _showAuthError('authError', 'Network error. Try again.');
      }
    };
  }

  const forgotSubmit = document.getElementById('authForgotSubmit');
  if (forgotSubmit) {
    forgotSubmit.onclick = async () => {
      const email = (document.getElementById('authForgotEmail')?.value || '').trim();
      if (!email) {
        _showAuthError('authForgotError', 'Enter your email.');
        return;
      }
      try {
        await fetch(`${API_BASE}/api/auth/forgot`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ email }),
        });
        _showAuthError('authForgotError', 'If that email exists, we sent a reset link.');
      } catch {
        _showAuthError('authForgotError', 'Failed to send reset link.');
      }
    };
  }

  const resetSubmit = document.getElementById('authResetSubmit');
  if (resetSubmit) {
    resetSubmit.onclick = async () => {
      const newPassword = (document.getElementById('authResetPassword')?.value || '').trim();
      if (!_resetToken) {
        _showAuthError('authResetError', 'Missing reset token.');
        return;
      }
      if (!newPassword) {
        _showAuthError('authResetError', 'Enter a new password.');
        return;
      }
      try {
        const r = await fetch(`${API_BASE}/api/auth/reset`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ token: _resetToken, new_password: newPassword }),
        });
        if (!r.ok) {
          const err = await safeReadError(r);
          _showAuthError('authResetError', err || 'Reset failed.');
          return;
        }
        _showAuthError('authResetError', 'Password updated. You can log in now.');
        setAuthStep('email');
      } catch {
        _showAuthError('authResetError', 'Network error.');
      }
    };
  }
}

async function safeReadError(res) {
  try {
    const j = await res.json();
    const d = j?.detail;
    if (typeof d === 'string') return d;
    if (d?.message) return d.message;
    return '';
  } catch {
    return '';
  }
}

async function handleAuthQueryParams() {
  const url = new URL(window.location.href);
  const verify = url.searchParams.get('verify');
  const reset = url.searchParams.get('reset');
  const login = url.searchParams.get('login');

  if (verify) {
    try {
      const r = await fetch(`${API_BASE}/api/auth/verify?token=${encodeURIComponent(verify)}`, { method: 'POST' });
      if (r.ok) {
        // Clean query
        url.searchParams.delete('verify');
        window.history.replaceState({}, '', url.toString());
        await refreshAuthState();
        openAuthModal('login');
        setAuthStep('email');
        _showAuthError('authError', 'Email verified. You can use Tracking now.');
      }
    } catch {}
  }

  if (reset) {
    _resetToken = reset;
    // Clean query
    url.searchParams.delete('reset');
    window.history.replaceState({}, '', url.toString());
    openAuthModal('login');
    setAuthStep('reset');
  }

  if (login === 'success') {
    url.searchParams.delete('login');
    window.history.replaceState({}, '', url.toString());
    await refreshAuthState();
    // After OAuth redirects back, refresh the feed and open any deep-link.
    await fetchFeed({ reset: true });
    await maybeOpenDeepLinkedArticle();
  }
}

// ----------------------------
// Pricing / Billing UI
// ----------------------------
function bindPricingUI(){
  const pricingSection = document.getElementById('pricingSection');
  const profileSection = document.getElementById('profileSection');
  const feedView = document.getElementById('feedView');
  if(!pricingSection || !feedView) return;


// Info pages (Legal / Support)
const infoSection = document.getElementById('infoSection');
const infoTitleEl = document.getElementById('infoTitle');
const infoMetaEl  = document.getElementById('infoMeta');
const infoBodyEl  = document.getElementById('infoBody');
const infoBackBtn = document.getElementById('infoBackBtn');

// Professional copy (lightweight templates; customize anytime)
const INFO_PAGES = {
  contact: {
    title: "Contact",
    updated: "2026-02-21",
    html: `
      <p class="infoLead">Questions, feedback, partnerships, or support — we’re here to help.</p>

      <div class="infoCallout">
        <b>Email</b><br/>
        <a href="mailto:contact@checkne.com">contact@checkne.com</a>
      </div>

      <h2>Include in your message</h2>
      <ul>
        <li>A short description of what you need</li>
        <li>A link (or screenshot) that shows the issue</li>
        <li>Your device and browser</li>
        <li>If it’s billing-related: the email on your account (never send passwords)</li>
      </ul>

      <h2>Response time</h2>
      <p>We typically reply on business days. If your request is urgent, put <b>URGENT</b> in the subject line.</p>
    `
  },
  status: {
  title: "Status",
  updated: "2026-02-21",
  html: `
    <p class="infoLead">Live operational status of CHECKNE services.</p>

    <h2>Current status</h2>
    <ul class="statusList" id="statusList">
      <li class="statusRow" data-svc="web_app">
        <div class="statusLeft">
          <span class="statusDot status-warn" aria-hidden="true"></span>
          <span class="statusName">Web app</span>
        </div>
        <div class="statusText" data-svc-text="web_app">Checking…</div>
      </li>
      <li class="statusRow" data-svc="api">
        <div class="statusLeft">
          <span class="statusDot status-warn" aria-hidden="true"></span>
          <span class="statusName">API</span>
        </div>
        <div class="statusText" data-svc-text="api">Checking…</div>
      </li>
      <li class="statusRow" data-svc="tracking">
        <div class="statusLeft">
          <span class="statusDot status-warn" aria-hidden="true"></span>
          <span class="statusName">Tracking / ingest</span>
        </div>
        <div class="statusText" data-svc-text="tracking">Checking…</div>
      </li>
      <li class="statusRow" data-svc="email">
        <div class="statusLeft">
          <span class="statusDot status-warn" aria-hidden="true"></span>
          <span class="statusName">Email notifications</span>
        </div>
        <div class="statusText" data-svc-text="email">Checking…</div>
      </li>
    </ul>

    <div class="statusMetaRow" id="statusMeta">Checking status…</div>

    <h2>Report an issue</h2>
    <p>If something looks wrong, send us a message: <a class="statusSmallLink" href="https://mail.google.com/mail/?view=cm&fs=1&to=support%40checkne.com&su=Status%20issue%20%E2%80%94%20CHECKNE&body=Hi%20CHECKNE%20support%2C%0A%0AI%20think%20there%27s%20a%20status%20issue%3A%0A%0A%E2%80%94%20What%20I%20see%3A%0A%E2%80%94%20Link%20%2F%20screenshot%3A%0A%E2%80%94%20Device%20%2F%20browser%3A%0A%0AThanks!" target="_blank" rel="noopener">Open email</a></p>
  `
},

  privacy: {
    title: "Privacy Policy",
    updated: "2026-02-21",
    html: `
      <p class="infoLead">This Privacy Policy explains how CHECKNE (“we”, “us”) processes personal data when you use our website and services.</p>

      <h2>1. Controller</h2>
      <p>CHECKNE is operated by an individual founder based in Germany (the “Controller”).<br/>
      Contact: <a href="mailto:support@checkne.com">support@checkne.com</a></p>

      <h2>2. Data we collect</h2>
      <ul>
        <li><b>Account data</b> (e.g., email address, authentication identifiers)</li>
        <li><b>Subscription & billing metadata</b> (e.g., plan, payment status, renewal/cancellation state; we do not store full card details)</li>
        <li><b>Usage data</b> (e.g., pages viewed, actions taken, error logs, approximate timestamps)</li>
        <li><b>Technical data</b> (e.g., IP address, device/browser information, cookies/local storage identifiers)</li>
        <li><b>Support messages</b> you send to us (content + attachments you choose to provide)</li>
      </ul>

      <h2>3. How we use data</h2>
      <ul>
        <li>Provide and operate the Service (authentication, tracking, alerts)</li>
        <li>Process subscriptions and prevent fraud</li>
        <li>Improve reliability, performance, and security</li>
        <li>Communicate with you (service emails, support replies)</li>
        <li>Comply with legal obligations</li>
      </ul>

      <h2>4. Legal bases (GDPR)</h2>
      <ul>
        <li><b>Contract</b> (Art. 6(1)(b)) — to provide your account and subscription</li>
        <li><b>Legitimate interests</b> (Art. 6(1)(f)) — security, abuse prevention, service improvement</li>
        <li><b>Consent</b> (Art. 6(1)(a)) — where required (e.g., non-essential cookies)</li>
        <li><b>Legal obligation</b> (Art. 6(1)(c)) — accounting/tax and compliance</li>
      </ul>

      <h2>5. Sharing and processors</h2>
      <p>We share data only as necessary to run the Service — for example with hosting, analytics (if enabled), email delivery, and payment providers. These providers act as processors under GDPR where applicable.</p>

      <h2>6. International transfers</h2>
      <p>Some providers may process data outside the EU/EEA. Where required, we rely on appropriate safeguards (such as Standard Contractual Clauses) or other lawful mechanisms.</p>

      <h2>7. Retention</h2>
      <p>We keep personal data only as long as needed for the purposes above, including legal and accounting requirements. You can request deletion of your account, subject to mandatory retention obligations.</p>

      <h2>8. Security</h2>
      <p>We use reasonable technical and organizational measures to protect personal data. No method of transmission or storage is 100% secure.</p>

      <h2>9. Your rights</h2>
      <p>Depending on your location, you may have rights such as access, correction, deletion, portability, restriction, objection, and withdrawing consent. To exercise these rights, email <a href="mailto:support@checkne.com">support@checkne.com</a>.</p>

      <h2>10. Cookies</h2>
      <p>We use cookies and similar technologies to keep the Service working and remember preferences. See our <a href="#/cookies">Cookie Policy</a> for details.</p>

      <h2>11. Children</h2>
      <p>The Service is not intended for children. If you believe a child provided personal data, contact us and we will take appropriate steps.</p>

      <h2>12. Changes</h2>
      <p>We may update this Privacy Policy from time to time. We will update the “Last updated” date and, where appropriate, provide additional notice.</p>
    `
  },
  terms: {
    title: "Terms of Service",
    updated: "2026-02-21",
    html: `
      <p class="infoLead">These Terms of Service (“Terms”) govern your access to and use of CHECKNE (“Service”). By using the Service, you agree to these Terms.</p>

      <h2>1. Service</h2>
      <p>CHECKNE provides AI-assisted news tracking and signal intelligence features. We may add, modify, or remove features to improve the Service.</p>

      <h2>2. Accounts</h2>
      <ul>
        <li>You must provide accurate information and keep it up to date.</li>
        <li>You are responsible for your account credentials and all activity under your account.</li>
        <li>You must not share accounts or use the Service on behalf of someone else without permission.</li>
      </ul>

      <h2>3. Paid subscriptions</h2>
      <p>Certain features require a paid subscription.</p>
      <h3>Billing & renewal</h3>
      <p>Subscriptions are billed on a recurring basis (monthly or annually, depending on the plan) and renew automatically unless canceled before the renewal date.</p>
      <h3>Cancellation</h3>
      <p>You can cancel at any time from your account settings. Cancellation stops future renewals; you keep access until the end of the current paid period.</p>
      <h3>Refunds</h3>
      <p>Payments are non-refundable except where required by applicable law.</p>

      <h2>4. Acceptable use</h2>
      <ul>
        <li>Do not misuse the Service, attempt to disrupt it, or access it in unauthorized ways.</li>
        <li>Do not scrape, reverse-engineer, or abuse the Service or its rate limits.</li>
        <li>Do not upload or distribute unlawful, harmful, or misleading content.</li>
        <li>Do not use CHECKNE to build a competing product or provide a competing service.</li>
      </ul>

      <h2>5. Content and third‑party links</h2>
      <p>CHECKNE may link to third‑party websites and sources. Third‑party content is governed by their terms and policies, and we are not responsible for it.</p>

      <h2>6. AI output disclaimer</h2>
      <p>The Service uses automated systems and AI-generated analysis. Outputs may be incomplete, inaccurate, or outdated. You are responsible for verifying information before relying on it.</p>

      <h2>7. Disclaimers</h2>
      <p>The Service is provided “as is” and “as available”. We do not guarantee uninterrupted operation or error-free results.</p>

      <h2>8. Limitation of liability</h2>
      <p>To the maximum extent permitted by law, CHECKNE is not liable for indirect, incidental, special, consequential, or punitive damages.</p>

      <h2>9. Termination</h2>
      <p>We may suspend or terminate access if you violate these Terms or to protect the Service, users, or third parties.</p>

      <h2>10. Governing law</h2>
      <p>These Terms are governed by the laws of Germany.</p>

      <h2>Contact</h2>
      <p>Questions about these Terms: <a href="mailto:contact@checkne.com?subject=Terms%20question%20%E2%80%94%20CHECKNE">contact@checkne.com</a></p>
    `
  },
  cookies: {
    title: "Cookie Policy",
    updated: "2026-02-21",
    html: `
      <p class="infoLead">This Cookie Policy explains how CHECKNE uses cookies and similar technologies.</p>
      <h2>What are cookies?</h2>
      <p>Cookies are small text files stored on your device to help websites function and remember preferences.</p>
      <h2>Types of cookies we may use</h2>
      <ul>
        <li><b>Essential cookies</b> (required for core functionality and security)</li>
        <li><b>Preferences cookies</b> (remember language or UI settings)</li>
        <li><b>Analytics cookies</b> (help us understand usage and improve performance)</li>
      </ul>
      <h2>Managing cookies</h2>
      <p>You can control cookies through your browser settings. Disabling some cookies may affect site functionality.</p>
      <h2>Contact</h2>
      <p>Cookie questions: <a href="mailto:contact@checkne.com?subject=Cookie%20question%20%E2%80%94%20CHECKNE">contact@checkne.com</a></p>
    `
  },
  impressum: {
    title: "Impressum",
    updated: "2026-02-21",
    html: `
      <p class="infoLead">Information according to applicable German law (e.g., § 5 TMG / § 18 MStV, as relevant).</p>
      <h2>Service provider</h2>
      <p><b>CHECKNE</b><br/>Contact: <a href="mailto:contact@checkne.com">contact@checkne.com</a></p>
      <h2>Responsible for content</h2>
      <p>Responsible person (content): CHECKNE (see contact above).</p>
      <h2>Disclaimer</h2>
      <p>Despite careful control, we assume no liability for external links. The operators of linked pages are solely responsible for their content.</p>
    `
  }
};

let __statusPollTimer = null;

function __statusClassFromState(s){
  const v = String(s || '').toLowerCase();
  if(v === 'operational' || v === 'ok' || v === 'green') return 'status-ok';
  if(v === 'degraded' || v === 'warning' || v === 'warn' || v === 'yellow') return 'status-warn';
  return 'status-down';
}

function __stopStatusPoll(){
  if(__statusPollTimer){
    clearInterval(__statusPollTimer);
    __statusPollTimer = null;
  }
}

async function __refreshStatusOnce(){
  const meta = document.getElementById('statusMeta');
  const list = document.getElementById('statusList');
  if(!list) return;

  if(meta) meta.textContent = 'Checking status…';

  try{
    const r = await fetch(`${API_BASE}/api/status`, { cache: 'no-store' });
    if(!r.ok) throw new Error(`HTTP ${r.status}`);
    const data = await r.json();

    const services = (data && data.services) ? data.services : {};
    const updatedAt = (data && data.generated_at) ? String(data.generated_at) : '';

    Object.keys(services).forEach((k)=>{
      const item = services[k] || {};
      const state = item.status || 'down';
      const text = item.message || state;

      const row = list.querySelector(`[data-svc="${k}"]`);
      if(!row) return;

      const dot = row.querySelector('.statusDot');
      if(dot){
        dot.classList.remove('status-ok','status-warn','status-down');
        dot.classList.add(__statusClassFromState(state));
      }

      const t = row.querySelector(`[data-svc-text="${k}"]`);
      if(t) t.textContent = text;
    });

    if(meta){
      meta.textContent = updatedAt ? (`Last checked: ${updatedAt}`) : 'Last checked just now';
    }
  }catch(e){
    // Mark everything as degraded/down if API cannot be reached
    list.querySelectorAll('.statusRow').forEach((row)=>{
      const dot = row.querySelector('.statusDot');
      const t = row.querySelector('.statusText');
      if(dot){
        dot.classList.remove('status-ok','status-warn');
        dot.classList.add('status-down');
      }
      if(t) t.textContent = 'Unavailable';
    });
    if(meta) meta.textContent = 'Status check failed. Please try again later.';
  }
}

function __initStatusPage(){
  __stopStatusPoll();
  __refreshStatusOnce();
  __statusPollTimer = setInterval(__refreshStatusOnce, 20000);
}

function setInfoPage(slug){
  if(!infoSection || !infoTitleEl || !infoBodyEl) return;

  const page = INFO_PAGES[slug];
  if(!page) return;

  // Hide other main views
  feedView.style.display = 'none';
  pricingSection.style.display = 'none';
  if(profileSection) profileSection.style.display = 'none';

  // Render content
  infoTitleEl.textContent = page.title;
  if(infoMetaEl) infoMetaEl.textContent = `Last updated: ${page.updated}`;
  infoBodyEl.innerHTML = page.html;

  if(slug === 'status') __initStatusPage(); else __stopStatusPoll();

  infoSection.style.display = 'block';
  window.scrollTo({ top: 0, behavior: 'instant' });
}

function setMainFeed(){
  if(infoSection) infoSection.style.display = 'none';
  __stopStatusPoll();
  pricingSection.style.display = 'none';
  if(profileSection) profileSection.style.display = 'none';
  feedView.style.display = 'block';
  window.scrollTo({ top: 0, behavior: 'instant' });
}

  // Selected plan for the single CTA button under the cards
  let selectedPlan = (billingState?.plan || 'free').toLowerCase();

  function setPage(page){
    // page: 'feed' | 'pricing' | 'info:<slug>'
    if(page === 'pricing'){
      if(infoSection) infoSection.style.display = 'none';
      feedView.style.display = 'none';
      if(profileSection) profileSection.style.display = 'none';
      pricingSection.style.display = 'block';
      window.scrollTo({ top: 0, behavior: 'instant' });
      const btn = document.getElementById('btnPricing');
      if(btn) btn.setAttribute('aria-current','page');
      return;
    }

    if(page === 'profile'){
      if(infoSection) infoSection.style.display = 'none';
      feedView.style.display = 'none';
      pricingSection.style.display = 'none';
      if(profileSection) profileSection.style.display = 'block';
      try{ window.scrollTo({ top: 0, behavior: 'instant' }); }catch{}
      // Keep UI in sync
      try{ updateProfileUI(); }catch{}
      return;
    }

    if(page && page.startsWith('info:')){
      const slug = page.slice('info:'.length);
      const btn = document.getElementById('btnPricing');
      if(btn) btn.removeAttribute('aria-current');
      setInfoPage(slug);
      return;
    }

    // Default: main feed (with tabs/tracking inside)
    const btn = document.getElementById('btnPricing');
    if(btn) btn.removeAttribute('aria-current');
    setMainFeed();
  }

  // Expose for other handlers (Tracking / Login, etc.)
  window.__setMainPage = setPage;

window.__openInfoPage = (slug)=> setPage(`info:${slug}`);

// Back button for info pages
if(infoBackBtn){
  infoBackBtn.addEventListener('click', ()=>{
    // Go back to feed by default
    location.hash = '#/';
  });
}

// Hash routing for footer links and shareable URLs
function routeFromHash(){
  const h = String(location.hash || '');
  if(h === '#/pricing' || h.startsWith('#/pricing')){
    setPage('pricing');
    return;
  }

  if(h === '#/account' || h === '#/profile' || h.startsWith('#/account') || h.startsWith('#/profile')){
    setPage('profile');
    return;
  }
  if(h === '#/tracking' || h.startsWith('#/tracking')){
    // Ensure we are on the main feed view and then switch to Tracking tab
    setPage('feed');
    switchMode('fav');
    return;
  }
  if(h === '#/contact') return setPage('info:contact');
  if(h === '#/status') return setPage('info:status');
  if(h === '#/privacy') return setPage('info:privacy');
  if(h === '#/terms') return setPage('info:terms');
  if(h === '#/cookies') return setPage('info:cookies');
  if(h === '#/impressum') return setPage('info:impressum');

  // Default
  setPage('feed');
}

window.addEventListener('hashchange', routeFromHash);


  const btnPricing = document.getElementById('btnPricing');
  if(btnPricing){
    btnPricing.addEventListener('click', (e)=>{
      e.preventDefault();
      setPage('pricing');
    });
  }

  // Clicking the logo/title returns to the feed
  const brand = document.getElementById('brand');
  if(brand){
    brand.addEventListener('click', async (e)=>{
      e.preventDefault();
      setPage('feed');
      await switchMode('feed');
    });
  }

  const monthlyBtn = document.getElementById('billMonthly');
  const yearlyBtn  = document.getElementById('billYearly');


  
  function syncIntervalUI(){
    const isMonthly = (billingInterval === 'monthly');
    if(monthlyBtn){
      monthlyBtn.classList.toggle('on', isMonthly);
      monthlyBtn.setAttribute('aria-selected', isMonthly ? 'true':'false');
    }
    if(yearlyBtn){
      yearlyBtn.classList.toggle('on', !isMonthly);
      yearlyBtn.setAttribute('aria-selected', !isMonthly ? 'true':'false');
    }
    document.querySelectorAll('.planPrice').forEach(el=>{
      const monthlyStr = el.getAttribute('data-price-monthly') || '';
      const yearlyStr  = el.getAttribute('data-price-yearly') || '';

      const nowEl  = el.querySelector('.priceNow');
      const wasEl  = el.querySelector('.priceWas');
      const saveEl = el.querySelector('.priceSave');

      // Fallback: if HTML wasn't updated for some reason, keep previous behavior.
      if(!nowEl){
        const v = isMonthly ? monthlyStr : yearlyStr;
        if(v) el.textContent = v;
        return;
      }

      if(isMonthly){
        nowEl.textContent = monthlyStr;
        if(wasEl) wasEl.style.display = 'none';
        if(saveEl) saveEl.style.display = 'none';
        return;
      }

      // Yearly view: show new price + struck-through "would be" annual price + savings.
      nowEl.textContent = yearlyStr;

      const parsePrice = (s)=>{
        const n = parseFloat(String(s).replace(/[^0-9.]/g,''));
        return Number.isFinite(n) ? n : null;
      };

      const m = parsePrice(monthlyStr);
      const y = parsePrice(yearlyStr);
      if(m != null && y != null){
        const annual = m * 12;
        const pct = Math.max(0, Math.round((1 - (y / annual)) * 100));

        if(wasEl){
          wasEl.textContent = `$${annual.toFixed(2)}`;
          wasEl.style.display = 'inline';
        }
        if(saveEl){
          saveEl.textContent = pct > 0 ? `Save ${pct}%` : '';
          saveEl.style.display = pct > 0 ? 'inline' : 'none';
        }
      }else{
        if(wasEl) wasEl.style.display = 'none';
        if(saveEl) saveEl.style.display = 'none';
      }
    });
  }

  function syncSelectionUI(){
    document.querySelectorAll('.planCard').forEach(card=>{
      const plan = card.getAttribute('data-plan');
      card.classList.toggle('isSelected', plan === selectedPlan);
    });

    const mainBtn = document.getElementById('pricingMainCta');
    if(mainBtn){
      const currentPlan = (billingState?.plan || 'free').toLowerCase();
      const status = (billingState?.status || 'active').toLowerCase();
      const currentInterval = (billingState?.interval || 'monthly').toLowerCase();
      const hasActivePaid =
        authState.authenticated &&
        currentPlan !== 'free' &&
        (status === 'active' || status === 'trialing');

      const isCurrentSelected = hasActivePaid && selectedPlan === currentPlan && billingInterval === currentInterval;

      if (isCurrentSelected) {
        mainBtn.textContent = 'Current plan';
        mainBtn.disabled = true;
      } else {
        mainBtn.disabled = false;
        mainBtn.textContent =
          selectedPlan === 'free' ? 'Get Free' :
          selectedPlan === 'pro' ? 'Upgrade to Pro' :
          'Upgrade to Analyst';
      }
    }
  }

  // Select plan by clicking a card
  document.querySelectorAll('.planCard').forEach(card=>{
    card.addEventListener('click', ()=>{
      selectedPlan = card.getAttribute('data-plan') || 'free';
      syncSelectionUI();
    });
    card.addEventListener('keydown', (ev)=>{
      if(ev.key === 'Enter' || ev.key === ' '){
        ev.preventDefault();
        selectedPlan = card.getAttribute('data-plan') || 'free';
        syncSelectionUI();
      }
    });
  });

  if(monthlyBtn) monthlyBtn.addEventListener('click', ()=>{
    billingInterval = 'monthly';
    syncIntervalUI();
  });
  if(yearlyBtn) yearlyBtn.addEventListener('click', ()=>{
    billingInterval = 'yearly';
    syncIntervalUI();
  });

 const mainBtn = document.getElementById('pricingMainCta');

if (mainBtn) {
  mainBtn.addEventListener('click', async () => {

    const currentPlan = (billingState?.plan || 'free').toLowerCase();
    const status = (billingState?.status || '').toLowerCase();
    const currentInterval = (billingState?.interval || 'monthly').toLowerCase();

    const hasActivePaid =
      authState.authenticated &&
      currentPlan !== 'free' &&
      (status === 'active' || status === 'trialing');

    // ✅ Уже куплено → запрещаем повторную покупку
    if (
      hasActivePaid &&
      selectedPlan === currentPlan &&
      billingInterval === currentInterval
    ) {
      toast("✅ You already have this plan.");
      return;
    }

    // дальше твоя логика
    if (selectedPlan === 'free') {
      toast("Free plan enabled (no payment).");
      return;
    }

        await startCheckout(selectedPlan, billingInterval);
  });
}


  // Default state
  syncIntervalUI();
  syncSelectionUI();
}


function setBillingInterval(interval) {
  billingInterval = interval;
  const bM = document.getElementById('billMonthly');
  const bY = document.getElementById('billYearly');
  if (bM && bY) {
    bM.classList.toggle('on', interval === 'monthly');
    bY.classList.toggle('on', interval === 'yearly');
    bM.setAttribute('aria-selected', interval === 'monthly' ? 'true' : 'false');
    bY.setAttribute('aria-selected', interval === 'yearly' ? 'true' : 'false');
  }
  // Update displayed prices (+ crossed out annual "was" when Yearly)
  document.querySelectorAll('.planPrice').forEach((el) => {
    const monthlyStr = el.getAttribute('data-price-monthly') || '';
    const yearlyStr  = el.getAttribute('data-price-yearly') || '';

    const now = el.querySelector('.priceNow');
    const was = el.querySelector('.priceWas');
    const save = el.querySelector('.priceSave');

    if (!now) return;

    if (interval === 'yearly') {
      now.textContent = yearlyStr || monthlyStr;

      const monthly = parseMoney(monthlyStr);
      const annualWas = monthly * 12;
      const yearly = parseMoney(yearlyStr);

      if (was) {
        was.style.display = (monthly > 0 && yearly > 0) ? 'block' : 'none';
        was.textContent = (monthly > 0 && yearly > 0) ? formatMoney(annualWas) : '';
      }

      if (save) {
        const pct = (annualWas > 0 && yearly > 0)
          ? Math.round(((annualWas - yearly) / annualWas) * 100)
          : 0;
        save.style.display = (pct > 0) ? 'block' : 'none';
        save.textContent = (pct > 0) ? `Save ${pct}%` : '';
      }
    } else {
      now.textContent = monthlyStr || yearlyStr;
      if (was) { was.style.display = 'none'; was.textContent = ''; }
      if (save) { save.style.display = 'none'; save.textContent = ''; }
    }
  });
}

function updatePricingUI() {
  // Highlight current plan + update CTA text
  document.querySelectorAll('.planCard').forEach((card) => {
    const plan = card.getAttribute('data-plan');
    const btn = card.querySelector('.planBtn');
    const isCurrent = plan === billingState.plan;
    card.classList.toggle('current', isCurrent);
    if (btn) {
      if (isCurrent) {
        btn.textContent = 'Current plan';
        btn.disabled = true;
      } else {
        btn.disabled = false;
        if (plan === 'free') btn.textContent = 'Switch to Free';
        else if (plan === 'pro') btn.textContent = 'Upgrade to Pro';
        else btn.textContent = 'Upgrade to Analyst';
      }
    }
  });
}

function _fmtPeriodEnd(iso){
  if(!iso) return '';
  try{
    const d = new Date(String(iso));
    if(Number.isNaN(d.getTime())) return '';
    return d.toLocaleDateString('en-US', { year:'numeric', month:'short', day:'2-digit' });
  }catch{
    return '';
  }
}

function _planLabel(plan){
  const p = String(plan || 'free').toLowerCase();
  if(p === 'pro') return 'Plus';
  if(p === 'analyst') return 'Analyst';
  return 'Free';
}

function updateProfileUI(){
  const sec = document.getElementById('profileSection');
  if(!sec) return;

  const nameEl  = document.getElementById('profileName');
  const emailEl = document.getElementById('profileEmail');

  const planPill   = document.getElementById('profilePlanPill');
  const statusPill = document.getElementById('profileStatusPill');
  const renewText  = document.getElementById('profileRenewText');
  const cancelHint = document.getElementById('profileCancelHint');

  const btnManage = document.getElementById('profileManageBtn');
  const btnCancel = document.getElementById('profileCancelBtn');
  const btnResume = document.getElementById('profileResumeBtn');

  const isAuthed = !!authState?.authenticated;
  const user = authState?.user || null;

  const name = isAuthed ? displayNameFromUser(user) : '—';
  const email = isAuthed ? String(user?.email || '').trim() : '';

  if(nameEl) nameEl.textContent = name;
  if(emailEl) emailEl.textContent = email || '—';

  const plan = String(billingState?.plan || 'free').toLowerCase();
  const status = String(billingState?.status || 'active');
  const cancelAt = !!billingState?.cancel_at_period_end;
  const end = _fmtPeriodEnd(billingState?.current_period_end);

  if(planPill) planPill.textContent = _planLabel(plan);
  if(statusPill) statusPill.textContent = (status ? status.charAt(0).toUpperCase() + status.slice(1) : 'Active');

  // Actions
  if(btnManage){
    btnManage.disabled = !isAuthed;
    btnManage.onclick = () => { location.hash = '#/pricing'; };
  }

  if(btnCancel) btnCancel.style.display = 'none';
  if(btnResume) btnResume.style.display = 'none';
  if(cancelHint) cancelHint.style.display = 'none';

  if(!isAuthed){
    if(renewText) renewText.textContent = 'Log in to manage your plan.';
    return;
  }

  if(plan === 'free'){
    if(renewText) renewText.textContent = 'You are on Free. Upgrade anytime to unlock premium features.';
    return;
  }

  if(cancelAt){
    if(renewText) renewText.textContent = end ? `Your subscription is set to cancel on ${end}.` : 'Your subscription is set to cancel at period end.';
    if(btnResume){
      btnResume.style.display = '';
      btnResume.disabled = false;
      btnResume.onclick = async ()=>{
        try{
          btnResume.disabled = true;
          const r = await fetch(`${API_BASE}/api/billing/resume`, { method:'POST' });
          const j = await r.json().catch(()=> ({}));
          if(!r.ok) throw new Error(j?.detail || `HTTP ${r.status}`);
          await refreshBillingState();
        }catch(e){
          alert(String(e?.message || e || 'Failed to resume subscription'));
        }finally{
          btnResume.disabled = false;
        }
      };
    }
    if(cancelHint){
      cancelHint.style.display = '';
      cancelHint.textContent = 'You will keep access until the end of your current billing period.';
    }
  }else{
    if(renewText) renewText.textContent = end ? `Renews on ${end}.` : 'Renews automatically unless canceled.';
    if(btnCancel){
      btnCancel.style.display = '';
      btnCancel.disabled = false;
      btnCancel.onclick = async ()=>{
        const ok = confirm('Cancel at period end? You will keep access until the end of the current billing period.');
        if(!ok) return;
        try{
          btnCancel.disabled = true;
          const r = await fetch(`${API_BASE}/api/billing/cancel`, { method:'POST' });
          const j = await r.json().catch(()=> ({}));
          if(!r.ok) throw new Error(j?.detail || `HTTP ${r.status}`);
          await refreshBillingState();
        }catch(e){
          alert(String(e?.message || e || 'Failed to cancel subscription'));
        }finally{
          btnCancel.disabled = false;
        }
      };
    }
  }
}

async function startCheckout(plan, interval) {
  try {
    if (plan === 'free') {
      await fetch(`${API_BASE}/api/billing/set-free`, { method: 'POST' });
      await refreshBillingState();
      // Refresh feed so paywall disappears
      await fetchFeed({ reset: true });
      const sec = document.getElementById('pricingSection');
      if (sec) sec.scrollIntoView({ behavior: 'smooth', block: 'start' });
      return;
    }

    const r = await fetch(`${API_BASE}/api/billing/checkout`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ plan, interval }),
    });
    const j = await r.json();
    if (!r.ok) {
      alert(j?.detail || 'Failed to start checkout');
      return;
    }
    if (j?.url) window.location.href = j.url;
  } catch {
    alert('Network error. Try again.');
  }
}

async function handleBillingQueryParams() {
  const url = new URL(window.location.href);
  const checkout = url.searchParams.get('checkout');
  const sessionId = url.searchParams.get('session_id');
  if (checkout === 'success' && sessionId) {
    try {
      const r = await fetch(`${API_BASE}/api/billing/checkout/complete?session_id=${encodeURIComponent(sessionId)}`, {
        method: 'POST',
      });
      // Clean query params either way
      url.searchParams.delete('checkout');
      url.searchParams.delete('session_id');
      window.history.replaceState({}, '', url.toString());
      if (r.ok) {
        await refreshBillingState();
        await fetchFeed({ reset: true });
      }
    } catch {
      // ignore
    }
  }
}

function renderTags() {
  const tagsEl = qs("tags");
  tagsEl.innerHTML = "";
  [...new Set(DEFAULT_INTERESTS)].forEach((tag) => {
    const el = document.createElement("div");
    el.className = "tag" + (state.interests.includes(tag) ? " on" : "");
    el.textContent = t(`interests.${tag}`, tag);
    el.onclick = async () => {
      // Guests can read the top 3 items, but changing interests requires an account.
      if (!authState?.authenticated) {
        openAuthModal('interests');
        return;
      }
      if (state.interests.includes(tag)) {
        state.interests = state.interests.filter((x) => x !== tag);
        if (state.interests.length === 0) state.interests = ["general"];
      } else {
        // Make sure we never introduce duplicates
        state.interests = [...new Set([...(state.interests || []), tag])];
      }
      renderTags();
      if (state.mode === "feed") await fetchFeed();
    };
    tagsEl.appendChild(el);
  });
}

function applyTabs() {
  const feed = qs("tabFeed");
  const fav = qs("tabFav");
  if (state.mode === "feed") {
    feed.classList.add("on");
    fav.classList.remove("on");
  } else {
    fav.classList.add("on");
    feed.classList.remove("on");
  }

  const isTracking = (state.mode !== "feed");
  // Hide feed-only UI when in Tracking tab
  const controlsWrap = qs("controlsWrap");
  const showMoreWrap = qs("showMoreWrap");
  const btnRefresh = qs("btnRefresh");
  const selectedBar = qs("selectedBar");
  if (controlsWrap) controlsWrap.style.display = isTracking ? "none" : "";
  if (showMoreWrap) showMoreWrap.style.display = isTracking ? "none" : "";
  if (btnRefresh) btnRefresh.style.display = isTracking ? "none" : "";
  if (selectedBar) selectedBar.style.display = isTracking ? "none" : "";

  // Hide Top stories carousel (🔥) when in Tracking tab
  const topStories = document.getElementById("topStories");
  if (topStories) topStories.style.display = isTracking ? "none" : "";

  updateTrashZone();
  
function updateTrackingHint() {
  const el = qs('trackingHint');
  if (!el) return;
  const show = (state.mode === 'fav') && (getFavIds().length > 0);
  el.style.display = show ? 'block' : 'none';
}
updateTrackingHint();
  updateEmailAlertsUI();
}

function updateTrashZone() {
  const z = qs('trashZone');
  if (!z) return;

  const show = (state.mode === 'fav') && !!state.isDragging; // show only while dragging
  z.style.display = show ? 'grid' : 'none';
  z.setAttribute('aria-hidden', show ? 'false' : 'true');

  if (show) updateTrashZonePosition();
}

function updateTrashZonePosition() {
  const z = qs('trashZone');
  if (!z) return;

  const baseBottom = 92; // must match CSS bottom
  const footer = document.querySelector('footer');
  if (!footer) {
    z.style.bottom = `${baseBottom}px`;
    return;
  }

  const r = footer.getBoundingClientRect();

  if (r.top >= window.innerHeight) {
    z.style.bottom = `${baseBottom}px`;
    return;
  }

  const overlap = window.innerHeight - r.top;
  const extra = overlap > 0 ? (overlap + 24) : 0;
  z.style.bottom = `${baseBottom + extra}px`;
}

function itemMatchesSearch(item, q) {
  if (!q) return true;
  const qq = q.toLowerCase().trim();
  if (!qq) return true;
  if ((item.title || "").toLowerCase().includes(qq)) return true;
  for (const s of (item.sources || [])) {
    if ((s.title || "").toLowerCase().includes(qq)) return true;
    if ((s.source_name || "").toLowerCase().includes(qq)) return true;
  }
  return false;
}

function scoreClass(score) {
  if (score >= 80) return "good";
  if (score >= 60) return "warn";
  return "bad";
}

function clamp(n, a, b) {
  n = Number(n);
  if (!Number.isFinite(n)) n = a;
  return Math.max(a, Math.min(b, n));
}

function formatTimeHHMM(iso) {
  try {
    if (!iso) return "";
    const d = new Date(iso);
    if (Number.isNaN(d.getTime())) return "";
   return d.toLocaleTimeString('en-US', { hour: "2-digit", minute: "2-digit" });
  } catch {
    return "";
  }
}

function pickPrimarySourceName(item) {
  const s = Array.isArray(item?.sources) ? item.sources : [];
  const name = (s[0]?.source_name || "").trim();
  const fallback = String(item?.primary_source || "").trim();
  return name || fallback || "Unknown";
}

function keywordsFromTitle(title) {
  const t = String(title || "").toLowerCase();
  const words = t
    .replace(/[^a-z0-9\s-]/g, " ")
    .split(/\s+/)
    .map((w) => w.trim())
    .filter(Boolean)
    .filter((w) => w.length >= 4)
    .slice(0, 4);
  return words.length ? words.join(",") : "news";
}

function getNewsImage(item) {
  // Use an image ONLY if it is tied to the event.
  // Priority:
  // 1) cluster-level fields (if backend adds them later)
  // 2) any image fields from sources
  const direct = String(item?.image || item?.urlToImage || item?.image_url || "").trim();
  if (direct) return direct;

  const sources = Array.isArray(item?.sources) ? item.sources : [];
  for (const s of sources) {
    const u = String(s?.image || s?.urlToImage || s?.image_url || "").trim();
    if (u) return u;
  }

  // No relevant image found.
  return "";
}

function onImgErrorToFallback(imgEl) {
  // No random fallbacks. If the provided image fails, switch to a neutral placeholder.
  if (!imgEl) return;
  imgEl.dataset.fallbackStage = "placeholder";
  imgEl.src = "data:image/svg+xml;charset=utf-8," +
    encodeURIComponent(
      `<svg xmlns='http://www.w3.org/2000/svg' width='600' height='400'>
        <rect width='100%' height='100%' fill='#e9e9ee'/>
        <text x='50%' y='50%' dominant-baseline='middle' text-anchor='middle' fill='#8a8a96' font-family='system-ui, -apple-system, Segoe UI, Roboto, Arial' font-size='20'>No related image available</text>
      </svg>`
    );
}

// -----------------------------
// Top stories carousel (🔥)
// Driven by server-side: item.is_trending
// -----------------------------

const topCarouselState = {
  items: [],
  index: 0,
  timer: null,
  paused: false,
  inited: false,
};

function _topCarouselEls() {
  return {
    wrap: document.getElementById('topStories'),
    root: document.getElementById('topCarousel'),
    viewport: document.getElementById('topCarouselViewport'),
    track: document.getElementById('topCarouselTrack'),
    dots: document.getElementById('topCarouselDots'),
    prev: document.getElementById('topCarouselPrev'),
    next: document.getElementById('topCarouselNext'),
  };
}

function _pickTopStories(feedItems) {
  const arr = Array.isArray(feedItems) ? feedItems : [];

  // Prefer items with server-side trending flag.
  let tops = arr.filter(it => !!it?.is_trending);

  // If none are trending (rare), fall back to most "important" items.
  if (!tops.length) {
    tops = [...arr].sort((a, b) => {
      const ia = Number(a?.importance ?? 0);
      const ib = Number(b?.importance ?? 0);
      if (ia !== ib) return ib - ia;
      const sa = Number(a?.sources_count ?? (a?.sources ? a.sources.length : 0));
      const sb = Number(b?.sources_count ?? (b?.sources ? b.sources.length : 0));
      if (sa !== sb) return sb - sa;
      const ua = Date.parse(a?.updated_at || a?.latest_published_at || a?.created_at || '') || 0;
      const ub = Date.parse(b?.updated_at || b?.latest_published_at || b?.created_at || '') || 0;
      return ub - ua;
    });
  } else {
    // Keep deterministic but put "bigger" events first.
    tops = [...tops].sort((a, b) => {
      const sa = Number(a?.sources_count ?? (a?.sources ? a.sources.length : 0));
      const sb = Number(b?.sources_count ?? (b?.sources ? b.sources.length : 0));
      if (sa !== sb) return sb - sa;
      const ia = Number(a?.importance ?? 0);
      const ib = Number(b?.importance ?? 0);
      if (ia !== ib) return ib - ia;
      const ua = Date.parse(a?.updated_at || a?.latest_published_at || a?.created_at || '') || 0;
      const ub = Date.parse(b?.updated_at || b?.latest_published_at || b?.created_at || '') || 0;
      return ub - ua;
    });
  }

  // Keep it compact (premium hero, not a full list)
  return tops.slice(0, 6);
}

function _topCarouselStop() {
  if (topCarouselState.timer) {
    clearInterval(topCarouselState.timer);
    topCarouselState.timer = null;
  }
}

function _topCarouselStart() {
  _topCarouselStop();
  if (!topCarouselState.items || topCarouselState.items.length <= 1) return;
  topCarouselState.timer = setInterval(() => {
    if (topCarouselState.paused) return;
    topCarouselGo(topCarouselState.index + 1);
  }, 6000);
}

function topCarouselGo(nextIndex) {
  const els = _topCarouselEls();
  if (!els.track || !els.root) return;

  const n = topCarouselState.items.length;
  if (!n) return;

  let idx = Number(nextIndex) || 0;
  if (idx < 0) idx = n - 1;
  if (idx >= n) idx = 0;
  topCarouselState.index = idx;

  // Ensure we animate slide changes even after a drag (dragging sets transition:none).
  // Let the CSS transition apply by clearing inline override.
  els.track.style.transition = '';
  els.track.style.transform = `translateX(-${idx * 100}%)`;

  // dots
  if (els.dots) {
    const dots = els.dots.querySelectorAll('.topDot');
    dots.forEach((d, i) => {
      if (i === idx) d.classList.add('on');
      else d.classList.remove('on');
    });
  }
}

function _renderTopCarousel(items) {
  const els = _topCarouselEls();
  if (!els.root || !els.track || !els.dots || !els.wrap) return;

  const list = Array.isArray(items) ? items : [];
  topCarouselState.items = list;
  topCarouselState.index = 0;

  // If nothing to show, hide the whole block.
  if (!list.length) {
    els.wrap.style.display = 'none';
    els.track.innerHTML = '';
    els.dots.innerHTML = '';
    _topCarouselStop();
    return;
  }
  els.wrap.style.display = '';

  // Build slides
  els.track.innerHTML = '';
  for (const it of list) {
    const cid = Number(it?.cluster_id ?? it?.event_id ?? it?.id);
    const title = String(it?.title || '').trim() || 'Top story';
    const summary = String(it?.summary || '').trim();
    const sourceName = pickPrimarySourceName(it);
    const outlets = Number(it?.sources_count ?? (it?.sources ? it.sources.length : 0));
    const imgUrl = getNewsImage(it);

    const slide = document.createElement('div');
    slide.className = 'topSlide';
    slide.setAttribute('data-id', String(cid || ''));

    const left = document.createElement('div');
    left.className = 'topSlideLeft';

    const kicker = document.createElement('div');
    kicker.className = 'topKicker';
    kicker.innerHTML = `<span class="dot"></span><span>Top story</span>`;

    const h = document.createElement('h2');
    h.className = 'topTitle';
    h.textContent = title;

    const p = document.createElement('p');
    p.className = 'topSummary';
    p.textContent = summary || 'AI summary is being prepared. Open the card to view details and sources.';

    const meta = document.createElement('div');
    meta.className = 'topMeta';
    const pill = document.createElement('span');
    pill.className = 'topMetaPill';
    pill.innerHTML = `<span class="tiny">${escapeHtml(sourceName)}</span> · <span>${Number.isFinite(outlets) ? outlets : 0} outlets</span>`;
    meta.appendChild(pill);

    const cta = document.createElement('button');
    cta.type = 'button';
    cta.className = 'topCta';
    cta.textContent = 'Open story';

    const open = async (e) => {
      e.preventDefault();
      e.stopPropagation();
      if (!cid) return;
      // Open the same card from the feed (or inject and open if needed)
      await ensureItemInFeedAndOpen(cid);
    };

    slide.addEventListener('click', open);
    cta.addEventListener('click', open);

    left.appendChild(kicker);
    left.appendChild(h);
    left.appendChild(p);
    left.appendChild(meta);
    left.appendChild(cta);

    const right = document.createElement('div');
    right.className = 'topSlideRight';

    const img = document.createElement('img');
    img.className = 'topImage';
    img.alt = '';
    img.loading = 'lazy';
    img.decoding = 'async';
    if (imgUrl) img.src = imgUrl;
    else onImgErrorToFallback(img);
    img.onerror = () => onImgErrorToFallback(img);

    const overlay = document.createElement('div');
    overlay.className = 'topImageOverlay';

    right.appendChild(img);
    right.appendChild(overlay);

    slide.appendChild(left);
    slide.appendChild(right);
    els.track.appendChild(slide);
  }

  // Dots
  els.dots.innerHTML = '';
  for (let i = 0; i < list.length; i++) {
    const d = document.createElement('button');
    d.type = 'button';
    d.className = 'topDot' + (i === 0 ? ' on' : '');
    d.setAttribute('aria-label', `Go to top story ${i + 1}`);
    d.addEventListener('click', (e) => {
      e.preventDefault();
      e.stopPropagation();
      topCarouselGo(i);
      _topCarouselStart();
    });
    els.dots.appendChild(d);
  }

  // Nav buttons
  if (els.prev) {
    els.prev.onclick = (e) => {
      e.preventDefault();
      e.stopPropagation();
      topCarouselGo(topCarouselState.index - 1);
      _topCarouselStart();
    };
  }
  if (els.next) {
    els.next.onclick = (e) => {
      e.preventDefault();
      e.stopPropagation();
      topCarouselGo(topCarouselState.index + 1);
      _topCarouselStart();
    };
  }

  // Hover/focus pause
  if (els.root && !topCarouselState.inited) {
    topCarouselState.inited = true;

    const pause = () => { topCarouselState.paused = true; };
    const resume = () => { topCarouselState.paused = false; };
    els.root.addEventListener('mouseenter', pause);
    els.root.addEventListener('mouseleave', resume);
    els.root.addEventListener('focusin', pause);
    els.root.addEventListener('focusout', resume);

    // Drag / swipe (touch + mouse)
    let startX = 0;
    let lastX = 0;
    let startT = 0;
    let lastT = 0;
    let dragging = false;
    let moved = false;

    const isInteractiveTarget = (target) => {
      if (!target || !(target instanceof Element)) return false;
      // Don't hijack drags on buttons/links/inputs (e.g. "Open story", dots)
      return Boolean(target.closest('a,button,input,textarea,select,[role="button"]'));
    };

    const widthPx = () => Math.max(1, els.viewport?.clientWidth || els.root?.clientWidth || 1);
    const setDragTranslate = (dxPx) => {
      const w = widthPx();
      // Convert pixels -> % for smooth transforms (no layout reads in loops)
      const dxPct = (dxPx / w) * 100;
      const base = -topCarouselState.index * 100;
      els.track.style.transition = 'none';
      els.track.style.transform = `translate3d(${base + dxPct}%, 0, 0)`;
    };
    const snapBack = () => {
      els.track.style.transition = 'transform 420ms cubic-bezier(.2,.9,.2,1)';
      els.track.style.transform = `translate3d(${-topCarouselState.index * 100}%, 0, 0)`;
    };

    els.root.style.touchAction = 'pan-y'; // allow horizontal swipe, keep vertical scroll

    els.root.addEventListener('pointerdown', (e) => {
      if (e.button != null && e.button !== 0) return; // left button only
      if (isInteractiveTarget(e.target)) return;
      dragging = true;
      moved = false;
      startX = lastX = e.clientX;
      startT = lastT = performance.now();
      topCarouselState.paused = true;
      // stop auto-advance while dragging
      if (_topCarouselTimer) {
        clearInterval(_topCarouselTimer);
        _topCarouselTimer = null;
      }
      try { els.root.setPointerCapture(e.pointerId); } catch {}
      els.root.classList.add('isDragging');
    });

    els.root.addEventListener('pointermove', (e) => {
      if (!dragging) return;
      const dx = e.clientX - startX;
      // simple damping on edges
      const atStart = topCarouselState.index === 0;
      const atEnd = topCarouselState.index === (topCarouselState.items?.length ? (topCarouselState.items.length - 1) : 0);
      let dxAdj = dx;
      if ((atStart && dx > 0) || (atEnd && dx < 0)) dxAdj = dx * 0.35;
      if (Math.abs(dxAdj) > 6) moved = true;
      setDragTranslate(dxAdj);
      lastX = e.clientX;
      lastT = performance.now();
    });

    const endDrag = (e) => {
      if (!dragging) return;
      dragging = false;
      els.root.classList.remove('isDragging');

      const w = widthPx();
      const dx = (e?.clientX ?? lastX) - startX;
      const dt = Math.max(1, (performance.now() - startT));
      const vx = dx / dt; // px per ms

      // if user barely moved, just snap back and allow click
      if (!moved) {
        snapBack();
        topCarouselState.paused = false;
        _topCarouselStart();
        return;
      }

      const threshold = w * 0.18;
      const fling = Math.abs(vx) > 0.55;
      if (dx > threshold || (fling && vx > 0)) topCarouselGo(topCarouselState.index - 1);
      else if (dx < -threshold || (fling && vx < 0)) topCarouselGo(topCarouselState.index + 1);
      else snapBack();

      topCarouselState.paused = false;
      _topCarouselStart();
    };

    els.root.addEventListener('pointerup', endDrag);
    els.root.addEventListener('pointercancel', endDrag);

    // Prevent accidental clicks after a drag
    els.root.addEventListener('click', (e) => {
      if (moved) {
        e.preventDefault();
        e.stopPropagation();
        moved = false;
      }
    }, true);
  }

  // Reset position
  topCarouselGo(0);
  _topCarouselStart();
}

function updateTopStoriesCarousel(feedItems) {
  try {
    const tops = _pickTopStories(feedItems);
    _renderTopCarousel(tops);
  } catch (e) {
    console.warn('Top carousel failed:', e);
  }
}

function itemPassesFilters(item) {
  const sourcesCount = Number(item.sources_count ?? (item.sources ? item.sources.length : 0));
  const score = Number(item.score ?? item.credibility_score ?? item.credibility ?? item.trust_score ?? item.rating ?? 0);
  const minS = Number(state.filters.minScore ?? 0);
  const maxS = Number(state.filters.maxScore ?? 100);
  if (score < minS) return false;
  if (score > maxS) return false;

  // Extra filters
  if (state.filters.onlyConfirmed && sourcesCount < 2) return false;
  if (state.filters.onlyAiSummary) {
    const summaryText = String(item?.summary || '').trim();
    if (!summaryText) return false;
  }

  return true;
}

function normalizeStatus(x) {
  return String(x || "").trim().toLowerCase();
}

function getAiSummaryState(item) {
  const text = String(item?.summary || "").trim();
  const st = normalizeStatus(item?.summary_status);

  if (st === "skipped" || st === "locked") {
    return { status: "locked", text: "AI summary is available on Pro." };
  }
  if (text) {
    return { status: "ready", text };
  }
  // If backend reports a failure, don't show a scary error in UI.
  if (st === "failed") {
    return { status: "empty", text: "" };
  }
  // Default: generating / not ready yet.
  return { status: "loading", text: t("ui.loading","Loading…") };
}

function fmtI18n(key, params, fallback) {
  let s = t(key, fallback || "");
  if (!params || typeof params !== "object") return s;
  for (const [k, v] of Object.entries(params)) {
    s = s.replaceAll(`{${k}}`, String(v));
  }
  return s;
}

function translateScoreExplanationText(expl, factors) {
  const e = String(expl || "").trim();
  if (!e) return e;

  // Only translate known RU templates; otherwise return as-is.
  // Summary tiers
  if (/^Высокий балл:/i.test(e)) {
    return fmtI18n("score.summary.high", null, "High score: confirmed by multiple sources and/or reliable media.");
  }
  if (/^Средний балл:/i.test(e)) {
    return fmtI18n("score.summary.medium", null, "Medium score: some confirmation exists, but it is still limited or sources vary in quality.");
  }
  if (/^Низкий балл:/i.test(e)) {
    return fmtI18n("score.summary.low", null, "Low score: few independent confirmations and/or weaker source reputation.");
  }

  // If it contains the "negatives" suffix in RU
  if (/Есть факторы, которые снижают/i.test(e)) {
    // Replace only the suffix part if possible
    const base = e.replace(/\s*Есть факторы, которые снижают[^.]*\.?/i, "").trim();
    const baseT = translateScoreExplanationText(base, factors);
    const suffix = fmtI18n("score.summary.has_negatives", null, "Some factors reduce the score.");
    return (baseT ? `${baseT} ${suffix}` : suffix).trim();
  }

  return e;
}

function translateFactor(f) {
  const name = String(f?.name || "").trim();
  const desc = String(f?.description || "").trim();
  const impact = Number(f?.impact || 0);

  // Names
  const nameMap = {
    "Подтверждение источниками": "score.factor.confirmation.name",
    "Репутация источников": "score.factor.reputation.name",
    "Диверсификация источников": "score.factor.diversity.name",
    "Кликбейт/эмоциональная лексика": "score.factor.clickbait.name",
  };

  let outName = name;
  if (nameMap[name]) outName = t(nameMap[name], name);

  // Descriptions (RU patterns -> params)
  let outDesc = desc;

  if (/^Пока найден только один источник/i.test(desc)) {
    outDesc = t("score.factor.confirmation.desc.one", "Only one source found so far — limited confirmation.");
  } else if (/^Есть 2 независимых источника/i.test(desc)) {
    outDesc = t("score.factor.confirmation.desc.two", "There are 2 independent sources — confirmation starts to form.");
  } else {
    const m = desc.match(/Новость подтверждена\s+(\d+)\s+независимыми источниками(\s+—\s+сильный сигнал\.)?/i);
    if (m) {
      const n = m[1];
      const strong = !!m[2];
      outDesc = fmtI18n(
        strong ? "score.factor.confirmation.desc.many_strong" : "score.factor.confirmation.desc.many",
        { n },
        strong ? "Confirmed by {n} independent sources — strong signal." : "Confirmed by {n} independent sources."
      );
    }
  }

  const mRep = desc.match(/Средний вес:\s*([0-9.]+),\s*макс\.:\s*([0-9.]+)\./i);
  if (mRep) {
    outDesc = fmtI18n("score.factor.reputation.desc", { avg: mRep[1], max: mRep[2] }, "Average weight: {avg}, max: {max}.");
  }

  const mDiv = desc.match(/Доля сильных\/средних\/слабых \(нормировано\):\s*([0-9.]+)\./i);
  if (mDiv) {
    outDesc = fmtI18n("score.factor.diversity.desc", { share: mDiv[1] }, "Share of strong/medium/weak (normalized): {share}.");
  }

  if (/Заголовок содержит эмоциональные/i.test(desc)) {
    outDesc = t("score.factor.clickbait.desc", "The headline uses emotional or manipulative wording.");
  }

  return { name: outName, description: outDesc, impact };
}

function getWhyScoreState(item) {
  if (item?.guest_locked && !authState?.authenticated) {
    return { status: "locked", text: t("ui.guest_locked","Create an account to view full details.") };
  }
  const explRaw = String(item?.credibility_explanation || "").trim();
  const expl = (I18N_LANG && I18N_LANG !== 'ru') ? translateScoreExplanationText(explRaw, item?.credibility_factors) : explRaw;
  const factors = Array.isArray(item?.credibility_factors) ? item.credibility_factors : [];

  if (!expl && factors.length === 0) {
    return { status: "empty", text: "" };
  }

  // If scoring isn't really computed yet, show limited explanation.
  const notComputed = /score\s+is\s+not\s+computed\s+yet/i.test(expl) || /scoring\s+is\s+not\s+computed\s+yet/i.test(expl) || /скоринг\s+еще\s+не\s+рассчитан/i.test(expl);
  if (notComputed && factors.length === 0) {
    return { status: "empty", text: t("score.limited", "Score explanation is limited due to insufficient data") };
  }

  return { status: "ready", text: expl };
}

function isNoDiffMessage(text) {
  const t = String(text || "");
  return /существенных\s+различий/i.test(t) || /no\s+differences/i.test(t);
}

function getSourceDiffState(item) {
  const diffs = Array.isArray(item?.summary_diffs) ? item.summary_diffs : [];
  const facts = Array.isArray(item?.summary_facts) ? item.summary_facts : [];
  const uncertainties = Array.isArray(item?.summary_uncertainties) ? item.summary_uncertainties : [];

  // Treat a single "no differences" AI-produced line as no real diffs.
  const meaningfulDiffs = diffs.filter((d) => !isNoDiffMessage(d?.difference));

  const hasAny = meaningfulDiffs.length > 0 || facts.length > 0 || uncertainties.length > 0;
  if (!hasAny) return { status: "hidden" };

  const hasDiffs = meaningfulDiffs.length > 0;
  if (!hasDiffs) return { status: "ready", note: "All sources report consistent information", diffs: [] };

  return { status: "ready", note: "", diffs: meaningfulDiffs };
}

function collectDiffSourceNames(item) {
  const diffs = Array.isArray(item.summary_diffs) ? item.summary_diffs : [];
  const set = new Set();
  for (const d of diffs) {
    const srcs = Array.isArray(d?.sources) ? d.sources : [];
    for (const s of srcs) {
      const nm = String(s || "").trim();
      if (nm) set.add(nm);
    }
  }
  return set;
}

function renderEvidenceLine(label, ev) {
  if (!ev) return "";
  const name = escapeHtml(ev.source_name || ev.name || "");
  const title = escapeHtml(ev.title || "");
  const url = ev.url || "";
  if (!name && !title) return "";
  if (url) {
    return `<div class="evLine"><span class="evTag">${escapeHtml(label)}:</span> <b>${name}</b> — <a href="${url}" target="_blank" rel="noopener noreferrer">${title || url}</a></div>`;
  }
  return `<div class="evLine"><span class="evTag">${escapeHtml(label)}:</span> <b>${name}</b> — ${title}</div>`;
}

// ===== Incremental feed rendering (no full rerender on refresh) =====
// We keep DOM nodes for already rendered feed items and only prepend truly new ones.
let feedRenderedOrder = []; // array of string ids in DOM order (top -> bottom)
let feedRenderedSet = new Set();
let lastFeedSignature = ""; // used to decide when we can do an incremental update


function getItemId(it) {
  const id = it?.cluster_id ?? it?.event_id;
  return id == null ? '' : String(id);
}

function countRenderedNewsCards() {
  const cards = qs('cards');
  if (!cards) return 0;
  return cards.querySelectorAll('.newsCard').length;
}

function removeLastRenderedCard() {
  const cards = qs('cards');
  if (!cards) return;
  const list = cards.querySelectorAll('.newsCard');
  const last = list[list.length - 1];
  if (!last) return;
  const id = last.getAttribute('data-id') || '';
  // smooth collapse
  last.classList.add('isExiting');
  setTimeout(() => last.remove(), 230);
  if (id) {
    feedRenderedSet.delete(id);
    feedRenderedOrder = feedRenderedOrder.filter(x => x != id);
  }
}

function createCardElement(item, ctx, seen, idx) {
  const div = document.createElement('div');
  const id = Number(item.cluster_id ?? item.event_id);
  const idStr = String(id);
  div.setAttribute('data-id', idStr);

  const favOn = isFav(id);
  const sourcesCount = Number(item.sources_count ?? (item.sources ? item.sources.length : 0));

  // Be tolerant to backend/format changes (prevents showing 0/100 when the score exists under a different key)
  const score = clamp(
    item.credibility_score ?? item.credibility ?? item.score ?? item.rating ?? 0,
    0,
    100,
  );
  const importance = clamp(item.importance ?? 0, 0, 100);

  // Redesign: cards are always light; only the score badge switches black/white.
  div.className = 'newsCard';

  
  if (state.mode === 'fav') div.setAttribute('draggable','true');
// Tracking: allow drag-to-delete only inside Tracking tab.
  if (state.mode === 'fav') {
    div.setAttribute('draggable', 'true');
  } else {
    div.removeAttribute('draggable');
  }

  // "New" vs "Updated" is computed on the server so everyone sees the same label.
  const isNew = !!item.is_new;
  const metaTime = isNew
    ? (item.created_at || item.updated_at || item.latest_published_at)
    : (item.updated_at || item.latest_published_at || item.created_at);
  const metaHHMM = formatTimeHHMM(metaTime);
  const primarySource = pickPrimarySourceName(item);
  const metaLabel = isNew ? 'New' : 'Updated';
  const metaLine =
    `Source: ${escapeHtml(primarySource)} · ${sourcesCount} outlets · ${escapeHtml(item.country || 'world')} / ${escapeHtml(item.language || 'en')}` +
    (metaHHMM ? ` · ${metaLabel} ${escapeHtml(metaHHMM)}` : '');

  const diffState = getSourceDiffState(item);

  const diffSourceSet = new Set();
  if (diffState.status !== 'hidden') {
    for (const d of (diffState.diffs || [])) {
      const srcs = Array.isArray(d?.sources) ? d.sources : [];
      for (const nm0 of srcs) {
        const nm = String(nm0 || '').trim();
        if (nm) diffSourceSet.add(nm);
      }
    }
  }

  const sourcesHtml = (item.sources || [])
    .slice(0, 30)
    .map((s) => {
      const url = s.url || '#';
      const src = escapeHtml(s.source_name || 'unknown');
      const t = escapeHtml(s.title || '');
      const pub = s.published_at ? new Date(s.published_at).toLocaleString() : '';
      const mark = diffSourceSet.has(s.source_name) ? ` <span class="srcMark">diff</span>` : '';
      return `<div class="sourceRow">• <b>${src}</b>${mark} — <a href="${url}" target="_blank" rel="noopener noreferrer">${t || url}</a> <span class="muted">${escapeHtml(pub)}</span></div>`;
    })
    .join('');

  const factorsHtml = (item.credibility_factors || [])
    .map((f) => {
      const tf = (I18N_LANG && I18N_LANG !== 'ru') ? translateFactor(f) : { name: (f?.name||''), description: (f?.description||''), impact: Number(f?.impact||0) };
      const name = escapeHtml(tf.name || '');
      const desc = escapeHtml(tf.description || '');
      const impact = Number(tf.impact || 0);
      const sign = impact > 0 ? '+' : '';
      return `<div class="factor"><div><span class="impact">${sign}${impact}</span> — <b>${name}</b></div><div class="muted">${desc}</div></div>`;
    })
    .join('');

  // --- AI Summary states: loading | ready | empty | locked
  const aiState = getAiSummaryState(item);
  let summaryHtml = '';
  if (aiState.status === 'ready') {
    summaryHtml = `<div class="aiSummaryBlock" data-status="ready">
      <div class="aiSummaryTitle">${t("ui.ai_summary","AI Summary")}</div>
      <div class="aiSummaryText">${escapeHtml(aiState.text)}</div>
    </div>`;
  } else if (aiState.status === 'loading') {
    summaryHtml = `<div class="aiSummaryBlock" data-status="loading">
      <div class="aiSummaryTitle">${t("ui.ai_summary","AI Summary")}</div>
      <div class="aiSummaryText"><span class="muted">${escapeHtml(aiState.text)}</span></div>
    </div>`;
  } else if (aiState.status === 'locked') {
    summaryHtml = `<div class="aiSummaryBlock" data-status="locked">
      <div class="aiSummaryTitle">${t("ui.ai_summary","AI Summary")}</div>
      <div class="aiSummaryText"><span class="muted">${escapeHtml(aiState.text)}</span></div>
    </div>`;
  }

  const unconfirmed = sourcesCount <= 1 ? `<span class="chip chipDanger">${t("ui.unconfirmed","Unconfirmed")}</span>` : '';
  const changeBadges = '';

  // --- Why this score?
  const whyState = getWhyScoreState(item);
  let whyHtml = '';
  if (whyState.status === 'ready') {
    const expl = whyState.text
      ? `<div class="muted">${escapeHtml(whyState.text)}</div>`
      : `<div class="muted">${t("score.limited","Score explanation is limited due to insufficient data")}</div>`;
    whyHtml = `
        <details class="accordion">
          <summary class="accordionSummary">${t("ui.why_score","Why this score?")}</summary>
          <div class="accordionBody">
            ${expl}
            <div class="factors">${factorsHtml || '<div class="muted">${t("score.limited","Score explanation is limited due to insufficient data")}</div>'}</div>
          </div>
        </details>`;
  } else if (whyState.status === 'empty' && whyState.text) {
    whyHtml = `
        <details class="accordion">
          <summary class="accordionSummary">${t("ui.why_score","Why this score?")}</summary>
          <div class="accordionBody"><div class="muted">${escapeHtml(whyState.text)}</div></div>
        </details>`;
  }

  // --- Source differences
  const facts = Array.isArray(item.summary_facts) ? item.summary_facts : [];
  const uncertainties = Array.isArray(item.summary_uncertainties) ? item.summary_uncertainties : [];

  const factsHtml = facts.length
    ? `<div class="miniList">${facts.map(x => `<div>• ${escapeHtml(String(x))}</div>`).join('')}</div>`
    : '';

  const uncertaintiesHtml = uncertainties.length
    ? `<div class="miniList">${uncertainties.map(x => `<div>• ${escapeHtml(String(x))}</div>`).join('')}</div>`
    : '';

  let diffsSectionHtml = '';
  if (diffState.status !== 'hidden') {
    const topMsg = diffState.note ? `<div class="muted">${escapeHtml(diffState.note)}</div>` : '';
    const diffsHtml = (diffState.diffs || []).length
      ? `${(diffState.diffs || []).map((d) => {
          const diffText = escapeHtml(d?.difference || '');
          const srcs = Array.isArray(d?.sources) ? d.sources.map(x => String(x || '').trim()).filter(Boolean) : [];
          const srcLabel = srcs.length ? `<div class="muted" style="margin-bottom:6px;">Sources: ${escapeHtml(srcs.slice(0, 4).join(' vs '))}${srcs.length > 4 ? '…' : ''}</div>` : '';
          const evA = d?.a || null;
          const evB = d?.b || null;
          const evBlock = (evA || evB)
            ? `<div class="evBox">${renderEvidenceLine('A', evA)}${renderEvidenceLine('B', evB)}</div>`
            : '';
          return `<div class="diffItem">${srcLabel}<div>• ${diffText}</div>${evBlock}</div>`;
        }).join('')}`
      : '';

    diffsSectionHtml = `
        <details class="accordion">
          <summary class="accordionSummary">Source differences</summary>
          <div class="accordionBody">
            ${topMsg}
            ${diffsHtml}
            ${factsHtml ? `<div class="splitSmall"></div><div><b>Key facts</b>${factsHtml}</div>` : ''}
            ${uncertaintiesHtml ? `<div class="splitSmall"></div><div><b>Uncertainties</b>${uncertaintiesHtml}</div>` : ''}
          </div>
        </details>`;
  }

  const imageUrl = getNewsImage(item);
  const showThumb = !!state.showThumbs;
  const thumbHtml = showThumb
    ? `<div class="newsThumbWrap">${imageUrl ? `<img class="newsThumb" loading="lazy" alt="" src="${imageUrl}" />` : `<div class="newsThumbPh" aria-hidden="true"></div>`}</div>`
    : '';

  // Tracking-only UI (icon + delta like in the reference)
//
// IMPORTANT: delta must come from the server so every device sees the same Tracking changes.
// Backend should return `delta_score` (positive/negative) per tracked item.
const delta = Number(item?.delta_score ?? item?.delta ?? item?.credibility_delta ?? 0);
const hasDelta = Number.isFinite(delta) && delta !== 0;
const deltaDir = delta > 0 ? 'up' : delta < 0 ? 'down' : 'flat';
const deltaAbs = Math.abs(delta);

// Only show tracking delta + icon inside the Tracking tab.
const showTrackingUI = state.mode === 'fav';

  const historyHtml = showTrackingUI ? buildTrustHistorySectionHtml(item) : '';

  const dragHandleHtml = showTrackingUI
    ? `<span class=\"dragHandle\" title=\"Drag to delete\" aria-label=\"Drag to delete\">⋮⋮</span>`
    : '';

  const deltaHtml = (!showTrackingUI || !hasDelta || deltaDir === 'flat')
    ? ''
    : `<div class="delta ${deltaDir}">${deltaDir === 'up' ? '▲' : '▼'} ${deltaAbs}</div>`;

  const iconSrc = !showTrackingUI
    ? '/static/icons/Tracking.svg'
    : (deltaDir === 'down'
      ? '/static/icons/TrackingRed.svg'
      : (deltaDir === 'up'
        ? '/static/icons/TrackingGreen.svg'
        : '/static/icons/Tracking.svg'));
  const iconTone = deltaDir === 'down' ? 'red' : (deltaDir === 'up' ? 'green' : 'neutral');
  const iconHtml = !showTrackingUI
    ? ''
    : `<div class="trackIconWrap ${iconTone}" title="Tracking">
         <img class="trackIcon" src="${iconSrc}" alt="Tracking" />
       </div>`;

  // Share button (Feed + Tracking).
  const shareHtml = `<button class="shareBtn" type="button" title="Share" aria-label="Share">
    <img class="shareIcon" src="/static/icons/Share.svg" alt="Share" />
  </button>`;

  // Tracking toggle (replaces the old star button).
  // Visual contract:
  // - tracked   => white toggle
  // - not track => black toggle
  const trackToggleHtml = `<button class="trackToggle ${favOn ? 'on' : ''}" type="button" title="Tracking" aria-label="Tracking" data-track="${id}">
    <span class="trackDot"></span>
  </button>`;

  // Trending flame badge (server-side; consistent across devices)
  const isTrending = !!item.is_trending;
  const flameHtml = isTrending
    ? `<img class="newFlame" src="/static/icons/new.svg" alt="Trending" title="Trending" />`
    : '';

  div.innerHTML = `
    <div class="cardInner">
    <details class="newsDetails">
      <summary class="newsSummary">
        <div class="newsSummaryGrid">
          <div class="newsSummaryText">
            <div class="newsTopRow">
              <div class="newsTitle">${dragHandleHtml}${escapeHtml(item.title || 'Event')}</div>
              <div class="newsTopRight">
                ${flameHtml}
                ${trackToggleHtml}
                <div class="scoreBadge ${score < LOW_SCORE_THRESHOLD ? 'dark' : 'light'}">${score} / 100</div>
                ${deltaHtml}
                ${iconHtml}
                ${shareHtml}
              </div>
            </div>
            <div class="newsMeta">${metaLine}</div>
          </div>
          ${thumbHtml}
        </div>
      </summary>

      <div class="newsOpenBody">
        <div class="newsHero">
          ${summaryHtml}
          <div class="newsImageWrap" data-image-state="${imageUrl ? 'loading' : 'empty'}">
            ${imageUrl ? `<img class="newsImage" loading="lazy" alt="" src="${imageUrl}" data-fallback-stage="0" />` : `<div class="newsImagePlaceholder">No related image available</div>`}
          </div>
        </div>

        ${historyHtml}

        <div class="newsSubMeta">
          <span class="chip">Topic: <b>${escapeHtml(item.topic || 'general')}</b></span>
          <span class="chip">Importance: <b>${importance}</b>/100</span>
          <span class="chip">Outlets: <b>${sourcesCount}</b></span>
          ${unconfirmed}
          ${changeBadges}
          <span class="chip">${escapeHtml(item.country || 'world')}/${escapeHtml(item.language || 'en')}</span>
          <span class="chip">Latest: ${escapeHtml(item.latest_published_at ? new Date(item.latest_published_at).toLocaleString() : '')}</span>
        </div>
        ${whyHtml}
        ${diffsSectionHtml}

        <details class="accordion">
          <summary class="accordionSummary">Sources</summary>
          <div class="accordionBody">
            <div class="sourcesList">${sourcesHtml || '<div class="muted">Not enough sources yet.</div>'}</div>
          </div>
        </details>

        
      </div>
    </details>
    </div>
  `;

  // Guest access rules:
  // - Guests can open only the top 3 news items in the Feed.
  // - No blur/paywall overlay; instead we block opening locked items and show the auth modal.
  const isLocked = (!authState.authenticated && state.mode !== 'fav' && typeof idx === 'number')
    ? (idx >= 3)
    : (!!item.guest_locked && !authState.authenticated && state.mode !== 'fav');
  if (isLocked) {
    div.dataset.locked = '1';

    const detailsEl = div.querySelector('details.newsDetails');
    const summaryEl = div.querySelector('summary.newsSummary');

    const blockOpen = (e) => {
      if (authState?.authenticated) return false;
      if (e) {
        try { e.preventDefault(); } catch (_) {}
        try { e.stopPropagation(); } catch (_) {}
      }
      // Ensure the details is not left open
      if (detailsEl) detailsEl.open = false;
      openAuthModal('paywall');
      return true;
    };

    // Mouse / touch
    if (summaryEl) {
      summaryEl.addEventListener('click', (e) => {
        // Allow share clicks even for guests.
        const t = e?.target;
        if (t && typeof t.closest === 'function' && t.closest('.shareBtn')) return;
        // If user is a guest, prevent opening this item.
        if (!authState?.authenticated) blockOpen(e);
      }, { capture: true });

      // Keyboard (Enter / Space)
      summaryEl.addEventListener('keydown', (e) => {
        if (authState?.authenticated) return;
        if (e.key === 'Enter' || e.key === ' ') blockOpen(e);
      }, { capture: true });
    }

    // Safety: if something toggles it open anyway, close it.
    if (detailsEl) {
      detailsEl.addEventListener('toggle', () => {
        // Paywall guard for guests
        if (!authState?.authenticated && detailsEl.open) {
          detailsEl.open = false;
          openAuthModal('paywall');
          return;
        }

        // Tracking: keep delta visible until the user actually opens the card.
        // When opened in Tracking, ACK it so next refresh shows the new baseline.
        if (detailsEl.open && state.mode === 'fav') {
          ackTrackingDelta(id);
        }
      });
    }
  }

  const imgEl = div.querySelector('img.newsImage');
  if (imgEl) {
    imgEl.addEventListener('error', () => {
      if (imgEl.parentElement) imgEl.parentElement.dataset.imageState = 'error';
      onImgErrorToFallback(imgEl);
    });
    imgEl.addEventListener('load', () => {
      if (imgEl.parentElement) imgEl.parentElement.dataset.imageState = 'ready';
    });
  }

  // Share button should not toggle the details accordion.
  const shareBtn = div.querySelector('.shareBtn');
  if (shareBtn) {
    shareBtn.onclick = async (e) => {
      e.preventDefault();
      e.stopPropagation();
      await shareCluster(item);
    };
  }

  const trackBtn = div.querySelector(`[data-track="${id}"]`);
  if (trackBtn) {
    trackBtn.onclick = async (e) => {
      e.preventDefault();
      e.stopPropagation();

      if (!authState?.authenticated) {
        openAuthModal('tracking');
        return;
      }

      const nowOn = toggleFav(id);
      trackBtn.classList.toggle('on', nowOn);

      const n = getFavIds().length;
      const favCountEl = document.getElementById('favCount');
      if (favCountEl) favCountEl.textContent = String(n);
      const trackingCountEl = document.getElementById('trackingCount');
      if (trackingCountEl) trackingCountEl.textContent = String(n);

      // If we are currently viewing Tracking and the user removed it, refresh the list.
      if (state.mode === 'fav' && !nowOn) {
        await fetchFavorites();
      }
    };
  }

  // Drag-to-delete in Tracking tab
  div.addEventListener('dragstart', (e) => {
    if (state.mode !== 'fav') return;

    state.isDragging = true;
    updateTrashZone();

    try {
      e.dataTransfer.setData('text/plain', String(id));
      e.dataTransfer.effectAllowed = 'move';
    } catch (_) {}
    div.classList.add('isDragging');
  });
  div.addEventListener('dragend', () => {
    div.classList.remove('isDragging');
    state.isDragging = false;
    updateTrashZone();
  });

  

// Tracking: clear the sticky ▲/▼ indicator only when the user opens the card.
// (This prevents it from disappearing immediately on auto-refresh.)
const detailsOpenEl = div.querySelector('details.newsDetails');
if (detailsOpenEl) {
  detailsOpenEl.addEventListener('toggle', () => {
  // если мы сейчас анимируем открытие/закрытие — не трогаем DOM
  if (detailsOpenEl.dataset.animating === '1') {
    setTimeout(() => {
      // повторим после анимации
      if (detailsOpenEl.open && state.mode === 'fav') {
        clearTrackingDelta(id);
      }
    }, 360); // чуть больше твоих 340ms
    return;
  }

  if (detailsOpenEl.open && state.mode === 'fav') {
    clearTrackingDelta(id);
  }
});

  // Apply once for programmatic opens (deep links)
  const tw0 = div.querySelector('.newsThumbWrap');
  if (tw0) tw0.style.display = detailsOpenEl.open ? 'none' : '';
}

return div;
}

function updateCardElement(el, item, ctx, seen) {
  if (!el) return;
  const id = getItemId(item);
  const idStr = String(id);
  const score = clamp(
    item.credibility_score ?? item.credibility ?? item.score ?? item.rating ?? 0,
    0,
    100,
  );

  // Update score badge
  const scoreEl = el.querySelector('.scoreBadge');
  if (scoreEl) {
    scoreEl.textContent = `${score} / 100`;
    scoreEl.classList.toggle('dark', score < LOW_SCORE_THRESHOLD);
    scoreEl.classList.toggle('light', score >= LOW_SCORE_THRESHOLD);
  }

  // When switching tabs, ensure Tracking-specific UI doesn't "leak" into the feed.
  const trackingWrap = el.querySelector('.trackingWrap');
  if (trackingWrap) trackingWrap.style.display = (state.mode === 'fav') ? 'flex' : 'none';

  // Toggle draggable depending on tab
  if (state.mode === 'fav') el.setAttribute('draggable', 'true');
  else el.removeAttribute('draggable');

  // Update Trending flame visibility (server-driven)
  const shouldShowTrending = !!item.is_trending;

  const flame = el.querySelector('.newFlame');
  if (shouldShowTrending) {
    if (!flame) {
      const topRight = el.querySelector('.newsTopRight');
      if (topRight) {
        const img = document.createElement('img');
        img.className = 'newFlame';
        img.src = '/static/icons/new.svg';
        img.alt = 'Trending';
        img.title = 'Trending';
        // Put it before score badge for the same layout
        topRight.prepend(img);
      }
    }
  } else {
    if (flame) flame.remove();
  }
}


function renderCards(items, opts) {
  const options = opts || {};
  const now = Number.isFinite(Number(options.nowTs)) ? Number(options.nowTs) : Date.now();
  const newIds = (options.newIds instanceof Set) ? options.newIds : new Set();
  const suppressNewBadges = !!options.suppressNewBadges;
  const incremental = !!options.incremental;
  const animate = options.animate !== false;

  const cards = qs('cards');
  if (!cards) return;
  if (!incremental) {
    cards.innerHTML = '';
  }

  // Build an index of existing cards for incremental updates
  const existing = new Map();
  if (incremental) {
    cards.querySelectorAll('[data-id]').forEach((el) => {
      existing.set(String(el.getAttribute('data-id')), el);
    });
    // Remove previous "load more" block (we re-add it at the end).
    cards.querySelectorAll('.loadMoreWrap').forEach((el) => el.remove());
  }

  // Reset incremental feed index (used for prepend updates)
  feedRenderedOrder = [];
  feedRenderedSet = new Set();

  const q = (state.q || '').trim();

  const filtered = (items || [])
    .filter((it) => isUrlQuery(q) ? true : itemMatchesSearch(it, q))
    .filter((it) => itemPassesFilters(it));

  // IMPORTANT: do not sort on the client.
  // The server returns a deterministic order (and a time-bucketed snapshot),
  // so every device sees the same feed for the same interests.
  let visible = filtered;

  // Client sort (UI-driven).
  // Newest keeps the server order (deterministic), but we *stable-partition*
  // so "confirmed" items appear first.
  if (state.filters.sortOrder === 'newest') {
    const hi = [];
    const lo = [];
    for (const it of visible) {
      const s = Number(it.score ?? it.credibility_score ?? it.credibility ?? it.trust_score ?? it.rating ?? 0);
      // confirmed threshold is score-based (product decision)
      if (s < CONFIRMED_SCORE_THRESHOLD) lo.push(it);
      else hi.push(it);
    }
    visible = hi.concat(lo);
  }

  if (state.filters.sortOrder === 'low' || state.filters.sortOrder === 'high') {
    const dir = (state.filters.sortOrder === 'low') ? 1 : -1;
    visible = [...visible].sort((a, b) => {
      const sa = Number(a.score ?? a.credibility_score ?? a.credibility ?? a.trust_score ?? a.rating ?? 0);
      const sb = Number(b.score ?? b.credibility_score ?? b.credibility ?? b.trust_score ?? b.rating ?? 0);
      if (sa === sb) return 0;
      return (sa < sb ? -1 : 1) * dir;
    });
  }

  if (state.mode === 'feed' && !feedExpanded && filtered.length > FEED_PAGE_SIZE) {
    visible = visible.slice(0, FEED_PAGE_SIZE);
  }

  if (filtered.length === 0) {
    cards.innerHTML = `<div class="panel muted">${t("ui.no_results","No results")}</div>`;
    return;
  }

  const seen = loadSeenState();

  
const newFeedEls = [];
let newInsertIndex = 0;

for (let idx = 0; idx < visible.length; idx++) {
  const item = visible[idx];
  const idStr = getItemId(item);
  if (!idStr) continue;

  if (incremental && existing.has(idStr)) {
    // Keep position, only update small bits that don't cause jumps.
    updateCardElement(existing.get(idStr), item, { nowTs: now, newIds, suppressNewBadges }, seen);
    continue;
  }

  const el = createCardElement(item, { nowTs: now, newIds, suppressNewBadges }, seen, idx);

  // Animate only truly new items in feed.
  if (animate && !suppressNewBadges && state.mode === 'feed' && newIds.has(idStr)) {
    el.classList.add('appear');
    el.style.animationDelay = `${Math.min(newInsertIndex * 70, 700)}ms`;
    newInsertIndex += 1;
  }

  if (incremental && state.mode === 'feed') {
    newFeedEls.push(el);
  } else {
    cards.appendChild(el);
  }

  feedRenderedOrder.push(idStr);
  feedRenderedSet.add(idStr);
}

// Insert new feed cards at the top while preserving their order.
if (incremental && state.mode === 'feed' && newFeedEls.length) {
  for (let i = newFeedEls.length - 1; i >= 0; i -= 1) {
    cards.insertBefore(newFeedEls[i], cards.firstChild);
  }
}
// Load more UI (feed only)
  if (state.mode === 'feed' && filtered.length > FEED_PAGE_SIZE) {
    const total = filtered.length;
    const hiddenCountNow = Math.max(0, total - FEED_PAGE_SIZE);

    const wrap = document.createElement('div');
    wrap.className = 'loadMoreWrap';
    wrap.id = 'loadMoreWrap';

    const hint = document.createElement('div');
    hint.className = 'loadMoreHint';
   hint.textContent = feedExpanded
  ? t("ui.feed.shown").replace("{count}", total)
  : t("ui.feed.hidden").replace("{count}", hiddenCountNow);


    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'loadMoreBtn';

    if (feedExpanded) {
      btn.textContent = t("ui.feed.hide");

      btn.onclick = (e) => {
        e.preventDefault();
        e.stopPropagation();
        setFeedExpanded(false);
        window.scrollTo({ top: 0, behavior: 'smooth' });
      };
    } else {
      btn.textContent = t("ui.feed.show_more")
  .replace("{count}", hiddenCountNow);

      btn.onclick = (e) => {
        e.preventDefault();
        e.stopPropagation();
        if (!authState?.authenticated) {
          openAuthModal('show_more');
          return;
        }
        setFeedExpanded(true);
      };
    }

    wrap.appendChild(hint);
    wrap.appendChild(btn);
    cards.appendChild(wrap);
  }
}


// Build or update the "load more" block at the bottom of the feed.
function updateLoadMoreBlock(totalCount) {
  const cards = qs('cards');
  if (!cards) return;
  const existing = document.getElementById('loadMoreWrap');
  if (existing) existing.remove();

  if (state.mode !== 'feed') return;
  if (!(totalCount > FEED_PAGE_SIZE)) return;

  const hiddenCountNow = Math.max(0, totalCount - FEED_PAGE_SIZE);

  const wrap = document.createElement('div');
  wrap.className = 'loadMoreWrap';
  wrap.id = 'loadMoreWrap';

  const hint = document.createElement('div');
  hint.className = 'loadMoreHint';
  hint.textContent = feedExpanded
    ? t("ui.feed.shown","Showing {count} news").replace("{count}", totalCount)
    : t("ui.feed.hidden","Hidden {count} news").replace("{count}", hiddenCountNow);

  const btn = document.createElement('button');
  btn.type = 'button';
  btn.className = 'loadMoreBtn';

  if (feedExpanded) {
    btn.textContent = t("ui.feed.hide");

    btn.onclick = (e) => {
      e.preventDefault();
      e.stopPropagation();
      setFeedExpanded(false);
      window.scrollTo({ top: 0, behavior: 'smooth' });
    };
  } else {
    btn.textContent = t("ui.feed.show_more")
  .replace("{count}", hiddenCountNow);

    btn.onclick = (e) => {
      e.preventDefault();
      e.stopPropagation();
      if (!authState?.authenticated) {
        openAuthModal('show_more');
        return;
      }
      setFeedExpanded(true);
    };
  }

  wrap.appendChild(hint);
  wrap.appendChild(btn);
  cards.appendChild(wrap);
}

// Incremental update for feed: prepend new cards without re-rendering the entire list.
function incrementalUpdateFeed(sortedItems, opts) {
  const options = opts || {};
  const now = Number.isFinite(Number(options.nowTs)) ? Number(options.nowTs) : Date.now();
  const newIds = (options.newIds instanceof Set) ? options.newIds : new Set();
  const suppressNewBadges = !!options.suppressNewBadges;
  const incremental = !!options.incremental;
  const animate = options.animate !== false;

  const cards = qs('cards');
  if (!cards) return;

  const q = (state.q || '').trim();
  const filtered = (sortedItems || [])
    .filter((it) => isUrlQuery(q) ? true : itemMatchesSearch(it, q))
    .filter((it) => itemPassesFilters(it));

  // We only display a slice when collapsed.
  let visible = filtered;

  // Client sort (UI-driven).
  // Newest keeps the server order (deterministic).
  if (state.filters.sortOrder === 'low' || state.filters.sortOrder === 'high') {
    const dir = (state.filters.sortOrder === 'low') ? 1 : -1;
    visible = [...visible].sort((a, b) => {
      const sa = Number(a.score ?? a.credibility_score ?? a.credibility ?? a.trust_score ?? a.rating ?? 0);
      const sb = Number(b.score ?? b.credibility_score ?? b.credibility ?? b.trust_score ?? b.rating ?? 0);
      if (sa === sb) return 0;
      return (sa < sb ? -1 : 1) * dir;
    });
  }

  if (state.mode === 'feed' && !feedExpanded && filtered.length > FEED_PAGE_SIZE) {
    visible = visible.slice(0, FEED_PAGE_SIZE);
  }

  const seen = loadSeenState();

  // Determine truly new items compared to what is already rendered.
  const newVisibleItems = [];
  for (const it of visible) {
    const idStr = getItemId(it);
    if (idStr && !feedRenderedSet.has(idStr)) {
      newVisibleItems.push(it);
    }
  }

  if (newVisibleItems.length === 0) {
    // Still update load more text.
    updateLoadMoreBlock(filtered.length);
    return;
  }

  // Insert in correct order (keep sorted order at the top).
  const anchor = cards.querySelector('.newsCard') || document.getElementById('loadMoreWrap');
  const toInsert = [...newVisibleItems].reverse();

  for (const it of toInsert) {
    const idStr = getItemId(it);
    const el = createCardElement(it, { nowTs: now, newIds, suppressNewBadges }, seen);
    if (!suppressNewBadges && state.mode === 'feed' && newIds.has(idStr)) el.classList.add('appear');

    if (anchor) cards.insertBefore(el, anchor);
    else cards.prepend(el);

    feedRenderedSet.add(idStr);
    feedRenderedOrder.unshift(idStr);
  }

  // Keep the collapsed feed size stable.
  if (state.mode === 'feed' && !feedExpanded) {
    while (countRenderedNewsCards() > FEED_PAGE_SIZE) {
      removeLastRenderedCard();
    }
  }

  updateLoadMoreBlock(filtered.length);
}

async function fetchFeed(opts) {
  const options = opts || {};
  const quiet = !!options.quiet;
  const forceReset = !!options.reset;
  const signal = options.signal;

  const interests = encodeURIComponent((state.interests || []).join(","));
  const rawQ = (state.q || "").trim();
  const q = encodeURIComponent(rawQ);

  // If the user pasted a URL into Search, show similar items from the feed.
  const isUrl = /^https?:\/\//i.test(rawQ);

  const url = isUrl
    ? `${API_BASE}/api/news/similar?url=${q}` +
      `&ui_lang=${encodeURIComponent(state.language || "en")}`
    : `${API_BASE}/api/news?interests=${interests}` +
      `&country=${encodeURIComponent(state.country)}` +
      `&language=all` +
      `&ui_lang=${encodeURIComponent(state.language || "en")}` +
      (q ? `&q=${q}` : "");


  const feedKey = `${state.country}|${(state.interests || []).join(",")}|${(state.q || "").trim()}`;

  const keyChanged = (typeof currentFeedKey === "string") && (currentFeedKey !== feedKey);
  const shouldReset = forceReset || !currentFeedKey || keyChanged;

  // On first load (or after key reset), suppress NEW badges and avoid animations.
  const suppressNewBadges = !hasInitialFeedLoaded || shouldReset;

  if (!quiet) setStatus(t("ui.loading_feed","Loading feed..."));

  // Allow the caller to abort (we use this to prevent overlapping requests on slow hosts like Render)
  const res = await fetch(url, signal ? { signal } : undefined);
  if (!res.ok) {
    if (!quiet) setStatus(`${t("ui.error_api_news","Error /api/news")}: ${res.status}`);
    return;
  }

  const data = await res.json();
  const items = data.items || [];

  // keep cache for smooth expand/collapse
  lastFeedItems = items;

  // Update seen state first so first_seen_at is stable.
  const newIds = updateSeenStateFromItems(items);

  // Decide rendering mode
  currentFeedKey = feedKey;

  // Auto-refresh (quiet) — обновляем без сброса открытых карточек
const useIncremental = quiet && !shouldReset;

renderCards(items, {
  nowTs: Date.now(),
  newIds,
  suppressNewBadges,
  incremental: useIncremental,
  animate: false,
});

  // Hero carousel under header (top stories 🔥)
  updateTopStoriesCarousel(items);


  hasInitialFeedLoaded = true;


  const lastUpdatedEl = qs("lastUpdated");
  if (lastUpdatedEl) {
    lastUpdatedEl.textContent = t("ui.feed.meta")
  .replace("{time}", new Date().toLocaleString())
  .replace("{count}", items.length);

  }

  if (!quiet) setStatus("");
}


async function fetchFavorites(opts = {}) {
  if (!authState.authenticated) {
    openAuthModal('tracking');
    setStatus('');
    return;
  }

  // Require email verification for Tracking/Favorites (backend enforces too)
  if (authState.user && authState.user.provider === 'local' && !authState.user.email_verified) {
    openAuthModal('verify_required');
    setStatus('');
    return;
  }

  setStatus('Loading tracking…');

  try {
    const r = await fetch(`${API_BASE}/api/tracking`);
    if (r.status === 401) {
      authState = { authenticated: false, user: null };
      updateAuthUI();
      openAuthModal('tracking');
      return;
    }
    if (r.status === 403) {
      openAuthModal('verify_required');
      return;
    }
    const data = await r.json();
    const items = (data && data.items) ? data.items : [];

    lastFavItems = items;

    // Tracking page uses server-side deltas (delta_score / delta_sources_count)
    const useIncremental = !!opts.quiet && !opts.reset;
    renderCards(items, { nowTs: Date.now(), newIds: new Set(), suppressNewBadges: true, incremental: useIncremental, animate: false });

    // Hydrate trust history charts (server-side) for newly rendered cards
    if (!opts.quiet || opts.reset) hydrateTrustHistorySections();

    setStatus(items.length ? '' : 'Tracking is empty. Tap ★ on a news card to add.');
    updateCounts();
  } catch (e) {
    console.error(e);
    setStatus('Failed to load tracking.');
  }
}

async function ackTrackingDelta(clusterId) {
  try {
    if (!authState?.authenticated) return;
    const cid = Number(clusterId);
    if (!Number.isFinite(cid)) return;

    await fetch(`${API_BASE}/api/tracking/ack`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ ids: [cid] }),
    });

    // Update UI immediately (no full refetch)
    const card = document.querySelector(`.newsCard[data-id="${String(cid)}"]`);
    if (card) {
      const deltaEl = card.querySelector('.delta');
      if (deltaEl) deltaEl.remove();
      const icon = card.querySelector('img.trackIcon');
      if (icon) icon.src = '/static/icons/Tracking.svg';
      const wrap = card.querySelector('.trackIconWrap');
      if (wrap) {
        wrap.classList.remove('red', 'green');
        wrap.classList.add('neutral');
      }
    }

    // Also update cached items so later rerenders stay consistent
    const patchList = (arr) => {
      if (!Array.isArray(arr)) return;
      const it = arr.find(x => Number(x?.cluster_id ?? x?.id) === cid);
      if (it) {
        it.delta_score = 0;
        it.delta_sources_count = 0;
      }
    };
    patchList(lastFavItems);
    patchList(lastFeedItems);
  } catch (e) {
    // Non-fatal
    console.warn('ackTrackingDelta failed', e);
  }
}

// ✅ Keep header counters in sync (Tracking badge)
function updateCounts() {
  try {
    const n = (getFavIds() || []).length;

    // Old counter (hidden)
    const favCountEl = document.getElementById("favCount");
    if (favCountEl) favCountEl.textContent = String(n);

    // New header badge
    const trackingCountEl = document.getElementById("trackingCount");
    if (trackingCountEl) trackingCountEl.textContent = String(n);
  } catch (_) {
    // noop
  }
}


function startCooldown(seconds) {
  const now = Date.now();
  state.cooldownUntil = Math.max(state.cooldownUntil, now + seconds * 1000);
}

function tickCooldownUI() {
  const now = Date.now();
  const btn = qs("btnRefresh");
  if (!btn) return;
  if (state.cooldownUntil > now) {
    const left = Math.ceil((state.cooldownUntil - now) / 1000);
    btn.disabled = true;
    setStatus(`${t("ui.try_again","Try again")} (${left}s)`);
  } else {
    if (btn.disabled) {
      btn.disabled = false;
      setStatus("");
    }
  }
}

async function refreshBackend() {
  // "Refresh" now means "reload my feed". Ingest happens server-side on a schedule.
  setStatus(t("ui.loading","Loading…"));
  if (state.mode === "feed") await fetchFeed();
  else await fetchFavorites();
}


// ------------------------------
// Re-render current view (used by Filters UI)
// ------------------------------
function render() {
  try {
    const nowTs = Date.now();
    if (state.mode === 'feed') {
      renderCards(Array.isArray(lastFeedItems) ? lastFeedItems : [], {
        nowTs,
        newIds: new Set(),
        suppressNewBadges: true,
        incremental: false,
        animate: false,
      });
    } else if (state.mode === 'fav') {
      renderCards(Array.isArray(lastFavItems) ? lastFavItems : [], {
        nowTs,
        newIds: new Set(),
        suppressNewBadges: true,
        incremental: false,
        animate: false,
      });
    } else {
      renderCards(Array.isArray(lastFavItems) ? lastFavItems : [], {
        nowTs,
        newIds: new Set(),
        suppressNewBadges: true,
        incremental: false,
        animate: false,
      });
    }
  } catch (e) {
    console.warn('render() failed', e);
  }
}

function bindUI() {
  qs("country").value = state.country;
  qs("language").value = state.language;

  // Custom country/language picker UI (replaces Safari native select popover)
  try { initCountryDropdown(); } catch(_) {}
  try { initLanguageDropdown(); } catch(_) {}

  // Apply country/language immediately (we keep the hidden Save button for compatibility).
  qs("btnSave").onclick = async () => {
    state.country = qs("country").value;
    // setLanguage() also persists + refetches
    await setLanguage(qs("language").value, { persist: false, refetch: true });

    setFeedExpanded(false);
    savePrefs();
    if (state.mode === "feed") await fetchFeed();
    else await fetchFavorites();
  };

  // In the new UI we auto-apply on change.
  qs("country").onchange = qs("btnSave").onclick;
  qs("language").onchange = async () => { await setLanguage(qs("language").value); };
  // Search (text OR URL)
  const searchEl = qs("search");
  const btnSearch = qs("btnSearch");

  // Keep input in sync with state
  if (searchEl) searchEl.value = state.q || "";

  let __searchT = null;
  async function applySearch({ reset } = { reset: true }){
    if (!searchEl) return;
    state.q = String(searchEl.value || "");
    savePrefs();
    setFeedExpanded(false);
    if (state.mode === "feed") await fetchFeed({ reset: !!reset });
    else await fetchFavorites();
  }

  function scheduleSearch(){
    if (__searchT) clearTimeout(__searchT);
    __searchT = setTimeout(() => { applySearch({ reset: true }); }, 250);
  }

  if (btnSearch) btnSearch.onclick = () => applySearch({ reset: true });

  if (searchEl){
    // live typing (debounced)
    searchEl.addEventListener("input", scheduleSearch, { passive: true });
    // paste should apply quickly
    searchEl.addEventListener("paste", () => setTimeout(() => applySearch({ reset: true }), 0));
    // Enter applies instantly
    searchEl.addEventListener("keydown", (e) => {
      if (e.key === "Enter"){
        e.preventDefault();
        if (__searchT) clearTimeout(__searchT);
        applySearch({ reset: true });
        searchEl.blur();
      }
      if (e.key === "Escape"){
        searchEl.blur();
      }
    });
  }



  // filters init
  syncFiltersStateToUI();

  // Sort dropdown UI
  const sortWrap = qs('sortWrap');
  const sortBtn = qs('sortBtn');
  const sortMenu = qs('sortMenu');

  let __sortMenuCloseT = null;
  let __sortMenuOnEnd = null;

  function closeSortMenu(){
    if (!sortMenu || !sortBtn) return;
    if (sortMenu.hidden) return;

    sortBtn.setAttribute('aria-expanded','false');

    // kick off close animation
    sortMenu.classList.remove('open');
    sortMenu.classList.add('closing');

    // clean previous handlers/timeouts
    if (__sortMenuOnEnd) {
      sortMenu.removeEventListener('transitionend', __sortMenuOnEnd);
      __sortMenuOnEnd = null;
    }
    if (__sortMenuCloseT) clearTimeout(__sortMenuCloseT);

    __sortMenuOnEnd = (e)=>{
      // Only react to the menu's own transition end
      if (e && e.target !== sortMenu) return;
      if (__sortMenuCloseT) { clearTimeout(__sortMenuCloseT); __sortMenuCloseT = null; }
      sortMenu.hidden = true;
      sortMenu.classList.remove('closing');
      if (__sortMenuOnEnd) {
        sortMenu.removeEventListener('transitionend', __sortMenuOnEnd);
        __sortMenuOnEnd = null;
      }
    };

    sortMenu.addEventListener('transitionend', __sortMenuOnEnd);

    // fallback (in case transitionend doesn't fire on some mobile browsers)
    __sortMenuCloseT = setTimeout(()=>{ if (__sortMenuOnEnd) __sortMenuOnEnd(null); }, 320);
  }

  function openSortMenu(){
    if (!sortMenu || !sortBtn) return;

    // cancel close in-flight
    if (__sortMenuOnEnd) {
      sortMenu.removeEventListener('transitionend', __sortMenuOnEnd);
      __sortMenuOnEnd = null;
    }
    if (__sortMenuCloseT) { clearTimeout(__sortMenuCloseT); __sortMenuCloseT = null; }

    sortMenu.hidden = false;
    sortMenu.classList.remove('closing');
    sortBtn.setAttribute('aria-expanded','true');

    // two RAFs to guarantee the browser commits 'hidden=false' before we add .open
    requestAnimationFrame(()=>requestAnimationFrame(()=>{
      if (sortMenu) sortMenu.classList.add('open');
    }));
  }

  function toggleSortMenu(){
    if (!sortMenu || !sortBtn) return;
    if (sortMenu.hidden) openSortMenu();
    else closeSortMenu();
  }

  if (sortBtn && sortMenu) {
    sortBtn.addEventListener('click', (e)=>{
      e.preventDefault();
      toggleSortMenu();
    });

    document.addEventListener('click', (e)=>{
      if (!sortWrap || sortMenu.hidden) return;
      if (sortWrap.contains(e.target)) return;
      closeSortMenu();
    });

    document.addEventListener('keydown', (e)=>{
      if (e.key === 'Escape') closeSortMenu();
    });

    // Apply immediately on changes
    sortMenu.addEventListener('change', ()=>{
      applyFiltersUIToState();
      render();
    });

    const minEl = qs('scoreMin');
    const maxEl = qs('scoreMax');
    let __filtersCommitT = null;
    const commit = (immediate=false)=>{
      if (__filtersCommitT) clearTimeout(__filtersCommitT);
      const run = ()=>{ applyFiltersUIToState(); render(); };
      if (immediate) run();
      else __filtersCommitT = setTimeout(run, 120);
    };
    if (minEl) {
      minEl.addEventListener('input', ()=>commit(false));
      minEl.addEventListener('change', ()=>commit(true));
      minEl.addEventListener('blur', ()=>commit(true));
    }
    if (maxEl) {
      maxEl.addEventListener('input', ()=>commit(false));
      maxEl.addEventListener('change', ()=>commit(true));
      maxEl.addEventListener('blur', ()=>commit(true));
    }
  }

  // Tracking: drag-to-delete zone (cards can be dragged onto the trash)
  const z = qs('trashZone');
  if (z) {
    const onScrollOrResize = () => {
      if (state.mode === 'fav' && state.isDragging) updateTrashZonePosition();
    };
    window.addEventListener('scroll', onScrollOrResize, { passive: true });
    window.addEventListener('resize', onScrollOrResize);

    const clearOver = () => z.classList.remove('isOver');
    z.addEventListener('dragover', (e) => {
      if (state.mode !== 'fav') return;
      e.preventDefault();
      z.classList.add('isOver');
      try { e.dataTransfer.dropEffect = 'move'; } catch (_) {}
    });
    z.addEventListener('dragenter', (e) => {
      if (state.mode !== 'fav') return;
      e.preventDefault();
      z.classList.add('isOver');
    });
    z.addEventListener('dragleave', clearOver);
    z.addEventListener('drop', (e) => {
      if (state.mode !== 'fav') return;
      e.preventDefault();
      clearOver();
      state.isDragging = false;
      updateTrashZone();
      const id = String(e.dataTransfer?.getData('text/plain') || '').trim();
      if (!id) return;

      // Update storage + server
      const removed = removeFav(id);
      if (!removed) return;

      // Update cached list + UI smoothly
      lastFavItems = lastFavItems.filter(it => String(it.id) !== id);
      const el = document.querySelector(`.newsCard[data-id="${CSS.escape(id)}"]`);
      if (el) {
        el.classList.add('isExiting');
        setTimeout(() => el.remove(), 230);
      }

      // Update button/empty state
      updateShowMoreButton();
      if (lastFavItems.length === 0) {
        qs('cards').innerHTML = '';
        showEmptyState(true);
      }
    });
  }

  // Mini thumbnails toggle (near Interests)
  const thumbToggle = document.getElementById('thumbToggle');
  if (thumbToggle) {
    syncThumbToggleUI();
    thumbToggle.onchange = () => {
      state.showThumbs = !!thumbToggle.checked;
      saveThumbPrefs();
      syncThumbToggleUI();
      // Re-render current list (no network)
      if (state.mode === 'feed') {
        renderCards(lastFeedItems, { incremental: false });
      } else if (state.mode === 'fav') {
        renderCards(lastFavItems, { incremental: false });
      }
        };
  }

  // -----------------------------
  // Feed <-> Tracking tab switching (with premium transition)
  // -----------------------------
  async function setMode(nextMode){
    const mode = (nextMode === 'fav') ? 'fav' : 'feed';
    // Close any open menus (sort dropdown etc.)
    try { closeSortMenu(); } catch(e) {}

    // Use the premium transition function so BOTH directions animate.
    await switchMode(mode);
  }

  const tabFeed = qs('tabFeed');
  const tabFav  = qs('tabFav');
  if (tabFeed) tabFeed.onclick = () => { void setMode('feed'); };
  if (tabFav)  tabFav.onclick  = () => { void setMode('fav'); };

  const btnTracking = document.getElementById('btnTracking');
  if (btnTracking) {
    btnTracking.onclick = (e) => {
      e.preventDefault();
      e.stopPropagation();
      // Always open Tracking.
      // Do NOT toggle back to Feed on a second tap — this was causing accidental exits.
      if (state.mode !== 'fav') void setMode('fav');
    };
  }

}

// --- Dropdowns (custom, avoids Safari native select popover issues) ---
// --- Country dropdown ---
let __countryMenuOpen = false;

function closeCountryMenu(){
  const menu = document.getElementById('countryMenu');
  const btn  = document.getElementById('countryBtn');
  if (!menu || !btn) return;
  __countryMenuOpen = false;
  btn.setAttribute('aria-expanded','false');
  menu.classList.remove('open');
  window.setTimeout(()=>{ if(!__countryMenuOpen) menu.hidden = true; }, 120);
}

function openCountryMenu(){
  const menu = document.getElementById('countryMenu');
  const btn  = document.getElementById('countryBtn');
  if (!menu || !btn) return;
  __countryMenuOpen = true;
  menu.hidden = false;
  btn.setAttribute('aria-expanded','true');
  requestAnimationFrame(()=> menu.classList.add('open'));
}

function syncCountryBtnLabel(){
  const sel = document.getElementById('country');
  const val = document.getElementById('countryBtnValue');
  if (!sel || !val) return;
  const opt = sel.options[sel.selectedIndex];
  val.textContent = (opt && opt.textContent) ? opt.textContent : String(sel.value || '').toUpperCase();
}

function initCountryDropdown(){
  const sel = document.getElementById('country');
  const menu = document.getElementById('countryMenu');
  const btn  = document.getElementById('countryBtn');
  if (!sel || !menu || !btn) return;

  function rebuild(){
    menu.innerHTML = '';
    const current = String(sel.value || '');
    for (const opt of Array.from(sel.options || [])) {
      const v = String(opt.value || '');
      const label = String(opt.textContent || v).trim();
      const item = document.createElement('button');
      item.type = 'button';
      item.className = 'selectItem';
      item.setAttribute('role','menuitemradio');
      item.setAttribute('aria-checked', v === current ? 'true' : 'false');
      item.innerHTML = `<span>${escapeHtml(label)}</span><span class="selectCheck">${v === current ? '✓' : ''}</span>`;
      item.onclick = (e) => {
        e.preventDefault();
        e.stopPropagation();
        if (sel.value !== v){
          sel.value = v;
          syncCountryBtnLabel();
          sel.dispatchEvent(new Event('change', { bubbles: true }));
        }
        closeCountryMenu();
      };
      menu.appendChild(item);
    }
  }

  rebuild();
  syncCountryBtnLabel();

  btn.onclick = (e) => {
    e.preventDefault();
    e.stopPropagation();
    try { closeSortMenu(); } catch(_) {}
    try { closeLanguageMenu(); } catch(_) {}
    if (__countryMenuOpen) closeCountryMenu();
    else { rebuild(); openCountryMenu(); }
  };

  sel.addEventListener('change', () => {
    syncCountryBtnLabel();
    if (__countryMenuOpen) rebuild();
  });

  document.addEventListener('click', (e) => {
    if (!__countryMenuOpen) return;
    const wrap = document.getElementById('countryWrap');
    if (wrap && e.target instanceof Node && wrap.contains(e.target)) return;
    closeCountryMenu();
  }, { passive: true });

  document.addEventListener('keydown', (e) => {
    if (!__countryMenuOpen) return;
    if (e.key === 'Escape') closeCountryMenu();
  });
}

// --- Language dropdown (custom, avoids Safari native select popover issues) ---
let __langMenuOpen = false;

function closeLanguageMenu(){
  const menu = document.getElementById('languageMenu');
  const btn  = document.getElementById('languageBtn');
  if (!menu || !btn) return;
  __langMenuOpen = false;
  btn.setAttribute('aria-expanded','false');
  menu.classList.remove('open');
  window.setTimeout(()=>{ if(!__langMenuOpen) menu.hidden = true; }, 120);
}

function openLanguageMenu(){
  const menu = document.getElementById('languageMenu');
  const btn  = document.getElementById('languageBtn');
  if (!menu || !btn) return;
  __langMenuOpen = true;
  menu.hidden = false;
  btn.setAttribute('aria-expanded','true');
  requestAnimationFrame(()=> menu.classList.add('open'));
}

function syncLanguageBtnLabel(){
  const sel = document.getElementById('language');
  const val = document.getElementById('languageBtnValue');
  if (!sel || !val) return;
  const opt = sel.options[sel.selectedIndex];
  val.textContent = (opt && opt.textContent) ? opt.textContent : String(sel.value || '').toUpperCase();
}

function initLanguageDropdown(){
  const sel = document.getElementById('language');
  const menu = document.getElementById('languageMenu');
  const btn  = document.getElementById('languageBtn');
  if (!sel || !menu || !btn) return;

  function rebuild(){
    menu.innerHTML = '';
    const current = String(sel.value || '');
    for (const opt of Array.from(sel.options || [])) {
      const v = String(opt.value || '');
      const label = String(opt.textContent || v).trim();
      const item = document.createElement('button');
      item.type = 'button';
      item.className = 'selectItem';
      item.setAttribute('role','menuitemradio');
      item.setAttribute('aria-checked', v === current ? 'true' : 'false');
      item.innerHTML = `<span>${escapeHtml(label)}</span><span class="selectCheck">${v === current ? '✓' : ''}</span>`;
      item.onclick = (e) => {
        e.preventDefault();
        e.stopPropagation();
        if (sel.value !== v){
          sel.value = v;
          syncLanguageBtnLabel();
          sel.dispatchEvent(new Event('change', { bubbles: true }));
        }
        closeLanguageMenu();
      };
      menu.appendChild(item);
    }
  }

  rebuild();
  syncLanguageBtnLabel();

  btn.onclick = (e) => {
    e.preventDefault();
    e.stopPropagation();
    try { closeSortMenu(); } catch(_) {}
    try { closeCountryMenu(); } catch(_) {}
    if (__langMenuOpen) closeLanguageMenu();
    else { rebuild(); openLanguageMenu(); }
  };

  sel.addEventListener('change', () => {
    syncLanguageBtnLabel();
    if (__langMenuOpen) rebuild();
  });

  document.addEventListener('click', (e) => {
    if (!__langMenuOpen) return;
    const wrap = document.getElementById('languageWrap');
    if (wrap && e.target instanceof Node && wrap.contains(e.target)) return;
    closeLanguageMenu();
  }, { passive: true });

  document.addEventListener('keydown', (e) => {
    if (!__langMenuOpen) return;
    if (e.key === 'Escape') closeLanguageMenu();
  });
}




async function refreshBackendQuiet() {
  // Server now ingests on a schedule. Clients should not trigger ingest.
  return;
}

async function autoUpdateTick(trigger) {
  // Fetch and incrementally insert new cards.
  if (state.mode === "feed") await fetchFeed({ quiet: true });
  else await fetchFavorites();
}

function initSmartHeader() {
  const header = document.getElementById('siteHeader') || document.querySelector('header');
  if (!header) return;
  header.classList.add('siteHeader');

  // Ensure content is not hidden behind the fixed header.
  // (CSS uses --headerH for padding-top.)
  const applyHeaderHeight = () => {
    const h = Math.max(48, Math.round(header.getBoundingClientRect().height || 0));
    document.documentElement.style.setProperty('--headerH', `${h}px`);
  };
  applyHeaderHeight();

  // Robust scroll position getter (works even if the page uses a scroll container).
  const getScrollY = () => {
    const se = document.scrollingElement;
    if (se) return se.scrollTop || 0;
    return window.scrollY || document.documentElement.scrollTop || document.body.scrollTop || 0;
  };

  let lastY = getScrollY();
  let ticking = false;

  // Tune these to feel “premium” and avoid jitter.
  const DELTA = 10;         // ignore tiny scroll noise
  const HIDE_AFTER = 80;    // only start hiding after some content
  const SHOW_AT_TOP = 8;    // always show near the top

  function update() {
    ticking = false;
    const y = getScrollY();
    const dy = y - lastY;

    if (Math.abs(dy) < DELTA) {
      lastY = y;
      return;
    }

    if (y <= SHOW_AT_TOP) {
      header.classList.remove('isHidden');
      lastY = y;
      return;
    }

    if (dy > 0 && y > HIDE_AFTER) {
      // scrolling down -> hide
      header.classList.add('isHidden');
    } else if (dy < 0) {
      // scrolling up -> show
      header.classList.remove('isHidden');
    }

    lastY = y;
  }

  const onScroll = () => {
    if (ticking) return;
    ticking = true;
    window.requestAnimationFrame(update);
  };

  // Listen on both window and document to catch scrolls in all setups.
  window.addEventListener('scroll', onScroll, { passive: true });
  document.addEventListener('scroll', onScroll, { passive: true, capture: true });

  // If layout changes (rotation/resize), keep header accessible.
  window.addEventListener('resize', () => {
    header.classList.remove('isHidden');
    applyHeaderHeight();
  }, { passive: true });
 }

async function main() {
  const hadPrefs = !!localStorage.getItem(STORAGE_KEY);
  loadPrefs();
  loadFilters();
  loadThumbPrefs();

  // Auto language on first visit (browser preference)
  if (!hadPrefs) {
    state.language = detectBrowserLang();
  }
  await loadI18n(state.language);
  applyI18nToDOM();

  // Capture deep-link request early (before auth/feed fetch)
  const dl = readDeepLinkParams();
  if (dl.id) {
    pendingOpenClusterId = dl.id;
    pendingOpenRequiresAuth = !!dl.shared;
  }

  setFavIds(getFavIds());

  bindAuthModalUI();
  bindPricingUI();
  await refreshAuthState();
  await handleAuthQueryParams();
  await handleBillingQueryParams();

  bindUI();
  initSmartHeader();
  initCookieBanner();
  renderTags();
  syncThumbToggleUI();
  applyTabs();

  // initial load
  await fetchFeed({ reset: true });

  // If we arrived via a shared URL (/?open=...), open that article card.
  await maybeOpenDeepLinkedArticle();

  /**
   * Auto refresh strategy (Render can be slow):
   * - never run overlapping requests
   * - throttle visibility/focus refreshes
   * - keep the feed fresh while tab is visible, but without spamming
   */
  const AUTO_REFRESH_MS = 60 * 1000;      // baseline: 1 min while visible
  const WAKE_THROTTLE_MS = 15 * 1000;     // focus/visibility won't refresh more often than this
  let lastFetchAt = 0;
  let inFlight = null;

  async function safeRefresh(reason, opts = {}) {
    const now = Date.now();

    // Do nothing while hidden
    if (document.hidden) return;

    // Only refresh the active mode
    const isFeed = state.mode === 'feed';

    // Throttle wake-up spam (some browsers fire focus + visibility together)
    if ((reason === 'focus' || reason === 'visible') && (now - lastFetchAt) < WAKE_THROTTLE_MS) {
      return;
    }

    // Don't overlap network requests
    if (inFlight) return inFlight;

    inFlight = (async () => {
      try {
        if (isFeed) await fetchFeed(opts);
        else await fetchFavorites(opts);
        lastFetchAt = Date.now();
      } finally {
        inFlight = null;
      }
    })();

    return inFlight;
  }

  // Refresh when user comes back to the tab (after sleep/background throttling)
  document.addEventListener('visibilitychange', () => {
    if (!document.hidden) void safeRefresh('visible', { quiet: true });
  });
  window.addEventListener('focus', () => void safeRefresh('focus', { quiet: true }));

  // Periodic refresh while visible
  setInterval(() => {
    if (document.hidden) return;
    void safeRefresh('interval', { quiet: true });
  }, AUTO_REFRESH_MS);

  // cooldown UI tick (UI only; keep it light)
  setInterval(tickCooldownUI, 1000);

  // NOTE: Disabled page-level left/right swipe navigation (Feed <-> Tracking)
  // because it conflicts with carousel/news swipes on mobile.
  // Users should switch views only via the Tracking button.
  // setupSwipeNavigation();
}

const monthlyBtn = document.getElementById("billMonthly");
const yearlyBtn  = document.getElementById("billYearly");

const prices = document.querySelectorAll(".planPriceBig");

function setBilling(mode){
  prices.forEach(el => {
    const monthly = parseFloat(el.dataset.monthly);
    const yearly  = parseFloat(el.dataset.yearly);

    const oldSpan = el.querySelector(".oldPrice");
    const newSpan = el.querySelector(".newPrice");

    if(mode === "monthly"){
      oldSpan.textContent = "";
      newSpan.textContent = `$${monthly.toFixed(2)}`;
    }

    if(mode === "yearly"){
      // старая цена = monthly * 12
      const old = monthly * 12;

      oldSpan.textContent = `$${old.toFixed(2)}`;
      newSpan.textContent = `$${yearly.toFixed(2)}`;
    }
  });

  monthlyBtn.classList.toggle("on", mode === "monthly");
  yearlyBtn.classList.toggle("on", mode === "yearly");
}

monthlyBtn.onclick = () => setBilling("monthly");
yearlyBtn.onclick  = () => setBilling("yearly");

// старт
setBilling("monthly");

// ===== Account dropdown =====
const btnAccount = document.getElementById("btnAccount");
const accountMenu = document.getElementById("accountMenu");

const menuProfile = document.getElementById("menuProfile");
const menuPricing = document.getElementById("menuPricing");
const menuLogout = document.getElementById("menuLogout");

// открыть/закрыть меню
btnAccount.addEventListener("click", (e) => {
  // If not logged in, the Account button behaves like Login.
  if (!authState.authenticated) {
    openAuthModal('login');
    return;
  }
  e.stopPropagation();
  accountMenu.classList.toggle("open");
});

// закрывать при клике вне
document.addEventListener("click", (e) => {
  if (!accountMenu.contains(e.target) && !btnAccount.contains(e.target)) {
    accountMenu.classList.remove("open");
  }
});

// ✅ Profile click
if(menuProfile){
  menuProfile.addEventListener("click", () => {
    accountMenu.classList.remove("open");
    location.hash = '#/account';
  });
}

// ✅ Pricing click
if(menuPricing){
  menuPricing.addEventListener("click", () => {
    accountMenu.classList.remove("open");
    location.hash = '#/pricing';
  });
}

// ✅ Logout click
menuLogout.addEventListener("click", async () => {
  accountMenu.classList.remove("open");

  try {
    // Cookie session logout
    const res = await fetch("/api/auth/logout", {
      method: "POST",
      credentials: "include",
    });

    // 2) если у тебя токены в localStorage/sessionStorage — очищаем на всякий
    localStorage.removeItem("access_token");
    localStorage.removeItem("token");
    localStorage.removeItem("user");
    sessionStorage.removeItem("access_token");
    sessionStorage.removeItem("token");

    if (!res.ok) {
      // иногда backend возвращает 204 без тела — это ок, но !ok значит 4xx/5xx
      const txt = await res.text().catch(() => "");
      console.error("Logout failed:", res.status, txt);
      alert("Logout failed. Check console.");
      return;
    }

    // Update in-memory state + UI
    authState = { authenticated: false, user: null };
    billingState = null;
    updateAuthUI();
    updatePricingUI();

    alert("Logged out!");

  } catch (e) {
    console.error(e);
    alert("Network error while logging out.");
  }
});

function initCookieBanner() {
  const key = "cookie_banner_ok_v1";
  const banner = document.getElementById("cookie-banner");
  const btn = document.getElementById("cookie-accept");
  if (!banner || !btn) return;

  // If already accepted -> don't show
  if (localStorage.getItem(key) === "1") return;

  banner.style.display = "block";

  btn.addEventListener("click", () => {
    localStorage.setItem(key, "1");
    banner.style.display = "none";
  });
}

// ------------------------------
// Smooth <details> animations
// ------------------------------
// Native <details> opens instantly. We intercept clicks on summaries and
// animate the content container height + opacity.
let _smoothDetailsInit = false;

function _animateDetails(detailsEl, contentEl, shouldOpen){
  if (!detailsEl || !contentEl) return;
  if (detailsEl.dataset.animating === '1') return;

  const prefersReduced = !!(window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches);
  if (prefersReduced){
    detailsEl.open = !!shouldOpen;
    // clear inline styles
    contentEl.style.height = '';
    contentEl.style.opacity = '';
    contentEl.style.transform = '';
    contentEl.style.transition = '';
    return;
  }

  const duration = 340;
  const ease = 'cubic-bezier(.16,1,.3,1)';

  detailsEl.dataset.animating = '1';
  contentEl.style.overflow = 'hidden';

// Apple-like smoothness: images loading can change scrollHeight mid-animation and cause "jank".
// Watch size changes while animating and smoothly retarget the height.
const stopResizeWatch = () => {
  try { if (contentEl._smoothRO) contentEl._smoothRO.disconnect(); } catch {}
  contentEl._smoothRO = null;
};

const startResizeWatch = () => {
  stopResizeWatch();
  if (!('ResizeObserver' in window)) return;
  try {
    const ro = new ResizeObserver(() => {
      if (detailsEl.dataset.animating !== '1') return;
      if (!detailsEl.open) return;
      contentEl.style.height = `${contentEl.scrollHeight}px`;
    });
    ro.observe(contentEl);
    contentEl._smoothRO = ro;
  } catch {}
};


  const cleanup = () => {
    detailsEl.dataset.animating = '';
    contentEl.style.height = '';
    contentEl.style.opacity = '';
    contentEl.style.transform = '';
    contentEl.style.transition = '';
    stopResizeWatch();
    // allow normal layout after animation
    if (detailsEl.open) contentEl.style.overflow = 'visible';
  };

  if (shouldOpen){
    detailsEl.open = true;
    // start from 0
    contentEl.style.height = '0px';
    contentEl.style.opacity = '0';
    contentEl.style.transform = 'translateY(-6px)';

    // measure after open
    const endH = contentEl.scrollHeight;
    startResizeWatch();
    requestAnimationFrame(() => {
      contentEl.style.transition = `height ${duration}ms ${ease}, opacity ${duration}ms ${ease}, transform ${duration}ms ${ease}`;
      contentEl.style.height = `${endH}px`;
      contentEl.style.opacity = '1';
      contentEl.style.transform = 'translateY(0)';
    });

    const onEnd = (e) => {
      if (e && e.target !== contentEl) return;
      contentEl.removeEventListener('transitionend', onEnd);
      cleanup();
    };
    contentEl.addEventListener('transitionend', onEnd);
  } else {
    // closing
    stopResizeWatch();
    const startH = contentEl.scrollHeight;
    contentEl.style.height = `${startH}px`;
    contentEl.style.opacity = '1';
    contentEl.style.transform = 'translateY(0)';

    requestAnimationFrame(() => {
      contentEl.style.transition = `height ${duration}ms ${ease}, opacity ${duration}ms ${ease}, transform ${duration}ms ${ease}`;
      contentEl.style.height = '0px';
      contentEl.style.opacity = '0';
      contentEl.style.transform = 'translateY(-6px)';
    });

    const onEnd = (e) => {
      if (e && e.target !== contentEl) return;
      contentEl.removeEventListener('transitionend', onEnd);
      detailsEl.open = false;
      cleanup();
    };
    contentEl.addEventListener('transitionend', onEnd);
  }
}

function initSmoothDetails(){
  if (_smoothDetailsInit) return;
  _smoothDetailsInit = true;

  // Use capture so we can prevent the native toggle before it happens.
  document.addEventListener('click', (e) => {
    const sum = e.target && e.target.closest ? e.target.closest('summary.accordionSummary, summary.newsSummary') : null;
    if (!sum) return;

    const detailsEl = sum.parentElement;
    if (!detailsEl || detailsEl.tagName !== 'DETAILS') return;

    // Ignore clicks on interactive elements inside the summary (buttons/links etc.)
    if (sum.classList.contains('newsSummary')){
      if (e.target.closest('button, a, input, textarea, select, .trackToggle, .shareBtn, .iconBtn')) return;
      const body = detailsEl.querySelector('.newsOpenBody');
      if (!body) return;
      e.preventDefault();
      e.stopPropagation();
      _animateDetails(detailsEl, body, !detailsEl.open);
      return;
    }

    if (sum.classList.contains('accordionSummary')){
      const body = detailsEl.querySelector('.accordionBody');
      if (!body) return;
      e.preventDefault();
      e.stopPropagation();
      _animateDetails(detailsEl, body, !detailsEl.open);
    }
  }, true);
}


requestAnimationFrame(updateFooterShadeGap);
initSmoothDetails();
main();


let _emailAlertsInit = false;
let _emailAlertsLast = null;

async function updateEmailAlertsUI(){
  const wrap = qs('trackingSettings');
  const toggle = qs('emailAlertsToggle');
  if (!wrap || !toggle) return;

  const inTracking = (state.mode === 'fav');
  const loggedIn = !!(authState && authState.user && authState.user.email);

  wrap.style.display = (inTracking && loggedIn) ? 'flex' : 'none';
  if (!(inTracking && loggedIn)) return;

  // init listener once
  if (!_emailAlertsInit){
    _emailAlertsInit = true;
    toggle.addEventListener('change', async () => {
      const enabled = !!toggle.checked;
      try{
        const r = await fetch('/api/alerts/email', {
          method:'POST',
          headers:{'Content-Type':'application/json'},
          credentials:'include',
          body: JSON.stringify({ enabled })
        });
        const data = await r.json().catch(()=>({}));
        _emailAlertsLast = !!data.enabled;
        toggle.checked = _emailAlertsLast;
      }catch(e){
        // revert UI on error
        if (_emailAlertsLast !== null) toggle.checked = _emailAlertsLast;
      }
    });
  }

  // if we already have value from /api/auth/me
  if (typeof authState.user.email_alerts_enabled !== 'undefined'){
    toggle.checked = !!authState.user.email_alerts_enabled;
    _emailAlertsLast = !!toggle.checked;
  }

  // refresh from server (cheap)
  try{
    const r = await fetch('/api/alerts/email', { credentials:'include' });
    const data = await r.json().catch(()=>({}));
    const enabled = !!data.enabled;
    _emailAlertsLast = enabled;
    toggle.checked = enabled;
  }catch(e){
    // ignore
  }


}


// -------------------------
// Trust score history interactions (tooltip on dots)
// -------------------------
async function hydrateTrustHistorySections() {
  const wraps = Array.from(document.querySelectorAll('.trustHistoryWrap[data-trust-cid]'));
  for (const w of wraps) {
    if (w.dataset.trustHydrated === '1') continue;
    const cid = Number(w.getAttribute('data-trust-cid') || w.dataset.trustCid);
    if (!Number.isFinite(cid)) continue;

    const points = await fetchTrustHistory(cid, 80);
    if (!points || !points.length) {
      // No history yet: hide section
      w.style.display = 'none';
      w.dataset.trustHydrated = '1';
      continue;
    }

    // Controls live in the header to avoid overlapping the tooltip.
    // IMPORTANT: inject controls before initTrustHistoryZoom so listeners can bind.
    const slot = w.querySelector('.trustChartControlsSlot');
    if (slot) {
      slot.innerHTML = buildTrustHistoryControlsHtml();
      slot.setAttribute('aria-hidden', 'false');
    }

    // Render SVG
    const svg = buildTrustHistorySvg(points);
    const chartCard = w.querySelector('.trustChartCard');
    if (chartCard) {
      chartCard.innerHTML = `${svg}<div class="trustTooltip" aria-hidden="true"></div>`;
      // zoom/pan setup (safe even if user never interacts)
      initTrustHistoryZoom(chartCard);
    }

    // Stats
    const scores = points.map(p => Number(p.score) || 0);
    const current = scores[scores.length - 1] ?? 0;
    const highest = Math.max(...scores);
    const lowest = Math.min(...scores);
    const change = current - (scores[0] ?? current);

    const rows = w.querySelectorAll('.trustStatsRow');
    if (rows && rows.length >= 4) {
      const setVal = (rowIdx, val) => {
        const el = rows[rowIdx]?.querySelector('.trustStatsVal');
        if (el) el.textContent = String(val);
      };
      setVal(0, current);
      setVal(1, highest);
      setVal(2, lowest);
      // change row is after divider: it's the last .trustStatsRow
      const changeRow = w.querySelectorAll('.trustStatsRow')[3];
      const changeEl = changeRow?.querySelector('.trustStatsVal');
      if (changeEl) changeEl.textContent = `${change >= 0 ? '+' : ''}${change}`;
    }

    w.dataset.trustHydrated = '1';
  }
}

function buildTrustHistoryControlsHtml() {
  return `
    <div class="trustChartControls" aria-label="Chart controls">
      <button class="trustCtl" type="button" data-action="zoomOut" aria-label="Zoom out">−</button>
      <button class="trustCtl" type="button" data-action="zoomIn" aria-label="Zoom in">+</button>
      <button class="trustCtl" type="button" data-action="reset" aria-label="Reset zoom">↺</button>
    </div>
  `;
}

function initTrustHistoryZoom(chartCard) {
  try {
    const svg = chartCard.querySelector('svg.trustChartSvg');
    if (!svg) return;

    const xform = svg.querySelector('g.trustPlotXform');
    const panLayer = svg.querySelector('rect.trustPanLayer');
    if (!xform || !panLayer) return;

    const plotLeft = Number(svg.getAttribute('data-plot-left') || 0);
    const plotRight = Number(svg.getAttribute('data-plot-right') || 0);
    const viewW = Number(svg.getAttribute('data-view-w') || 0);
    if (!Number.isFinite(plotLeft) || !Number.isFinite(plotRight) || !Number.isFinite(viewW) || viewW <= 0) return;

    const clamp = (v, a, b) => Math.max(a, Math.min(b, v));
    const MAX_ZOOM = 20;

    // per-chart state
    const st = { sx: 1, tx: 0, dragging: false, dragStartX: 0, txStart: 0, pinch: null };

    // Keep dots visually circular when we zoom only along X.
    // Without compensation, scaling the plot group on X turns circles into ellipses.
    function updateDotCompensation() {
      const inv = 1 / (st.sx || 1);
      svg.querySelectorAll('g.trustPlotXform circle.ptDot, g.trustPlotXform circle.ptHalo').forEach((c) => {
        const cx = Number(c.getAttribute('cx'));
        const cy = Number(c.getAttribute('cy'));
        if (!Number.isFinite(cx) || !Number.isFinite(cy)) return;
        // Apply inverse X-scale around the circle center.
        c.setAttribute('transform', `translate(${cx} ${cy}) scale(${inv} 1) translate(${-cx} ${-cy})`);
      });
    }

    function boundsFor(sx) {
      // Keep content covering the plot area (avoid blank gaps).
      const minTx = plotRight - sx * plotRight;
      const maxTx = plotLeft - sx * plotLeft;
      return { minTx, maxTx };
    }

    function apply() {
      const b = boundsFor(st.sx);
      st.tx = clamp(st.tx, b.minTx, b.maxTx);
      xform.setAttribute('transform', `matrix(${st.sx} 0 0 1 ${st.tx} 0)`);
      updateDotCompensation();
      // Cursor feedback
      panLayer.style.cursor = (st.sx > 1.001) ? (st.dragging ? 'grabbing' : 'grab') : 'default';
    }

    function clientXToViewBoxX(clientX) {
      const r = svg.getBoundingClientRect();
      const px = (clientX - r.left) / (r.width || 1);
      return clamp(px, 0, 1) * viewW;
    }

    function zoomAt(viewX, factor) {
      const next = clamp(st.sx * factor, 1, MAX_ZOOM);
      if (Math.abs(next - st.sx) < 0.0001) return;
      // Keep viewX stable under the cursor
      st.tx = st.tx + (st.sx - next) * viewX;
      st.sx = next;
      apply();
    }

    function reset() {
      st.sx = 1;
      st.tx = 0;
      st.dragging = false;
      st.pinch = null;
      apply();
    }

    // Buttons (controls live in header outside chartCard)
    const wrap = chartCard.closest('.trustHistoryWrap') || chartCard;
    wrap.querySelectorAll('.trustChartControls .trustCtl').forEach((btn) => {
      btn.addEventListener('click', (e) => {
        const act = btn.getAttribute('data-action');
        if (act === 'zoomIn') zoomAt((plotLeft + plotRight) / 2, 1.25);
        else if (act === 'zoomOut') zoomAt((plotLeft + plotRight) / 2, 1 / 1.25);
        else reset();
        e.preventDefault();
        e.stopPropagation();
      });
    });

    // Wheel zoom (trackpad/mouse)
    svg.addEventListener('wheel', (e) => {
      // Only if inside plot area
      const r = svg.getBoundingClientRect();
      const inside = e.clientX >= r.left && e.clientX <= r.right && e.clientY >= r.top && e.clientY <= r.bottom;
      if (!inside) return;
      e.preventDefault();
      const viewX = clientXToViewBoxX(e.clientX);
      const factor = (e.deltaY < 0) ? 1.18 : (1 / 1.18);
      zoomAt(viewX, factor);
    }, { passive: false });

    // Drag to pan (Pointer Events)
    panLayer.addEventListener('pointerdown', (e) => {
      if (st.sx <= 1.001) return; // no pan when not zoomed
      st.dragging = true;
      st.dragStartX = e.clientX;
      st.txStart = st.tx;
      try { panLayer.setPointerCapture(e.pointerId); } catch {}
      apply();
      e.preventDefault();
      e.stopPropagation();
    });
    panLayer.addEventListener('pointermove', (e) => {
      if (!st.dragging) return;
      const r = svg.getBoundingClientRect();
      const dxPx = e.clientX - st.dragStartX;
      // Convert screen px to viewBox units
      const dxView = (dxPx / (r.width || 1)) * viewW;
      st.tx = st.txStart + dxView;
      apply();
      e.preventDefault();
      e.stopPropagation();
    });
    const endDrag = () => {
      if (!st.dragging) return;
      st.dragging = false;
      apply();
    };
    panLayer.addEventListener('pointerup', endDrag);
    panLayer.addEventListener('pointercancel', endDrag);
    panLayer.addEventListener('pointerleave', endDrag);

    // Pinch zoom (touch)
    svg.addEventListener('touchstart', (e) => {
      if (e.touches && e.touches.length === 2) {
        const a = e.touches[0], b = e.touches[1];
        const dist = Math.hypot(a.clientX - b.clientX, a.clientY - b.clientY);
        const midX = (a.clientX + b.clientX) / 2;
        st.pinch = { dist, sx: st.sx, tx: st.tx, midViewX: clientXToViewBoxX(midX) };
      }
    }, { passive: true });
    svg.addEventListener('touchmove', (e) => {
      if (!st.pinch || !(e.touches && e.touches.length === 2)) return;
      e.preventDefault();
      const a = e.touches[0], b = e.touches[1];
      const dist = Math.hypot(a.clientX - b.clientX, a.clientY - b.clientY);
      const ratio = dist / (st.pinch.dist || dist || 1);
      const next = clamp(st.pinch.sx * ratio, 1, MAX_ZOOM);
      st.tx = st.pinch.tx + (st.pinch.sx - next) * st.pinch.midViewX;
      st.sx = next;
      apply();
    }, { passive: false });
    svg.addEventListener('touchend', () => { st.pinch = null; }, { passive: true });
    svg.addEventListener('touchcancel', () => { st.pinch = null; }, { passive: true });

    // Init
    apply();
  } catch {
    // never break the tracking page if something goes wrong
  }
}


function initTrustHistoryInteractions() {
  function hideAll() {
    document.querySelectorAll('.trustChartCard .trustTooltip.show').forEach((el) => {
      el.classList.remove('show');
      el.setAttribute('aria-hidden','true');
    });

    document.querySelectorAll('.trustChartSvg .hoverLine').forEach((l) => {
      l.style.display = 'none';
    });
    document.querySelectorAll('.trustChartSvg g.pt.active').forEach((pt) => {
      pt.classList.remove('active');
    });
  }

  function showForPoint(ptEl, anchorRect) {
    const card = ptEl.closest('.trustChartCard');
    if (!card) return;
    const tip = card.querySelector('.trustTooltip');
    if (!tip) return;

    let meta = null;
    try { meta = JSON.parse(decodeURIComponent(ptEl.getAttribute('data-meta') || '')); } catch {}
    if (!meta) return;

    const d = meta.ts ? new Date(meta.ts) : new Date();
   const userLocale = navigator.language || 'en-US';

const datePart = d.toLocaleDateString('en-GB', {
  day: '2-digit',
  month: 'short'
});

const timePart = d.toLocaleTimeString(userLocale, {
  hour: '2-digit',
  minute: '2-digit'
});

const dateStr = `${datePart}, ${timePart}`;

    const added = Number(meta.sources_added || 0);
    tip.innerHTML = `
      <div class="ttDate">${escapeHtml(dateStr)}</div>
      <div class="ttRow"><span class="ttLabel">${t("ui.trust_score","Trust score")}</span><b>${Number(meta.score || 0)}</b></div>
      <div class="ttRow"><span class="ttLabel">${t("ui.sources_added","Sources added")}</span><b>+${added}</b></div>
    `;

    // hover line + active point (like the reference)
    try {
      const svg = ptEl.closest('svg');
      const hoverLine = svg ? svg.querySelector('.hoverLine') : null;
      const dot = ptEl.querySelector('circle.ptDot');
      if (svg && hoverLine && dot) {
        const cx = Number(dot.getAttribute('cx') || 0);
        if (Number.isFinite(cx)) {
          hoverLine.setAttribute('x1', String(cx));
          hoverLine.setAttribute('x2', String(cx));
          hoverLine.style.display = '';
        }
      }
      svg && svg.querySelectorAll('g.pt.active').forEach((p) => p.classList.remove('active'));
      ptEl.classList.add('active');
    } catch {}

    const cardRect = card.getBoundingClientRect();
    const ar = anchorRect || ptEl.getBoundingClientRect();

    // Initial position near point
    tip.style.left = `${ar.left - cardRect.left}px`;
    tip.style.top = `${ar.top - cardRect.top}px`;

    tip.classList.add('show');
    tip.setAttribute('aria-hidden','false');

    // Clamp after layout
    requestAnimationFrame(() => {
      const w = tip.offsetWidth || 180;
      const h = tip.offsetHeight || 80;
      let left = (ar.left - cardRect.left) - w / 2;
      let top  = (ar.top - cardRect.top) - h - 12;

      const pad = 8;
      left = Math.max(pad, Math.min(left, cardRect.width - w - pad));
      top  = Math.max(pad, Math.min(top, cardRect.height - h - pad));

      tip.style.left = `${left}px`;
      tip.style.top  = `${top}px`;
    });
  }

  // Hover (desktop) + tap/click (mobile)
  document.addEventListener('pointerover', (e) => {
    const tgt = e.target;
    const pt = tgt && tgt.closest ? tgt.closest('g.pt') : null;
    if (!pt) return;
    showForPoint(pt, tgt.getBoundingClientRect ? tgt.getBoundingClientRect() : null);
  });

  document.addEventListener('click', (e) => {
    const tgt = e.target;
    const pt = tgt && tgt.closest ? tgt.closest('g.pt') : null;
    if (pt) {
      showForPoint(pt, tgt.getBoundingClientRect ? tgt.getBoundingClientRect() : null);
      e.stopPropagation();
      return;
    }
    // Click outside: hide all tooltips
    hideAll();
  });

  // When a card closes, hide its tooltip
  document.addEventListener('toggle', (e) => {
    const details = e.target;
    if (!details || details.tagName !== 'DETAILS') return;
    if (details.classList && details.classList.contains('newsDetails') && !details.open) hideAll();
  }, true);
}
initTrustHistoryInteractions();