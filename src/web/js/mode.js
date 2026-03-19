/*
 * CHECKNE Web App — mode.js
 * Premium mode transitions + swipe navigation + basic helpers
 *
 * Split from the former monolithic app.js to keep responsibilities separated.
 * Keep files loaded in order (see index.html).
 */

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

    // Widgets: hide on Tracking (fav) to avoid layout clutter.
    try{
      if (typeof window.__setWidgetsEnabled === 'function'){
        window.__setWidgetsEnabled(targetMode === 'feed');
      }
    }catch{}

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


    try{ if (typeof updateTrackingLimitBarUI === 'function') updateTrackingLimitBarUI(); }catch{}
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

// Feed policy: when sorting by "Newest", push low-score items to the bottom
// so every dark badge (< LOW_SCORE_THRESHOLD) always stays after the light ones.
// Must stay in sync with the card UI threshold from state.js.
const CONFIRMED_SCORE_THRESHOLD = LOW_SCORE_THRESHOLD;

function loadPrefs() {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return;
    const p = JSON.parse(raw);
    // Keep interests deterministic & deduplicated (prevents duplicate chips like "technology" twice)
    const ints = Array.isArray(p.interests) ? p.interests : state.interests;
    const normalize = (typeof window.checkneNormalizeInterests === 'function')
      ? window.checkneNormalizeInterests
      : ((list) => {
          const uniq = [...new Set((Array.isArray(list) ? list : []).map((x) => String(x || '').trim().toLowerCase()).filter(Boolean))];
          const core = uniq.filter((x) => ['business','technology','politics','science','sports','health'].includes(x));
          return core.length ? core : ['general'];
        });
    state.interests = normalize(ints);
    state.country = (typeof window.checkneNormalizeCountrySelection === 'function') ? window.checkneNormalizeCountrySelection(p.country, state.country) : (p.country || state.country);
    state.language = p.language || state.language;
  } catch {}
}

// --- Account-scoped preferences (backend) ---
// Interests/country/language should follow the account (not leak across logins).
let _prefsSuppressRemoteSave = false;
let _prefsRemoteSaveTimer = null;

async function fetchPrefsFromServer(){
  try{
    const r = await fetch(`${API_BASE}/api/preferences`, { credentials:'include' });
    const j = await r.json().catch(()=>null);
    if (!r.ok) return null;
    // Accept both {preferences:{...}} and flat payloads.
    const p = (j && (j.preferences || j.saved || j)) || null;
    if (!p || typeof p !== 'object') return null;
    return {
      interests: Array.isArray(p.interests) ? p.interests : undefined,
      country: (typeof p.country === 'string') ? p.country : undefined,
      language: (typeof p.language === 'string') ? p.language : undefined,
      ui: (p.ui && typeof p.ui === 'object') ? p.ui : undefined,
    };
  }catch{ return null; }
}

function _applyUiPrefs(ui, { persistLocal = true } = {}){
  if (!ui || typeof ui !== 'object') return;
  try{
    if (typeof ui.showThumbs === 'boolean') state.showThumbs = ui.showThumbs;
    if (ui.filters && typeof ui.filters === 'object'){
      const f = ui.filters;
      const so = String(f.sortOrder || state.filters.sortOrder || 'newest');
      state.filters.sortOrder = (so === 'low' || so === 'high' || so === 'newest') ? so : 'newest';
      state.filters.minScore = clamp(Number(f.minScore ?? state.filters.minScore ?? 0), 0, 100);
      state.filters.maxScore = clamp(Number(f.maxScore ?? state.filters.maxScore ?? 100), 0, 100);
      state.filters.onlyConfirmed = !!f.onlyConfirmed;
      state.filters.onlyAiSummary = !!f.onlyAiSummary;
    }
  }catch{}

  if (persistLocal){
    try { saveThumbPrefs(); } catch {}
    try { saveFilters(); } catch {}
  }

  // Widgets layout is owned by widgets.js. Apply it if available.
  try{
    if (ui.widgets && typeof ui.widgets === 'object'){
      if (typeof window.checkneApplyWidgetsLayout === 'function'){
        window.checkneApplyWidgetsLayout(ui.widgets, { persistLocal });
      }else{
        // widgets.js not loaded yet — stash and apply on init.
        window.__checknePendingWidgetsLayout = ui.widgets;
      }
    }
  }catch{}

  // If UI is already initialized, sync UI controls.
  try { if (typeof syncFiltersStateToUI === 'function') syncFiltersStateToUI(); } catch {}
  try { if (typeof renderTags === 'function') renderTags(); } catch {}
}

