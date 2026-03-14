/*
 * CHECKNE Web App — dropdowns.js
 * Custom dropdowns (country/language) + related UI
 *
 * Split from the former monolithic app.js to keep responsibilities separated.
 * Keep files loaded in order (see index.html).
 */

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

// Allow other modules (auth/prefs sync) to force dropdown UI to reflect current state.
function syncDropdownsFromState(){
  try{
    const c = document.getElementById('country');
    if (c && state && state.country && c.value !== state.country) {
      c.value = state.country;
      try { syncCountryBtnLabel(); } catch {}
    }
  }catch{}
  try{
    const l = document.getElementById('language');
    if (l && state && state.language && l.value !== state.language) {
      l.value = state.language;
      try { syncLanguageBtnLabel(); } catch {}
    }
  }catch{}
}
window.syncDropdownsFromState = syncDropdownsFromState;




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

  // Apply routing after the UI is fully initialized.
  // Supports clean URLs (/privacy) and also auto-converts old hash URLs (/#/privacy).
  if (typeof window.__routeFromLocation === 'function') {
    try { window.__routeFromLocation(); } catch (_) {}
  }

  const initialPath = (() => {
    try {
      let path = String(window.location?.pathname || '/');
      path = path.split('?')[0].split('#')[0];
      if (!path.startsWith('/')) path = '/' + path;
      if (path.length > 1) path = path.replace(/\/+$/, '');
      return path || '/';
    } catch {
      return '/';
    }
  })();

  // Initial data load must respect the direct route.
  // Without this, opening /tracking and then refreshing can first render the
  // main feed snapshot, which mixes feed cards into the tracking view.
  if (initialPath === '/tracking') {
    try { state.mode = 'fav'; } catch {}
    try { applyTabs(); } catch {}
    try {
      if (typeof window.__setWidgetsEnabled === 'function') {
        window.__setWidgetsEnabled(false);
      }
    } catch {}
    await fetchFavorites({ reset: true });
  } else {
    await fetchFeed({ reset: true });
  }

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