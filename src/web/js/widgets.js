/* CHECKNE — widgets.js
 * Side widgets (left/right) with add/configure/remove + drag & drop.
 * Stored in localStorage so layout persists per device.
 */

(function(){
  const STORAGE_KEY = "checkne_widgets_v1";
  const INIT_KEY = "checkne_widgets_init_v1";
  const MAX_PER_SIDE = 3;
  const MAX_TOTAL = 5; // total widgets across both sides (and on mobile dock)

  function isAuthed(){
    try {
      // authState is declared as `let authState = {...}` in state.js (global, but not on window).
      if ((typeof authState !== "undefined") && !!authState && !!authState.authenticated) return true;
    } catch {}
    // Fallback: some flows render the UI as authed before authState is updated.
    try { return document.documentElement && document.documentElement.dataset && document.documentElement.dataset.authed === "1"; } catch {}
    return false;
  }

  function requireAuth(reason){
    if (isAuthed()) return true;
    try {
      if (typeof window.openAuthModal === 'function') window.openAuthModal(reason || 'login');
    } catch {}
    return false;
  }

  const ICON_FILES = {
    fx_rates: "/static/icons/FxRates.svg",
    crypto_prices: "/static/icons/CryptoFix.svg",
    headlines: "/static/icons/TopHeadlines.svg",
    tracking_stats: "/static/icons/TrackingStats.svg",
    market_clock: "/static/icons/MarketClock.svg",
    media_bias: "/static/icons/Perspective.svg",
    pro_momentum: "/static/icons/MomentumTimeline.svg",
    pro_entities: "/static/icons/Entities.svg",
    pro_related_coverage: "/static/icons/RelatedCoverage.svg",
    pro_recent_history: "/static/icons/RecentHistory.svg",
    pro_video_report: "/static/icons/VideoreportFix.svg",
  };


  function wt(key, fallback){
    try {
      if (typeof t === 'function') return t(key, fallback);
    } catch {}
    return fallback;
  }

  function widgetMeta(key, fallbackName, fallbackDesc){
    return { name: fallbackName, desc: fallbackDesc };
  }

  function getWidgetName(key, def){
    return wt(`widgets.${key}.name`, def?.name || key);
  }

  function getWidgetDesc(key, def){
    return wt(`widgets.${key}.desc`, def?.desc || '');
  }

  const PRO_ICON_POOL = [
    "/static/icons/FxRates.svg",
    "/static/icons/CryptoFix.svg",
    "/static/icons/TopHeadlines.svg",
    "/static/icons/TrackingStats.svg",
    "/static/icons/MarketClock.svg",
  ];

  function pickProIcon(type){
    const s = String(type || "");
    let acc = 0;
    for (let i = 0; i < s.length; i++) acc = (acc + s.charCodeAt(i) * (i + 1)) >>> 0;
    return PRO_ICON_POOL[acc % PRO_ICON_POOL.length];
  }

  function getIconPath(type){
    return ICON_FILES[type] || pickProIcon(type);
  }

  function getPlan(){
    try{
      if (typeof billingState === 'undefined' || !billingState) return null;
      const p = billingState?.plan;
      if (p === null || typeof p === 'undefined') return null;
      return String(p).toLowerCase();
    }catch{
      return null;
    }
  }

  // Treat any non-free plan as having access to Pro widgets.
  // This makes the frontend resilient if the backend introduces new paid tiers.
  function hasPro(){
    const p = getPlan();
    if (!p) return null; // unknown/loading
    if (p === 'free') return false;
    // common paid tiers
    if (p === 'pro' || p === 'analyst' || p === 'plus' || p === 'premium' || p === 'enterprise' || p === 'business') return true;
    // fallback: any other non-free value counts as paid
    return true;
  }

  function goPricing(){
    // Navigate to pricing with optional preselection.
    // plan: free | pro | analyst
    // checkout: if true, pricing page will immediately start checkout.
    if (!(typeof authState !== 'undefined' && authState && authState.authenticated)) {
      try { if (typeof window.toast === 'function') window.toast(wt('ui.sign_in_first_continue', 'Please sign in first to continue.'), 'info'); } catch {}
      try { if (typeof window.openAuthModal === 'function') window.openAuthModal('login'); } catch {}
      return false;
    }
    return goPricingWith({ plan: 'pro', checkout: false });
  }

  function goPricingWith(opts){
    const plan = String(opts?.plan || 'pro').toLowerCase();
    const checkout = !!opts?.checkout;
    const interval = String(opts?.interval || 'monthly').toLowerCase();
    const params = new URLSearchParams();
    if (plan) params.set('plan', plan);
    if (checkout) params.set('checkout', '1');
    if (interval) params.set('interval', interval);
    const url = `/pricing${params.toString() ? ('?' + params.toString()) : ''}`;
    try {
      if (typeof window.__navigate === 'function') window.__navigate(url);
      else location.href = url;
    } catch {
      try { location.href = url; } catch {}
    }
  }

  function gatePro(){
    const pro = hasPro();
    // If billing is still loading, don't mislead the user with an upgrade prompt.
    if (pro === null){
      try { if (typeof toast === 'function') toast('Checking your subscription…'); } catch {}
      try { if (typeof refreshBillingState === 'function') refreshBillingState(); } catch {}
      return false;
    }
    if (pro) return true;

    try { if (typeof toast === 'function') toast('🔒 Pro feature — upgrade to unlock.'); } catch {}
    try { if (state?.modal?.open) closeModal(); } catch {}
    goPricingWith({ plan: 'pro' });
    return false;
  }

  function getCurrentClusterId(){
    try {
      const w = Number(window.__currentClusterId);
      if (Number.isFinite(w) && w > 0) return w;
    } catch {}
    try {
      const v = localStorage.getItem('checkne_current_cluster');
      const n = Number(v);
      if (Number.isFinite(n) && n > 0) return n;
    } catch {}
    return null;
  }


function getCurrentStory(){
  try {
    if (window.__currentStory && typeof window.__currentStory === 'object') return window.__currentStory;
  } catch {}
  try {
    const raw = localStorage.getItem('checkne_current_story');
    if (raw) {
      const j = JSON.parse(raw);
      if (j && typeof j === 'object') return j;
    }
  } catch {}
  return null;
}

  // Light caching helper to avoid hammering free APIs (and avoid rate-limits).
  const __wgCache = new Map(); // key -> { t:number, v:any }
// JSON fetch with caching + request de-duplication.
// - Memory cache (fast during a session)
// - localStorage cache (survives reload; avoids re-hitting server)
// - inflight de-dupe (prevents 2-10 identical requests on re-render)
const __jsonCache = new Map();
const __jsonInflight = new Map();

function __lsKey(url) { return `__news_jsoncache__:${url}`; }

function __lsGet(url, ttlMs) {
  try {
    const raw = localStorage.getItem(__lsKey(url));
    if (!raw) return null;
    const obj = JSON.parse(raw);
    if (!obj || typeof obj.t !== 'number') return null;
    if ((Date.now() - obj.t) > ttlMs) return null;
    return obj.v;
  } catch (_) {
    return null;
  }
}

function __lsSet(url, value) {
  try {
    const obj = { t: Date.now(), v: value };
    // Guard against huge payloads; localStorage is limited.
    const raw = JSON.stringify(obj);
    if (raw.length > 200000) return; // ~200KB safety cap
    localStorage.setItem(__lsKey(url), raw);
  } catch (_) {
    // ignore
  }
}

async function fetchJsonCached(url, ttlMs = 5 * 60 * 1000) {
  // 1) Memory
  const hit = __jsonCache.get(url);
  if (hit && (Date.now() - hit.t) < ttlMs) return hit.v;

  // 2) localStorage
  const lshit = __lsGet(url, ttlMs);
  if (lshit != null) {
    __jsonCache.set(url, { t: Date.now(), v: lshit });
    return lshit;
  }

  // 3) Inflight de-dupe
  if (__jsonInflight.has(url)) return await __jsonInflight.get(url);

  const p = (async () => {
    const res = await fetch(url, { credentials: 'include' });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const data = await res.json();
    __jsonCache.set(url, { t: Date.now(), v: data });
    __lsSet(url, data);
    return data;
  })();

  __jsonInflight.set(url, p);
  try {
    return await p;
  } finally {
    __jsonInflight.delete(url);
  }
}

  function getFeedItemsSafe(){
    try {
      if (typeof lastFeedItems !== 'undefined' && Array.isArray(lastFeedItems)) return lastFeedItems;
    } catch {}
    return [];
  }

  function getCardElById(cid){
    const id = String(cid);
    return document.querySelector(`.newsCard[data-id="${CSS.escape(id)}"]`);
  }

  function openClusterInFeed(cid){
    const card = getCardElById(cid);
    if (!card) return;
    try { card.scrollIntoView({ behavior: 'smooth', block: 'center' }); } catch {}
    try { card.dispatchEvent(new MouseEvent('click', { bubbles: true })); } catch {}
  }

  async function openClusterInTracking(cid){
    const clusterId = Number(cid);
    if (!Number.isFinite(clusterId)) return;
    if (!isAuthed()) return requireAuth('tracking');

    try {
      if (typeof window.__queueTrackingFocus === 'function') {
        window.__queueTrackingFocus(clusterId, { open_card: true, scroll_to_graph: true });
      } else {
        try {
          sessionStorage.setItem('checkne_tracking_focus_v1', JSON.stringify({
            cluster_id: clusterId,
            open_card: true,
            scroll_to_graph: true,
            ts: Date.now(),
          }));
        } catch {}
      }

      if (typeof isFav === 'function' && !isFav(clusterId)) {
        const current = (typeof getFavIds === 'function' && Array.isArray(getFavIds())) ? getFavIds() : [];
        const next = [clusterId, ...current.filter(x => Number(x) !== clusterId)];
        if (typeof setFavIds === 'function') setFavIds(next);
        if (typeof syncFavoritesToServer === 'function') await syncFavoritesToServer();
      }
    } catch {}

    try {
      if (typeof window.__navigate === 'function') {
        window.__navigate('/tracking');
      } else {
        location.href = '/tracking';
      }
    } catch {}
  }

  function setSearchTerm(term){
    const t = String(term || '').trim();
    if (!t) return;
    const inp = document.querySelector('input[type="search"], input#searchInput, input[name="search"], input[placeholder*="Search"]');
    if (!(inp instanceof HTMLInputElement)) return;
    inp.value = t;
    try { inp.dispatchEvent(new Event('input', { bubbles: true })); } catch {}
  }

  function scoreLabel(v){
    const n = Number(v);
    if (!Number.isFinite(n)) return '';
    if (n >= 80) return 'High';
    if (n >= 55) return 'Medium';
    return 'Low';
  }

  function clamp(n, a, b){
    return Math.max(a, Math.min(b, n));
  }

  function computeImpact(it){
    const outlets = Number(it?.sources_count ?? it?.outlets_count ?? it?.outlets ?? 0) || 0;
    const imp = Number(it?.importance ?? it?.importance_score ?? it?.score ?? 0) || 0;
    return Math.round((imp * 0.8) + (outlets * 6));
  }

  function computeRisk(it){
    const title = String(it?.title || '').toLowerCase();
    const outlets = Number(it?.sources_count ?? it?.outlets_count ?? it?.outlets ?? 0) || 0;
    const imp = Number(it?.importance ?? it?.importance_score ?? it?.score ?? 0) || 0;

    const keywords = [
      'war','strike','attack','missile','drone','nuclear','sanction','ceasefire','hostage','terror',
      'protest','riot','coup','earthquake','tsunami','outage','hack','breach','lawsuit','indict',
    ];
    let k = 0;
    for (const w of keywords){
      if (title.includes(w)) k += 1;
    }

    const raw = (outlets * 10) + (k * 12) + (imp * 0.5);
    const pct = clamp(Math.round(raw / 2.2), 0, 99);
    return { pct, keywordHits: k, keywords };
  }

  function whyImpact(it){
    const outlets = Number(it?.sources_count ?? it?.outlets_count ?? it?.outlets ?? 0) || 0;
    const imp = Number(it?.importance ?? it?.importance_score ?? it?.score ?? 0) || 0;
    const parts = [];
    if (outlets >= 4) parts.push(`spread across ${outlets} outlets`);
    else if (outlets > 0) parts.push(`${outlets} outlet${outlets===1?'':'s'}`);
    if (imp >= 70) parts.push('high importance');
    else if (imp >= 50) parts.push('medium importance');
    return parts.length ? parts.join(' · ') : 'based on outlets and importance';
  }

  function whyRisk(it, meta){
    const outlets = Number(it?.sources_count ?? it?.outlets_count ?? it?.outlets ?? 0) || 0;
    const imp = Number(it?.importance ?? it?.importance_score ?? it?.score ?? 0) || 0;
    const title = String(it?.title || '').toLowerCase();
    const kw = [];
    for (const w of meta.keywords){
      if (title.includes(w)) kw.push(w);
      if (kw.length >= 3) break;
    }
    const parts = [];
    if (outlets >= 3) parts.push(`fast pickup (${outlets} outlets)`);
    if (imp >= 60) parts.push('high importance');
    if (kw.length) parts.push(`keywords: ${kw.join(', ')}`);
    return parts.length ? parts.join(' · ') : 'velocity + importance + key terms';
  }

  

const MEDIA_BIAS_REQUESTS = new Map();

function renderMediaBias(root, settings){
  // Widget reads the "current cluster" from the feed (set in feed.js on card open).
  const getClusterId = () => {
    try { if (typeof window.__currentClusterId !== 'undefined' && window.__currentClusterId) return Number(window.__currentClusterId) || null; } catch {}
    try {
      const s = localStorage.getItem('checkne_current_cluster');
      const n = s && /^\d+$/.test(s) ? Number(s) : null;
      return n && n > 0 ? n : null;
    } catch {}
    return null;
  };

  const clusterId = getClusterId();
  root.innerHTML = `<div class="muted" style="font-size:13px;">${clusterId ? 'Loading…' : 'Open a story to see bias.'}</div>`;

  if (!clusterId) return;

  const url = `/api/widgets/media-bias?cluster_id=${encodeURIComponent(String(clusterId))}`;

  const cacheKey = String(clusterId);
  const inflight = MEDIA_BIAS_REQUESTS.get(cacheKey) || apiFetchJson(url, { credentials: 'include', timeoutMs: 7000 })
    .then(({ data }) => data)
    .catch(() => null)
    .finally(() => { MEDIA_BIAS_REQUESTS.delete(cacheKey); });
  MEDIA_BIAS_REQUESTS.set(cacheKey, inflight);

  inflight
    .then(payload => {
      const data = payload && payload.data;
      if (!data){
        const reason = (payload && payload.reason) ? String(payload.reason) : 'not_available';
        const msg = (reason === 'not_enough_sources' || reason === 'not_enough_bias_data')
          ? wt('widgets.media_bias.not_enough', 'Not enough data to estimate media bias for this story.')
          : wt('widgets.media_bias.unavailable', 'Bias data is not available yet.');
        root.innerHTML = `<div class="muted" style="font-size:13px; line-height:1.35;">${escapeHtml(msg)}</div>`;
        return;
      }

      const leftP = clamp(Number(data.left?.percent || 0), 0, 100);
      const centerP = clamp(Number(data.center?.percent || 0), 0, 100);
      const rightP = clamp(Number(data.right?.percent || 0), 0, 100);

      const leftC = Number(data.left?.count || 0) || 0;
      const centerC = Number(data.center?.count || 0) || 0;
      const rightC = Number(data.right?.count || 0) || 0;
      const unknownC = Number(data.unknown?.count || 0) || 0;
      const classifiedSources = Number(data.classified_sources || (leftC + centerC + rightC) || 0) || 0;
      const totalSources = Number(data.total_sources || (classifiedSources + unknownC) || classifiedSources || 0) || 0;
      const coveragePct = clamp(Number(data.coverage || 0), 0, 100);

      const conf = String(data.confidence || '').toLowerCase();
      const confLabel = conf ? conf.charAt(0).toUpperCase() + conf.slice(1) : '';

      const bar = `
        <div class="mbBar" role="img" aria-label="${escapeHtml(wt('widgets.media_bias.aria', 'Media bias distribution'))}">
          <div class="mbSeg mbLeft" style="width:${leftP}%;"></div>
          <div class="mbSeg mbCenter" style="width:${centerP}%;"></div>
          <div class="mbSeg mbRight" style="width:${rightP}%;"></div>
        </div>
      `;

      const stats = `
        
        <div class="mbStats">
          <div class="mbStat">
            <span class="mbDot mbLeft"></span>
            <span class="mbLabel"><b>${escapeHtml(wt("widgets.media_bias.left", "Left"))}</b> ${leftC} ${escapeHtml(wt("widgets.media_bias.sources", "sources"))}</span>
            <span class="mbPct">${leftP}%</span>
          </div>
          <div class="mbStat">
            <span class="mbDot mbCenter"></span>
            <span class="mbLabel"><b>${escapeHtml(wt("widgets.media_bias.center", "Center"))}</b> ${centerC} ${escapeHtml(wt("widgets.media_bias.sources", "sources"))}</span>
            <span class="mbPct">${centerP}%</span>
          </div>
          <div class="mbStat">
            <span class="mbDot mbRight"></span>
            <span class="mbLabel"><b>${escapeHtml(wt("widgets.media_bias.right", "Right"))}</b> ${rightC} ${escapeHtml(wt("widgets.media_bias.sources", "sources"))}</span>
            <span class="mbPct">${rightP}%</span>
          </div>
        </div>
      `;

      const toggleBtn = `<button type="button" class="mbToggleBtn">${escapeHtml(wt("widgets.media_bias.show_sources", "Show sources"))}</button>`;
      const detailsWrap = `<div class="mbDetails" style="display:none;"></div>`;

      root.innerHTML = `
        <div class="mbTop">
          ${bar}
          ${stats}
          <div class="mbMeta">
            ${confLabel ? `<span class="chip">${escapeHtml(wt("widgets.media_bias.confidence", "Confidence"))}: <b>${escapeHtml(wt(`widgets.media_bias.conf_${conf}`, confLabel))}</b></span>` : ''}
            ${totalSources > 0 ? `<span class="chip">${escapeHtml(wt("widgets.media_bias.coverage", "Coverage"))}: <b>${classifiedSources}/${totalSources}</b></span>` : ''}
            ${unknownC > 0 ? `<span class="chip">${escapeHtml(wt("widgets.media_bias.unknown", "Unknown"))}: <b>${unknownC}</b></span>` : ''}
            ${data.is_partial ? `<span class="chip">${escapeHtml(wt("widgets.media_bias.partial", "Partial classification"))} · <b>${coveragePct}%</b></span>` : ''}
          </div>
          <div class="mbActions">${toggleBtn}</div>
          ${detailsWrap}
        </div>
      `;

      const btn = root.querySelector('.mbToggleBtn');
      const details = root.querySelector('.mbDetails');

      function renderSourceList(list){
        const items = (list || []).map((x) => {
          const dom = escapeHtml(String(x.domain || ''));
          const nm = escapeHtml(String(x.name || ((x.names && x.names[0]) ? x.names[0] : dom) || dom));
          return `<li><span class="mbSrcName">${nm}</span><span class="mbSrcDomain">${dom}</span></li>`;
        }).join('');
        return `<ul class="mbSrcList">${items || '<li class="muted">—</li>'}</ul>`;
      }

      function buildDetails(){
        const leftList = renderSourceList(data.left?.sources || []);
        const centerList = renderSourceList(data.center?.sources || []);
        const rightList = renderSourceList(data.right?.sources || []);
        const unknownList = renderSourceList(data.unknown?.sources || []);

        return `
          <div class="mbGroup">
            <div class="mbGroupTitle"><span class="mbDot mbLeft"></span>${escapeHtml(wt("widgets.media_bias.left", "Left"))}</div>
            ${leftList}
          </div>
          <div class="mbGroup">
            <div class="mbGroupTitle"><span class="mbDot mbCenter"></span>${escapeHtml(wt("widgets.media_bias.center", "Center"))}</div>
            ${centerList}
          </div>
          <div class="mbGroup">
            <div class="mbGroupTitle"><span class="mbDot mbRight"></span>${escapeHtml(wt("widgets.media_bias.right", "Right"))}</div>
            ${rightList}
          </div>
          ${unknownC > 0 ? `
          <div class="mbGroup">
            <div class="mbGroupTitle"><span class="mbDot"></span>${escapeHtml(wt("widgets.media_bias.unknown", "Unknown"))}</div>
            ${unknownList}
          </div>` : ''}
        `;
      }

      if (btn && details){
        btn.addEventListener('click', () => {
          const isOpen = details.style.display !== 'none';
          details.style.display = isOpen ? 'none' : 'block';
          btn.textContent = isOpen ? wt('widgets.media_bias.show_sources', 'Show sources') : wt('widgets.media_bias.hide_sources', 'Hide sources');
          if (!isOpen && !details.dataset.ready){
            details.innerHTML = buildDetails();
            details.dataset.ready = '1';
          }
        });
      }
    })
    .catch(() => {
      root.innerHTML = `<div class="muted" style="font-size:13px;">Bias data is not available yet.</div>`;
    });
}

const WIDGETS = {
    fx_rates: {
      ...widgetMeta("fx_rates", "FX Rates", "EUR rates for major currencies (customizable)."),
      defaults: { base: "EUR", symbols: "USD,GBP,PLN,UAH" },
      pro: true,
      render: renderFxRates,
      settingsUI: fxRatesSettingsUI,
    },
    crypto_prices: {
      ...widgetMeta("crypto_prices", "Crypto", "BTC/ETH prices (customizable) via CoinGecko."),
      defaults: { vs: "eur", coins: "bitcoin,ethereum" },
      pro: true,
      render: renderCrypto,
      settingsUI: cryptoSettingsUI,
    },
    headlines: {
      ...widgetMeta("headlines", "Top Headlines", "Quick peek at what’s currently in your feed."),
      defaults: { limit: 4 },
      render: renderHeadlines,
      settingsUI: headlinesSettingsUI,
    },
    tracking_stats: {
      ...widgetMeta("tracking_stats", "Tracking Stats", "How many items you’re tracking + quick shortcuts."),
      defaults: {},
      render: renderTrackingStats,
      settingsUI: null,
    },
    media_bias: {
      ...widgetMeta("media_bias", "Media Bias", "Left • Center • Right distribution across sources in the current story."),
      defaults: {},
      pro: false,
      render: renderMediaBias,
      settingsUI: null,
    },

    market_clock: {
      ...widgetMeta("market_clock", "GLOBAL CLOCK", "Choose cities and see local timezones."),
      // Show up to 8 cities (similar UX to FX Rates).
      defaults: { cities: "Europe/Berlin,Europe/London,America/New_York,Asia/Tokyo,Europe/Kyiv" },
      render: renderMarketClock,
      settingsUI: marketClockSettingsUI,
    },

    // =========================
    // PRO Widgets (Premium)
    // =========================
    pro_momentum: {
      ...widgetMeta("pro_momentum", "Momentum Timeline", "Shows whether a topic is rising or cooling down."),
      defaults: { limit: 1 },
      pro: true,
      render: renderProMomentum,
      settingsUI: null,
    },
    pro_entities: {
      ...widgetMeta("pro_entities", "Entities", "People / countries / orgs trending right now."),
      defaults: { limit: 8 },
      pro: true,
      render: renderProEntities,
      settingsUI: null,
    },
    pro_related_coverage: {
      ...widgetMeta("pro_related_coverage", "Related Coverage", "More articles about the same event — from other outlets."),
      defaults: { limit: 6 },
      pro: true,
      render: renderProRelatedCoverage,
      settingsUI: relatedCoverageSettingsUI,
    },
    pro_recent_history: {
      ...widgetMeta("pro_recent_history", "Recent History", "Latest publications within this event cluster (24h / 3d / week)."),
      defaults: { limit: 10, window: '3d' },
      pro: true,
      render: renderProRecentHistory,
      settingsUI: recentHistorySettingsUI,
    },
// Video Report is FREE (server-side cached to save YouTube quota)
pro_video_report: {
  ...widgetMeta("pro_video_report", "Video Report", "Watch a relevant report for the currently opened story (embedded, no re-hosting)."),
  defaults: { max_results: 5 },
  pro: false,
  render: renderProVideoReport,
  settingsUI: videoReportSettingsUI,
},
    pro_silence: {
      ...widgetMeta("pro_silence", "Silence Indicator", "Shows notable outlets/regions that are not covering this story."),
      defaults: { threshold: 4 },
      pro: true,
      disabled: true,
      render: renderProSilenceIndicator,
      settingsUI: silenceSettingsUI,
    },
  };


  // ----------------------------
  // Temporary / feature-flagged widgets
  // ----------------------------
  function isWidgetEnabled(type){
    const t = String(type || "");
    const def = WIDGETS[t];
    return !!def && !def.disabled;
  }

  function countEnabled(arr){
    let n = 0;
    (arr || []).forEach(w => { if (w && isWidgetEnabled(w.type)) n++; });
    return n;
  }

  function clampPerSide(arr){
    // Keep all disabled widgets in storage (so we can re-enable later),
    // but limit the number of ENABLED widgets shown per side.
    let enabled = 0;
    const out = [];
    (arr || []).forEach(w => {
      if (!w) return;
      if (!isWidgetEnabled(w.type)) { out.push(w); return; }
      enabled += 1;
      if (enabled <= MAX_PER_SIDE) out.push(w);
    });
    return out;
  }

  function clampGlobal(layout){
    // Enforce MAX_TOTAL only across ENABLED widgets (disabled ones don't count).
    const l = layout?.left || [];
    const r = layout?.right || [];
    const enabledTotal = () => countEnabled(l) + countEnabled(r);

    const popLastEnabled = (arr) => {
      for (let i = arr.length - 1; i >= 0; i--){
        if (isWidgetEnabled(arr[i]?.type)) { arr.splice(i, 1); return true; }
      }
      return false;
    };

    while (enabledTotal() > MAX_TOTAL){
      if (!popLastEnabled(r)){
        if (!popLastEnabled(l)) break;
      }
    }
    return layout;
  }

  function actionFeedSettingsUI(mount, settings){
    const s = settings || {};
    mount.innerHTML = `
      <label class="setRow">
        <div class="setLabel">Items</div>
        <input class="setInput" type="number" name="limit" min="3" max="10" value="${escapeAttr(String(s.limit ?? 5))}" />
      </label>
      <div class="setHint">Shows top items with a clear explanation and quick actions.</div>
    `;
  }

  function alertsSettingsUI(mount, settings){
    const preset = String((settings && settings.preset) ? settings.preset : 'breaking');
    mount.innerHTML = `
      <div class="setHint" style="margin-bottom:10px;">Choose how often you want alerts:</div>
      <label class="setRow">
        <div class="setLabel">Preset</div>
        <select class="setSelect" name="preset">
          <option value="breaking" ${preset==='breaking'?'selected':''}>Breaking only</option>
          <option value="high_risk" ${preset==='high_risk'?'selected':''}>High risk only</option>
          <option value="daily" ${preset==='daily'?'selected':''}>Daily digest</option>
        </select>
      </label>
      <div class="setHint">This controls what the widget highlights. Delivery rules on the backend can be added next.</div>
    `;
  }

  function topChartsSettingsUI(mount, settings){
    const s = settings || {};
    mount.innerHTML = `
      <label class="setRow">
        <div class="setLabel">Stories</div>
        <input class="setInput" type="number" name="limit" min="3" max="10" value="${escapeAttr(String(s.limit ?? 6))}" />
      </label>
      <label class="setRow">
        <div class="setLabel">Auto-slide (sec)</div>
        <input class="setInput" type="number" name="seconds" min="3" max="20" value="${escapeAttr(String(s.seconds ?? 6))}" />
      </label>
      <div class="setHint">Mini graphs reuse your existing trust-history charts. Auto-slides like a premium dashboard.</div>
    `;
  }

  function relatedCoverageSettingsUI(mount, settings){
    const s = settings || {};
    mount.innerHTML = `
      <label class="setRow">
        <div class="setLabel">Items</div>
        <input class="setInput" type="number" name="limit" min="3" max="10" value="${escapeAttr(String(s.limit ?? 6))}" />
      </label>
      <div class="setHint">Shows 3–10 articles from the <b>same event cluster</b>, prioritizing different outlets.</div>
    `;
  }

  function recentHistorySettingsUI(mount, settings){
    const s = settings || {};
    const win = String(s.window || '3d');
    mount.innerHTML = `
      <label class="setRow">
        <div class="setLabel">Window</div>
        <select class="setSelect" name="window">
          <option value="24h" ${win==='24h'?'selected':''}>Last 24 hours</option>
          <option value="3d" ${win==='3d'?'selected':''}>Last 3 days</option>
          <option value="7d" ${win==='7d'?'selected':''}>Last week</option>
        </select>
      </label>
      <label class="setRow">
        <div class="setLabel">Items</div>
        <input class="setInput" type="number" name="limit" min="5" max="20" value="${escapeAttr(String(s.limit ?? 10))}" />
      </label>
      <div class="setHint">Sorted by publication time. Helps see how the story evolved.</div>
    `;
  }

  function silenceSettingsUI(mount, settings){
    const s = settings || {};
    mount.innerHTML = `
      <label class="setRow">
        <div class="setLabel">Coverage threshold</div>
        <input class="setInput" type="number" name="threshold" min="2" max="10" value="${escapeAttr(String(s.threshold ?? 4))}" />
      </label>
      <div class="setHint">If a story has at least this many outlets but is missing major expected sources, we flag it.</div>
    `;
  }

// ===== Settings presets (for user-friendly configuration) =====
const FIAT_CODES = [
  "EUR","USD","GBP","CHF","JPY","CAD","AUD","NZD",
  "PLN","UAH","SEK","NOK","DKK","CZK","HUF","RON",
  "TRY","ILS","CNY","HKD","SGD","INR","BRL","MXN"
];

const COIN_PRESETS = [
  { value:"bitcoin", label:"Bitcoin (BTC)" },
  { value:"ethereum", label:"Ethereum (ETH)" },
  { value:"tether", label:"Tether (USDT)" },
  { value:"binancecoin", label:"BNB (BNB)" },
  { value:"solana", label:"Solana (SOL)" },
  { value:"ripple", label:"XRP (XRP)" },
  { value:"usd-coin", label:"USD Coin (USDC)" },
  { value:"cardano", label:"Cardano (ADA)" },
  { value:"dogecoin", label:"Dogecoin (DOGE)" },
  { value:"tron", label:"TRON (TRX)" },
  { value:"toncoin", label:"Toncoin (TON)" },
  { value:"polkadot", label:"Polkadot (DOT)" },
  { value:"avalanche-2", label:"Avalanche (AVAX)" },
  { value:"chainlink", label:"Chainlink (LINK)" },
  { value:"litecoin", label:"Litecoin (LTC)" },
];

// Global Clock: curated city list (timezone + label)
const CLOCK_CITIES = [
  { tz: "Europe/Berlin", label: "Berlin" },
  { tz: "Europe/London", label: "London" },
  { tz: "Europe/Paris", label: "Paris" },
  { tz: "Europe/Warsaw", label: "Warsaw" },
  { tz: "Europe/Kyiv", label: "Kyiv" },
  { tz: "Europe/Istanbul", label: "Istanbul" },
  { tz: "America/New_York", label: "New York" },
  { tz: "America/Chicago", label: "Chicago" },
  { tz: "America/Los_Angeles", label: "Los Angeles" },
  { tz: "America/Toronto", label: "Toronto" },
  { tz: "America/Sao_Paulo", label: "São Paulo" },
  { tz: "Asia/Dubai", label: "Dubai" },
  { tz: "Asia/Tokyo", label: "Tokyo" },
  { tz: "Asia/Shanghai", label: "Shanghai" },
  { tz: "Asia/Singapore", label: "Singapore" },
  { tz: "Asia/Hong_Kong", label: "Hong Kong" },
  { tz: "Asia/Seoul", label: "Seoul" },
  { tz: "Asia/Kolkata", label: "Mumbai" },
  { tz: "Australia/Sydney", label: "Sydney" },
];

function parseList(v){
  return String(v || "")
    .split(",")
    .map(s => s.trim())
    .filter(Boolean);
}

function uniq(arr){
  const out = [];
  const seen = new Set();
  for (const v of arr){
    const k = String(v);
    if (seen.has(k)) continue;
    seen.add(k);
    out.push(k);
  }
  return out;
}

function createMultiSelect(mountEl, opts){
  // opts: { placeholder, options:[{value,label}], selected:[value], max, onChange, allowCustom, normalizeCustom }
  const placeholder = opts && opts.placeholder ? String(opts.placeholder) : "Search…";
  const max = (opts && Number.isFinite(Number(opts.max))) ? Number(opts.max) : 8;
  const allowCustom = !!(opts && opts.allowCustom);
  const normalizeCustom = (opts && typeof opts.normalizeCustom === "function") ? opts.normalizeCustom : (v) => String(v||"").trim();
  const optionList = Array.isArray(opts && opts.options) ? opts.options : [];
  const labelFor = new Map(optionList.map(o => [String(o.value), String(o.label || o.value)]));

  let selected = uniq(Array.isArray(opts && opts.selected) ? opts.selected.map(String) : []).slice(0, max);

  // Build base DOM
  mountEl.innerHTML = `
    <div class="msWrap">
      <div class="msChips" data-ms-chips></div>
      <div class="msInputRow">
        <input class="msInput" type="text" placeholder="${escapeAttr(placeholder)}" autocomplete="off" data-ms-input />
        <button class="msCaret" type="button" aria-label="Open">▾</button>
      </div>
      <div class="msDropdown" data-ms-dd aria-hidden="true"></div>
    </div>
  `;

  const chipsEl = mountEl.querySelector("[data-ms-chips]");
  const inputEl = mountEl.querySelector("[data-ms-input]");
  const ddEl = mountEl.querySelector("[data-ms-dd]");
  const caretBtn = mountEl.querySelector(".msCaret");

  if (!chipsEl || !(inputEl instanceof HTMLInputElement) || !ddEl) return;

  function emit(){
    try { if (opts && typeof opts.onChange === "function") opts.onChange(selected.slice()); } catch {}
  }

  function closeDD(){
    ddEl.setAttribute("aria-hidden", "true");
    ddEl.classList.remove("open");
  }

  function openDD(){
    ddEl.setAttribute("aria-hidden", "false");
    ddEl.classList.add("open");
    renderDD(inputEl.value || "");
  }

  function toggleDD(){
    const isOpen = ddEl.classList.contains("open");
    if (isOpen) closeDD(); else openDD();
  }

  function renderChips(){
    chipsEl.innerHTML = "";
    if (!selected.length){
      const hint = document.createElement("div");
      hint.className = "msHint";
      hint.textContent = "Nothing selected yet.";
      chipsEl.appendChild(hint);
      return;
    }
    selected.forEach((v) => {
      const chip = document.createElement("button");
      chip.type = "button";
      chip.className = "msChip";
      chip.innerHTML = `<span class="msChipText">${escapeHtml(labelFor.get(v) || v)}</span><span class="msChipX">×</span>`;
      chip.addEventListener("click", () => {
        selected = selected.filter(x => x !== v);
        renderChips();
        renderDD(inputEl.value || "");
        emit();
      });
      chipsEl.appendChild(chip);
    });
  }

  function addValue(v){
    const val = String(v || "").trim();
    if (!val) return;
    if (selected.includes(val)) return;
    if (selected.length >= max) return;
    selected = selected.concat([val]);
    renderChips();
    renderDD(inputEl.value || "");
    emit();
  }

  function renderDD(query){
    const q = String(query || "").trim().toLowerCase();
    ddEl.innerHTML = "";

    const items = optionList
      .map(o => ({ value:String(o.value), label:String(o.label || o.value) }))
      .filter(o => !selected.includes(o.value))
      .filter(o => !q || o.label.toLowerCase().includes(q) || o.value.toLowerCase().includes(q))
      .slice(0, 18);

    if (!items.length && !(allowCustom && q)){
      const empty = document.createElement("div");
      empty.className = "msEmpty";
      empty.textContent = "No matches.";
      ddEl.appendChild(empty);
      return;
    }

    if (allowCustom && q){
      const customVal = normalizeCustom(query);
      if (customVal && !selected.includes(customVal) && selected.length < max){
        const row = document.createElement("button");
        row.type = "button";
        row.className = "msRow";
        row.innerHTML = `<span class="msRowMain">Add “${escapeHtml(customVal)}”</span><span class="msRowSub">Custom id</span>`;
        row.addEventListener("click", () => {
          addValue(customVal);
          inputEl.value = "";
          inputEl.focus();
        });
        ddEl.appendChild(row);
      }
    }

    items.forEach((it) => {
      const row = document.createElement("button");
      row.type = "button";
      row.className = "msRow";
      row.innerHTML = `<span class="msRowMain">${escapeHtml(it.label)}</span><span class="msRowSub">${escapeHtml(it.value)}</span>`;
      row.addEventListener("click", () => {
        addValue(it.value);
        inputEl.value = "";
        inputEl.focus();
      });
      ddEl.appendChild(row);
    });
  }

  // Events
  inputEl.addEventListener("focus", () => openDD());
  inputEl.addEventListener("input", () => renderDD(inputEl.value || ""));
  inputEl.addEventListener("keydown", (e) => {
    if (e.key === "Escape"){
      closeDD();
      inputEl.blur();
    }
    if (e.key === "Enter"){
      if (!allowCustom) return;
      e.preventDefault();
      const v = normalizeCustom(inputEl.value || "");
      if (v && !selected.includes(v) && selected.length < max){
        addValue(v);
        inputEl.value = "";
      }
    }
  });

  if (caretBtn) caretBtn.addEventListener("click", toggleDD);

  // Click outside closes (bind once per mount to avoid stacking listeners)
  if (!mountEl.dataset._msDocBound){
    mountEl.dataset._msDocBound = "1";
    const onDoc = (ev) => {
      if (!(ev && ev.target)) return;
      if (mountEl.contains(ev.target)) return;
      closeDD();
    };
    document.addEventListener("mousedown", onDoc, { passive:true });
  }

  // Initial render
  renderChips();
  emit();
}

  
  function setupSidebarFollow(leftEl, rightEl){
  // Fallback for cases where CSS `position: sticky` breaks (some grid/overflow combos).
  // We emulate sticky by fixing an INNER wrapper, while keeping the sidebar element in-flow
  // (via min-height) so the layout does not shift or overlap the main content.
  const TOP_GAP = 14;
  const SIDES = [leftEl, rightEl].filter(Boolean);

  function headerH(){
    try{
      const h = getComputedStyle(document.body).getPropertyValue('--headerH');
      const n = Number(String(h || '').replace('px','').trim());
      return Number.isFinite(n) && n > 0 ? n : 92;
    } catch { return 92; }
  }

  // per sidebar state
  const meta = new Map(); // el -> { startY, inner, stickyBrokenCount, emulate, fixed, releasing, releaseT }

  function ensureInner(el){
    let inner = el.querySelector('.sidebarInner');
    if (inner) return inner;
    inner = document.createElement('div');
    inner.className = 'sidebarInner';
      inner.style.display = 'flex';
      inner.style.flexDirection = 'column';
      inner.style.gap = '16px';
    while (el.firstChild) inner.appendChild(el.firstChild);
    el.appendChild(inner);
    return inner;
  }

  function captureStart(el){
    const r = el.getBoundingClientRect();
    const s = meta.get(el) || {};
    s.startY = window.scrollY + r.top;
    s.inner = s.inner || ensureInner(el);
    s.stickyBrokenCount = s.stickyBrokenCount || 0;
    s.emulate = !!s.emulate;
    meta.set(el, s);
  }

  function applyEmulate(el, s){
    const top = headerH() + TOP_GAP;
    const r = el.getBoundingClientRect();

    // keep space in the grid column so main content doesn't reflow
    const innerH = s.inner.offsetHeight;
    el.style.minHeight = innerH ? (innerH + 'px') : '';

    // fix the inner wrapper (not the sidebar itself)
    // Base max height (viewport-based). We'll further clamp it when the footer enters.
    let maxH = Math.max(120, window.innerHeight - top - 16);
    s.inner.style.position = 'fixed';
    s.inner.style.top = top + 'px';
    s.inner.style.left = r.left + 'px';
    s.inner.style.width = r.width + 'px';
    s.inner.style.maxHeight = maxH + 'px';
    s.inner.style.overflow = 'auto';
    s.inner.style.zIndex = '20';

    // Premium motion: smooth fade/slide both when sticking and when releasing.
    // Keep transitions lightweight to avoid jank.
    if (!s.inner.dataset._followInit){
      s.inner.dataset._followInit = '1';
      s.inner.style.willChange = 'transform, opacity, left, top';
      s.inner.style.transition = 'opacity 180ms ease, transform 220ms ease';
    }

    // If user scrolls back down during a release animation, cancel the release.
    if (s.releaseT){
      clearTimeout(s.releaseT);
      s.releaseT = null;
      s.releasing = false;
    }
    s.inner.style.opacity = '1';

    // Prevent overlapping the footer:
    // Instead of translating the whole sidebar up (which can make left/right columns
    // visually misalign), we keep the TOP fixed and simply shrink the scroll area
    // when the footer comes into view.
    try {
      const footer = document.querySelector('footer.siteFooter, .siteFooter');
      if (footer){
        const fr = footer.getBoundingClientRect();
        const safeGap = 18; // breathing room above the footer
        const available = fr.top - safeGap - top;
        if (Number.isFinite(available) && available > 120){
          maxH = Math.max(120, Math.min(maxH, available));
        }
      }
    } catch {}

    s.inner.style.maxHeight = maxH + 'px';
    s.inner.style.transform = '';
    s.fixed = true;
  }

  // Public helper so other modules can toggle widgets on/off (e.g. Profile/Pricing pages)
  // without reaching into sidebar internals.
  if (typeof window !== 'undefined' && !window.__setWidgetsEnabled){
    window.__setWidgetsEnabled = (enabled) => {
      try{
        const on = !!enabled;
        document.body.classList.toggle('widgets-disabled', !on);
        // Nudge the follow logic to recalc positions after layout changes.
        try{ document.dispatchEvent(new Event('checkne:widgetsRendered')); }catch{}
      }catch{}
    };
  }

  function clearEmulate(el, s){
    el.style.minHeight = '';
    s.inner.style.position = '';
    s.inner.style.top = '';
    s.inner.style.left = '';
    s.inner.style.width = '';
    s.inner.style.maxHeight = '';
    s.inner.style.overflow = '';
    s.inner.style.zIndex = '';
    s.fixed = false;
  }

  function startRelease(el, s){
    if (s.releasing) return;
    s.releasing = true;

    // Fade/slide out the fixed copy.
    s.inner.style.opacity = '0';
    s.inner.style.transform = 'translateY(-8px)';

    // After fade-out, drop back into normal flow.
    // Keep minHeight until clearEmulate to prevent layout jump.
    s.releaseT = setTimeout(() => {
      s.releaseT = null;
      clearEmulate(el, s);
      // Reset for in-flow rendering.
      s.inner.style.opacity = '';
      s.inner.style.transform = '';
      s.releasing = false;
    }, 190);
  }

  function update(){
    const top = headerH() + TOP_GAP;

    for (const el of SIDES){
      if (!meta.has(el)) captureStart(el);
      const s = meta.get(el);

      // Re-capture start if layout changed significantly (responsive changes)
      const r = el.getBoundingClientRect();
      const approxStart = window.scrollY + r.top;
      if (!Number.isFinite(s.startY) || Math.abs(approxStart - s.startY) > 320){
        captureStart(el);
      }

      const shouldStick = (window.scrollY + top) >= s.startY;

      // If we're not emulating, observe whether native sticky is behaving.
      // If it isn't for a few frames while it *should* stick, enable emulate.
      if (!s.emulate && shouldStick){
        const delta = Math.abs(r.top - top);
        if (delta > 10){
          s.stickyBrokenCount = (s.stickyBrokenCount || 0) + 1;
        } else {
          s.stickyBrokenCount = 0;
        }
        if (s.stickyBrokenCount >= 3){
          s.emulate = true;
        }
      }

      if (s.emulate && shouldStick){
        applyEmulate(el, s);
      } else {
        // If we're currently fixed, release smoothly (no abrupt vanish at header).
        if (s.fixed){
          startRelease(el, s);
        } else {
          clearEmulate(el, s);
        }
        // reset counter when we are above the start
        if (!shouldStick) s.stickyBrokenCount = 0;
      }
    }
  }

  // Init
  requestAnimationFrame(() => {
    SIDES.forEach(captureStart);
    update();
  });

  window.addEventListener('scroll', update, { passive: true });
  window.addEventListener('resize', () => {
    meta.clear();
    requestAnimationFrame(() => {
      SIDES.forEach(captureStart);
      update();
    });
  });

  // Header hide/show (if you dispatch this event elsewhere)
  document.addEventListener('checkne:header', () => requestAnimationFrame(update));

  function forceRefresh(){
    // Re-apply follow positioning after DOM/height changes.
    // A single frame is not always enough when the feed is deep-scrolled and
    // widget add/remove causes the page/grid height to settle over multiple paints.
    for (const el of SIDES){
      const s = meta.get(el);
      if (!s || !s.inner) continue;
      try {
        s.inner.style.transition = 'none';
        s.inner.style.opacity = '1';
        s.inner.style.transform = '';
        if (s.releaseT){
          clearTimeout(s.releaseT);
          s.releaseT = null;
        }
        s.releasing = false;
      } catch {}
    }

    meta.clear();
    requestAnimationFrame(() => {
      SIDES.forEach(captureStart);
      update();
      requestAnimationFrame(() => {
        SIDES.forEach(captureStart);
        update();
        setTimeout(() => {
          SIDES.forEach(captureStart);
          update();
          for (const el of SIDES){
            const s = meta.get(el);
            if (!s || !s.inner) continue;
            try { s.inner.style.transition = ''; } catch {}
          }
        }, 40);
      });
    });
  }

  if (typeof window !== 'undefined'){
    window.__checkneRefreshSidebarFollow = forceRefresh;
  }

  // Widgets were re-rendered (configure/add/remove). Re-measure for follow.
  document.addEventListener('checkne:widgetsRendered', forceRefresh);
}

function uid(){
    return Math.random().toString(16).slice(2) + Date.now().toString(16);
  }

  function safeParse(json){
    try { return JSON.parse(json); } catch { return null; }
  }

  function loadLayout(){
    const raw = localStorage.getItem(STORAGE_KEY);
    const parsed = raw ? safeParse(raw) : null;
    const inited = localStorage.getItem(INIT_KEY) === '1';

    // Use stored layout if it looks valid (even if it's empty arrays).
    let layout = (parsed && typeof parsed === "object") ? parsed : null;

    const hasSides = layout && Object.prototype.hasOwnProperty.call(layout, "left") && Object.prototype.hasOwnProperty.call(layout, "right");
    if (!hasSides) layout = null;

    // Default dashboard for brand-new users (matches the main promo layout):
    // Left: Video Report + Top Headlines
    // Right: FX Rates + Crypto
    const makeDefault = () => ({
      left: [
        { id: uid(), type: "pro_video_report", settings: { ...WIDGETS.pro_video_report.defaults } },
        { id: uid(), type: "headlines", settings: { ...WIDGETS.headlines.defaults } },
      ],
      right: [
        { id: uid(), type: "market_clock", settings: { ...WIDGETS.market_clock.defaults } },
        { id: uid(), type: "tracking_stats", settings: { ...WIDGETS.tracking_stats.defaults } },
      ],
    });

    // First-time users (no storage yet) get a sensible default.
    if (!layout){
      layout = makeDefault();
      try { localStorage.setItem(INIT_KEY, '1'); } catch {}
    }

    // Normalize + validate (and allow fully empty layouts).
    if (!Array.isArray(layout.left)) layout.left = [];
    if (!Array.isArray(layout.right)) layout.right = [];

    const normalizeList = (arr) => {
      return (arr || [])
        .filter(w => w && typeof w === "object")
        .map(w => {
          const type = String(w.type || "");
          const def = WIDGETS[type];
          if (!def) return null;
          const settings = (w.settings && typeof w.settings === "object") ? w.settings : { ...(def.defaults || {}) };
          return { id: String(w.id || uid()), type, settings };
        })
        .filter(Boolean);
    };

    layout.left = clampPerSide(normalizeList(layout.left));
    layout.right = clampPerSide(normalizeList(layout.right));

    // If we have a stored layout but it ended up empty and the user never
    // successfully initialized widgets (common after hard refreshes or migrations),
    // restore the default 3-widget layout.
    if (!inited && (countEnabled(layout.left) + countEnabled(layout.right)) === 0){
      layout = makeDefault();
      try { localStorage.setItem(INIT_KEY, '1'); } catch {}
    }

    // Enforce global max across both sides (enabled widgets only)
    clampGlobal(layout);

    return layout;
  }

  
  function totalWidgets(){
    try { return countEnabled(state.layout?.left) + countEnabled(state.layout?.right); } catch { return 0; }
  }
function saveLayout(){
    localStorage.setItem(STORAGE_KEY, JSON.stringify(state.layout));
    try { localStorage.setItem(INIT_KEY, '1'); } catch {}

    // Persist layout to the backend as part of account-scoped UI prefs
    // so the same account has identical widgets across devices.
    try {
      if (typeof window.checkneRequestSaveUiPrefs === 'function') window.checkneRequestSaveUiPrefs();
    } catch {}
  }

  const state = {
    layout: null,
    drag: null, // {id, fromSide, fromIndex}
    modal: { open:false, mode:"pick", side:"left", widgetId:null },
    mobile: { activeKey: null, activeId: null } // currently opened widget (mobile sheet)
  };

  // Export/Import helpers for account-scoped preferences.
  function deepClone(obj){
    try { return JSON.parse(JSON.stringify(obj)); } catch { return obj; }
  }

  function normalizeIncomingLayout(layout){
    if (!layout || typeof layout !== 'object') return null;
    const out = { left: Array.isArray(layout.left) ? layout.left : [], right: Array.isArray(layout.right) ? layout.right : [] };

    const normalizeList = (arr) => {
      return (arr || [])
        .filter(w => w && typeof w === 'object')
        .map(w => {
          const type = String(w.type || "");
          const def = WIDGETS[type];
          if (!def) return null;
          const settings = (w.settings && typeof w.settings === "object") ? w.settings : { ...(def.defaults || {}) };
          return { id: String(w.id || uid()), type, settings };
        })
        .filter(Boolean);
    };

    out.left = clampPerSide(normalizeList(out.left));
    out.right = clampPerSide(normalizeList(out.right));
    clampGlobal(out);
    return out;
  }

  window.checkneGetWidgetsLayout = function(){
    try { return deepClone(state.layout); } catch { return null; }
  };

  window.checkneApplyWidgetsLayout = function(layout, opts){
    const persistLocal = !(opts && opts.persistLocal === false);
    const norm = normalizeIncomingLayout(layout);
    if (!norm) return false;
    state.layout = norm;
    if (persistLocal) {
      try { localStorage.setItem(STORAGE_KEY, JSON.stringify(state.layout)); } catch {}
      try { localStorage.setItem(INIT_KEY, '1'); } catch {}
    }
    try { renderAll(); } catch {}
    try { updateMobileDock(); } catch {}
    return true;
  };

  // ===== Mobile (phone) UI =====
  const MOBILE_BP = 980;
  let mobileDock = null;
  let mobileSheet = null;

  function isMobile(){
    try { return window.matchMedia && window.matchMedia(`(max-width: ${MOBILE_BP}px)`).matches; } catch {}
    return window.innerWidth <= MOBILE_BP;
  }

  function widgetsEnabled(){
    try { return !document.body.classList.contains('widgets-disabled'); } catch { return true; }
  }

  function allWidgetInstances(){
    const out = [];
    const left = state.layout?.left || [];
    const right = state.layout?.right || [];
    left.forEach(w => { if (w && isWidgetEnabled(w.type)) out.push({ side:'left', w }); });
    right.forEach(w => { if (w && isWidgetEnabled(w.type)) out.push({ side:'right', w }); });
    return out;
  }

  function ensureMobileUI(){
    if (mobileDock && mobileSheet) return;

    // Dock
    mobileDock = document.createElement('div');
    mobileDock.className = 'mwDock';
    mobileDock.id = 'mwDock';

    // Hint
    const hint = document.createElement('div');
    hint.className = 'mwDockHint';
    hint.textContent = 'Hold + swipe up/down to delete';
    mobileDock.appendChild(hint);

    // Sheet
    mobileSheet = document.createElement('div');
    mobileSheet.className = 'mwSheet';
    mobileSheet.id = 'mwSheet';
    mobileSheet.innerHTML = `
      <div class="mwSheetBackdrop" data-mw-close="1"></div>
      <div class="mwSheetPanel" role="dialog" aria-modal="true">
        <div class="mwSheetHead">
          <div class="mwSheetTitle" id="mwSheetTitle">Widget</div>
          <div class="mwSheetActions" id="mwSheetActions"></div>
        </div>
        <div class="mwSheetBody" id="mwSheetBody"></div>
      </div>
    `;

    document.body.appendChild(mobileDock);
    document.body.appendChild(mobileSheet);

    // Close interactions
    mobileSheet.addEventListener('click', (e) => {
      const t = e.target;
      if (!(t instanceof HTMLElement)) return;
      if (t.getAttribute('data-mw-close') === '1') closeMobileSheet();
    });
  }

  function setDockVisible(on){
    if (!mobileDock) return;
    mobileDock.classList.toggle('isOn', !!on);
    try { document.body.classList.toggle('hasMobileWidgetDock', !!on); } catch {}
  }

  function updateMobileDock(){
    ensureMobileUI();

    const shouldShow = isMobile() && widgetsEnabled();
    setDockVisible(shouldShow);
    if (!shouldShow){
      closeMobileSheet(true);
      return;
    }

    const items = allWidgetInstances();

    mobileDock.innerHTML = '';

    // Helper: long-press + swipe up/down to delete (mobile only)
    const attachSwipeToDelete = (btn, side, widgetId) => {
      // Reliable on iOS/Android: long-press, then swipe up/down.
      let holdTimer = 0;
      let holding = false;
      let startX = 0;
      let startY = 0;
      let active = false;

      const clear = () => {
        if (holdTimer) { clearTimeout(holdTimer); holdTimer = 0; }
        holding = false;
        active = false;
        btn.classList.remove('isHold');
        btn.classList.remove('isDrag');
        btn.style.transition = 'transform 180ms ease, opacity 180ms ease';
        btn.style.transform = '';
        btn.style.opacity = '';
        setTimeout(() => { try { btn.style.transition = ''; } catch {} }, 200);
      };

      const doDelete = () => {
        btn.dataset.mwDeleted = '1';
        removeWidget(side, widgetId);
        closeMobileSheet(true);
        updateMobileDock();
        try { navigator.vibrate && navigator.vibrate([16, 30, 16]); } catch {}
        clear();
      };

      // Block long-press selection/callout on mobile browsers
      btn.addEventListener('contextmenu', (ev) => { try { ev.preventDefault(); } catch {} });
      btn.addEventListener('dragstart', (ev) => { try { ev.preventDefault(); } catch {} });

      // Touch events (best for phones)
      btn.addEventListener('touchstart', (e) => {
        if (btn.classList.contains('isPlus')) return;
        if (!e.touches || !e.touches.length) return;
        const t = e.touches[0];
        startX = t.clientX;
        startY = t.clientY;
        holding = false;
        active = true;

        holdTimer = setTimeout(() => {
          holding = true;
          btn.classList.add('isHold');
          try { navigator.vibrate && navigator.vibrate(12); } catch {}
        }, 320);
      }, { passive: false });

      btn.addEventListener('touchmove', (e) => {
        if (!active) return;
        if (!e.touches || !e.touches.length) return;
        const t = e.touches[0];
        const dx = t.clientX - startX;
        const dy = t.clientY - startY;

        // If user moves before hold triggers — cancel hold.
        if (!holding && (Math.abs(dy) > 10 || Math.abs(dx) > 10)){
          if (holdTimer) { clearTimeout(holdTimer); holdTimer = 0; }
        }

        if (holding){
          // Prevent the page from scrolling while deleting
          e.preventDefault();
          btn.classList.add('isDrag');
          btn.style.transform = `translateY(${dy}px)`;
          const p = Math.min(Math.abs(dy) / 120, 1);
          btn.style.opacity = String(1 - p * 0.35);
          if (Math.abs(dy) > 42) {
            // little fling animation
            btn.style.transition = 'transform 140ms ease, opacity 140ms ease';
            btn.style.transform = `translateY(${dy > 0 ? 120 : -120}px)`;
            btn.style.opacity = '0';
            setTimeout(() => doDelete(), 110);
          }
        }
      }, { passive: false });

      btn.addEventListener('touchend', () => clear(), { passive: true });
      btn.addEventListener('touchcancel', () => clear(), { passive: true });

      // Pointer fallback (desktop emulation / some Android browsers)
      btn.addEventListener('pointerdown', (e) => {
        if (btn.classList.contains('isPlus')) return;
        if (e.pointerType !== 'touch' && e.pointerType !== 'pen') return;
        startX = e.clientX;
        startY = e.clientY;
        holding = false;
        active = true;

        holdTimer = setTimeout(() => {
          holding = true;
          btn.classList.add('isHold');
          try { navigator.vibrate && navigator.vibrate(12); } catch {}
        }, 320);
      }, { passive: true });

      btn.addEventListener('pointermove', (e) => {
        if (!active) return;
        const dx = e.clientX - startX;
        const dy = e.clientY - startY;
        if (!holding && (Math.abs(dy) > 10 || Math.abs(dx) > 10)){
          if (holdTimer) { clearTimeout(holdTimer); holdTimer = 0; }
        }
        if (holding){
          btn.classList.add('isDrag');
          btn.style.transform = `translateY(${dy}px)`;
          const p = Math.min(Math.abs(dy) / 120, 1);
          btn.style.opacity = String(1 - p * 0.35);
          if (Math.abs(dy) > 42){
            btn.style.transition = 'transform 140ms ease, opacity 140ms ease';
            btn.style.transform = `translateY(${dy > 0 ? 120 : -120}px)`;
            btn.style.opacity = '0';
            setTimeout(() => doDelete(), 110);
          }
        }
      }, { passive: true });

      btn.addEventListener('pointerup', () => clear(), { passive: true });
      btn.addEventListener('pointercancel', () => clear(), { passive: true });
    };

    const makeBtn = ({ side, w }) => {
      const b = document.createElement('button');
      b.type = 'button';
      b.className = 'mwDockBtn';
      b.setAttribute('aria-label', (WIDGETS[w.type]?.name || 'Widget'));
        // Avoid iOS/Android highlighting/selection during long-press
        try { b.style.touchAction = 'none'; } catch {}
      const img = document.createElement('img');
      img.alt = '';
      img.src = getIconPath(w.type);
      b.appendChild(img);
      const dot = document.createElement('span');
      dot.className = 'mwDockDot';
      b.appendChild(dot);

      const isActive = (state.mobile.activeId === w.id);
      b.classList.toggle('isActive', isActive);

      // Tap opens/closes the widget sheet
      b.addEventListener('click', () => {
        if (!requireAuth('widgets')) return;
        // If user is long-pressing for delete, don't open sheet.
        if (b.classList.contains('isHold') || b.dataset.mwDeleted === '1') return;
        if (state.mobile.activeId === w.id) closeMobileSheet();
        else openMobileSheet(side, w.id);
      });

      // Long-press + swipe up/down = delete
      attachSwipeToDelete(b, side, w.id);

      return b;
    };

    // PLUS button:
    // - If there are no widgets: show only "+" centered.
    // - If there are widgets: "+" becomes the first item (left), widgets follow to the right.
    const plus = document.createElement('button');
    plus.type = 'button';
    plus.className = 'mwDockBtn isPlus';
    plus.setAttribute('aria-label', 'Add widget');
    plus.innerHTML = '<span>+</span><span class="mwDockDot" aria-hidden="true"></span>';
    // Avoid iOS/Android long-press callout
    plus.addEventListener('contextmenu', (ev) => { try { ev.preventDefault(); } catch {} });
    plus.addEventListener('dragstart', (ev) => { try { ev.preventDefault(); } catch {} });
    // If already at max, don't show the add button at all.
    const atMax = (items.length >= MAX_TOTAL);
    if (atMax) plus.style.display = 'none';
    plus.addEventListener('click', () => {
      if (!requireAuth('widgets')) return;
      if (totalWidgets() >= MAX_TOTAL){
        try { if (typeof toast === 'function') toast(`Max ${MAX_TOTAL} widgets.`); else { /* no popup */ } } catch {}
        try { navigator.vibrate && navigator.vibrate([20, 30, 20]); } catch {}
        return;
      }
      const l = (state.layout?.left || []).length;
      const r = (state.layout?.right || []).length;
      openPicker(l <= r ? 'left' : 'right');
    });

    if (!items.length){
      mobileDock.classList.remove('hasItems');
      mobileDock.appendChild(plus);
      return;
    }

    mobileDock.classList.add('hasItems');
    if (!atMax) mobileDock.appendChild(plus);

    // Keep it compact on phones (max 6 widget buttons shown)
    items.slice(0, MAX_TOTAL).forEach(it => mobileDock.appendChild(makeBtn(it)));
  }

  function openMobileSheet(side, widgetId){
    ensureMobileUI();
    if (!mobileSheet) return;

    const w = (state.layout?.[side] || []).find(x => x.id === widgetId);
    if (!w) return;
    const def = WIDGETS[w.type];
    if (!def) return;
    if (def.pro && !hasPro()) { gatePro(); return; }

    state.mobile.activeId = widgetId;
    state.mobile.activeKey = w.type;

    const title = mobileSheet.querySelector('#mwSheetTitle');
    const actions = mobileSheet.querySelector('#mwSheetActions');
    const body = mobileSheet.querySelector('#mwSheetBody');
    if (!(title instanceof HTMLElement) || !(actions instanceof HTMLElement) || !(body instanceof HTMLElement)) return;

    title.textContent = getWidgetName(w.type, def) || wt("widgets.add_widget", "Widget");
    actions.innerHTML = '';

    if (def.settingsUI){
      const cfg = document.createElement('button');
      cfg.type = 'button';
      cfg.className = 'iconBtn iconBtn--icon';
      cfg.innerHTML = '<img class="iconBtnImg" src="/static/icons/gear.svg" alt="" />';
      cfg.setAttribute('aria-label', wt('widgets.configure', 'Configure'));
      cfg.addEventListener('click', (e) => {
        e.preventDefault(); e.stopPropagation();
        openSettings(side, widgetId);
      });
      actions.appendChild(cfg);
    }

    // Close (X)
    const close = document.createElement('button');
    close.type = 'button';
    close.className = 'iconBtn';
    close.textContent = '✕';
    close.setAttribute('aria-label', wt('ui.close', 'Close'));
    close.addEventListener('click', (e) => { e.preventDefault(); e.stopPropagation(); closeMobileSheet(); });
    actions.appendChild(close);

    // Delete (red button)
    const del = document.createElement('button');
    del.type = 'button';
    del.className = 'mwDeleteBtn';
    del.innerHTML = '<img class="mwDeleteIcon" alt="" src="/static/icons/Delete.png" />Delete';
    del.setAttribute('aria-label', wt('widgets.delete_widget', 'Delete widget'));
    del.addEventListener('click', (e) => {
      e.preventDefault(); e.stopPropagation();
      if (!requireAuth('widgets')) return;
      removeWidget(side, widgetId);
      closeMobileSheet();
      updateMobileDock();
    });
    actions.appendChild(del);

    body.innerHTML = '';
    // Render inside a card for consistent padding
    const wrap = document.createElement('div');
    wrap.className = 'widgetCard';
    const innerBody = document.createElement('div');
    innerBody.className = 'widgetBody';
    innerBody.textContent = wt('ui.loading', 'Loading…');
    wrap.appendChild(innerBody);
    body.appendChild(wrap);

    try { def.render(innerBody, w.settings, w); } catch { innerBody.textContent = wt('ui.try_again', 'Could not render.'); }

    mobileSheet.classList.add('isOpen');
    try { document.body.style.overflow = 'hidden'; } catch {}
    updateMobileDock();
  }

  function closeMobileSheet(silent){
    if (!mobileSheet) return;
    mobileSheet.classList.remove('isOpen');
    state.mobile.activeId = null;
    state.mobile.activeKey = null;
    try { document.body.style.overflow = ''; } catch {}
    if (!silent) updateMobileDock();
  }

  function init(){
    const left = document.getElementById("leftSidebar");
    const right = document.getElementById("rightSidebar");
    if (!left || !right) return;

    state.layout = loadLayout();

    // If mode.js fetched account-scoped UI prefs before widgets.js initialized,
    // it may have stashed a pending layout here.
    try {
      const pending = window.__checknePendingWidgetsLayout;
      if (pending && typeof pending === 'object'){
        const applied = window.checkneApplyWidgetsLayout(pending, { persistLocal: true });
        if (applied) window.__checknePendingWidgetsLayout = null;
      }
    } catch {}
    renderAll();

    // Hard reload (Cmd+Shift+R) can cause widgets to render before some app state is ready.
    // Re-render once after full window load so widgets refetch and recover without needing delete/re-add.
    window.addEventListener('load', () => {
      try { if (!(state && state.modal && state.modal.open)) renderAll(); } catch {}
      try { updateMobileDock(); } catch {}
    }, { once:true });

    // Mobile bottom dock (phones)
    updateMobileDock();
    window.addEventListener('resize', () => updateMobileDock(), { passive: true });
    // When other pages disable widgets, hide dock + close sheet
    const mo = new MutationObserver(() => updateMobileDock());
    try { mo.observe(document.body, { attributes:true, attributeFilter:['class'] }); } catch {}

    // Sticky fallback:
    // Some browser/layout combinations (notably sticky inside complex grids) can break.
    // We ensure sidebars stay visible by switching them to position:fixed after scroll threshold.
    setupSidebarFollow(left, right);

    // Re-render headlines widget after feed updates (best-effort)
    document.addEventListener("checkne:feedRendered", () => {
      // Feed-driven widgets should refresh after the feed is actually rendered.
      // On hard reload some widgets may render before feed data exists; this makes them self-heal.
      ["headlines","tracking_stats","pro_action_feed","pro_risk_why","pro_momentum","pro_entities","pro_top_charts"].forEach(refreshWidgetType);
    });

    // When the user opens a different story in the feed, refresh Momentum
    // (and other story-context widgets) to reflect the currently opened item.
    document.addEventListener('checkne:currentClusterChanged', () => {
      try { refreshWidgetType('pro_momentum'); } catch {}
      try { refreshWidgetType('pro_top_charts'); } catch {}
      try { refreshWidgetType('media_bias'); } catch {}
    });

document.addEventListener('checkne:currentStoryChanged', () => {
  try { refreshWidgetType('pro_video_report'); } catch {}
  try { refreshWidgetType('pro_related_coverage'); } catch {}
  try { refreshWidgetType('pro_recent_history'); } catch {}
});


    // Update Tracking Stats widget when tracking list changes
    document.addEventListener("checkne:favsChanged", () => refreshWidgetType("tracking_stats"));
    window.addEventListener("storage", (e) => {
      const k = String(e && e.key ? e.key : "");
      if (k === "news_favs_v1" || k.startsWith("news_favs_v1__")) refreshWidgetType("tracking_stats");
    });

    // If billing plan loads/changes after widgets init, re-render so PRO widgets unlock correctly.
    document.addEventListener("checkne:billingUpdated", () => {
      try { renderAll(); } catch {}
      try { if (state?.modal?.open) openModal(); } catch {}
      try {
        // If a mobile sheet is open, refresh its content (it may have been locked before billing loaded).
        if (mobileSheet && mobileSheet.classList.contains('isOpen') && state?.mobile?.activeId){
          const wid = state.mobile.activeId;
          const left = (state.layout?.left || []).some(x => x.id === wid);
          const right = (state.layout?.right || []).some(x => x.id === wid);
          const side = left ? 'left' : (right ? 'right' : null);
          if (side) openMobileSheet(side, wid);
        }
      } catch {}
      try { updateMobileDock(); } catch {}
    });

    // Close modal actions
    document.addEventListener("click", (e) => {
      const t = e.target;
      if (!(t instanceof HTMLElement)) return;
      if (t.getAttribute("data-widget-close") === "1"){
        closeModal();
      }
    });
    document.addEventListener("keydown", (e) => {
      if (e.key === "Escape") closeModal();
    });
  }

  function renderAll(){
    renderSidebar("left");
    renderSidebar("right");
    try {
      if (typeof window.__checkneRefreshSidebarFollow === 'function') {
        window.__checkneRefreshSidebarFollow();
      }
    } catch {}
  }

  function refreshWidgetType(type){
    ["left","right"].forEach(side => {
      const list = state.layout[side] || [];
      list.forEach(w => {
        if (w.type !== type) return;
        const el = document.querySelector(`.widgetCard[data-widget-id="${w.id}"] .widgetBody`);
        if (el) {
          try { WIDGETS[w.type].render(el, w.settings, w); } catch {}
        }
      });
    });
  }

  function renderSidebar(side){
    const root = document.getElementById(side === "left" ? "leftSidebar" : "rightSidebar");
    if (!root) return;

    // IMPORTANT: do NOT wipe the sidebar root, because the follow/"sticky" logic
    // wraps content in .sidebarInner. If we remove it, widgets stop following after
    // any re-render (add/remove/configure).
    let inner = root.querySelector(".sidebarInner");
    if (!inner){
      inner = document.createElement("div");
      inner.className = "sidebarInner";
      inner.style.display = "flex";
      inner.style.flexDirection = "column";
      inner.style.gap = "16px";
      root.appendChild(inner);
    }
    inner.innerHTML = "";

    const list = state.layout[side] || [];
    list.forEach((w, idx) => {
      const def = WIDGETS[w.type];
      if (!def) return;
      if (def.disabled) return;

      const card = document.createElement("div");
      card.className = "widgetCard";
      card.setAttribute("draggable", "true");
      card.dataset.widgetId = w.id;
      card.dataset.type = w.type;
      card.dataset.side = side;
      card.dataset.index = String(idx);

      // If this is a PRO widget and user doesn't have Pro, clicking the card
      // should open Pricing with Pro preselected (nice upsell UX).
      if (def.pro && !hasPro()) {
        card.classList.add('isLocked');
        card.addEventListener('click', (e) => {
          // Avoid hijacking clicks on controls inside
          const t = e?.target;
          if (t && typeof t.closest === 'function') {
            if (t.closest('.iconBtn') || t.closest('button') || t.closest('a')) return;
          }
          e.preventDefault();
          e.stopPropagation();
          goPricingWith({ plan: 'pro' });
        });
      }

      card.addEventListener("dragstart", (e) => onDragStart(e, side, idx, w.id));
      card.addEventListener("dragend", () => onDragEnd());
      card.addEventListener("dragover", (e) => onDragOver(e));
      card.addEventListener("drop", (e) => onDrop(e, side, idx));

      const header = document.createElement("div");
      header.className = "widgetHeader";

      const titleWrap = document.createElement("div");
      titleWrap.className = "widgetTitleWrap";

      const icon = document.createElement("div");
      icon.className = "widgetIcon";
      const iconImg = document.createElement("img");
      iconImg.className = "widgetIconImg";
      iconImg.alt = "";
      iconImg.src = getIconPath(w.type);
      icon.appendChild(iconImg);

      const title = document.createElement("div");
      title.className = "widgetTitle";
      title.textContent = getWidgetName(w.type, def);

      if (def.pro){
        const pill = document.createElement('span');
        pill.className = 'proPill';
        pill.textContent = 'PRO';
        pill.title = 'Pro feature';
        title.appendChild(document.createTextNode(' '));
        title.appendChild(pill);
      }

      titleWrap.appendChild(icon);
      titleWrap.appendChild(title);

      const actions = document.createElement("div");
      actions.className = "widgetActions";

      if (def.settingsUI){
        const btnCfg = iconButton("⚙", "Configure");
        btnCfg.addEventListener("click", (e) => {
          e.preventDefault(); e.stopPropagation();
          if (!requireAuth("widgets")) return;
          openSettings(side, w.id);
        });
        actions.appendChild(btnCfg);
      }

      const btnDel = iconButton("✕", "Remove");
      btnDel.addEventListener("click", (e) => {
        e.preventDefault(); e.stopPropagation();
        if (!requireAuth("widgets")) return;
        removeWidget(side, w.id);
      });
      actions.appendChild(btnDel);

      header.appendChild(titleWrap);
      header.appendChild(actions);

      const body = document.createElement("div");
      body.className = "widgetBody";
      body.textContent = "Loading…";

      card.appendChild(header);
      card.appendChild(body);
      inner.appendChild(card);

      try { def.render(body, w.settings, w); } catch { body.textContent = wt('ui.could_not_render', 'Could not render.'); }
    });

    // Show "Add widget" only if:
    // - this side has room AND
    // - we are not at the global max
    if (countEnabled(list) < MAX_PER_SIDE && totalWidgets() < MAX_TOTAL){
      const add = document.createElement("div");
      add.className = "addWidgetTile";
      add.innerHTML = '<div class="addWidgetPlus">+</div><div>Add widget</div>';
      add.addEventListener("click", () => {
        if (!requireAuth("widgets")) return;
        openPicker(side);
      });
      add.addEventListener("dragover", (e) => onDragOver(e));
      add.addEventListener("drop", (e) => onDropToEnd(e, side));
      inner.appendChild(add);
    }

    // Let the follow logic re-measure after DOM updates.
    try { document.dispatchEvent(new CustomEvent("checkne:widgetsRendered")); } catch {}

    // Keep mobile dock in sync (selected dots, add/remove, etc.)
    try { updateMobileDock(); } catch {}
  }

  function iconButton(text, label){
    const b = document.createElement("button");
    b.className = "iconBtn";
    b.type = "button";
    b.setAttribute("aria-label", label);
    if (String(label || '').toLowerCase() === 'configure') {
      b.classList.add('iconBtn--icon');
      b.innerHTML = '<img class="iconBtnImg" src="/static/icons/gear.svg" alt="" />';
    } else {
      b.textContent = text;
    }
    return b;
  }

  function removeWidget(side, id){
    if (!requireAuth('widgets')) return;
    state.layout[side] = (state.layout[side] || []).filter(w => w.id !== id);
    saveLayout();
    // Re-render both sidebars so the global "Add widget" tile state
    // stays correct on both sides after a remove.
    renderAll();
  }

  function addWidget(side, type){
    if (!requireAuth('widgets')) return;
    const def = WIDGETS[type];
    if (!def) return;
    if (def.pro && !hasPro()) {
      gatePro();
      return;
    }
    if (countEnabled(state.layout[side] || []) >= MAX_PER_SIDE) return;
    if (totalWidgets() >= MAX_TOTAL) {
      try { if (typeof toast === "function") toast(`Max ${MAX_TOTAL} widgets on screen.`); } catch {}
      return;
    }

    state.layout[side].push({ id: uid(), type, settings: { ...(def.defaults || {}) } });
    saveLayout();
    // Re-render both sidebars so the opposite column also hides its
    // "Add widget" tile immediately when we hit the 5-widget cap.
    renderAll();
  }

  // ===== Drag & Drop =====
  function onDragStart(e, fromSide, fromIndex, id){
    if (!requireAuth('widgets')) {
      try { e.preventDefault(); } catch {}
      return;
    }
    state.drag = { id, fromSide, fromIndex };
    try { e.dataTransfer.setData("text/plain", id); } catch {}
    try { e.dataTransfer.effectAllowed = "move"; } catch {}
    const card = e.currentTarget;
    if (card && card.classList) card.classList.add("isDragging");
  }

  function onDragEnd(){
    state.drag = null;
    document.querySelectorAll(".widgetCard.isDragging").forEach(el => el.classList.remove("isDragging"));
  }

  function onDragOver(e){
    e.preventDefault();
    try { e.dataTransfer.dropEffect = "move"; } catch {}
  }

  function onDrop(e, toSide, toIndex){
    e.preventDefault();
    if (!requireAuth('widgets')) return;
    if (!state.drag) return;

    const { id, fromSide, fromIndex } = state.drag;
    if (fromSide === toSide && fromIndex === toIndex) return;

    const fromList = state.layout[fromSide] || [];
    const toList = state.layout[toSide] || [];
    const moving = fromList[fromIndex];
    if (!moving || moving.id !== id) return;

    // remove from origin
    fromList.splice(fromIndex, 1);

    // adjust index if same list and moving upward/downward
    let insertAt = toIndex;
    if (fromSide === toSide && fromIndex < toIndex) insertAt = Math.max(0, toIndex - 1);

    toList.splice(insertAt, 0, moving);

    state.layout[fromSide] = clampPerSide(fromList);
      clampGlobal(state.layout);
    state.layout[toSide] = clampPerSide(toList);
      clampGlobal(state.layout);

    saveLayout();
    renderAll();
  }

  function onDropToEnd(e, toSide){
    e.preventDefault();
    if (!requireAuth('widgets')) return;
    if (!state.drag) return;

    const { id, fromSide, fromIndex } = state.drag;
    const fromList = state.layout[fromSide] || [];
    const toList = state.layout[toSide] || [];

    const moving = fromList[fromIndex];
    if (!moving || moving.id !== id) return;

    fromList.splice(fromIndex, 1);
    toList.push(moving);

    state.layout[fromSide] = clampPerSide(fromList);
      clampGlobal(state.layout);
    state.layout[toSide] = clampPerSide(toList);
      clampGlobal(state.layout);

    saveLayout();
    renderAll();
  }

  // ===== Modal =====
  function openModal(){
    const modal = document.getElementById("widgetModal");
    const body = document.getElementById("widgetModalBody");
    const footer = document.getElementById("widgetModalFooter");
    const title = document.getElementById("widgetModalTitle");
    if (!modal || !body || !footer || !title) return;

    modal.classList.add("isOpen");
    modal.setAttribute("aria-hidden", "false");
    try { modal.dataset.mode = state.modal.mode || ""; } catch {}
    body.innerHTML = "";
    footer.innerHTML = "";
    footer.style.display = "none";

    if (state.modal.mode === "pick"){
      title.textContent = wt("widgets.add_widget", "Add Widget");
      body.appendChild(renderPicker());
    } else if (state.modal.mode === "settings"){
      title.textContent = wt("widgets.widget_settings", "Widget settings");
      const content = renderSettings();
      if (content) body.appendChild(content);
      footer.style.display = "flex";
      const btnCancel = document.createElement("button");
      btnCancel.className = "btnSoft";
      btnCancel.type = "button";
      btnCancel.textContent = wt("ui.cancel", "Cancel");
      btnCancel.setAttribute("data-widget-close", "1");

      const btnSave = document.createElement("button");
      btnSave.className = "btnBlack";
      btnSave.type = "button";
      btnSave.textContent = wt("ui.save", "Save");
      btnSave.addEventListener("click", onSaveSettings);

      footer.appendChild(btnCancel);
      footer.appendChild(btnSave);
    }
  }

  function closeModal(){
    const modal = document.getElementById("widgetModal");
    if (!modal) return;
    modal.classList.remove("isOpen");
    modal.setAttribute("aria-hidden", "true");
    state.modal.open = false;
  }

  function openPicker(side){
    if (!requireAuth('widgets')) return;
    state.modal = { open:true, mode:"pick", side, widgetId:null };
    openModal();
  }

  function openSettings(side, widgetId){
    if (!requireAuth('widgets')) return;
    // On mobile we may have a bottom sheet open for the widget — close it before showing the settings modal.
    try { closeMobileSheet(true); } catch {}
    state.modal = { open:true, mode:"settings", side, widgetId };
    openModal();
  }

function renderPicker(){
  const side = state.modal.side;

  // Mark already-added widget types so the picker can show the filled radio.
  // (We consider widgets added on either sidebar as "selected".)
  const selectedTypes = new Set([
    ...((state.layout.left || []).map(w => w.type)),
    ...((state.layout.right || []).map(w => w.type)),
  ]);

  const wrap = document.createElement("div");
  wrap.className = "widgetPicker";

  // Split widgets into FREE vs PRO+
  const freeKeys = [];
  const proKeys = [];
  Object.keys(WIDGETS).forEach((k) => {
    const def = WIDGETS[k];
    if (!def || def.disabled) return;
    if (def.pro) proKeys.push(k);
    else freeKeys.push(k);
  });

  const makeSection = (label, keys, isProSection) => {
    const section = document.createElement("div");
    section.className = "widgetPickerSection" + (isProSection ? " isPro" : "");
    const h = document.createElement("div");
    h.className = "widgetPickerLabel";
    h.textContent = label;
    section.appendChild(h);

    const grid = document.createElement("div");
    grid.className = "widgetGridV2";
    keys.forEach((key) => {
      const def = WIDGETS[key];
      if (!def) return;

      const locked = !!def.pro && !hasPro();
      const card = document.createElement("button");
      card.type = "button";
      card.className = "widgetPickV2" + (isProSection ? " isPro" : "") + (locked ? " isLocked" : "") + (selectedTypes.has(key) ? " isSelected" : "");
      card.setAttribute("data-widget-type", key);

      const iconWrap = document.createElement("div");
      iconWrap.className = "widgetPickIcon";
      const img = document.createElement("img");
      img.alt = "";
      img.src = getIconPath(key);
      iconWrap.appendChild(img);

      const meta = document.createElement("div");
      meta.className = "widgetPickMeta";

      const name = document.createElement("div");
      name.className = "widgetPickNameV2";
      name.textContent = getWidgetName(key, def);

      const desc = document.createElement("div");
      desc.className = "widgetPickDescV2";
      desc.textContent = getWidgetDesc(key, def);

      meta.appendChild(name);
      meta.appendChild(desc);

      const radio = document.createElement("div");
      radio.className = "widgetPickRadio";

      card.appendChild(iconWrap);
      card.appendChild(meta);
      card.appendChild(radio);

      card.addEventListener("click", () => {
        if (locked) return gatePro();
        addWidget(side, key);
        closeModal();
      });

      grid.appendChild(card);
    });

    section.appendChild(grid);
    return section;
  };

  wrap.appendChild(makeSection(wt("widgets.free_section", "FREE"), freeKeys, false));
  wrap.appendChild(makeSection(wt("widgets.pro_section", "PRO+"), proKeys, true));

  if (!hasPro()){
    const ctaWrap = document.createElement("div");
    ctaWrap.className = "widgetPickerCta";

    const btn = document.createElement("button");
    btn.type = "button";
    btn.className = "widgetGetProBtn";
    btn.textContent = wt("widgets.get_pro", "Get Pro");
    // "Get Pro" should take the user straight to checkout (Pro, monthly).
    btn.addEventListener("click", () => {
      try { closeModal(); } catch {}
      goPricingWith({ plan: 'pro', checkout: true, interval: 'monthly' });
    });

    ctaWrap.appendChild(btn);
    wrap.appendChild(ctaWrap);
  }

  return wrap;
}

  function renderSettings(){
    const { side, widgetId } = state.modal;
    const w = (state.layout[side] || []).find(x => x.id === widgetId);
    if (!w) return null;
    const def = WIDGETS[w.type];
    if (!def || !def.settingsUI) return null;

    const form = document.createElement("div");
    form.dataset.widgetSettingsFor = widgetId;
    def.settingsUI(form, w.settings);
    return form;
  }

  function onSaveSettings(){
    if (!requireAuth('widgets')) return;
    const { side, widgetId } = state.modal;
    const w = (state.layout[side] || []).find(x => x.id === widgetId);
    if (!w) return;

    const form = document.querySelector(`[data-widget-settings-for="${widgetId}"]`);
    if (!(form instanceof HTMLElement)) return;

    // Collect inputs/selects (simple approach)
    const next = { ...(w.settings || {}) };
    form.querySelectorAll("input, select").forEach((el) => {
      const name = el.getAttribute("name");
      if (!name) return;
      if (el instanceof HTMLInputElement && el.type === "number"){
        next[name] = Number(el.value || 0);
      } else {
        next[name] = String((el).value || "").trim();
      }
    });

    w.settings = next;
    saveLayout();
    renderSidebar(side);
    closeModal();
  }

  // ===== Widget renderers =====
  function renderFxRates(root, settings){
    const base = (settings && settings.base ? String(settings.base).toUpperCase() : "EUR").trim() || "EUR";
    const symbols = (settings && settings.symbols ? String(settings.symbols) : "USD,GBP,PLN,UAH")
      .split(",").map(s => s.trim().toUpperCase()).filter(Boolean).slice(0, 8);

    root.innerHTML = `<div class="muted" style="font-size:12px; margin-bottom:10px;">Base: <b>${escapeHtml(base)}</b></div>
      <div id="fxRows" class="miniList"></div>`;

    const rows = root.querySelector("#fxRows");
    if (!rows) return;
    rows.innerHTML = `<div class="muted" style="font-size:13px;">${escapeHtml(wt("ui.loading", "Loading…"))}</div>`;

    // Prefer backend proxy (supports more base currencies like UAH).
    const proxyUrl = `/api/market/fx?base=${encodeURIComponent(base)}&symbols=${encodeURIComponent(symbols.join(','))}`;
    // Public fallback (CORS-friendly). Note: this provider often returns `conversion_rates`.
    const fallbackUrl = `https://open.er-api.com/v6/latest/${encodeURIComponent(base)}`;

    function normalizeRates(payload){
      if (!payload) return null;
      const r = payload.rates || payload.conversion_rates || (payload.result === 'success' && payload.rates) || null;
      if (!r || typeof r !== 'object') return null;
      // Case-insensitive map: providers sometimes return lowercase keys.
      const map = {};
      for (const k in r){
        if (!Object.prototype.hasOwnProperty.call(r, k)) continue;
        map[String(k).toUpperCase()] = r[k];
      }
      return map;
    }

    (async () => {
      let payload = null;
      let ratesMap = null;

      // 1) Try server proxy
      try{
        payload = await fetchJsonCached(proxyUrl, 30_000);
        ratesMap = normalizeRates(payload);
        // If the proxy is up but upstream provider failed, it may return empty rates.
        if (!ratesMap || Object.keys(ratesMap).length === 0) throw new Error('proxy_empty');
      } catch {
        // 2) Fallback to public endpoint
        payload = await fetchJsonCached(fallbackUrl, 30_000);
        ratesMap = normalizeRates(payload);
      }

      if (!ratesMap) throw new Error('no_rates');

      rows.innerHTML = "";
      symbols.forEach((sym) => {
        const v = ratesMap[sym];
        const row = document.createElement("div");
        row.className = "kvRow";
        row.innerHTML = `<div class="kvKey">${escapeHtml(sym)}</div><div class="kvVal">${(v == null ? "—" : formatNum(v))}</div>`;
        rows.appendChild(row);
      });
    })().catch(() => {
      rows.innerHTML = `<div class="muted" style="font-size:13px; margin-bottom:10px;">${escapeHtml(wt("widgets.fx_rates.load_error", "Couldn’t load rates."))}</div><button class="miniBtn" type="button">${escapeHtml(wt("ui.try_again", "Retry"))}</button>`;
      const btn = rows.querySelector('.miniBtn');
      if (btn) btn.addEventListener('click', () => renderFxRates(root, settings));
    });
  }

  function renderCrypto(root, settings){
    const vs = (settings && settings.vs ? String(settings.vs).toLowerCase().trim() : "eur") || "eur";
    const coins = (settings && settings.coins ? String(settings.coins) : "bitcoin,ethereum")
      .split(",").map(s => s.trim().toLowerCase()).filter(Boolean).slice(0, 6);

    root.innerHTML = `<div class="muted" style="font-size:12px; margin-bottom:10px;">${escapeHtml(wt("widgets.crypto.currency", "Currency"))}: <b>${escapeHtml(vs.toUpperCase())}</b></div>
      <div id="cryptoRows" class="miniList"></div>`;

    const rows = root.querySelector("#cryptoRows");
    if (!rows) return;
    rows.innerHTML = `<div class="muted" style="font-size:13px;">${escapeHtml(wt("ui.loading", "Loading…"))}</div>`;

    // Prefer backend proxy (avoids CORS + rate-limit issues), fallback to direct API.
    const proxyUrl = `/api/market/crypto?vs=${encodeURIComponent(vs)}&coins=${encodeURIComponent(coins.join(','))}`;
    const directUrl = `https://api.coingecko.com/api/v3/simple/price?ids=${encodeURIComponent(coins.join(","))}&vs_currencies=${encodeURIComponent(vs)}`;

    (async () => {
      let data = null;
      try {
        data = await fetchJsonCached(proxyUrl, 25_000);
      } catch {
        try { data = await fetchJsonCached(directUrl, 25_000); } catch {}
      }
      if (!data) throw new Error('no_data');

      rows.innerHTML = "";
      coins.forEach((id) => {
        const prices = (data && data.prices) ? data.prices : data;
        const val = (prices && prices[id] && prices[id][vs] != null) ? prices[id][vs] : null;
        const row = document.createElement("div");
        row.className = "kvRow";
        row.innerHTML = `<div class="kvKey">${escapeHtml(coinLabel(id))}</div><div class="kvVal">${formatMoney(val, vs)}</div>`;
        rows.appendChild(row);
      });
    })().catch(() => {
      rows.innerHTML = `<div class="muted" style="font-size:13px; margin-bottom:10px;">${escapeHtml(wt("widgets.crypto.load_error", "Couldn’t load crypto."))}</div><button class="miniBtn" type="button">${escapeHtml(wt("ui.try_again", "Retry"))}</button>`;
      const btn = rows.querySelector('.miniBtn');
      if (btn) btn.addEventListener('click', () => renderCrypto(root, settings));
    });
  }

  function renderHeadlines(root, settings){
    const limit = clampInt(settings && settings.limit ? settings.limit : 4, 1, 6);

    const titles = [];
    document.querySelectorAll(".newsCard .newsTitle").forEach((el) => {
      const t = (el.textContent || "").trim();
      if (t && titles.length < limit) titles.push(t);
    });

    // fallback: top carousel
    if (titles.length === 0){
      document.querySelectorAll("#topCarouselTrack .topTitle, #topCarouselTrack .topCardTitle").forEach((el) => {
        const t = (el.textContent || "").trim();
        if (t && titles.length < limit) titles.push(t);
      });
    }

    if (titles.length === 0){
      root.innerHTML = `<div class="muted" style="font-size:13px;">No headlines yet.</div>`;
      return;
    }

    const list = document.createElement("div");
    list.className = "miniList";
    titles.forEach((t) => {
      const item = document.createElement("div");
      item.className = "miniItem";
      item.innerHTML = `<div class="miniDot"></div><div class="miniText">${escapeHtml(t)}</div>`;
      list.appendChild(item);
    });
    root.innerHTML = "";
    root.appendChild(list);
  }

  function renderTrackingStats(root){
    const ids = (typeof getFavIds === "function") ? (getFavIds() || []) : [];
    const count = Array.isArray(ids) ? ids.length : 0;

    const authed = isAuthed();

    // Render a fast skeleton first (then async fill recent + sync state)
    root.innerHTML = `
      <div class="kvRow">
        <div class="kvKey">Tracked</div>
        <div class="kvVal" id="wgTrackedCount">${Number.isFinite(count) ? String(count) : "0"}</div>
      </div>

      <div class="trackRow" style="margin-top:10px;">
        <span class="trackBadge" id="wgSyncBadge">${authed ? 'Checking…' : 'Login'}</span>
        <span class="muted" id="wgSyncText" style="font-size:12px;">${authed ? 'Sync status' : 'Login required to sync.'}</span>
      </div>

      <div class="trackSectionTitle" style="margin-top:12px;">Recent</div>
      <div class="trackRecent" id="wgRecentWrap">
        <div class="muted" style="font-size:12px; padding:6px 2px;">${count ? 'Loading…' : 'No tracked stories yet.'}</div>
      </div>

      <div class="trackActions" style="margin-top:12px;">
        <button class="btnBlack" type="button" id="wgOpenTracking" style="flex:1;">Open Tracking</button>
        <button class="btnGhost" type="button" id="wgRefresh" aria-label="Refresh" title="Refresh" style="width:44px;">↻</button>
      </div>

      <div class="trackActions" style="margin-top:10px;">
        <button class="btnGhost" type="button" id="wgSyncNow" style="flex:1;">Sync now</button>
        <button class="btnGhost" type="button" id="wgClearAll" style="flex:1;">Clear</button>
      </div>
    `;

    const openBtn = root.querySelector("#wgOpenTracking");
    const refreshBtn = root.querySelector("#wgRefresh");
    const syncNowBtn = root.querySelector("#wgSyncNow");
    const clearBtn = root.querySelector("#wgClearAll");

    const doRefresh = () => {
      try { renderTrackingStats(root); } catch {}
    };

    if (refreshBtn) refreshBtn.addEventListener("click", doRefresh);

    if (openBtn) openBtn.addEventListener("click", () => {
      if (!isAuthed()) {
        requireAuth('tracking');
        return;
      }
      try {
        // Tracking is the 'fav' mode in this app
        if (typeof switchMode === 'function') void switchMode('fav');
      } catch {}
    });

    if (syncNowBtn) syncNowBtn.addEventListener("click", async () => {
      if (!isAuthed()) return requireAuth('tracking');
      try {
        syncNowBtn.textContent = 'Syncing…';
        syncNowBtn.setAttribute('disabled', 'true');
        if (typeof syncFavoritesToServer === 'function') await syncFavoritesToServer();
      } catch {}
      finally {
        syncNowBtn.removeAttribute('disabled');
        syncNowBtn.textContent = 'Sync now';
        doRefresh();
      }
    });

    if (clearBtn) clearBtn.addEventListener("click", async () => {
      if (!isAuthed()) return requireAuth('tracking');
      if (!count) return;
      const ok = (typeof uiConfirm==='function') ? await uiConfirm('Clear all tracked items?', {title:'Clear tracking', okText:'Clear', cancelText:'Cancel'}) : (toast && toast('Confirm dialog unavailable', 'error'), false);
      if (!ok) return;
      try {
        if (typeof setFavIds === 'function') setFavIds([]);
        if (typeof syncFavoritesToServer === 'function') await syncFavoritesToServer();
      } catch {}
      doRefresh();
    });

    // --- Async enhancements: recent list + sync state ---
    void (async () => {
      const badge = root.querySelector('#wgSyncBadge');
      const text = root.querySelector('#wgSyncText');
      const recentWrap = root.querySelector('#wgRecentWrap');
      const countEl = root.querySelector('#wgTrackedCount');
      if (countEl) countEl.textContent = String(count || 0);

      // 1) Sync status (best-effort)
      if (authed) {
        try {
          const r = await fetch(`${API_BASE}/api/favorites`, { credentials: 'include' });
          const j = await r.json().catch(() => ({}));
          const serverIds = Array.isArray(j.ids) ? j.ids.map(Number).filter(Number.isFinite) : [];
          const localIds = (typeof getFavIds === 'function') ? (getFavIds() || []) : [];
          const serverSet = new Set(serverIds.map(String));
          const localSet = new Set(localIds.map(String));

          const sameSize = serverSet.size === localSet.size;
          let same = sameSize;
          if (same) {
            for (const v of localSet) { if (!serverSet.has(v)) { same = false; break; } }
          }

          if (badge) {
            badge.textContent = same ? 'Synced' : 'Pending';
            badge.classList.toggle('isGood', !!same);
            badge.classList.toggle('isWarn', !same);
          }
          if (text) text.textContent = same ? 'Saved to your account.' : 'Local changes not synced yet.';
        } catch {
          if (badge) { badge.textContent = 'Local'; badge.classList.add('isWarn'); }
          if (text) text.textContent = 'Could not check sync status.';
        }
      } else {
        if (badge) { badge.textContent = 'Login'; badge.classList.add('isWarn'); }
        if (text) text.textContent = 'Login required to sync.';
      }

      // 2) Recent cards preview
      try {
        if (!recentWrap) return;
        const localIds = (typeof getFavIds === 'function') ? (getFavIds() || []) : [];
        const topIds = localIds.slice(0, 6).map(Number).filter(Number.isFinite);
        if (!topIds.length) {
          recentWrap.innerHTML = `<div class="muted" style="font-size:12px; padding:6px 2px;">No tracked stories yet.</div>`;
          return;
        }

        const interests = encodeURIComponent((state && Array.isArray(state.interests)) ? state.interests.join(',') : 'general');
        const country = encodeURIComponent((state && state.country) ? state.country : 'world');
        const uiLang = encodeURIComponent((state && state.language) ? state.language : 'en');

        const url = `${API_BASE}/api/news/by_ids?ids=${encodeURIComponent(topIds.join(','))}` +
          `&interests=${interests}&country=${country}&language=all&ui_lang=${uiLang}${(typeof window.__checkneBuildGuestPreviewIdsQuery === 'function' ? window.__checkneBuildGuestPreviewIdsQuery() : '')}`;
        const r = await fetch(url);
        const j = await r.json().catch(() => ({}));
        const items = Array.isArray(j.items) ? j.items : [];

        const byId = new Map();
        for (const it of items) {
          const id = Number(it.cluster_id ?? it.event_id ?? it.id);
          if (Number.isFinite(id)) byId.set(id, it);
        }

        const rows = [];
        for (const id of topIds) {
          const it = byId.get(id);
          const title = it?.title ? String(it.title) : `Story #${id}`;
          const score = (it?.credibility_score ?? it?.trust_score ?? it?.score);
          const sc = Number.isFinite(Number(score)) ? Number(score) : null;
          const outlets = (it?.sources_count ?? it?.outlet_count);
          const oc = Number.isFinite(Number(outlets)) ? Number(outlets) : null;

          rows.push(`
            <div class="trackItem" data-id="${id}">
              <button class="trackItemMain" type="button" title="Open">
                <div class="trackItemTitle">${escapeHtml(title)}</div>
                <div class="trackItemMeta">
                  ${sc === null ? '' : `<span class="trackPill">Score ${escapeHtml(String(sc))}</span>`}
                  ${oc === null ? '' : `<span class="trackPill">${escapeHtml(String(oc))} outlets</span>`}
                </div>
              </button>
              <button class="trackItemX" type="button" aria-label="Remove" title="Remove">×</button>
            </div>
          `);
        }

        recentWrap.innerHTML = `<div class="trackRecentList">${rows.join('')}</div>`;

        recentWrap.querySelectorAll('.trackItem').forEach((rowEl) => {
          const id = Number(rowEl.getAttribute('data-id'));
          const openEl = rowEl.querySelector('.trackItemMain');
          const rmEl = rowEl.querySelector('.trackItemX');

          if (openEl) openEl.addEventListener('click', async () => {
            if (!Number.isFinite(id)) return;
            try { if (typeof switchMode === 'function') await switchMode('feed'); } catch {}
            try {
              if (typeof ensureItemInFeedAndOpen === 'function') {
                await ensureItemInFeedAndOpen(id);
              } else {
                const u = new URL(window.location.href);
                u.searchParams.set('open', String(id));
                window.location.href = u.toString();
              }
            } catch {}
          });

          if (rmEl) rmEl.addEventListener('click', async (e) => {
            e.preventDefault();
            e.stopPropagation();
            if (!isAuthed()) return requireAuth('tracking');
            try {
              if (typeof removeFav === 'function') removeFav(id);
              else if (typeof toggleFav === 'function') toggleFav(id);
            } catch {}
            doRefresh();
          });
        });

      } catch {}
    })();
  }

  function renderMarketClock(root, settings){
    const now = new Date();

    const s = settings || {};
    const list = parseList(s.cities || "Europe/Berlin,Europe/London,America/New_York,Asia/Tokyo");
    // Backward compatible: older settings had `count`. We now simply show the selection (max 8).
    const selected = (list.length ? list : ["Europe/Berlin","Europe/London"]).slice(0, 8);

    const rows = selected.map((tz) => {
      const meta = (CLOCK_CITIES.find(c => c.tz === tz) || null);
      const label = meta ? meta.label : tz.replace(/_/g,' ').split('/').slice(-1)[0];
      const t = fmtTime(now, tz);
      return `<div class="kvRow"><div class="kvKey">${escapeHtml(label)}</div><div class="kvVal">${escapeHtml(t)}</div></div>`;
    }).join('');

    root.innerHTML = `
      ${rows}
      <div class="muted" style="font-size:12px; margin-top:10px;">Updates every minute.</div>
    `;

    // tick
    const tick = () => {
      try { renderMarketClock(root, settings); } catch {}
    };
    setTimeout(tick, 60_000);
  }

  // =========================
  // PRO Widgets (explainable + actionable)
  // =========================
  function _proEmpty(root){
    root.innerHTML = `
      <div class="proEmpty">
        <div class="proEmptyTitle">Nothing to show yet</div>
        <div class="proEmptyDesc">Load your feed first — then this widget can compute insights.</div>
      </div>
    `;
  }

  function _requireProOrRenderUpsell(root){
    const pro = hasPro();
    if (pro === null){
      root.textContent = 'Loading…';
      return false;
    }
    if (pro) return true;
    root.innerHTML = `
      <div class="proLocked">
        <div class="proLockedTitle">Pro widget</div>
        <div class="proLockedDesc">Upgrade to unlock explainable insights and dashboard widgets.</div>
        <button class="btnBlack" type="button" data-pro-upgrade>Upgrade to Pro</button>
      </div>
    `;
    const btn = root.querySelector('[data-pro-upgrade]');
    if (btn) btn.addEventListener('click', () => goPricingWith({ plan: 'pro' }));
    return false;
  }

  function _pickTop(items, limit){
    const arr = (Array.isArray(items) ? items : []).slice();
    arr.sort((a,b) => computeImpact(b) - computeImpact(a));
    return arr.slice(0, Math.max(1, Number(limit) || 5));
  }

  function renderProActionFeed(root, settings){
    if (!_requireProOrRenderUpsell(root)) return;
    const limit = Number(settings?.limit ?? 5) || 5;
    const items = _pickTop(getFeedItemsSafe(), limit);
    if (!items.length) return _proEmpty(root);

    root.innerHTML = `
      <div class="proHint">Numbers are not “random”: they are computed from <b>importance</b> + <b>outlet spread</b>. Tap a row to jump to the story.</div>
      <div class="proList" data-pro-list></div>
    `;
    const list = root.querySelector('[data-pro-list]');
    if (!list) return;

    for (const it of items){
      const cid = Number(it?.cluster_id ?? it?.id);
      const title = String(it?.title || 'Untitled');
      const impact = computeImpact(it);
      const row = document.createElement('button');
      row.type = 'button';
      row.className = 'proRow';
      row.innerHTML = `
        <div class="proRowMain">
          <div class="proRowTitle">${escapeHtml(title)}</div>
          <div class="proRowWhy">${escapeHtml(whyImpact(it))}</div>
        </div>
        <div class="proRowBadge" title="Impact score">${impact}</div>
      `;
      row.addEventListener('click', () => { if (Number.isFinite(cid)) openClusterInFeed(cid); });
      list.appendChild(row);
    }
  }

  function renderProRiskWhy(root, settings){
    if (!_requireProOrRenderUpsell(root)) return;
    const limit = Number(settings?.limit ?? 5) || 5;
    const items = (Array.isArray(getFeedItemsSafe()) ? getFeedItemsSafe() : []).slice();
    items.sort((a,b) => (computeRisk(b).pct - computeRisk(a).pct));
    const top = items.slice(0, Math.max(1, limit));
    if (!top.length) return _proEmpty(root);

    root.innerHTML = `
      <div class="proHint">Risk = velocity (how fast it spreads) + importance + sensitive keywords. It’s a prioritization helper, not a prediction.</div>
      <div class="proList" data-pro-list></div>
    `;
    const list = root.querySelector('[data-pro-list]');
    if (!list) return;

    for (const it of top){
      const meta = computeRisk(it);
      const cid = Number(it?.cluster_id ?? it?.id);
      const row = document.createElement('button');
      row.type = 'button';
      row.className = 'proRow';
      row.innerHTML = `
        <div class="proRowMain">
          <div class="proRowTitle">${escapeHtml(String(it?.title || 'Untitled'))}</div>
          <div class="proRowWhy">${escapeHtml(whyRisk(it, meta))}</div>
        </div>
        <div class="proRowPct" title="Risk score">${meta.pct}%</div>
      `;
      row.addEventListener('click', () => { if (Number.isFinite(cid)) openClusterInFeed(cid); });
      list.appendChild(row);
    }
  }

  async function renderProMomentum(root){
    if (!_requireProOrRenderUpsell(root)) return;
    const currentCid = getCurrentClusterId();
    const feedItems = getFeedItemsSafe();
    let it = null;
    let cid = null;

    if (Number.isFinite(Number(currentCid))) {
      cid = Number(currentCid);
      it = (Array.isArray(feedItems) ? feedItems : []).find(x => Number(x?.cluster_id ?? x?.id) === cid) || null;
    }

    // Fallback: pick the most impactful story if user hasn't opened anything yet.
    if (!cid || !Number.isFinite(cid)){
      const items = _pickTop(feedItems, 1);
      it = items[0] || null;
      cid = it ? Number(it?.cluster_id ?? it?.id) : null;
    }

    if (!cid || !Number.isFinite(cid)) return _proEmpty(root);

    root.innerHTML = `
      <div class="proTitleSm">${escapeHtml(String(it?.title || 'Selected story'))}</div>
      <div class="proHint" style="margin-top:6px;">Mini chart = your Trust History (0–100) over time. Higher = more consistent across sources.</div>
      <div class="proChart" data-pro-chart>Loading…</div>
      <div class="proActions">
        <button class="btnSoft" type="button" data-pro-open>Open</button>
        <button class="btnSoft" type="button" data-pro-track>Search terms</button>
      </div>
    `;
    const openBtn = root.querySelector('[data-pro-open]');
    if (openBtn) openBtn.addEventListener('click', () => { void openClusterInTracking(cid); });
    const searchBtn = root.querySelector('[data-pro-track]');
    if (searchBtn) searchBtn.addEventListener('click', () => {
      const t = String(it?.title || '').trim();
      const q = t ? t.split(' ').slice(0, 2).join(' ') : '';
      if (q) setSearchTerm(q);
    });

    const chartEl = root.querySelector('[data-pro-chart]');
    if (!chartEl) return;

    try {
      if (typeof fetchTrustHistory !== 'function' || typeof buildTrustHistorySvg !== 'function') {
        chartEl.textContent = 'Chart engine not available.';
        return;
      }
      const pts = await fetchTrustHistory(cid, 36);
      if (!pts || !pts.length) {
        chartEl.textContent = 'No history yet.';
        return;
      }
      chartEl.innerHTML = buildTrustHistorySvg(pts);
      chartEl.classList.add('proChartReady');
    } catch {
      chartEl.textContent = 'Failed to load chart.';
    }
  }

  // ===== Pro helpers for cluster-aware widgets =====
  function _normName(s){
    return String(s || '').trim().toLowerCase();
  }
function _truncateList(arr, max){
    const a = Array.isArray(arr) ? arr.filter(Boolean) : [];
    const m = clamp(Number(max) || 6, 3, 12);
    if (a.length <= m) return a.join(' · ');
    return a.slice(0, m).join(' · ') + ` · +${a.length - m} more`;
  }

  function _findSideByWidgetId(id){
    try {
      for (const side of ['left','right']){
        const list = state?.layout?.[side] || [];
        if (list.some(w => w && w.id === id)) return side;
      }
    } catch {}
    return 'left';
  }


  function _dtMs(iso){
    try {
      const v = String(iso || '').trim();
      if (!v) return null;
      const ms = Date.parse(v);
      return Number.isFinite(ms) ? ms : null;
    } catch { return null; }
  }

  const _DATE_LOCALE = 'en-GB'; // English by default (avoid device locale like ru/uk)

  function _fmtWhen(iso){
    const ms = _dtMs(iso);
    if (!ms) return '';
    try {
      return new Intl.DateTimeFormat(_DATE_LOCALE, {
        year:'numeric', month:'short', day:'2-digit',
        hour:'2-digit', minute:'2-digit',
        hour12: false
      }).format(new Date(ms));
    } catch {
      try { return new Date(ms).toISOString().slice(0,16).replace('T',' '); } catch { return ''; }
    }
  }

  function _fmtDateOnly(iso){
    const ms = _dtMs(iso);
    if (!ms) return '';
    try {
      return new Intl.DateTimeFormat(_DATE_LOCALE, { year:'numeric', month:'short', day:'2-digit' }).format(new Date(ms));
    } catch {
      try { return new Date(ms).toISOString().slice(0,10); } catch { return ''; }
    }
  }

  function _fmtTimeOnly(iso){
    const ms = _dtMs(iso);
    if (!ms) return '';
    try {
      return new Intl.DateTimeFormat(_DATE_LOCALE, { hour:'2-digit', minute:'2-digit', hour12:false }).format(new Date(ms));
    } catch { return ''; }
  }

  function _fmtAgeShort(iso){
    const ms = _dtMs(iso);
    if (!ms) return '';
    const d = Date.now() - ms;
    if (!Number.isFinite(d) || d < 0) return '';
    const m = Math.floor(d / 60000);
    if (m < 60) return m + 'm';
    const h = Math.floor(m / 60);
    if (h < 48) return h + 'h';
    const days = Math.floor(h / 24);
    return days + 'd';
  }

  async function _fetchClusterById(cid){
    try {
      const interests = encodeURIComponent((state && Array.isArray(state.interests)) ? state.interests.join(',') : 'general');
      const country = encodeURIComponent((state && state.country) ? state.country : 'world');
      const uiLang = encodeURIComponent((state && state.language) ? state.language : 'en');
      const url = `${API_BASE}/api/news/by_ids?ids=${encodeURIComponent(String(cid))}` +
        `&interests=${interests}&country=${country}&language=all&ui_lang=${uiLang}${(typeof window.__checkneBuildGuestPreviewIdsQuery === 'function' ? window.__checkneBuildGuestPreviewIdsQuery() : '')}`;
      const r = await fetch(url, { credentials: 'include' });
      const j = await r.json().catch(() => ({}));
      const items = Array.isArray(j.items) ? j.items : [];
      return items && items.length ? items[0] : null;
    } catch {
      return null;
    }
  }

  async function _getCurrentClusterItem(){
    const currentCid = getCurrentClusterId();
    const feedItems = getFeedItemsSafe();
    let it = null;
    let cid = null;

    if (Number.isFinite(Number(currentCid))) {
      cid = Number(currentCid);
      it = (Array.isArray(feedItems) ? feedItems : []).find(x => Number(x?.cluster_id ?? x?.id) === cid) || null;
    }
    if (!cid || !Number.isFinite(cid)){
      const top = _pickTop(feedItems, 1);
      it = top[0] || null;
      cid = it ? Number(it?.cluster_id ?? it?.id) : null;
    }
    if (!cid || !Number.isFinite(cid)) return { cid: null, it: null };

    // Ensure we have sources (guests / older snapshots may not include them)
    const hasSources = Array.isArray(it?.sources) && it.sources.length;
    if (!hasSources) {
      const fetched = await _fetchClusterById(cid);
      if (fetched) it = fetched;
    }
    return { cid, it };
  }

  function renderProAlerts(root, settings){
    if (!_requireProOrRenderUpsell(root)) return;

    const preset = String(settings?.preset || 'breaking');
    const presetLabel = (preset === 'daily') ? 'Daily digest' : (preset === 'high_risk') ? 'High risk only' : 'Breaking only';

    root.innerHTML = `
      <div class="proHint">Alerts are sent only for your tracked topics. Presets explain what the widget highlights.</div>
      <div class="proAlertsRow">
        <div>
          <div class="proAlertsTitle">Email alerts</div>
          <div class="proAlertsSub">Preset: <b>${escapeHtml(presetLabel)}</b></div>
        </div>
        <label class="switch"><input type="checkbox" data-email-alerts-toggle /><span class="slider"></span></label>
      </div>
      <div class="proActions">
        <button class="btnSoft" type="button" data-pro-test-email>Send test email</button>
        <button class="btnSoft" type="button" data-pro-go-tracking>Open tracking</button>
      </div>
      <div class="proHint" style="margin-top:8px;">One‑click unsubscribe is included in every email.</div>
    `;

    const toggle = root.querySelector('[data-email-alerts-toggle]');
    if (toggle && typeof initEmailAlertsControls === 'function') {
      // Reuse existing implementation (bootstrap.js)
      initEmailAlertsControls(root);
    }

    const testBtn = root.querySelector('[data-pro-test-email]');
    if (testBtn) testBtn.addEventListener('click', async () => {
      if (!requireAuth('alerts')) return;
      try {
        const r = await fetch('/api/alerts/email/test', { method:'POST', credentials:'include' });
        if (r.ok) { try { if (typeof toast === 'function') toast('✅ Test email sent.'); } catch {} }
        else { try { if (typeof toast === 'function') toast('Could not send test email.'); } catch {} }
      } catch {
        try { if (typeof toast === 'function') toast('Could not send test email.'); } catch {}
      }
    });

    const trBtn = root.querySelector('[data-pro-go-tracking]');
    if (trBtn) trBtn.addEventListener('click', () => {
      try { if (typeof window.__navigate === 'function') window.__navigate('/tracking'); else location.href = '/tracking'; } catch {}
    });
  }

  function renderProEntities(root, settings){
    if (!_requireProOrRenderUpsell(root)) return;
    const limit = Number(settings?.limit ?? 8) || 8;
    const items = getFeedItemsSafe();
    if (!items.length) return _proEmpty(root);

    // Simple entity extraction:
    // 1) common geopolitics keywords
    // 2) uppercase words in titles
    const common = ['USA','US','UK','EU','NATO','UN','RUSSIA','UKRAINE','CHINA','IRAN','ISRAEL','GAZA','PAKISTAN','INDIA','FRANCE','GERMANY'];
    const counts = new Map();
    const add = (k) => {
      const key = String(k || '').trim();
      if (!key) return;
      counts.set(key, (counts.get(key) || 0) + 1);
    };

    for (const it of items){
      const title = String(it?.title || '');
      for (const c of common){
        if (title.toUpperCase().includes(c)) add(c);
      }
      // Naive “proper noun” tokens (kept small)
      const toks = title.split(/\s+/).map(s => s.replace(/[^A-Za-z\-]/g,'')).filter(Boolean);
      for (const t of toks){
        if (t.length < 4) continue;
        if (t.toUpperCase() === t && t.length <= 10) add(t); // e.g., TRUMP
      }
    }

    const ranked = Array.from(counts.entries())
      .sort((a,b) => (b[1]-a[1]) || a[0].localeCompare(b[0]))
      .slice(0, Math.max(3, limit));

    root.innerHTML = `
      <div class="proHint">Tap an entity to search your feed. This helps you spot what’s trending across stories.</div>
      <div class="entityGrid" data-entity-grid></div>
    `;
    const grid = root.querySelector('[data-entity-grid]');
    if (!grid) return;

    for (const [name, n] of ranked){
      const btn = document.createElement('button');
      btn.type = 'button';
      btn.className = 'entityChip';
      btn.innerHTML = `<span class="entityName">${escapeHtml(name)}</span><span class="entityCount">${n}</span>`;
      btn.addEventListener('click', () => setSearchTerm(name));
      grid.appendChild(btn);
    }
  }

function videoReportSettingsUI(container, settings){
  const v = clamp(Number(settings?.max_results ?? 5), 1, 10);
  container.innerHTML = `
    <label class="setRow">
      <div class="setLabel">Max results</div>
      <input class="setInput" type="number" name="max_results" min="1" max="10" value="${escapeAttr(String(v))}" />
    </label>
    <div class="setHint">How many video results to fetch (1–10).</div>
  `;
}

async function renderProVideoReport(root, settings, widget){
  root.innerHTML = '';
  const story = getCurrentStory();
  const head = document.createElement('div');
  head.className = 'proHero';
  const h = document.createElement('div');
  h.className = 'proHeroTitle';
  h.textContent = 'Video Report';
  const sub = document.createElement('div');
  sub.className = 'proHeroDesc';
  sub.textContent = story && story.title ? `For: ${String(story.title).slice(0, 90)}${String(story.title).length>90?'…':''}` : 'Open a story to see a relevant video report.';
  head.appendChild(h);
  head.appendChild(sub);
  root.appendChild(head);

  if (!story || !story.title) {
    const empty = document.createElement('div');
    empty.className = 'proEmpty';
    empty.textContent = 'Tip: open a card in the feed, then this widget will load a related report.';
    root.appendChild(empty);
    return;
  }

  // Only for high-rated stories (avoid noise + extra API calls)
  const minRating = 70;
  const storyScore = Number(story?.score ?? 0) || 0;
  if (storyScore < minRating) {
    const empty = document.createElement('div');
    empty.className = 'proEmpty';
    empty.innerHTML = `This widget is available only for stories rated <b>${minRating}+</b>.`;
    root.appendChild(empty);
    return;
  }

const maxResults = clamp(Number(settings?.max_results ?? 5), 1, 10);

  const box = document.createElement('div');
  box.className = 'proBox';
  const status = document.createElement('div');
  status.className = 'proMuted';
  status.textContent = 'Searching for a relevant video…';
  box.appendChild(status);
root.appendChild(box);

  const cid = Number(story.cluster_id || getCurrentClusterId() || 0) || 0;
  const url = `${API_BASE}/api/news/video?q=${encodeURIComponent(story.title)}&max_results=${encodeURIComponent(String(maxResults))}&cluster_id=${encodeURIComponent(String(cid||''))}&min_rating=${encodeURIComponent(String(minRating))}`;

  let j = null;
  try {
   j = await fetchJsonCached(url, 1000 * 60 * 15);
  } catch {
    j = null;
  }

  const items = Array.isArray(j?.items) ? j.items : [];
  const detail = String(j?.detail || '');

  box.innerHTML = '';

  if (!items.length) {
    const msg = document.createElement('div');
    msg.className = 'proEmpty';
    if (detail.includes('YOUTUBE_API_KEY')) {
      msg.innerHTML = `Video search is not enabled on the server.<br><span class="proMuted">Set <b>YOUTUBE_API_KEY</b> to enable this widget.</span>`;
    } else {
      msg.textContent = 'No video found for this story yet.';
    }
    box.appendChild(msg);

    const openBtn = document.createElement('a');
    openBtn.className = 'proBtn';
    openBtn.href = `https://www.youtube.com/results?search_query=${encodeURIComponent(story.title)}`;
    openBtn.target = '_blank';
    openBtn.rel = 'noopener noreferrer';
    openBtn.textContent = 'Search on YouTube';
    box.appendChild(openBtn);
    return;
  }

  const primary = items[0];

  const player = document.createElement('div');
  player.className = 'videoPlayer';
  player.innerHTML = `<iframe class="videoFrame" src="https://www.youtube-nocookie.com/embed/${encodeURIComponent(primary.video_id)}" title="Video report" frameborder="0" allow="accelerometer; autoplay; clipboard-write; encrypted-media; gyroscope; picture-in-picture" allowfullscreen></iframe>`;
  box.appendChild(player);

  const meta = document.createElement('div');
  meta.className = 'videoMeta';
  const t = document.createElement('div');
  t.className = 'videoTitle';
  t.textContent = primary.title || 'Video';
  const m = document.createElement('div');
  m.className = 'videoSub';
  const when = primary.published_at ? _fmtWhen(primary.published_at) : '';
  m.textContent = [primary.channel, when].filter(Boolean).join(' • ');
  meta.appendChild(t);
  meta.appendChild(m);

  const open = document.createElement('a');
  open.className = 'proBtn';
  open.href = primary.url || `https://www.youtube.com/watch?v=${primary.video_id}`;
  open.target = '_blank';
  open.rel = 'noopener noreferrer';
  open.textContent = 'Open on YouTube';

  meta.appendChild(open);
  box.appendChild(meta);

  if (items.length > 1) {
    const list = document.createElement('div');
    list.className = 'videoList';
    items.slice(1, 4).forEach((it) => {
      const row = document.createElement('button');
      row.type = 'button';
      row.className = 'videoRow';
      row.addEventListener('click', () => {
        try {
          const iframe = box.querySelector('iframe.videoFrame');
          if (iframe) iframe.src = `https://www.youtube-nocookie.com/embed/${encodeURIComponent(it.video_id)}`;
        } catch {}
        try { t.textContent = it.title || 'Video'; } catch {}
        try {
          const when2 = it.published_at ? _fmtWhen(it.published_at) : '';
          m.textContent = [it.channel, when2].filter(Boolean).join(' • ');
        } catch {}
        try { open.href = it.url || `https://www.youtube.com/watch?v=${it.video_id}`; } catch {}
      });

      const thumb = document.createElement('div');
      thumb.className = 'videoThumb';
      if (it.thumbnail) thumb.style.backgroundImage = `url("${String(it.thumbnail).replace(/"/g,'&quot;')}")`;
      const rt = document.createElement('div');
      rt.className = 'videoRowText';
      const rt1 = document.createElement('div');
      rt1.className = 'videoRowTitle';
      rt1.textContent = it.title || 'Video';
      const rt2 = document.createElement('div');
      rt2.className = 'videoRowSub';
      const when3 = it.published_at ? _fmtWhen(it.published_at) : '';
      rt2.textContent = [it.channel, when3].filter(Boolean).join(' • ');
      rt.appendChild(rt1);
      rt.appendChild(rt2);

      row.appendChild(thumb);
      row.appendChild(rt);
      list.appendChild(row);
    });
    box.appendChild(list);
  }
}

async function renderProRelatedCoverage(root, settings){
    if (!_requireProOrRenderUpsell(root)) return;
    const limit = clamp(Number(settings?.limit ?? 6) || 6, 3, 10);
    const { cid, it } = await _getCurrentClusterItem();
    if (!cid || !it) return _proEmpty(root);

    const sources = Array.isArray(it?.sources) ? it.sources.slice() : [];
    if (!sources.length) {
      root.innerHTML = `<div class="proHint">No sources available for this story yet.</div>`;
      return;
    }

    // Prefer diversity: keep first entry per source_key/source_name.
    const seen = new Set();
    const uniq = [];
    for (const s of sources){
      const k = _normName(s?.source_key || s?.source_name);
      if (!k || seen.has(k)) continue;
      seen.add(k);
      uniq.push(s);
      if (uniq.length >= limit) break;
    }

    const score = Number(it?.credibility_score);
    const scorePill = Number.isFinite(score) ? `<span class="trackPill">Score ${escapeHtml(String(score))}</span>` : '';
    const outlets = Number(it?.sources_count);
    const outletPill = Number.isFinite(outlets) ? `<span class="trackPill">${escapeHtml(String(outlets))} outlets</span>` : '';

    root.innerHTML = `
      <div class="proTitleSm">${escapeHtml(String(it?.title || 'Selected story'))}</div>
      <div class="proHint" style="margin-top:6px;">Same-event coverage from other outlets (cluster-based, not keyword-only).</div>
      <div class="trackItemMeta" style="margin:8px 0 10px;">${scorePill}${outletPill}</div>
      <div class="proList" data-rc-list></div>
      <div class="proActions" style="margin-top:10px;">
        <button class="btnSoft" type="button" data-pro-open>Open</button>
      </div>
    `;
    const openBtn = root.querySelector('[data-pro-open]');
    if (openBtn) openBtn.addEventListener('click', () => openClusterInFeed(cid));

    const list = root.querySelector('[data-rc-list]');
    if (!list) return;
    for (const s of uniq){
      const url = String(s?.url || '').trim();
      const title = String(s?.title || 'Untitled');
      const src = String(s?.source_name || '').trim() || 'Source';
      const iso = (s?.published_at || s?.inserted_at);
      const dateOnly = _fmtDateOnly(iso);
      const badge = _fmtAgeShort(iso) || _fmtTimeOnly(iso) || '';

      const row = document.createElement('div');
      row.className = 'proRow';
      row.style.cursor = url ? 'pointer' : 'default';
      row.innerHTML = `
        <div class="proRowMain">
          <div class="proRowTitle">${escapeHtml(title)}</div>
          <div class="proRowWhy">${escapeHtml(src)}${dateOnly ? ' · ' + escapeHtml(dateOnly) : ''}</div>
        </div>
        <div class="proRowBadgeSm" title="Published">${escapeHtml(badge)}</div>
      `;
      if (url) row.addEventListener('click', () => { try { window.open(url, '_blank', 'noopener'); } catch {} });
      list.appendChild(row);
    }
  }

  async function renderProRecentHistory(root, settings, widget){
    if (!_requireProOrRenderUpsell(root)) return;
    const limit = clamp(Number(settings?.limit ?? 10) || 10, 5, 20);
    const win = String(settings?.window || '3d');
    const { cid, it } = await _getCurrentClusterItem();
    if (!cid || !it) return _proEmpty(root);

    const sources = Array.isArray(it?.sources) ? it.sources.slice() : [];
    if (!sources.length) {
      root.innerHTML = `<div class="proHint">No timeline yet for this story.</div>`;
      return;
    }

    const now = Date.now();
    const maxAgeMs = (win === '24h') ? 24*3600*1000 : (win === '7d') ? 7*24*3600*1000 : 3*24*3600*1000;

    const rows = sources
      .map(s => ({ s, ms: _dtMs(s?.published_at || s?.inserted_at) }))
      .filter(x => x.ms)
      .filter(x => (now - x.ms) <= maxAgeMs)
      .sort((a,b) => b.ms - a.ms)
      .slice(0, limit);

    const active = (win === '24h') ? '24h' : (win === '7d') ? '7d' : '3d';

    root.innerHTML = `
      <div class="proTitleSm">Recent History</div>
      <div class="proHint" style="margin-top:6px;">Publications inside the same event cluster. Use the filter to see how coverage evolves.</div>
      <div class="proFilterRow" data-rh-filters>
        <button type="button" class="chipBtn ${active==='24h' ? 'isOn' : ''}" data-win="24h">24h</button>
        <button type="button" class="chipBtn ${active==='3d' ? 'isOn' : ''}" data-win="3d">3d</button>
        <button type="button" class="chipBtn ${active==='7d' ? 'isOn' : ''}" data-win="7d">Week</button>
      </div>
      <div class="proList" data-rh-list></div>
      <div class="proActions" style="margin-top:10px;">
        <button class="btnSoft" type="button" data-pro-open>Open</button>
      </div>
    `;
    const openBtn = root.querySelector('[data-pro-open]');
    if (openBtn) openBtn.addEventListener('click', () => openClusterInFeed(cid));
const filterRow = root.querySelector('[data-rh-filters]');
    if (filterRow && widget && widget.id){
      filterRow.addEventListener('click', (e) => {
        const btn = e.target && e.target.closest ? e.target.closest('button[data-win]') : null;
        if (!btn) return;
        const nextWin = String(btn.getAttribute('data-win') || '').trim();
        if (!nextWin) return;
        try {
          const side = _findSideByWidgetId(widget.id);
          const w = (state.layout[side] || []).find(x => x.id === widget.id);
          if (!w) return;
          w.settings = { ...(w.settings || {}), window: nextWin };
          saveLayout();
          renderSidebar(side);
        } catch {}
      });
    }


    const list = root.querySelector('[data-rh-list]');
    if (!list) return;

    if (!rows.length){
      list.innerHTML = `<div class="muted" style="font-size:12px; padding:6px 2px;">No articles in this window.</div>`;
      return;
    }

    for (const r of rows){
      const s = r.s;
      const url = String(s?.url || '').trim();
      const title = String(s?.title || 'Untitled');
      const src = String(s?.source_name || '').trim() || 'Source';
      const iso = (s?.published_at || s?.inserted_at);
      const dateOnly = _fmtDateOnly(iso);
      const badge = _fmtAgeShort(iso) || _fmtTimeOnly(iso) || '';
      const row = document.createElement('div');
      row.className = 'proRow';
      row.style.cursor = url ? 'pointer' : 'default';
      row.innerHTML = `
        <div class="proRowMain">
          <div class="proRowTitle">${escapeHtml(title)}</div>
          <div class="proRowWhy">${escapeHtml(src)}${dateOnly ? ' · ' + escapeHtml(dateOnly) : ''}</div>
        </div>
        <div class="proRowBadgeSm" title="Published">${escapeHtml(badge)}</div>
      `;
      if (url) row.addEventListener('click', () => { try { window.open(url, '_blank', 'noopener'); } catch {} });
      list.appendChild(row);
    }
  }

  async function renderProSilenceIndicator(root, settings, widget){
    if (!_requireProOrRenderUpsell(root)) return;
    const threshold = clamp(Number(settings?.threshold ?? 4) || 4, 2, 10);
    const { cid, it } = await _getCurrentClusterItem();
    if (!cid || !it) return _proEmpty(root);

    const sources = Array.isArray(it?.sources) ? it.sources.slice() : [];
    const outletsCount = Number(it?.sources_count);
    const topic = String(it?.topic || 'general').toLowerCase();

    const present = new Set();
    for (const s of sources){
      present.add(_normName(s?.source_name));
    }

    const EXPECTED = {
      general: ["Reuters","Associated Press","BBC","The Guardian","Al Jazeera"],
      politics: ["Reuters","Associated Press","BBC","The New York Times","The Washington Post","The Guardian","Al Jazeera","CNN"],
      economy: ["Reuters","Bloomberg","Financial Times","The Wall Street Journal","CNBC"],
      business: ["Reuters","Bloomberg","Financial Times","The Wall Street Journal","CNBC"],
      tech: ["Reuters","The Verge","Wired","TechCrunch","Bloomberg"],
      science: ["Reuters","BBC","Nature","Science","Associated Press"],
      health: ["Reuters","BBC","WHO","Associated Press"],
      war: ["Reuters","BBC","Al Jazeera","Associated Press","CNN"],
      world: ["Reuters","Associated Press","BBC","The Guardian","Al Jazeera"],
    };

    const pick = (EXPECTED[topic] || EXPECTED.general);
    const missingMajor = pick.filter(nm => !present.has(_normName(nm)));

    
    const REGION_OF = {
      "reuters": "Global",
      "associated press": "North America",
      "ap": "North America",
      "the new york times": "North America",
      "the washington post": "North America",
      "cnn": "North America",
      "bloomberg": "North America",
      "the wall street journal": "North America",
      "wsj": "North America",
      "cnbc": "North America",
      "bbc": "Europe",
      "the guardian": "Europe",
      "financial times": "Europe",
      "dw": "Europe",
      "france 24": "Europe",
      "al jazeera": "Middle East",
      "haaretz": "Middle East",
      "times of israel": "Middle East",
      "japan times": "Asia-Pacific",
      "south china morning post": "Asia-Pacific",
      "who": "Official",
    };

    const regionsPresent = new Set();
    for (const s of sources){
      const nm = _normName(s?.source_name);
      const r = REGION_OF[nm];
      if (r) regionsPresent.add(r);
    }
    const regionsExpected = ["North America","Europe","Middle East","Asia-Pacific","Global"];
    const missingRegions = regionsExpected.filter(r => !regionsPresent.has(r));

    // very light “official statement” heuristic (no deep NLP)
    const titlesText = sources.map(s => String(s?.title || '')).join(' ').toLowerCase();
    const hasOfficial = /(official|statement|spokesperson|ministry|government|police|president|prime minister)/i.test(titlesText);

    const shouldFlag = (Number.isFinite(outletsCount) ? outletsCount : (sources.length || 0)) >= threshold;

    root.innerHTML = `
      <div class="proTitleSm">Silence Indicator</div>
      <div class="proHint" style="margin-top:6px;">A “gap” signal: the story is spreading, but some <b>expected</b> sources/regions haven’t appeared yet. This is a clue — not proof.</div>
      <div class="proList" data-silence-list></div>
      <div class="proActions" style="margin-top:10px;">
        <button class="btnSoft" type="button" data-pro-open>Open</button>
      </div>
    `;

    const openBtn = root.querySelector('[data-pro-open]');
    if (openBtn) openBtn.addEventListener('click', () => openClusterInFeed(cid));

    const list = root.querySelector('[data-silence-list]');
    if (!list) return;

    if (!shouldFlag){
      list.innerHTML = `<div class="muted" style="font-size:12px; padding:6px 2px;">Not enough coverage yet (threshold: ${escapeHtml(String(threshold))}).</div>`;
      return;
    }

    
    const blocks = [];
    const majorTxt = missingMajor.length ? _truncateList(missingMajor, 6) : 'None detected';
    const regionsTxt = missingRegions.length ? _truncateList(missingRegions, 5) : 'None detected';

    blocks.push(`
      <div class="proRow proRowCard" style="cursor:default;">
        <div class="proRowMain">
          <div class="proRowTitle">Missing major outlets</div>
          <div class="proRowWhy">${escapeHtml(majorTxt)}</div>
          <div class="muted" style="font-size:12px; margin-top:6px;">${escapeHtml(wt('widgets.silence.expected_list_hint', 'Expected list is based on the topic (e.g., politics, economy). Tweak threshold in settings.'))}</div>
        </div>
        <div class="proRowBadgeSm" title="Count">${escapeHtml(String(missingMajor.length))}</div>
      </div>
    `);

    blocks.push(`
      <div class="proRow proRowCard" style="cursor:default;">
        <div class="proRowMain">
          <div class="proRowTitle">Regions without coverage</div>
          <div class="proRowWhy">${escapeHtml(regionsTxt)}</div>
        </div>
        <div class="proRowBadgeSm" title="Count">${escapeHtml(String(missingRegions.length))}</div>
      </div>
    `);

    blocks.push(`
      <div class="proRow proRowCard" style="cursor:default;">
        <div class="proRowMain">
          <div class="proRowTitle">Official statement signal</div>
          <div class="proRowWhy">${hasOfficial ? 'Some headlines look like official-language (statement / ministry / spokesperson).' : 'No obvious official-language detected in headlines yet.'}</div>
        </div>
        <div class="proRowBadgeSm">${hasOfficial ? 'Yes' : 'No'}</div>
      </div>
    `);

    list.innerHTML = blocks.join('');
  }

  async function renderProTopCharts(root, settings){
    if (!_requireProOrRenderUpsell(root)) return;
    const limit = Math.max(3, Number(settings?.limit ?? 6) || 6);
    const seconds = clamp(Number(settings?.seconds ?? 6) || 6, 3, 20);
    const items = _pickTop(getFeedItemsSafe(), limit);
    if (!items.length) return _proEmpty(root);

    // Prevent duplicate timers on re-render
    if (root._proChartsTimer) {
      try { clearInterval(root._proChartsTimer); } catch {}
      root._proChartsTimer = null;
    }

    const slides = items.map(it => {
      const cid = Number(it?.cluster_id ?? it?.id);
      return {
        cid,
        title: String(it?.title || 'Untitled'),
        impact: computeImpact(it),
      };
    }).filter(s => Number.isFinite(s.cid));

    let idx = 0;

    root.innerHTML = `
      <div class="proHint">Auto-sliding mini charts for top stories. Tap a slide to open the story.</div>
      <div class="miniCarousel">
        <button class="miniNav" type="button" data-mini-prev aria-label="Previous">‹</button>
        <div class="miniSlide" data-mini-slide>Loading…</div>
        <button class="miniNav" type="button" data-mini-next aria-label="Next">›</button>
      </div>
      <div class="miniDots" data-mini-dots></div>
    `;

    const slideEl = root.querySelector('[data-mini-slide]');
    const dotsEl = root.querySelector('[data-mini-dots]');
    const prevBtn = root.querySelector('[data-mini-prev]');
    const nextBtn = root.querySelector('[data-mini-next]');

    const renderIdx = async (i) => {
      if (!slideEl) return;
      idx = (i + slides.length) % slides.length;
      const s = slides[idx];

      slideEl.innerHTML = `
        <div class="miniTop">
          <div class="miniTitle">${escapeHtml(s.title)}</div>
          <div class="miniBadge" title="Impact">${s.impact}</div>
        </div>
        <div class="miniChart" data-mini-chart>Loading chart…</div>
        <div class="miniSub">Trust history (0–100) · ${escapeHtml(scoreLabel(s.impact))} attention</div>
      `;
      slideEl.onclick = () => openClusterInFeed(s.cid);

      if (dotsEl){
        dotsEl.innerHTML = '';
        slides.forEach((_,di) => {
          const d = document.createElement('button');
          d.type = 'button';
          d.className = 'miniDot' + (di===idx ? ' isOn' : '');
          d.addEventListener('click', () => { renderIdx(di); });
          dotsEl.appendChild(d);
        });
      }

      const chartEl = slideEl.querySelector('[data-mini-chart]');
      if (!chartEl) return;
      try {
        if (typeof fetchTrustHistory !== 'function' || typeof buildTrustHistorySvg !== 'function') {
          chartEl.textContent = 'Chart engine not available.';
          return;
        }
        const pts = await fetchTrustHistory(s.cid, 28);
        if (!pts || !pts.length) {
          chartEl.textContent = 'No history yet.';
          return;
        }
        chartEl.innerHTML = buildTrustHistorySvg(pts);
        chartEl.classList.add('miniChartReady');
      } catch {
        chartEl.textContent = 'Failed to load chart.';
      }
    };

    if (prevBtn) prevBtn.addEventListener('click', () => renderIdx(idx - 1));
    if (nextBtn) nextBtn.addEventListener('click', () => renderIdx(idx + 1));

    // Initial render
    renderIdx(0);

    // Auto-slide
    root._proChartsTimer = setInterval(() => {
      renderIdx(idx + 1);
    }, seconds * 1000);
  }

  // ===== Settings UI builders =====
  function fxRatesSettingsUI(container, settings){
  const base = String((settings && settings.base) || "EUR").toUpperCase().trim() || "EUR";
  const selectedSymbols = parseList((settings && settings.symbols) || "USD,GBP,PLN,UAH")
    .map(s => s.toUpperCase())
    .filter(Boolean);

  container.innerHTML = `
    <div class="muted" style="font-size:13px; line-height:1.35;">
      ${escapeHtml(wt('widgets.settings.fx_intro', 'Choose a base currency and then pick the currencies you want to display.')).replace('base', '<b>base</b>')}
    </div>

    <div class="widgetFormRow" style="margin-top:14px;">
      <label>${escapeHtml(wt('widgets.settings.base', 'Base'))}</label>
      <select name="base" data-ms-base>
        ${FIAT_CODES.map(c => `<option value="${c}" ${c===base?"selected":""}>${c}</option>`).join("")}
      </select>
    </div>

    <div class="widgetFormRow">
      <label>${escapeHtml(wt('widgets.settings.symbols', 'Symbols'))}</label>
      <div class="msRoot" data-ms-root="fxSymbols"></div>
      <input type="hidden" name="symbols" value="${escapeAttr(selectedSymbols.join(","))}" />
    </div>

    <div class="muted" style="font-size:12px; margin-top:10px;">
      ${escapeHtml(wt('widgets.settings.tip_max8', 'Tip: You can search and click to add/remove. Max 8.'))}
    </div>
  `;

  const ms = container.querySelector('[data-ms-root="fxSymbols"]');
  const hidden = container.querySelector('input[name="symbols"]');

  if (ms && hidden){
    createMultiSelect(ms, {
      placeholder: wt('widgets.settings.search_currencies', 'Search currencies…'),
      options: FIAT_CODES.filter(c => c !== base).map(c => ({ value: c, label: c })),
      selected: selectedSymbols.filter(c => c !== base),
      max: 8,
      onChange: (vals) => { hidden.value = vals.join(","); }
    });

    // When base changes, remove it from symbols and update list.
    const baseSel = container.querySelector('[data-ms-base]');
    if (baseSel){
      baseSel.addEventListener('change', () => {
        const nextBase = String(baseSel.value || "EUR").toUpperCase();
        const current = parseList(hidden.value).map(s => s.toUpperCase()).filter(Boolean);
        const filtered = current.filter(c => c !== nextBase).slice(0, 8);
        hidden.value = filtered.join(",");
        createMultiSelect(ms, {
          placeholder: wt('widgets.settings.search_currencies', 'Search currencies…'),
          options: FIAT_CODES.filter(c => c !== nextBase).map(c => ({ value: c, label: c })),
          selected: filtered,
          max: 8,
          onChange: (vals) => { hidden.value = vals.join(","); }
        });
      });
    }
  }
}

  function marketClockSettingsUI(container, settings){
    const s = settings || {};
    const selectedCities = parseList(s.cities || "Europe/Berlin,Europe/London,America/New_York,Asia/Tokyo");

    container.innerHTML = `
      <div class="muted" style="font-size:13px; line-height:1.35;">
        ${escapeHtml(wt('widgets.settings.cities_intro', 'Choose which cities you want to display.')).replace('cities', '<b>cities</b>')}
      </div>

      <div class="widgetFormRow" style="margin-top:14px;">
        <label>${escapeHtml(wt('widgets.settings.cities', 'Cities'))}</label>
        <div class="msRoot" data-ms-root="clockCities"></div>
        <input type="hidden" name="cities" value="${escapeAttr(selectedCities.join(','))}" />
      </div>

      <div class="muted" style="font-size:12px; margin-top:10px;">
        ${escapeHtml(wt('widgets.settings.tip_max8', 'Tip: You can search and click to add/remove. Max 8.'))}
      </div>
    `;

    const ms = container.querySelector('[data-ms-root="clockCities"]');
    const hidden = container.querySelector('input[name="cities"]');

    if (ms && hidden){
      createMultiSelect(ms, {
        placeholder: wt('widgets.settings.search_cities', 'Search cities…'),
        options: CLOCK_CITIES.map(c => ({ value: c.tz, label: c.label })),
        selected: selectedCities,
        max: 8,
        onChange: (vals) => { hidden.value = vals.join(','); }
      });
    }
  }

  function cryptoSettingsUI(container, settings){
  const vs = String((settings && settings.vs) || "eur").toLowerCase().trim() || "eur";
  const selectedCoins = parseList((settings && settings.coins) || "bitcoin,ethereum")
    .map(s => s.toLowerCase())
    .filter(Boolean);

  container.innerHTML = `
    <div class="muted" style="font-size:13px; line-height:1.35;">
      ${escapeHtml(wt('widgets.settings.crypto_intro', 'Pick the display currency and the coins you want to track.')).replace('display currency', '<b>display currency</b>')}
    </div>

    <div class="widgetFormRow" style="margin-top:14px;">
      <label>${escapeHtml(wt('widgets.settings.currency', 'Currency'))}</label>
      <select name="vs">
        ${FIAT_CODES.map(c => `<option value="${c.toLowerCase()}" ${c.toLowerCase()===vs?"selected":""}>${c}</option>`).join("")}
      </select>
    </div>

    <div class="widgetFormRow">
      <label>${escapeHtml(wt('widgets.settings.coins', 'Coins'))}</label>
      <div class="msRoot" data-ms-root="cryptoCoins"></div>
      <input type="hidden" name="coins" value="${escapeAttr(selectedCoins.join(","))}" />
    </div>

    <div class="muted" style="font-size:12px; margin-top:10px;">
      ${escapeHtml(wt('widgets.settings.tip_coins', 'Tip: Search + click to add. You can also paste an id (CoinGecko) and press Enter.'))}
    </div>
  `;

  const ms = container.querySelector('[data-ms-root="cryptoCoins"]');
  const hidden = container.querySelector('input[name="coins"]');

  if (ms && hidden){
    createMultiSelect(ms, {
      placeholder: wt('widgets.settings.search_coins', 'Search coins… (BTC, ETH, SOL, …)'),
      options: COIN_PRESETS,
      selected: selectedCoins,
      max: 6,
      allowCustom: true,
      normalizeCustom: (v) => String(v||"").trim().toLowerCase().replaceAll(" ", "-"),
      onChange: (vals) => { hidden.value = vals.join(","); }
    });
  }
}

  function headlinesSettingsUI(container, settings){
    const v = clampInt(settings && settings.limit ? settings.limit : 4, 1, 6);
    container.innerHTML = `
      <div class="widgetFormRow">
        <label>${escapeHtml(wt('widgets.settings.items', 'Items'))}</label>
        <select name="limit">
          ${[1,2,3,4,5,6].map(n => `<option value="${n}" ${n===v?"selected":""}>${n}</option>`).join("")}
        </select>
      </div>
    `;
  }

  // ===== Helpers =====
  function escapeHtml(s){
    return String(s || "")
      .replaceAll("&","&amp;")
      .replaceAll("<","&lt;")
      .replaceAll(">","&gt;")
      .replaceAll('"',"&quot;")
      .replaceAll("'","&#39;");
  }
  function escapeAttr(s){ return escapeHtml(s).replaceAll("\n"," "); }

  function clampInt(v, a, b){
    const n = Number(v);
    if (!Number.isFinite(n)) return a;
    return Math.max(a, Math.min(b, Math.round(n)));
  }

  function formatNum(x){
    if (x === null || x === undefined) return "—";
    const n = Number(x);
    if (!Number.isFinite(n) || n <= 0) return "—";
    // 3 decimals for FX
    return n.toFixed(3);
  }

  function formatMoney(x, vs){
    if (x === null || x === undefined) return "—";
    const n = Number(x);
    if (!Number.isFinite(n) || n <= 0) return "—";
    const c = (vs || "eur").toUpperCase();
    // show no decimals for big numbers, 2 for smaller
    const dec = n >= 100 ? 0 : 2;
    try {
      return new Intl.NumberFormat(undefined, { style: "currency", currency: c, maximumFractionDigits: dec, minimumFractionDigits: dec }).format(n);
    } catch {
      return `${c} ${n.toFixed(dec)}`;
    }
  }

  function coinLabel(id){
    const m = {
      bitcoin: "BTC",
      ethereum: "ETH",
      solana: "SOL",
      ripple: "XRP",
      cardano: "ADA",
      dogecoin: "DOGE",
    };
    return m[id] || id.toUpperCase();
  }

  function fmtTime(date, tz){
    try {
      return new Intl.DateTimeFormat(undefined, { hour:"2-digit", minute:"2-digit", timeZone: tz }).format(date);
    } catch {
      return date.toLocaleTimeString([], { hour:"2-digit", minute:"2-digit" });
    }
  }

  // init when DOM ready
  if (document.readyState === "loading"){
    document.addEventListener("DOMContentLoaded", init);
  } else {
    init();
  }
})();