function applyPrefsObject(p, { persistLocal = true } = {}){
  try{
    if (p && Array.isArray(p.interests)){
      const ints = p.interests;
      const normalize = (typeof window.checkneNormalizeInterests === 'function')
        ? window.checkneNormalizeInterests
        : ((list) => {
            const uniq = [...new Set((Array.isArray(list) ? list : []).map((x) => String(x || '').trim().toLowerCase()).filter(Boolean))];
            const core = uniq.filter((x) => ['business','technology','politics','science','sports','health'].includes(x));
            return core.length ? core : ['general'];
          });
      state.interests = normalize(ints);
    }
    if (p && typeof p.country === 'string' && p.country) state.country = (typeof window.checkneNormalizeCountrySelection === 'function') ? window.checkneNormalizeCountrySelection(p.country, state.country) : p.country;
    if (p && typeof p.language === 'string' && p.language) state.language = p.language;
  }catch{}

  if (persistLocal){
    _prefsSuppressRemoteSave = true;
    try { savePrefs(); } catch {}
    _prefsSuppressRemoteSave = false;
  }

  // UI preferences (filters/widgets/thumbs) are stored per account too.
  try { _applyUiPrefs(p.ui, { persistLocal }); } catch {}
}

async function syncPrefsFromServer(){
  if (!authState || !authState.authenticated) return false;
  const p = await fetchPrefsFromServer();
  if (!p) return false;
  applyPrefsObject(p, { persistLocal: true });
  // Sync UI if it is already initialized.
  try { if (typeof renderTags === 'function') renderTags(); } catch {}
  try { if (typeof syncDropdownsFromState === 'function') syncDropdownsFromState(); } catch {}
  return true;
}

// Expose for auth.js (called right after login state refresh)
window.checkneSyncPrefsFromServer = syncPrefsFromServer;

function savePrefs() {
  const normalize = (typeof window.checkneNormalizeInterests === 'function')
    ? window.checkneNormalizeInterests
    : ((list) => {
        const uniq = [...new Set((Array.isArray(list) ? list : []).map((x) => String(x || '').trim().toLowerCase()).filter(Boolean))];
        const core = uniq.filter((x) => ['business','technology','politics','science','sports','health'].includes(x));
        return core.length ? core : ['general'];
      });
  const interests = normalize(state.interests || ['general']);
  localStorage.setItem(STORAGE_KEY, JSON.stringify({
    interests,
    country: (typeof window.checkneNormalizeCountrySelection === 'function') ? window.checkneNormalizeCountrySelection(state.country, 'world') : state.country,
    language: state.language,
  }));

  // When authenticated, also persist preferences to the backend (account-scoped).
  if (_prefsSuppressRemoteSave) return;
  if (!authState || !authState.authenticated) return;

  try{
    if (_prefsRemoteSaveTimer) clearTimeout(_prefsRemoteSaveTimer);
    _prefsRemoteSaveTimer = setTimeout(async ()=>{
      try{
        await fetch(`${API_BASE}/api/preferences`, {
          method:'POST',
          headers:{ 'Content-Type':'application/json' },
          credentials:'include',
          body: JSON.stringify({ interests, country: (typeof window.checkneNormalizeCountrySelection === 'function') ? window.checkneNormalizeCountrySelection(state.country, 'world') : state.country, language: state.language })
        });
      }catch{}
    }, 300);
  }catch{}
}

// --- Account-scoped UI preferences (filters/widgets/thumbs) ---
let _uiRemoteSaveTimer = null;
function _collectUiPrefs(){
  const ui = {
    showThumbs: !!state.showThumbs,
    filters: {
      sortOrder: String(state.filters?.sortOrder || 'newest'),
      minScore: Number(state.filters?.minScore ?? 0),
      maxScore: Number(state.filters?.maxScore ?? 100),
      onlyConfirmed: !!state.filters?.onlyConfirmed,
      onlyAiSummary: !!state.filters?.onlyAiSummary,
    },
  };
  try{
    if (typeof window.checkneGetWidgetsLayout === 'function'){
      const w = window.checkneGetWidgetsLayout();
      if (w && typeof w === 'object') ui.widgets = w;
    }
  }catch{}
  return ui;
}

function requestSaveUiPrefs(){
  if (!authState || !authState.authenticated) return;
  try{
    if (_uiRemoteSaveTimer) clearTimeout(_uiRemoteSaveTimer);
    _uiRemoteSaveTimer = setTimeout(async ()=>{
      try{
        const normalize = (typeof window.checkneNormalizeInterests === 'function')
    ? window.checkneNormalizeInterests
    : ((list) => {
        const uniq = [...new Set((Array.isArray(list) ? list : []).map((x) => String(x || '').trim().toLowerCase()).filter(Boolean))];
        const core = uniq.filter((x) => ['business','technology','politics','science','sports','health'].includes(x));
        return core.length ? core : ['general'];
      });
  const interests = normalize(state.interests || ['general']);
        const ui = _collectUiPrefs();
        await fetch(`${API_BASE}/api/preferences`, {
          method:'POST',
          headers:{ 'Content-Type':'application/json' },
          credentials:'include',
          body: JSON.stringify({ interests, country: (typeof window.checkneNormalizeCountrySelection === 'function') ? window.checkneNormalizeCountrySelection(state.country, 'world') : state.country, language: state.language, ui })
        });
      }catch{}
    }, 350);
  }catch{}
}

// Expose for widgets.js (and others)
window.checkneRequestSaveUiPrefs = requestSaveUiPrefs;

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
  try { requestSaveUiPrefs(); } catch {}
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
  try { requestSaveUiPrefs(); } catch {}
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
  // Tracking is an account feature. When logged out, we must not show stale
  // counts from another account on the same device.
  if (!authState.authenticated) return [];
  try {
    const raw = localStorage.getItem(getScopedFavKey());
    const arr = raw ? JSON.parse(raw) : [];
    const ids = Array.isArray(arr) ? arr.map((x) => Number(x)).filter((x) => Number.isFinite(x)) : [];
    return [...new Set(ids)];
  } catch { return []; }
}

function setFavIds(ids) {
  if (!authState.authenticated) {
    // Do not persist favorites for guests.
    const trackingCountEl = document.getElementById("trackingCount");
    if (trackingCountEl) trackingCountEl.textContent = "0";
    return;
  }
  const uniq = [...new Set((ids || []).map((x) => Number(x)).filter((x) => Number.isFinite(x)))];
  localStorage.setItem(getScopedFavKey(), JSON.stringify(uniq));
  // legacy counter (hidden)
  const favCountEl = document.getElementById("favCount");
  if (favCountEl) favCountEl.textContent = String(uniq.length);

  // new header badge
  const trackingCountEl = document.getElementById("trackingCount");
  if (trackingCountEl) trackingCountEl.textContent = String(uniq.length);


  // Notify widgets/other UI that tracking changed
  try {
    document.dispatchEvent(new CustomEvent("checkne:favsChanged", { detail: { count: uniq.length } }));
  } catch {}
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
  if (!authState.authenticated) return {};
  try { return JSON.parse(localStorage.getItem(getScopedSeenKey()) || "{}") || {}; }
  catch { return {}; }
}
function saveSeenState(obj) {
  if (!authState.authenticated) return;
  localStorage.setItem(getScopedSeenKey(), JSON.stringify(obj || {}));
}