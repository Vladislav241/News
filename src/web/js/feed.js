/*
 * CHECKNE Web App — feed.js
 * Feed fetching + incremental rendering + cards UI + summaries
 *
 * Split from the former monolithic app.js to keep responsibilities separated.
 * Keep files loaded in order (see index.html).
 */

// ===== Incremental feed rendering (no full rerender on refresh) =====
// We keep DOM nodes for already rendered feed items and only prepend truly new ones.
let feedRenderedOrder = []; // array of string ids in DOM order (top -> bottom)
let feedRenderedSet = new Set();
let lastFeedSignature = ""; // used to decide when we can do an incremental update
let __feedAutoExpandTimer = null;
let __feedAutoExpandBusy = false;
let __feedAutoExpandObserver = null;
let __feedVisibleLimit = (typeof FEED_PAGE_SIZE !== 'undefined' ? FEED_PAGE_SIZE : 10);
let __feedAutoPaused = false;
let __feedAutoExpandLatch = false;
let __feedScrollSaveTimer = null;
let __feedRestoreTimer = null;
let __feedLastKnownScrollY = 0;
let __feedLastScrollDir = 0;
let __feedLastMagnetAt = 0;
let __feedMagnetLock = false;

const FEED_AUTO_BATCH_SIZE = 10;
const FEED_SCROLL_STATE_KEY = 'checkne_feed_scroll_state_v3';
const FEED_SCROLL_SAVE_THROTTLE_MS = 140;
const FEED_SCROLL_RESTORE_WINDOW_MS = 3 * 60 * 1000;
const FEED_LOAD_MORE_MAGNET_COOLDOWN_MS = 950;
const VISUAL_SEARCH_SOFT_TARGET_BYTES = 900 * 1024; // stay safely below common production body limits
const VISUAL_SEARCH_HARD_MAX_BYTES = 24 * 1024 * 1024;
const VISUAL_SEARCH_MAX_UPLOAD_BYTES = 1024 * 1024;
const VISUAL_SEARCH_MAX_DIMENSION = 2200;
const VISUAL_SEARCH_MIN_DIMENSION = 900;
const PERSONAL_RECO_INSERT_AFTER = 5;
const PERSONAL_RECO_MAX_ITEMS = 4;
const PERSONAL_RECO_ENDPOINT_LIMIT = 120;


function getGuestPreviewIds() {
  try {
    const items = Array.isArray(lastFeedItems) ? lastFeedItems : [];
    if (!items.length) return [];
    const ids = [];
    for (const it of items) {
      const id = String(getItemId(it) || '').trim();
      if (!id) continue;
      if (it?.guest_locked) continue;
      ids.push(id);
      if (ids.length >= 3) break;
    }
    return ids;
  } catch {
    return [];
  }
}

function buildGuestPreviewIdsQuery() {
  try {
    if (authState?.authenticated) return '';
    const ids = getGuestPreviewIds();
    return ids.length ? `&guest_preview_ids=${encodeURIComponent(ids.join(','))}` : '';
  } catch {
    return '';
  }
}

try {
  window.__checkneGetGuestPreviewIds = getGuestPreviewIds;
  window.__checkneBuildGuestPreviewIdsQuery = buildGuestPreviewIdsQuery;
} catch {}

const PERSONAL_RECO_MIN_SCORE = 70;
const PERSONAL_RECO_FALLBACK_MIN_SCORE = 60;

function getPersonalRecoStoryScore(item) {
  return Number(item?.score ?? item?.credibility_score ?? item?.credibility ?? item?.trust_score ?? item?.rating ?? 0) || 0;
}

function getPersonalRecoStoryImportance(item) {
  return Number(item?.importance ?? 0) || 0;
}

function getPersonalRecoStoryOutlets(item) {
  if (Number.isFinite(Number(item?.sources_count))) return Number(item.sources_count) || 0;
  if (Number.isFinite(Number(item?.outlets_count))) return Number(item.outlets_count) || 0;
  if (Array.isArray(item?.sources)) return item.sources.length;
  return 0;
}

function getPersonalRecoStoryFreshnessHours(item) {
  const raw = item?.latest_published_at ?? item?.published_at ?? item?.created_at ?? item?.updated_at ?? null;
  const ts = raw ? Date.parse(raw) : NaN;
  if (!Number.isFinite(ts)) return 9999;
  return Math.max(0, (Date.now() - ts) / 3600000);
}

function computePersonalRecoRank(item, profile) {
  const score = getPersonalRecoStoryScore(item);
  const importance = getPersonalRecoStoryImportance(item);
  const outlets = getPersonalRecoStoryOutlets(item);
  const freshnessHours = getPersonalRecoStoryFreshnessHours(item);
  const interests = Array.isArray(state?.interests) ? state.interests.map((x) => String(x || '').trim().toLowerCase()).filter(Boolean) : [];
  const topic = String(item?.topic || item?.category || '').trim().toLowerCase();
  const itemCountry = String(item?.country || '').trim().toLowerCase();
  const browserCountry = String(profile?.country || '').trim().toLowerCase();

  let rank = 0;
  rank += score * 1.8;
  rank += importance * 0.9;
  rank += Math.min(outlets, 8) * 7;
  rank += Math.max(0, 36 - Math.min(freshnessHours, 36));
  if (topic && interests.includes(topic)) rank += 22;
  if (itemCountry && browserCountry && itemCountry === browserCountry) rank += 12;
  if (score < PERSONAL_RECO_MIN_SCORE) rank -= (PERSONAL_RECO_MIN_SCORE - score) * 6;
  if (score < PERSONAL_RECO_FALLBACK_MIN_SCORE) rank -= 60;
  if (outlets <= 1) rank -= 12;
  return rank;
}

function pickPersonalRecoItems(fetched, currentIds, profile) {
  const all = Array.isArray(fetched) ? fetched : [];
  const base = all.filter((it) => {
    const id = getItemId(it);
    return !!id && !currentIds.has(id);
  });
  const pool = base.length ? base : all.filter((it) => !!getItemId(it));
  if (!pool.length) return [];

  const pickThreshold = (items) => {
    const thresholds = [PERSONAL_RECO_MIN_SCORE, 68, 65, PERSONAL_RECO_FALLBACK_MIN_SCORE];
    for (const threshold of thresholds) {
      if (items.some((it) => getPersonalRecoStoryScore(it) >= threshold)) return threshold;
    }
    return null;
  };

  const activeThreshold = pickThreshold(pool);
  const eligible = activeThreshold == null
    ? [...pool]
    : pool.filter((it) => getPersonalRecoStoryScore(it) >= activeThreshold);

  const sorted = eligible.sort((a, b) => {
    const sa = getPersonalRecoStoryScore(a);
    const sb = getPersonalRecoStoryScore(b);
    if (sa !== sb) return sb - sa;
    const ra = computePersonalRecoRank(a, profile);
    const rb = computePersonalRecoRank(b, profile);
    if (ra !== rb) return rb - ra;
    const ia = getPersonalRecoStoryImportance(a);
    const ib = getPersonalRecoStoryImportance(b);
    if (ia !== ib) return ib - ia;
    const oa = getPersonalRecoStoryOutlets(a);
    const ob = getPersonalRecoStoryOutlets(b);
    if (oa !== ob) return ob - oa;
    return getPersonalRecoStoryFreshnessHours(a) - getPersonalRecoStoryFreshnessHours(b);
  });

  return sorted.slice(0, PERSONAL_RECO_MAX_ITEMS);
}

let __personalRecoCache = {
  key: '',
  items: [],
  profile: null,
  fetchedAt: 0,
  loadingPromise: null,
};

function inferBrowserAudienceProfile() {
  try {
    const langs = (navigator.languages && navigator.languages.length ? navigator.languages : [navigator.language])
      .map((x) => String(x || '').trim())
      .filter(Boolean);
    const primary = String(langs[0] || navigator.language || '').trim();
    const localeMatch = primary.match(/[-_]([A-Za-z]{2})\b/);
    let country = localeMatch ? String(localeMatch[1]).toLowerCase() : '';
    const timeZone = String(Intl.DateTimeFormat().resolvedOptions().timeZone || '').trim();
    if (!country && timeZone) {
      const tz = timeZone.toLowerCase();
      const tzMap = [
        [/europe\/berlin|europe\/busingen/, 'de'],
        [/europe\/vienna/, 'at'],
        [/europe\/zurich/, 'ch'],
        [/europe\/paris/, 'fr'],
        [/europe\/madrid/, 'es'],
        [/europe\/rome/, 'it'],
        [/europe\/amsterdam/, 'nl'],
        [/europe\/brussels/, 'be'],
        [/europe\/warsaw/, 'pl'],
        [/europe\/prague/, 'cz'],
        [/europe\/kyiv|europe\/kiev/, 'ua'],
        [/europe\/london/, 'gb'],
        [/america\/new_york|america\/chicago|america\/denver|america\/los_angeles/, 'us'],
        [/america\/toronto|america\/vancouver/, 'ca'],
      ];
      for (const [rx, code] of tzMap) {
        if (rx.test(tz)) { country = code; break; }
      }
    }
    const language = String(primary.split(/[-_]/)[0] || state.language || 'en').toLowerCase();
    return {
      country: country || '',
      language,
      locale: primary || `${language}`,
      timeZone,
      reason: timeZone ? `${primary || language} · ${timeZone}` : (primary || language),
    };
  } catch {
    return { country: '', language: String(state.language || 'en').toLowerCase(), locale: '', timeZone: '', reason: '' };
  }
}

function shouldShowPersonalRecoBanner() {
  if (state.mode !== 'feed') return false;
  if (String(state.q || '').trim()) return false;
  if (Array.isArray(state.topicQs) && state.topicQs.length) return false;
  if (String(state.topicQ || '').trim()) return false;
  if (state.trendClusterId) return false;
  return true;
}

function removePersonalRecoBanner() {
  try { document.getElementById('personalRecoBanner')?.remove(); } catch {}
}

function buildPersonalRecoCacheKey(profile) {
  const interests = (state.interests || []).slice().sort().join(',');
  const ui = String(state.language || 'en').toLowerCase();
  const stateCountry = String(state.country || 'world').toLowerCase();
  const browserCountry = String(profile?.country || '').toLowerCase();
  return `${interests}|ui=${ui}|state=${stateCountry}|browser=${browserCountry}`;
}

async function ensurePersonalRecoItems(currentItems) {
  if (!shouldShowPersonalRecoBanner()) {
    removePersonalRecoBanner();
    return [];
  }

  const profile = inferBrowserAudienceProfile();
  const targetCountry = String(profile?.country || '').toLowerCase();
  if (!targetCountry || targetCountry === 'world') {
    removePersonalRecoBanner();
    return [];
  }

  const cacheKey = buildPersonalRecoCacheKey(profile);
  if (__personalRecoCache.key === cacheKey && Array.isArray(__personalRecoCache.items) && __personalRecoCache.items.length) {
    return __personalRecoCache.items;
  }
  if (__personalRecoCache.loadingPromise && __personalRecoCache.key === cacheKey) {
    return __personalRecoCache.loadingPromise;
  }

  const requestUrl = `${API_BASE}/api/news?interests=${encodeURIComponent((state.interests || []).join(','))}` +
    `&country=${encodeURIComponent(targetCountry)}` +
    `&language=all&ui_lang=${encodeURIComponent(state.language || 'en')}` +
    `&limit=${PERSONAL_RECO_ENDPOINT_LIMIT}`;

  const currentIds = new Set((Array.isArray(currentItems) ? currentItems : []).map((it) => getItemId(it)).filter(Boolean));

  const promise = fetch(requestUrl)
    .then((res) => {
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      return res.json();
    })
    .then((data) => {
      const fetched = Array.isArray(data?.items) ? data.items : [];
      const picked = pickPersonalRecoItems(fetched, currentIds, profile);
      __personalRecoCache = {
        key: cacheKey,
        items: picked,
        profile,
        fetchedAt: Date.now(),
        loadingPromise: null,
      };
      return picked;
    })
    .catch((err) => {
      console.warn('[feed] personal recommendations failed', err);
      __personalRecoCache = {
        key: cacheKey,
        items: [],
        profile,
        fetchedAt: Date.now(),
        loadingPromise: null,
      };
      return [];
    });

  __personalRecoCache = {
    key: cacheKey,
    items: __personalRecoCache.items || [],
    profile,
    fetchedAt: __personalRecoCache.fetchedAt || 0,
    loadingPromise: promise,
  };

  return promise;
}

function buildPersonalRecoAction(item) {
  const id = getItemId(item) || String(item?.id || '').trim();
  const normalizedTitle = (typeof window.__checkneNormalizeStoryTitle === 'function')
    ? window.__checkneNormalizeStoryTitle(String(item?.title || ''))
    : String(item?.title || '').trim().toLowerCase();
  const targetCountry = String(item?.country || '').trim().toLowerCase();

  if (id) {
    const escapedId = (typeof CSS !== 'undefined' && typeof CSS.escape === 'function') ? CSS.escape(String(id)) : String(id).replace(/"/g, '\\"');
    const cardExists = !!document.querySelector(`.newsCard[data-id="${escapedId}"]`);
    return {
      type: 'story',
      targetId: String(id),
      title: String(item?.title || ''),
      normalizedTitle,
      targetCountry,
      inFeed: cardExists,
    };
  }

  const source = Array.isArray(item?.sources) && item.sources.length ? item.sources[0] : null;
  const rawUrl = String(source?.url || '').trim();
  if (rawUrl) {
    return {
      type: 'source',
      href: buildSourceReaderUrl(rawUrl, String(source?.title || item?.title || rawUrl), String(source?.source_name || pickPrimarySourceName(item) || 'unknown')),
    };
  }
  return { type: 'source', href: '#' };
}

function getPersonalRecoInsertIndex(items) {
  const list = Array.isArray(items) ? items : [];
  if (!list.length) return 0;
  return Math.max(0, Math.min(PERSONAL_RECO_INSERT_AFTER, list.length));
}

async function fetchPersonalRecoStoryById(targetId, opts = {}) {
  const id = String(targetId || '').trim();
  if (!id) return null;
  try {
    const interests = encodeURIComponent((state.interests || []).join(','));
    const preferredCountry = String(opts?.preferredCountry || '').trim().toLowerCase();
    const country = encodeURIComponent(preferredCountry || state.country || 'world');
    const uiLang = encodeURIComponent(state.language || 'en');
    const res = await fetch(
      `${API_BASE}/api/news/by_ids?ids=${encodeURIComponent(id)}` +
      `&interests=${interests}&country=${country}&language=all&ui_lang=${uiLang}${buildGuestPreviewIdsQuery()}`
    );
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const data = await res.json();
    const items = Array.isArray(data?.items) ? data.items : [];
    return items.find((it) => String(getItemId(it) || it?.id || '').trim() === id) || items[0] || null;
  } catch (err) {
    console.warn('[feed] reco story fetch failed', err);
    return null;
  }
}

async function forceOpenPersonalRecoStory(targetId, normalizedTitle, opts = {}) {
  const id = String(targetId || '').trim();
  const titleNorm = String(normalizedTitle || '').trim();
  const preferredCountry = String(opts?.preferredCountry || '').trim().toLowerCase();
  if (!id && !titleNorm) return false;

  const directOpen = (() => {
    try {
      if (typeof window.__checkneFindCardInFeed === 'function' && typeof window.__checkneOpenCardElement === 'function') {
        const found = window.__checkneFindCardInFeed({ clusterId: id || null, title: '', allowLooseTitleMatch: false });
        if (found) return window.__checkneOpenCardElement(found);
      }
    } catch {}
    return false;
  })();
  if (directOpen) return true;

  const existing = Array.isArray(lastFeedItems) ? lastFeedItems : [];
  const inMemory = existing.find((it) => String(getItemId(it) || it?.id || '').trim() === id) || null;
  const item = inMemory || await fetchPersonalRecoStoryById(id, { preferredCountry });
  if (!item) {
    logRecoStoryDiagnostic('story-fetch-returned-empty', { id, normalizedTitle: titleNorm, preferredCountry });
    return false;
  }

  const itemId = String(getItemId(item) || item?.id || id).trim();
  const withoutExact = existing.filter((it) => String(getItemId(it) || it?.id || '').trim() !== itemId);
  const insertIndex = getPersonalRecoInsertIndex(withoutExact);
  const merged = [
    ...withoutExact.slice(0, insertIndex),
    item,
    ...withoutExact.slice(insertIndex),
  ];

  lastFeedItems = merged;
  renderCards(merged, {
    nowTs: Date.now(),
    newIds: new Set(),
    suppressNewBadges: true,
    incremental: false,
    animate: false,
  });

  await new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)));

  let opened = false;
  try {
    if (typeof window.__checkneFindCardInFeed === 'function' && typeof window.__checkneOpenCardElement === 'function') {
      const exact = window.__checkneFindCardInFeed({ clusterId: itemId, title: '', allowLooseTitleMatch: false });
      if (exact) opened = window.__checkneOpenCardElement(exact);
    }
  } catch {}
  if (!opened) {
    opened = focusNewsCardById(itemId, { open: true, block: 'center', maxAttempts: 14, delayMs: 120 });
  }
  return !!opened;
}

function normalizeStoryCountry(country) {
  const value = String(country || '').trim().toLowerCase();
  if (!value || value === 'all') return '';
  return value;
}

async function switchFeedCountryForPersonalReco(targetCountry) {
  const desired = normalizeStoryCountry(targetCountry);
  if (!desired || desired === 'world' || desired === String(state.country || '').trim().toLowerCase()) {
    return false;
  }

  state.country = desired;
  try { if (typeof syncDropdownsFromState === 'function') syncDropdownsFromState(); } catch {}
  try { if (typeof savePrefs === 'function') savePrefs(); } catch {}
  try { if (typeof resetFeedAutoLoadState === 'function') resetFeedAutoLoadState(); } catch {}
  try { if (typeof setFeedExpanded === 'function') setFeedExpanded(false); } catch {}
  await fetchFeed({ reset: true });
  await new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)));
  return true;
}

async function ensurePersonalRecoOpenContext() {
  try {
    if (typeof window.__navigate === 'function' && window.location && window.location.pathname !== '/') {
      window.__navigate('/');
    } else if (typeof window.__setMainPage === 'function') {
      window.__setMainPage('feed');
    }
  } catch {}

  try {
    if (typeof switchMode === 'function' && state.mode !== 'feed') {
      await switchMode('feed');
    }
  } catch {}

  await new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)));
}

async function openPersonalRecoStoryAction(targetId, normalizedTitle, targetCountry) {
  const desired = normalizeStoryCountry(targetCountry);
  const id = String(targetId || '').trim();
  const titleNorm = String(normalizedTitle || '').trim();

  setPendingStoryFocus({
    id,
    normalizedTitle: titleNorm,
    title: String(titleNorm || ''),
    country: desired,
    reason: 'personal-reco-banner',
  });
  logRecoStoryDiagnostic('click', {
    id,
    normalizedTitle: titleNorm,
    targetCountry: desired,
    currentCountry: String(state.country || '').trim().toLowerCase(),
    mode: String(state.mode || ''),
  });

  await ensurePersonalRecoOpenContext();

  if (desired && desired !== 'world' && desired !== String(state.country || '').trim().toLowerCase()) {
    await switchFeedCountryForPersonalReco(desired);
  }

  try {
    if (typeof window.openStoryInFeed === 'function') {
      const openedViaCore = await window.openStoryInFeed({ clusterId: id || null, title: titleNorm, exactTitleOnly: true, allowLooseTitleMatch: false });
      if (openedViaCore) return true;
    }
  } catch (err) {
    console.warn('[feed] reco story open via core failed', err);
  }

  const openedViaBannerFlow = await forceOpenPersonalRecoStory(id, titleNorm, { preferredCountry: desired });
  if (openedViaBannerFlow) return true;

  tryResolvePendingStoryFocus({ context: 'after-force-open' });

  try {
    await fetchFeed({ reset: true, reason: 'reco-story-refetch' });
    await new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)));
    if (typeof window.openStoryInFeed === 'function') {
      const openedAfterRefetch = !!(await window.openStoryInFeed({ clusterId: id || null, title: titleNorm, exactTitleOnly: true, allowLooseTitleMatch: false }));
      if (openedAfterRefetch) return true;
    }
  } catch (err) {
    console.warn('[feed] reco story open after refetch failed', err);
  }

  logRecoStoryDiagnostic('open-failed', { id, normalizedTitle: titleNorm, targetCountry: desired });
  clearPendingStoryFocus('open-failed');
  return false;
}

function createPersonalRecoBanner(items) {
  const profile = __personalRecoCache.profile || inferBrowserAudienceProfile();
  const banner = document.createElement('section');
  banner.className = 'personalRecoBanner';
  banner.id = 'personalRecoBanner';

  const browserCountry = String(profile?.country || '').toUpperCase() || 'YOUR REGION';
  const currentCountry = String(state.country || 'world').toUpperCase();
  const regionBadge = currentCountry !== browserCountry && browserCountry !== 'YOUR REGION'
    ? `${browserCountry} picks`
    : 'Smart picks';
  const reasonText = profile?.reason
    ? `Based on your browser region — ${profile.reason}`
    : 'Based on your browser region and interests';

  const cardsHtml = (Array.isArray(items) ? items : []).slice(0, PERSONAL_RECO_MAX_ITEMS).map((item, idx) => {
    const title = escapeHtml(String(item?.title || 'Story'));
    const source = escapeHtml(String(pickPrimarySourceName(item) || item?.topic || 'Recommended'));
    const topic = escapeHtml(String(item?.topic || 'general'));
    const thumb = (() => {
      try {
        const url = String(getNewsImage(item, 'thumb') || getNewsImage(item, 'card') || '').trim();
        if (!url) return `<div class="personalRecoItem__thumb" data-image-state="empty"><span>No image</span></div>`;
        return `<div class="personalRecoItem__thumb"><img src="${escapeHtml(url)}" alt="" loading="lazy" onerror="this.closest('.personalRecoItem__thumb')?.setAttribute('data-image-state','empty'); this.remove();" /></div>`;
      } catch {
        return `<div class="personalRecoItem__thumb" data-image-state="empty"><span>No image</span></div>`;
      }
    })();
    const action = buildPersonalRecoAction(item);
    const attr = action.type === 'story'
      ? `data-action="story" data-target-id="${escapeHtml(String(action.targetId || ''))}" data-title-normalized="${escapeHtml(String(action.normalizedTitle || ''))}" data-title="${escapeHtml(String(action.title || item?.title || ''))}" data-target-country="${escapeHtml(String(action.targetCountry || item?.country || ''))}"`
      : `data-action="source" data-href="${escapeHtml(String(action.href || '#'))}"`;
    const actionLabel = action.type === 'story'
      ? (action.inFeed ? 'Open story' : 'Load story')
      : 'Read story';
    const actionClass = action.type === 'story'
      ? (action.inFeed ? 'isSecondary' : 'isPrimary')
      : 'isPrimary';
    const metaBits = [source, topic.toUpperCase()];
    if (item?.country) metaBits.push(escapeHtml(String(item.country).toUpperCase()));
    return `
      <article class="personalRecoItem">
        ${thumb}
        <div class="personalRecoItem__body">
          <div class="personalRecoItem__eyebrow">${idx === 0 ? 'Top match' : 'Recommended'}</div>
          <div class="personalRecoItem__title">${title}</div>
          <div class="personalRecoItem__meta">${metaBits.join(' · ')}</div>
          <button type="button" class="personalRecoItem__action ${actionClass}" ${attr}>
            <span class="personalRecoItem__actionLabel">${actionLabel}</span>
            <span class="personalRecoItem__actionIcon" aria-hidden="true">→</span>
          </button>
        </div>
      </article>`;
  }).join('');

  banner.innerHTML = `
    <div class="personalRecoBanner__glow" aria-hidden="true"></div>
    <div class="personalRecoBanner__head">
      <div>
        <div class="personalRecoBanner__kicker">You may be interested</div>
        <div class="personalRecoBanner__title">Personalized stories beyond your current feed</div>
        <div class="personalRecoBanner__sub">${escapeHtml(reasonText)}</div>
      </div>
      <div class="personalRecoBanner__badges">
        <span class="personalRecoBanner__badge isPrimary">${escapeHtml(regionBadge)}</span>
        <span class="personalRecoBanner__badge">${escapeHtml(String((state.interests || ['general']).join(' · ') || 'general'))}</span>
      </div>
    </div>
    <div class="personalRecoBanner__swipeHint" aria-hidden="true">Swipe for more →</div>
    <div class="personalRecoBanner__grid">${cardsHtml}</div>
  `;

  banner.addEventListener('click', async (event) => {
    const btn = event.target.closest('.personalRecoItem__action');
    if (!btn) return;
    const action = String(btn.getAttribute('data-action') || '').trim();
    if (action === 'story') {
      const targetId = String(btn.getAttribute('data-target-id') || '').trim();
      const normalizedTitle = String(btn.getAttribute('data-title-normalized') || '').trim();
      const targetCountry = String(btn.getAttribute('data-target-country') || '').trim().toLowerCase();
      btn.disabled = true;
      btn.classList.add('isLoading');
      setStoryOpenOverlay(true);
      try {
        const opened = await openPersonalRecoStoryAction(targetId, normalizedTitle, targetCountry);
        if (!opened) {
          console.warn('[feed] reco story open failed', { targetId, normalizedTitle });
        }
      } finally {
        await new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)));
        btn.disabled = false;
        btn.classList.remove('isLoading');
        setStoryOpenOverlay(false);
      }
      return;
    }
    const href = String(btn.getAttribute('data-href') || '').trim();
    if (href && href !== '#') {
      window.open(href, '_blank', 'noopener,noreferrer');
    }
  });

  return banner;
}

async function syncPersonalRecoBanner(currentItems) {
  const cards = qs('cards');
  if (!cards) return;
  removePersonalRecoBanner();
  if (!shouldShowPersonalRecoBanner()) return;

  const renderedCards = Array.from(cards.querySelectorAll('.newsCard'));
  if (renderedCards.length <= PERSONAL_RECO_INSERT_AFTER) return;

  const items = await ensurePersonalRecoItems(currentItems);
  if (!Array.isArray(items) || !items.length) return;

  const anchor = renderedCards[PERSONAL_RECO_INSERT_AFTER];
  const banner = createPersonalRecoBanner(items);
  if (anchor) cards.insertBefore(banner, anchor);
  else cards.appendChild(banner);
}

function buildSourceReaderUrl(rawUrl, title, source) {
  const safeUrl = String(rawUrl || '').trim();
  if (!safeUrl) return '#';
  return `/api/source/go?url=${encodeURIComponent(safeUrl)}&title=${encodeURIComponent(String(title || safeUrl))}&source=${encodeURIComponent(String(source || 'unknown'))}`;
}



function setImgFallback(imgEl) {
  if (!imgEl) return;
  // Avoid infinite loops
  if (imgEl.dataset.fallbackStage === 'placeholder') return;
  imgEl.dataset.fallbackStage = 'placeholder';
  const svg = `
    <svg xmlns='http://www.w3.org/2000/svg' width='1200' height='800'>
      <rect width='100%' height='100%' fill='#e9e9ee'/>
      <text x='50%' y='50%' dominant-baseline='middle' text-anchor='middle'
        fill='#8a8a96' font-family='system-ui, -apple-system, Segoe UI, Roboto, Arial' font-size='28'>
        No related image available
      </text>
    </svg>`;
  imgEl.src = "data:image/svg+xml;charset=utf-8," + encodeURIComponent(svg);
}


function getItemId(it) {
  const id = it?.cluster_id ?? it?.event_id;
  return id == null ? '' : String(id);
}

let __feedRequestSeq = 0;
let __feedActiveAbortController = null;
let __pendingStoryFocus = null;

let __storyOpenOverlayCount = 0;

function setStoryOpenOverlay(active) {
  try {
    const body = document.body;
    if (!body) return;
    if (active) {
      __storyOpenOverlayCount += 1;
      body.classList.add('story-opening');
      return;
    }
    __storyOpenOverlayCount = Math.max(0, __storyOpenOverlayCount - 1);
    if (__storyOpenOverlayCount === 0) {
      body.classList.remove('story-opening');
    }
  } catch {}
}


function logRecoStoryDiagnostic(stage, payload = {}) {
  try {
    console.info('[feed][load-story]', stage, payload);
  } catch {}
}

function setPendingStoryFocus(target = {}) {
  const id = String(target?.id || '').trim();
  const normalizedTitle = String(target?.normalizedTitle || '').trim();
  if (!id && !normalizedTitle) return null;
  __pendingStoryFocus = {
    id,
    normalizedTitle,
    title: String(target?.title || '').trim(),
    country: String(target?.country || '').trim().toLowerCase(),
    createdAt: Date.now(),
    attempts: 0,
    reason: String(target?.reason || 'load-story').trim(),
  };
  logRecoStoryDiagnostic('pending-focus-set', __pendingStoryFocus);
  return __pendingStoryFocus;
}

function clearPendingStoryFocus(reason = '') {
  if (!__pendingStoryFocus) return;
  logRecoStoryDiagnostic('pending-focus-clear', {
    reason,
    id: __pendingStoryFocus.id,
    normalizedTitle: __pendingStoryFocus.normalizedTitle,
  });
  __pendingStoryFocus = null;
}

function getPendingStoryFocus() {
  if (!__pendingStoryFocus) return null;
  if ((Date.now() - Number(__pendingStoryFocus.createdAt || 0)) > 30000) {
    clearPendingStoryFocus('expired');
    return null;
  }
  return __pendingStoryFocus;
}

function ensurePendingStoryIncluded(items, filtered) {
  const pending = getPendingStoryFocus();
  const allItems = Array.isArray(items) ? items : [];
  const current = Array.isArray(filtered) ? filtered.slice() : [];
  if (!pending || (!pending.id && !pending.normalizedTitle)) return current;
  const id = String(pending.id || '').trim();
  const normalizedTitle = String(pending.normalizedTitle || '').trim();
  const matchesPending = (it) => {
    const itemId = String(getItemId(it) || it?.id || '').trim();
    if (id && itemId === id) return true;
    if (normalizedTitle && typeof window.__checkneNormalizeStoryTitle === 'function') {
      return window.__checkneNormalizeStoryTitle(String(it?.title || '')) === normalizedTitle;
    }
    return false;
  };
  if (current.some(matchesPending)) return current;
  const match = allItems.find(matchesPending);
  if (!match) return current;
  logRecoStoryDiagnostic('pending-focus-injected-into-render', { id, normalizedTitle });
  return [match, ...current];
}

function tryResolvePendingStoryFocus(opts = {}) {
  const pending = getPendingStoryFocus();
  if (!pending) return false;
  pending.attempts = Number(pending.attempts || 0) + 1;
  const id = String(pending.id || '').trim();
  const normalizedTitle = String(pending.normalizedTitle || '').trim();
  let card = null;
  try {
    if (typeof window.__checkneFindCardInFeed === 'function') {
      card = window.__checkneFindCardInFeed({
        clusterId: id || null,
        title: pending.title || '',
        exactTitleOnly: true,
        allowLooseTitleMatch: false,
      });
    }
  } catch {}
  if (!card) {
    logRecoStoryDiagnostic('pending-focus-dom-miss', {
      id,
      normalizedTitle,
      attempt: pending.attempts,
      context: String(opts?.context || ''),
    });
    return false;
  }
  let opened = false;
  try {
    if (typeof window.__checkneOpenCardElement === 'function') opened = window.__checkneOpenCardElement(card);
  } catch {}
  if (!opened && id) {
    opened = focusNewsCardById(id, { open: true, block: 'center', maxAttempts: 1, delayMs: 40 });
  }
  if (opened) {
    clearPendingStoryFocus('resolved');
    logRecoStoryDiagnostic('pending-focus-resolved', {
      id,
      normalizedTitle,
      attempt: pending.attempts,
      context: String(opts?.context || ''),
    });
    return true;
  }
  logRecoStoryDiagnostic('pending-focus-open-failed', { id, normalizedTitle, attempt: pending.attempts });
  return false;
}


function centerNewsCardInViewport(card, opts = {}) {
  if (!card) return false;
  const behavior = opts.behavior === 'auto' ? 'auto' : 'smooth';
  const extraOffset = Number.isFinite(Number(opts.offsetY)) ? Number(opts.offsetY) : 0;
  const settlePasses = Number.isFinite(Number(opts.settlePasses)) ? Number(opts.settlePasses) : 3;
  const settleDelayMs = Number.isFinite(Number(opts.settleDelayMs)) ? Number(opts.settleDelayMs) : 120;

  const scrollOnce = (scrollBehavior) => {
    const rect = card.getBoundingClientRect();
    const viewportHeight = window.innerHeight || document.documentElement.clientHeight || 0;
    const absoluteTop = window.pageYOffset + rect.top;
    const targetTop = Math.max(0, absoluteTop - Math.max(0, (viewportHeight - rect.height) / 2) - extraOffset);
    try {
      window.scrollTo({ top: targetTop, behavior: scrollBehavior, left: window.pageXOffset || 0 });
      return true;
    } catch {
      try {
        card.scrollIntoView({ behavior: scrollBehavior, block: 'center', inline: 'nearest' });
        return true;
      } catch {
        try { card.scrollIntoView(); } catch {}
      }
    }
    return false;
  };

  scrollOnce(behavior);
  for (let i = 1; i <= settlePasses; i += 1) {
    setTimeout(() => { try { scrollOnce('auto'); } catch {} }, settleDelayMs * i);
  }
  return true;
}
try { window.__checkneCenterNewsCardInViewport = centerNewsCardInViewport; } catch {}

function focusNewsCardById(cardId, opts = {}) {
  const id = String(cardId || '').trim();
  if (!id) return false;
  const maxAttempts = Number.isFinite(Number(opts.maxAttempts)) ? Number(opts.maxAttempts) : 24;
  const delayMs = Number.isFinite(Number(opts.delayMs)) ? Number(opts.delayMs) : 120;
  const shouldOpen = opts.open !== false;

  let attempts = 0;
  const run = () => {
    const card = document.querySelector(`.newsCard[data-id="${id}"], .newsCard[data-cluster-id="${id}"]`);
    if (!card) {
      if (attempts++ >= maxAttempts) return;
      setTimeout(run, delayMs);
      return;
    }

    const details = card.querySelector('details.newsDetails');
    const wasClosed = !!(details && !details.open);
    if (details && shouldOpen && !details.open) {
      try { details.open = true; } catch {}
    }

    centerNewsCardInViewport(card, {
      behavior: 'smooth',
      settlePasses: wasClosed ? 5 : 3,
      settleDelayMs: wasClosed ? 140 : 100,
    });

    card.classList.remove('newsCardFocusPulse');
    void card.offsetWidth;
    card.classList.add('newsCardFocusPulse');
    setTimeout(() => {
      try { card.classList.remove('newsCardFocusPulse'); } catch {}
    }, 1800);
  };

  run();
  return true;
}
try { window.focusNewsCardById = focusNewsCardById; } catch {}

function countRenderedNewsCards() {
  const cards = qs('cards');
  if (!cards) return 0;
  return cards.querySelectorAll('.newsCard').length;
}

function __feedSafeLower(value) {
  return String(value || '').trim().toLowerCase();
}

const __COUNTRY_META = [
  { code: 'UA', label: 'Ukraine', aliases: ['ukraine', 'ukrainian', 'kyiv', 'kiev', 'zelensky', 'zelenskyy'] },
  { code: 'IL', label: 'Israel', aliases: ['israel', 'israeli', 'netanyahu'] },
  { code: 'LB', label: 'Lebanon', aliases: ['lebanon', 'lebanese', 'beirut'] },
  { code: 'DE', label: 'Germany', aliases: ['germany', 'german', 'berlin'] },
  { code: 'FR', label: 'France', aliases: ['france', 'french', 'paris'] },
  { code: 'GB', label: 'United Kingdom', aliases: ['united kingdom', 'britain', 'british', 'uk', 'u.k.', 'england', 'english', 'scotland', 'scottish', 'wales', 'welsh', 'london'] },
  { code: 'US', label: 'USA', aliases: ['united states', 'united states of america', 'usa', 'u.s.', 'american', 'america', 'washington', 'white house', 'trump', 'biden'] },
  { code: 'RU', label: 'Russia', aliases: ['russia', 'russian', 'moscow', 'kremlin', 'putin'] },
  { code: 'CN', label: 'China', aliases: ['china', 'chinese', 'beijing', 'xi jinping'] },
  { code: 'IR', label: 'Iran', aliases: ['iran', 'iranian', 'tehran'] },
  { code: 'PS', label: 'Palestine', aliases: ['palestine', 'palestinian', 'gaza', 'west bank'] },
  { code: 'SY', label: 'Syria', aliases: ['syria', 'syrian', 'damascus'] },
  { code: 'TR', label: 'Turkey', aliases: ['turkey', 'turkish', 'ankara', 'istanbul'] },
  { code: 'SA', label: 'Saudi Arabia', aliases: ['saudi arabia', 'saudi', 'riyadh'] },
  { code: 'AE', label: 'UAE', aliases: ['united arab emirates', 'uae', 'abu dhabi', 'dubai'] },
  { code: 'JP', label: 'Japan', aliases: ['japan', 'japanese', 'tokyo'] },
  { code: 'KR', label: 'South Korea', aliases: ['south korea', 'korean', 'seoul'] },
  { code: 'KP', label: 'North Korea', aliases: ['north korea', 'pyongyang', 'kim jong un'] },
  { code: 'IN', label: 'India', aliases: ['india', 'indian', 'new delhi'] },
  { code: 'PK', label: 'Pakistan', aliases: ['pakistan', 'pakistani', 'islamabad'] },
  { code: 'AF', label: 'Afghanistan', aliases: ['afghanistan', 'afghan', 'kabul'] },
  { code: 'IT', label: 'Italy', aliases: ['italy', 'italian', 'rome'] },
  { code: 'ES', label: 'Spain', aliases: ['spain', 'spanish', 'madrid'] },
  { code: 'PT', label: 'Portugal', aliases: ['portugal', 'portuguese', 'lisbon'] },
  { code: 'NL', label: 'Netherlands', aliases: ['netherlands', 'dutch', 'amsterdam', 'hague'] },
  { code: 'BE', label: 'Belgium', aliases: ['belgium', 'belgian', 'brussels'] },
  { code: 'CH', label: 'Switzerland', aliases: ['switzerland', 'swiss', 'geneva', 'zurich'] },
  { code: 'AT', label: 'Austria', aliases: ['austria', 'austrian', 'vienna'] },
  { code: 'SE', label: 'Sweden', aliases: ['sweden', 'swedish', 'stockholm'] },
  { code: 'NO', label: 'Norway', aliases: ['norway', 'norwegian', 'oslo'] },
  { code: 'DK', label: 'Denmark', aliases: ['denmark', 'danish', 'copenhagen'] },
  { code: 'FI', label: 'Finland', aliases: ['finland', 'finnish', 'helsinki'] },
  { code: 'PL', label: 'Poland', aliases: ['poland', 'polish', 'warsaw'] },
  { code: 'CZ', label: 'Czech Republic', aliases: ['czech republic', 'czech', 'prague'] },
  { code: 'RO', label: 'Romania', aliases: ['romania', 'romanian', 'bucharest'] },
  { code: 'HU', label: 'Hungary', aliases: ['hungary', 'hungarian', 'budapest'] },
  { code: 'GR', label: 'Greece', aliases: ['greece', 'greek', 'athens'] },
  { code: 'IE', label: 'Ireland', aliases: ['ireland', 'irish', 'dublin'] },
  { code: 'CA', label: 'Canada', aliases: ['canada', 'canadian', 'ottawa', 'toronto'] },
  { code: 'MX', label: 'Mexico', aliases: ['mexico', 'mexican', 'mexico city'] },
  { code: 'BR', label: 'Brazil', aliases: ['brazil', 'brazilian', 'brasil', 'rio de janeiro', 'sao paulo'] },
  { code: 'AR', label: 'Argentina', aliases: ['argentina', 'argentinian', 'buenos aires'] },
  { code: 'CL', label: 'Chile', aliases: ['chile', 'chilean', 'santiago'] },
  { code: 'CO', label: 'Colombia', aliases: ['colombia', 'colombian', 'bogota'] },
  { code: 'VE', label: 'Venezuela', aliases: ['venezuela', 'venezuelan', 'caracas'] },
  { code: 'AU', label: 'Australia', aliases: ['australia', 'australian', 'sydney', 'melbourne', 'canberra'] },
  { code: 'NZ', label: 'New Zealand', aliases: ['new zealand', 'new zealander', 'wellington', 'auckland'] },
  { code: 'ZA', label: 'South Africa', aliases: ['south africa', 'south african', 'cape town', 'johannesburg'] },
  { code: 'EG', label: 'Egypt', aliases: ['egypt', 'egyptian', 'cairo'] },
  { code: 'NG', label: 'Nigeria', aliases: ['nigeria', 'nigerian', 'abuja', 'lagos'] },
  { code: 'KE', label: 'Kenya', aliases: ['kenya', 'kenyan', 'nairobi'] },
  { code: 'ET', label: 'Ethiopia', aliases: ['ethiopia', 'ethiopian', 'addis ababa'] },
  { code: 'SD', label: 'Sudan', aliases: ['sudan', 'sudanese', 'khartoum'] },
  { code: 'IQ', label: 'Iraq', aliases: ['iraq', 'iraqi', 'baghdad'] },
  { code: 'QA', label: 'Qatar', aliases: ['qatar', 'qatari', 'doha'] },
];

const __COUNTRY_BY_ALIAS = (() => {
  const map = new Map();
  for (const meta of __COUNTRY_META) {
    map.set(meta.code.toLowerCase(), meta);
    map.set(meta.label.toLowerCase(), meta);
    for (const alias of meta.aliases) map.set(String(alias).toLowerCase(), meta);
  }
  map.set('fr', map.get('france'));
  map.set('de', map.get('germany'));
  map.set('ua', map.get('ukraine'));
  map.set('us', map.get('usa'));
  map.set('gb', map.get('united kingdom'));
  map.set('uk', map.get('united kingdom'));
  map.set('world', { code: 'WORLD', label: 'World', emoji: '🌍' });
  map.set('global', { code: 'WORLD', label: 'World', emoji: '🌍' });
  map.set('international', { code: 'WORLD', label: 'World', emoji: '🌍' });
  map.set('europe', { code: 'EU', label: 'Europe', emoji: '🇪🇺' });
  return map;
})();

function __countryFlagFromCode(code) {
  const cc = String(code || '').trim().toUpperCase();
  if (!/^[A-Z]{2}$/.test(cc)) return '';
  return String.fromCodePoint(...Array.from(cc).map((ch) => 127397 + ch.charCodeAt(0)));
}

function normalizeCountryDisplay(rawValue) {
  const raw = String(rawValue || '').trim();
  if (!raw) return { code: 'WORLD', label: 'World', emoji: '🌍' };
  const lower = raw.toLowerCase();
  const direct = __COUNTRY_BY_ALIAS.get(lower);
  if (direct) {
    return {
      code: String(direct.code || '').toUpperCase() || 'WORLD',
      label: String(direct.label || raw).trim() || raw,
      emoji: direct.emoji || __countryFlagFromCode(direct.code),
    };
  }
  if (/^[A-Za-z]{2}$/.test(raw)) {
    const cc = raw.toUpperCase();
    return { code: cc, label: cc, emoji: __countryFlagFromCode(cc) };
  }
  return { code: '', label: raw, emoji: '' };
}

function __escapeCountryRegex(value) {
  return String(value || '').replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function __countryRegexes(meta) {
  const patterns = [];
  for (const alias of (meta?.aliases || [])) {
    const norm = String(alias || '').trim();
    if (!norm) continue;
    const escaped = __escapeCountryRegex(norm).replace(/\s+/g, '\\s+');
    patterns.push(new RegExp(`\\b${escaped}\\b`, 'i'));
  }
  if (meta?.code === 'US') {
    patterns.push(/\bUS\b/);
    patterns.push(/\bU\.S\.A?\.?\b/i);
  }
  if (meta?.code === 'GB') {
    patterns.push(/\bUK\b/);
    patterns.push(/\bU\.K\.\b/i);
  }
  return patterns;
}

function inferCountryDisplay(item) {
  const base = normalizeCountryDisplay(item?.country || '');
  const chunks = [
    { text: String(item?.title || ''), weight: 12, titleBias: 3 },
    { text: String(item?.summary || ''), weight: 5, titleBias: 0 },
    ...(Array.isArray(item?.sources)
      ? item.sources.slice(0, 6).map((s, idx) => ({ text: String(s?.title || ''), weight: Math.max(5 - idx, 2), titleBias: 0 }))
      : []),
  ].filter((x) => String(x?.text || '').trim());

  const scores = new Map();

  for (const meta of __COUNTRY_META) {
    const regexes = __countryRegexes(meta);
    let score = 0;
    let pos = Number.POSITIVE_INFINITY;
    for (const chunk of chunks) {
      const raw = String(chunk?.text || '');
      if (!raw) continue;
      for (const rx of regexes) {
        rx.lastIndex = 0;
        const m = rx.exec(raw);
        if (!m) continue;
        score += Number(chunk?.weight || 0) + Number(chunk?.titleBias || 0);
        if (typeof m.index === 'number') pos = Math.min(pos, m.index);
        break;
      }
    }
    if (score > 0) scores.set(meta.code, { meta, score, pos });
  }

  const baseScore = scores.get(base.code)?.score || 0;
  let best = null;
  for (const entry of scores.values()) {
    if (!best || entry.score > best.score || (entry.score === best.score && entry.pos < best.pos)) {
      best = entry;
    }
  }

  if (best?.meta) {
    const shouldOverrideBase = !base.code || base.code === 'WORLD' || base.code === 'EU' || baseScore === 0 || best.score >= (baseScore + 3);
    if (shouldOverrideBase) {
      return {
        code: best.meta.code,
        label: best.meta.label,
        emoji: __countryFlagFromCode(best.meta.code),
      };
    }
  }

  return base;
}

function formatCountryBadge(displayCountry) {
  const c = displayCountry || { label: 'World', emoji: '🌍' };
  const emoji = String(c?.emoji || '').trim();
  const label = String(c?.label || 'World').trim() || 'World';
  return `${emoji ? `${emoji} ` : ''}${label}`;
}

function getSortedSourcesForDisplay(item) {
  const list = Array.isArray(item?.sources) ? item.sources.slice() : [];
  list.sort((a, b) => {
    const ta = __sourceTimestampValue(a);
    const tb = __sourceTimestampValue(b);
    if (ta !== tb) return ta - tb;
    return String(a?.source_name || '').localeCompare(String(b?.source_name || ''));
  });
  return list;
}

function getFirstSourceName(item) {
  const sorted = getSortedSourcesForDisplay(item);
  const name = String(sorted[0]?.source_name || '').trim();
  if (name) return name;
  return String(item?.primary_source || '').trim() || 'Unknown';
}

function getSourceDomain(rawUrl) {
  try {
    const u = new URL(String(rawUrl || '').trim());
    return String(u.hostname || '').replace(/^www\./i, '').trim().toLowerCase();
  } catch {
    return '';
  }
}

function buildSourceLogoHtml(sourceName, rawUrl) {
  const label = String(sourceName || 'Unknown').trim() || 'Unknown';
  const domain = getSourceDomain(rawUrl);
  const fallback = escapeHtml(label.split(/\s+/).filter(Boolean).slice(0, 2).map((part) => part[0]?.toUpperCase() || '').join('') || label.slice(0, 2).toUpperCase());
  if (!domain) {
    return `<span class="sourceLogo sourceLogoFallback" aria-hidden="true">${fallback}</span>`;
  }
  const logoUrl = `https://www.google.com/s2/favicons?domain=${encodeURIComponent(domain)}&sz=64`;
  return `<span class="sourceLogo" aria-hidden="true"><img class="sourceLogoImg" src="${logoUrl}" alt="" loading="lazy" referrerpolicy="no-referrer" onerror="this.style.display='none'; this.parentElement.classList.add('isFallback'); const n=this.nextElementSibling; if(n){ n.style.display='inline-flex'; }" /><span class="sourceLogoFallbackInner" style="display:none">${fallback}</span></span>`;
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


function getScoreUiLocale() {
  const lang = String(I18N_LANG || localStorage.getItem('lang') || 'en').toLowerCase();
  if (lang.startsWith('de')) return 'de';
  if (lang.startsWith('fr')) return 'fr';
  return 'en';
}

function getScoreLocaleCopy() {
  const locale = getScoreUiLocale();
  const dict = {
    en: {
      outOf100: 'out of 100',
      ariaPrefix: 'Score',
      stable: 'Stable',
      recentSuffix: 'recently',
      pt: 'pt',
      pts: 'pts',
      labels: {
        s90: { label: 'Major story', shortLabel: 'Major story' },
        s80: { label: 'High impact', shortLabel: 'High impact' },
        s70: { label: 'Strong momentum', shortLabel: 'Strong momentum' },
        s55: { label: 'Developing', shortLabel: 'Developing' },
        s40: { label: 'Worth watching', shortLabel: 'Worth watching' },
        s25: { label: 'Low activity', shortLabel: 'Low activity' },
      },
    },
    de: {
      outOf100: 'von 100',
      ariaPrefix: 'Score',
      stable: 'Stabil',
      recentSuffix: 'zuletzt',
      pt: 'Pkt.',
      pts: 'Pkt.',
      labels: {
        s90: { label: 'Große Story', shortLabel: 'Große Story' },
        s80: { label: 'Hohe Wirkung', shortLabel: 'Hohe Wirkung' },
        s70: { label: 'Starke Dynamik', shortLabel: 'Starke Dynamik' },
        s55: { label: 'In Entwicklung', shortLabel: 'In Entwicklung' },
        s40: { label: 'Beobachtenswert', shortLabel: 'Beobachtenswert' },
        s25: { label: 'Geringe Aktivität', shortLabel: 'Geringe Aktivität' },
      },
    },
    fr: {
      outOf100: 'sur 100',
      ariaPrefix: 'Score',
      stable: 'Stable',
      recentSuffix: 'récemment',
      pt: 'pt',
      pts: 'pts',
      labels: {
        s90: { label: 'Sujet majeur', shortLabel: 'Sujet majeur' },
        s80: { label: 'Fort impact', shortLabel: 'Fort impact' },
        s70: { label: 'Forte dynamique', shortLabel: 'Forte dynamique' },
        s55: { label: 'En développement', shortLabel: 'En développement' },
        s40: { label: 'À surveiller', shortLabel: 'À surveiller' },
        s25: { label: 'Faible activité', shortLabel: 'Faible activité' },
      },
    },
  };
  return dict[locale] || dict.en;
}

function getStoryScoreMeta(item) {
  const score = clamp(
    item?.credibility_score ?? item?.credibility ?? item?.score ?? item?.rating ?? 0,
    0,
    100,
  );
  let tone = 's70';
  if (score >= 90) tone = 's90';
  else if (score >= 80) tone = 's80';
  else if (score >= 70) tone = 's70';
  else if (score >= 55) tone = 's55';
  else if (score >= 40) tone = 's40';
  else tone = 's25';
  const copy = getScoreLocaleCopy();
  const toneCopy = copy.labels?.[tone] || copy.labels?.s70 || { label: 'High signal', shortLabel: 'High signal' };
  return { score, tone, label: toneCopy.label, shortLabel: toneCopy.shortLabel, scaleLabel: copy.outOf100, ariaPrefix: copy.ariaPrefix };
}

function getStoryTrendMeta(item) {
  const delta = Number(item?.delta_score ?? item?.delta ?? item?.credibility_delta ?? 0);
  const copy = getScoreLocaleCopy();
  if (!Number.isFinite(delta) || delta === 0) return { delta: 0, text: copy.stable, dir: 'flat' };
  const dir = delta > 0 ? 'up' : 'down';
  const rounded = Math.abs(Math.round(delta));
  return {
    delta,
    dir,
    text: `${delta > 0 ? '+' : '−'}${rounded} ${rounded === 1 ? copy.pt : copy.pts} ${copy.recentSuffix}`,
  };
}

function buildWhyScoreFactors(item) {
  const sourcesCount = Number(item?.sources_count ?? (Array.isArray(item?.sources) ? item.sources.length : 0) ?? 0);
  const scoreMeta = getStoryScoreMeta(item);
  const trendMeta = getStoryTrendMeta(item);
  const impact = Number(item?.importance ?? scoreMeta.score ?? 0);
  const isTrending = !!item?.is_trending || trendMeta.dir === 'up' || scoreMeta.score >= 80;
  const firstTs = Date.parse(item?.created_at || item?.first_published_at || item?.latest_published_at || '') || NaN;
  const latestTs = Date.parse(item?.updated_at || item?.latest_published_at || item?.created_at || '') || NaN;
  const ageHours = Number.isFinite(firstTs) ? Math.max(0, (Date.now() - firstTs) / 36e5) : NaN;
  const freshnessHours = Number.isFinite(latestTs) ? Math.max(0, (Date.now() - latestTs) / 36e5) : NaN;
  const displayCountry = inferCountryDisplay(item);
  const displayLabel = String(displayCountry?.label || '').toLowerCase();
  const isGlobal = displayLabel === 'world' || displayLabel === 'global' || sourcesCount >= 8 || impact >= 78;

  const coverageWeight = Math.min(1, Math.max(0.12, sourcesCount / 10)) * 1.05;
  const velocityWeight = Math.min(1, Math.max(0.18, trendMeta.dir === 'up' ? 1 : (freshnessHours <= 6 ? 0.78 : 0.52))) * 0.95;
  const impactWeight = Math.min(1, Math.max(0.2, impact / 100)) * 1.15;
  const noveltyWeight = Math.min(1, Math.max(0.14, Number.isFinite(ageHours) && ageHours <= 8 ? 1 : (freshnessHours <= 6 ? 0.8 : 0.5))) * 0.85;
  const rawWeights = [coverageWeight, velocityWeight, impactWeight, noveltyWeight];
  const total = rawWeights.reduce((sum, n) => sum + n, 0) || 1;
  const rawPoints = rawWeights.map((w) => (scoreMeta.score * w) / total);
  const points = rawPoints.map((n) => Math.floor(n));
  let remainder = scoreMeta.score - points.reduce((sum, n) => sum + n, 0);
  rawPoints
    .map((n, idx) => ({ idx, frac: n - Math.floor(n) }))
    .sort((a, b) => b.frac - a.frac)
    .forEach((entry) => {
      if (remainder > 0) {
        points[entry.idx] += 1;
        remainder -= 1;
      }
    });

  const coverageText = sourcesCount >= 10
    ? 'Widely covered across major outlets.'
    : sourcesCount >= 5
      ? 'Covered by several outlets, giving the story broader weight.'
      : sourcesCount >= 2
        ? 'Appearing across multiple sources, but coverage is still building.'
        : 'Limited coverage so far, so the signal is still early.';
  const velocityText = trendMeta.dir === 'up'
    ? 'Rapidly developing, with attention rising right now.'
    : trendMeta.dir === 'down'
      ? 'Still active, but momentum has cooled slightly.'
      : isTrending
        ? 'Steady attention with ongoing developments.'
        : 'No sharp movement right now; the story is moving at a normal pace.';
  const impactText = isGlobal
    ? 'High global relevance with potential broader impact.'
    : impact >= 60
      ? 'Meaningful regional relevance with visible impact.'
      : 'More niche or local in scope right now.';
  const noveltyText = Number.isFinite(ageHours) && ageHours <= 8
    ? 'New story with fresh developments.'
    : Number.isFinite(freshnessHours) && freshnessHours <= 6
      ? 'Ongoing story with recent updates.'
      : 'Continuing story; attention is being sustained over time.';

  return [
    { name: 'Coverage', value: sourcesCount ? `${sourcesCount} sources` : 'Early signal', points: points[0], text: coverageText },
    { name: 'Velocity', value: trendMeta.dir === 'flat' ? 'Stable' : trendMeta.text, points: points[1], text: velocityText },
    { name: 'Impact', value: isGlobal ? 'Global' : 'Regional', points: points[2], text: impactText },
    { name: 'Novelty', value: (Number.isFinite(ageHours) && ageHours <= 8) ? 'New' : 'Ongoing', points: points[3], text: noveltyText },
  ];
}
function createCardElement(item, ctx, seen, idx) {
  const div = document.createElement('div');
  const id = Number(item.cluster_id ?? item.event_id);
  const idStr = String(id);
  div.setAttribute('data-id', idStr);
  div.setAttribute('data-title', String(item?.title || ''));
  try {
    const normalizedCardTitle = (typeof window.__checkneNormalizeStoryTitle === 'function')
      ? window.__checkneNormalizeStoryTitle(String(item?.title || ''))
      : String(item?.title || '').trim().toLowerCase();
    if (normalizedCardTitle) div.setAttribute('data-title-normalized', normalizedCardTitle);
  } catch {}

  const favOn = isFav(id);
  const sourcesCount = Number(item.sources_count ?? (item.sources ? item.sources.length : 0));

  // Be tolerant to backend/format changes (prevents showing 0/100 when the score exists under a different key)
  const scoreMeta = getStoryScoreMeta(item);
  const score = scoreMeta.score;
  const importance = clamp(item.importance ?? 0, 0, 100);
  const trendMeta = getStoryTrendMeta(item);

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
    ? (item.created_at || item.latest_published_at || item.updated_at)
    : (item.latest_published_at || item.updated_at || item.created_at);
  const metaAge = formatRelativeTimeFromNow(metaTime);
  const firstSourceName = getFirstSourceName(item);
  const displayCountry = inferCountryDisplay(item);
  const countryBadge = formatCountryBadge(displayCountry);
  const metaLabel = isNew ? t('ui.new', 'New') : t('ui.updated', 'Updated');
  const outletsLabel = t('feed.outlets', 'outlets');
  const metaLine =
    `${escapeHtml(countryBadge)} · ${sourcesCount} ${escapeHtml(outletsLabel)} · First source: ${escapeHtml(firstSourceName)}` +
    (metaAge ? ` · ${escapeHtml(metaLabel)} ${escapeHtml(metaAge)}` : '');

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

  const sourcesHtml = getSortedSourcesForDisplay(item)
    .slice(0, 30)
    .map((s) => {
      const rawUrl = String(s.url || '').trim();
      const srcName = String(s.source_name || 'unknown').trim();
      const src = escapeHtml(srcName || 'unknown');
      const titleRaw = String(s.title || '').trim();
      const t = escapeHtml(titleRaw);
      const pub = s.published_at ? new Date(s.published_at).toLocaleString() : '';
      const mark = diffSourceSet.has(s.source_name) ? ` <span class="srcMark">diff</span>` : '';
      const openHref = buildSourceReaderUrl(rawUrl, titleRaw || rawUrl, srcName || 'unknown');
      const logoHtml = buildSourceLogoHtml(srcName, rawUrl);
      return `<div class="sourceRow">${logoHtml}<div class="sourceRowBody"><div class="sourceRowHead"><b>${src}</b>${mark}</div><a href="${openHref}" target="_blank" rel="noopener noreferrer">${t || escapeHtml(rawUrl || '#')}</a> <span class="muted">${escapeHtml(pub)}</span></div></div>`;
    })
    .join('');

  const whyFactors = buildWhyScoreFactors(item);
  const factorsHtml = whyFactors
    .map((factor) => `<div class="scoreFactor"><div class="scoreFactorTop"><span class="scoreFactorName">${escapeHtml(factor.name)}</span><span class="scoreFactorMeta"><span class="scoreFactorValue">${escapeHtml(factor.value)}</span><span class="scoreFactorPts">+${escapeHtml(String(factor.points || 0))} pts</span></span></div><div class="scoreFactorText">${escapeHtml(factor.text)}</div></div>`)
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
  } else if (aiState.status === 'empty') {
    summaryHtml = `<div class="aiSummaryBlock" data-status="empty">
      <div class="aiSummaryTitle">${t("ui.ai_summary","AI Summary")}</div>
      <div class="aiSummaryText"><span class="muted">${escapeHtml(aiState.text || 'AI summary is not available for this story yet.')}</span></div>
    </div>`;
  }

  const unconfirmed = sourcesCount <= 1 ? `<span class="chip chipDanger">${t("ui.unconfirmed","Unconfirmed")}</span>` : '';
  const changeBadges = '';
  const disclosureIcon = '<span class="motionDisclosureIcon" aria-hidden="true"><span class="motionDisclosureIcon__h"></span><span class="motionDisclosureIcon__v"></span></span>';
  const accordionClosedAttrs = 'aria-expanded="false"';
  const accordionOpenAttrs = 'aria-expanded="true"';

  // --- Why this score?
  const whyState = getWhyScoreState(item);
  let whyHtml = '';
  const whyIntroText = (whyState.status === 'ready' && whyState.text)
    ? escapeHtml(whyState.text)
    : 'This score reflects importance and activity — not whether the story is true.';
  whyHtml = `
      <details class="accordion scoreAccordion">
        <summary class="accordionSummary" ${accordionClosedAttrs}><span class="accordionSummaryLabel">${t("ui.why_score","Why this score?")}</span>${disclosureIcon}</summary>
        <div class="accordionBody scoreExplainBody">
          <div class="scoreExplainLead">${whyIntroText}</div>
          <div class="scoreFactors">${factorsHtml || `<div class="muted">${t("score.limited","Score explanation is limited due to insufficient data")}</div>`}</div>
        </div>
      </details>`;

  // --- Event map
  let eventMapHtml = '';
  try {
    const mapLoc = item?.map_location;
    const lat = Number(mapLoc?.lat);
    const lng = Number(mapLoc?.lon ?? mapLoc?.lng);
    if (score > 70 && Number.isFinite(lat) && Number.isFinite(lng)) {
      const mapLabel = escapeHtml(String(mapLoc?.label || 'Mapped location'));
      eventMapHtml = `
        <details class="accordion">
          <summary class="accordionSummary" ${accordionOpenAttrs}><span class="accordionSummaryLabel">Event map</span>${disclosureIcon}</summary>
          <div class="accordionBody">
            <div class="muted" style="margin-bottom:12px;">${mapLabel}</div>
            <div class="eventMapMini" data-cluster-id="${idStr}"></div>
            <div class="eventMapActions">
              <button type="button" class="eventMapOpenBtn" data-open-full-map="${idStr}">Open full map</button>
            </div>
          </div>
        </details>`;
    }
  } catch {}

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
          <summary class="accordionSummary" ${accordionClosedAttrs}><span class="accordionSummaryLabel">Source differences</span>${disclosureIcon}</summary>
          <div class="accordionBody">
            ${topMsg}
            ${diffsHtml}
            ${factsHtml ? `<div class="splitSmall"></div><div><b>Key facts</b>${factsHtml}</div>` : ''}
            ${uncertaintiesHtml ? `<div class="splitSmall"></div><div><b>Uncertainties</b>${uncertaintiesHtml}</div>` : ''}
          </div>
        </details>`;
  }

  const thumbImageUrl = getNewsImage(item, 'thumb');
  const cardImageUrl = getNewsImage(item, 'card');
  const showThumb = !!state.showThumbs;
  const thumbHtml = showThumb
    ? `<div class="newsThumbWrap">${thumbImageUrl ? `<img class="newsThumb" loading="lazy" alt="" src="${thumbImageUrl}" />` : `<div class="newsThumbPh" aria-hidden="true"></div>`}</div>`
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
    <svg class="shareIcon shareIconSvg" viewBox="0 0 24 24" aria-hidden="true" focusable="false">
      <path d="M14 3h6a1 1 0 0 1 1 1v6" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"></path>
      <path d="M10 14 20 4" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"></path>
      <path d="M20 14v5a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V6a2 2 0 0 1 2-2h5" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"></path>
    </svg>
  </button>`;

  // Report button (opens report modal -> sends to Discord webhook).
  const reportHtml = `<button class="reportBtn" type="button" title="Report" aria-label="Report">
    <img class="reportIcon" src="/static/icons/Report.svg" alt="Report" />
  </button>`;

  // Tracking toggle (animated eye: closed when OFF, open when ON).
  const trackToggleHtml = `<button class="trackToggle ${favOn ? 'on' : ''}" type="button" title="Tracking" aria-label="Tracking" aria-pressed="${favOn ? 'true' : 'false'}" data-track="${id}">
    <span class="eyeToggleIcon" aria-hidden="true">
      <svg class="eyeSvg eyeClosed" viewBox="0 0 24 16" focusable="false">
        <path class="eyeStroke" d="M3 5.5c2.2 2 4.9 3 9 3s6.8-1 9-3"></path>
        <path class="eyeStroke" d="M9.2 8.1l-1.1 3.1"></path>
        <path class="eyeStroke" d="M12 8.5v3.5"></path>
        <path class="eyeStroke" d="M14.8 8.1l1.1 3.1"></path>
      </svg>
      <svg class="eyeSvg eyeOpen" viewBox="0 0 24 16" focusable="false">
        <path class="eyeFill" d="M1.8 8c2.2-3.3 5.8-5.3 10.2-5.3S20 4.7 22.2 8c-2.2 3.3-5.8 5.3-10.2 5.3S4 11.3 1.8 8Z"></path>
        <circle class="eyePupil" cx="12" cy="8" r="3.2"></circle>
      </svg>
    </span>
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
                <div class="scoreBadge ${scoreMeta.tone}" aria-label="${escapeHtml(scoreMeta.ariaPrefix)} ${score} ${escapeHtml(scoreMeta.label)}">
                  <span class="scoreBadgeValue">${score}</span>
                  <span class="scoreBadgeCopy">
                    <span class="scoreBadgeLabel">${escapeHtml(scoreMeta.shortLabel)}</span>
                    <span class="scoreBadgeScale">${escapeHtml(scoreMeta.scaleLabel)}</span>
                  </span>
                </div>
                ${(!showTrackingUI && trendMeta.dir !== 'flat') ? `<div class="scoreTrend ${trendMeta.dir}">${escapeHtml(trendMeta.text)}</div>` : ''}
                ${deltaHtml}
                ${iconHtml}
                ${shareHtml}
                ${reportHtml}
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
          <div class="newsImageWrap" data-image-state="${cardImageUrl ? 'loading' : 'empty'}">
            ${cardImageUrl ? `<img class="newsImage" loading="lazy" alt="" src="${cardImageUrl}" data-fallback-stage="0" />` : `<div class="newsImagePlaceholder">No related image available</div>`}
          </div>
        </div>

        ${historyHtml}

        <div class="newsSubMeta">
          <span class="chip">Topic: <b>${escapeHtml(item.topic || 'general')}</b></span>
          <span class="chip">Importance: <b>${importance}</b>/100</span>
          <span class="chip">Outlets: <b>${sourcesCount}</b></span>
          ${unconfirmed}
          ${changeBadges}
          <span class="chip">Country: <b>${escapeHtml(countryBadge)}</b></span>
          <span class="chip">First source: <b>${escapeHtml(firstSourceName)}</b></span>
          <span class="chip">Latest: ${escapeHtml(item.latest_published_at ? new Date(item.latest_published_at).toLocaleString() : '')}</span>
        </div>
        ${whyHtml}
        ${eventMapHtml}
        ${diffsSectionHtml}

        <details class="accordion">
          <summary class="accordionSummary" ${accordionClosedAttrs}><span class="accordionSummaryLabel">Sources</span>${disclosureIcon}</summary>
          <div class="accordionBody">
            <div class="sourcesList">${sourcesHtml || '<div class="muted">Not enough sources yet.</div>'}</div>
          </div>
        </details>

        
      </div>
    </details>
    </div>
  `;

  // Ensure images never show broken icons.
  for (const img of div.querySelectorAll('img.newsThumb, img.newsImage')) {
    img.addEventListener('error', () => setImgFallback(img));
    img.addEventListener('abort', () => setImgFallback(img));
  }

  // Guest access rules:
  // - Guests can open only the top 3 news items in the Feed.
  // - No blur/paywall overlay; instead we block opening locked items and show the auth modal.
  const isLocked = (!authState.authenticated && state.mode !== 'fav' && typeof idx === 'number')
    ? (idx >= 3)
    : (!!item.guest_locked && !authState.authenticated && state.mode !== 'fav');
  if (isLocked) {
    div.dataset.locked = '1';

    const detailsEl = div.querySelector('details.newsDetails');

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

  const scoreBadge = div.querySelector('.scoreBadge');
  const newsDetails = div.querySelector('details.newsDetails');
  const syncScoreBadgeExpansion = () => {
    if (!scoreBadge) return;
    const labelEl = scoreBadge.querySelector('.scoreBadgeLabel');
    if (!labelEl) return;
    scoreBadge.classList.remove('needsExpand', 'isExpanded');
    const detailsOpen = !!(newsDetails && newsDetails.open);
    if (!detailsOpen) return;
    requestAnimationFrame(() => {
      const labelElNow = scoreBadge.querySelector('.scoreBadgeLabel');
      if (!labelElNow) return;
      const needsExpand = (labelElNow.scrollWidth - labelElNow.clientWidth) > 1;
      if (!needsExpand) return;
      scoreBadge.classList.add('needsExpand');
      requestAnimationFrame(() => {
        scoreBadge.classList.add('isExpanded');
      });
    });
  };
  div.__syncScoreBadgeExpansion = syncScoreBadgeExpansion;
  if (newsDetails) {
    newsDetails.addEventListener('toggle', () => {
      syncScoreBadgeExpansion();
    });
  }
  if (scoreBadge) {
    requestAnimationFrame(() => syncScoreBadgeExpansion());
    window.addEventListener('resize', syncScoreBadgeExpansion, { passive: true });
  }

  const summaryEl = div.querySelector('summary.newsSummary');
  const isSummaryActionTarget = (target) => {
    if (!target || typeof target.closest !== 'function') return false;
    return !!target.closest('.trackToggle, .shareBtn, .reportBtn');
  };
  if (summaryEl) {
    summaryEl.addEventListener('click', (e) => {
      if (isSummaryActionTarget(e.target)) {
        e.preventDefault();
      }
    }, { capture: true });
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

  const reportBtn = div.querySelector('.reportBtn');
  if (reportBtn) {
    reportBtn.onclick = (e) => {
      e.preventDefault();
      e.stopPropagation();
      try {
        if (typeof window.openReportModal === 'function') {
          window.openReportModal({
            cluster_id: Number(item.cluster_id ?? item.event_id ?? 0),
            title: item.title || 'Event',
          });
        }
      } catch {}
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
      trackBtn.setAttribute('aria-pressed', nowOn ? 'true' : 'false');

      const n = getFavIds().length;
      const favCountEl = document.getElementById('favCount');
      if (favCountEl) favCountEl.textContent = String(n);
      const trackingCountEl = document.getElementById('trackingCount');
      if (trackingCountEl) trackingCountEl.textContent = String(n);
      try { document.dispatchEvent(new CustomEvent('checkne:trackingUpdated', { detail: { count: n } })); } catch {}

      // If we are currently viewing Tracking and the user removed it, refresh the list.
      if (state.mode === 'fav' && !nowOn) {
        await fetchFavorites();
      }
    };
  }

  const syncTrackingCardDraggable = () => {
    const isTracking = (state.mode === 'fav');
    const openDetails = div.querySelector('details.newsDetails[open]');
    if (isTracking && !openDetails) div.setAttribute('draggable', 'true');
    else div.removeAttribute('draggable');
  };

  // Drag-to-delete in Tracking tab
  let __cardDragGhost = null;
  const __clearCardDragGhost = () => {
    try { __cardDragGhost?.remove(); } catch (_) {}
    __cardDragGhost = null;
  };
  div.addEventListener('dragstart', (e) => {
    if (state.mode !== 'fav') {
      e.preventDefault();
      return;
    }

    const openDetails = div.querySelector('details.newsDetails[open]');
    if (openDetails || div.getAttribute('draggable') !== 'true') {
      e.preventDefault();
      return;
    }

    document.querySelectorAll('.newsCard.isDragging').forEach((el) => {
      if (el !== div) el.classList.remove('isDragging');
    });

    state.isDragging = true;
    updateTrashZone();

    try {
      e.dataTransfer.setData('text/plain', String(id));
      e.dataTransfer.effectAllowed = 'move';

      const rect = div.getBoundingClientRect();
      const ghost = div.cloneNode(true);
      ghost.classList.remove('isDragging');
      ghost.style.position = 'fixed';
      ghost.style.left = '-10000px';
      ghost.style.top = '0';
      ghost.style.width = `${Math.max(220, Math.round(rect.width))}px`;
      ghost.style.maxWidth = `${Math.max(220, Math.round(rect.width))}px`;
      ghost.style.transform = 'none';
      ghost.style.transition = 'none';
      ghost.style.pointerEvents = 'none';
      ghost.style.margin = '0';
      ghost.style.opacity = '1';
      ghost.style.zIndex = '-1';
      document.body.appendChild(ghost);
      __cardDragGhost = ghost;
      e.dataTransfer.setDragImage(ghost, Math.min(24, Math.max(0, e.clientX - rect.left)), Math.min(24, Math.max(0, e.clientY - rect.top)));
    } catch (_) {}
    div.classList.add('isDragging');
  });
  div.addEventListener('dragend', () => {
    div.classList.remove('isDragging');
    state.isDragging = false;
    updateTrashZone();
    __clearCardDragGhost();
    syncTrackingCardDraggable();
  });

  

// Tracking: clear the sticky ▲/▼ indicator only when the user opens the card.
// (This prevents it from disappearing immediately on auto-refresh.)
const detailsOpenEl = div.querySelector('details.newsDetails');
if (detailsOpenEl) {
  detailsOpenEl.addEventListener('toggle', () => {
  syncTrackingCardDraggable();
  // When a card is opened, remember it as the "current story" for PRO widgets
  // (Momentum Timeline / Top Charts etc.).
  // This is intentionally independent from search/topic filters.
  if (detailsOpenEl.open) {
    try { window.__currentClusterId = Number(id) || null; } catch {}
    try { localStorage.setItem('checkne_current_cluster', String(id)); } catch {}
    try { document.dispatchEvent(new CustomEvent('checkne:currentClusterChanged', { detail: { cluster_id: Number(id) } })); } catch {}

// Store richer "current story" info for widgets that need the specific headline (e.g., Video Report).
try {
  const story = {
    cluster_id: Number(id) || null,
    item_id: Number(item.id) || null,
    importance: Number(item.importance) || 0,
    credibility: Number(item.credibility) || 0,
    score: Number(item.score ?? item.credibility_score ?? item.credibility ?? 0) || 0,
    title: String(item.title || ''),
    url: String(item.url || ''),
    source: String(item.source || item.outlet || ''),
    published_at: item.latest_published_at || item.published_at || item.created_at || item.updated_at || null,
  };
  window.__currentStory = story;
  localStorage.setItem('checkne_current_story', JSON.stringify(story));
  // Back-compat for widgets that read __currentStory
  try { localStorage.setItem('__currentStory', JSON.stringify(story)); } catch {}
  document.dispatchEvent(new CustomEvent('checkne:currentStoryChanged', { detail: story }));
} catch {}
  }

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
  syncTrackingCardDraggable();
} else {
  syncTrackingCardDraggable();
}

return div;
}

function updateCardElement(el, item, ctx, seen) {
  if (!el) return;
  const id = getItemId(item);
  const idStr = String(id);
  const scoreMeta = getStoryScoreMeta(item);
  const score = scoreMeta.score;

  // Update score badge
  const scoreEl = el.querySelector('.scoreBadge');
  if (scoreEl) {
    scoreEl.className = `scoreBadge ${scoreMeta.tone}`;
    scoreEl.setAttribute('aria-label', `${scoreMeta.ariaPrefix} ${score} ${scoreMeta.label}`);
    scoreEl.innerHTML = `<span class="scoreBadgeValue">${score}</span><span class="scoreBadgeCopy"><span class="scoreBadgeLabel">${escapeHtml(scoreMeta.shortLabel)}</span><span class="scoreBadgeScale">${escapeHtml(scoreMeta.scaleLabel)}</span></span>`;
    const syncScoreBadgeExpansion = el.__syncScoreBadgeExpansion;
    if (typeof syncScoreBadgeExpansion === 'function') {
      requestAnimationFrame(() => syncScoreBadgeExpansion());
    }
  }

  const trendMeta = getStoryTrendMeta(item);
  let trendEl = el.querySelector('.scoreTrend');
  if (state.mode === 'fav' || trendMeta.dir === 'flat') {
    if (trendEl) trendEl.remove();
  } else {
    if (!trendEl) {
      trendEl = document.createElement('div');
      trendEl.className = 'scoreTrend';
      const topRight = el.querySelector('.newsTopRight');
      const deltaEl = el.querySelector('.delta');
      if (topRight) {
        if (deltaEl) topRight.insertBefore(trendEl, deltaEl);
        else topRight.appendChild(trendEl);
      }
    }
    trendEl.className = `scoreTrend ${trendMeta.dir}`;
    trendEl.textContent = trendMeta.text;
  }

  // When switching tabs, ensure Tracking-specific UI doesn't "leak" into the feed.
  const trackingWrap = el.querySelector('.trackingWrap');
  if (trackingWrap) trackingWrap.style.display = (state.mode === 'fav') ? 'flex' : 'none';

  // Toggle draggable depending on tab and expanded state
  const openDetails = el.querySelector('details.newsDetails[open]');
  if (state.mode === 'fav' && !openDetails) el.setAttribute('draggable', 'true');
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
  const preserveScroll = !!options.preserveScroll;

  const cards = qs('cards');
  if (!cards) return;
  const scrollAnchorBeforeRender = preserveScroll ? getFeedAnchorSnapshot() : null;
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

  const filteredBase = (items || [])
    .filter((it) => isUrlQuery(q) ? true : itemMatchesSearch(it, q))
    .filter((it) => itemPassesFilters(it));
  const filtered = ensurePendingStoryIncluded(items, filteredBase);

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
    visible = visible.slice(0, getFeedVisibleLimit(filtered.length));
  }

  if (filtered.length === 0) {
    removePersonalRecoBanner();
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
    const hiddenCountNow = Math.max(0, total - getFeedVisibleLimit(total));

    const wrap = createLoadMoreLoader({
      totalCount: total,
      hiddenCount: hiddenCountNow,
    });

    cards.appendChild(wrap);
    bindFeedAutoExpandObserver(feedExpanded ? null : wrap);
  } else {
    bindFeedAutoExpandObserver(null);
  }
  // Notify side widgets (best-effort)
  try { document.dispatchEvent(new CustomEvent("checkne:feedRendered")); } catch {}
  if (scrollAnchorBeforeRender) {
    try {
      const anchor = scrollAnchorBeforeRender.id
        ? document.querySelector(`.newsCard[data-id="${CSS.escape(scrollAnchorBeforeRender.id)}"]`)
        : null;
      if (anchor) {
        const rect = anchor.getBoundingClientRect();
        const absoluteTop = getCurrentScrollY() + rect.top;
        const targetY = Math.max(0, Math.round(absoluteTop - Number(scrollAnchorBeforeRender.deltaTop || 0)));
        window.scrollTo({ top: targetY, left: window.pageXOffset || 0, behavior: 'auto' });
      } else if (Number.isFinite(Number(scrollAnchorBeforeRender.scrollY))) {
        window.scrollTo({ top: Math.max(0, Math.round(Number(scrollAnchorBeforeRender.scrollY))), left: window.pageXOffset || 0, behavior: 'auto' });
      }
    } catch {}
  }
  tryResolvePendingStoryFocus({ context: 'renderCards' });
  syncPersonalRecoBanner(visible);
  if (state.mode === 'feed') {
    window.setTimeout(() => { maybeApplyLoadMoreMagnet(); }, 24);
    window.setTimeout(() => { saveFeedScrollState('render-complete'); }, 40);
  }

}


function resetFeedAutoLoadState() {
  __feedVisibleLimit = (typeof FEED_PAGE_SIZE !== 'undefined' ? FEED_PAGE_SIZE : 10);
  __feedAutoPaused = false;
  __feedAutoExpandLatch = false;
  clearFeedAutoExpandTimer();
  resetLoadMoreLoaderState();
}


function getFeedScrollableRoot() {
  return document.scrollingElement || document.documentElement || document.body || null;
}

function getCurrentScrollY() {
  const root = getFeedScrollableRoot();
  return Math.max(window.pageYOffset || 0, root?.scrollTop || 0, document.documentElement?.scrollTop || 0, document.body?.scrollTop || 0);
}

function isFeedModeActiveForScrollState() {
  return state?.mode === 'feed';
}

function getFeedAnchorSnapshot() {
  const cards = qs('cards');
  if (!cards) return null;
  const viewportH = window.innerHeight || document.documentElement?.clientHeight || 0;
  const targetBandTop = Math.max(72, Math.round(viewportH * 0.18));
  const candidates = Array.from(cards.querySelectorAll('.newsCard[data-id]'));
  let best = null;
  let bestDistance = Infinity;
  for (const el of candidates) {
    const rect = el.getBoundingClientRect();
    if (rect.bottom < 0 || rect.top > viewportH) continue;
    const distance = Math.abs(rect.top - targetBandTop);
    if (distance < bestDistance) {
      bestDistance = distance;
      best = el;
    }
  }
  if (!best && candidates.length) best = candidates[0];
  if (!best) return null;
  const rect = best.getBoundingClientRect();
  return {
    id: String(best.getAttribute('data-id') || ''),
    deltaTop: Math.round(rect.top),
    scrollY: Math.round(getCurrentScrollY()),
    ts: Date.now(),
    mode: String(state?.mode || ''),
  };
}

function saveFeedScrollState(reason = 'generic') {
  try {
    if (!isFeedModeActiveForScrollState()) return;
    const snapshot = getFeedAnchorSnapshot() || {
      id: '',
      deltaTop: 0,
      scrollY: Math.round(getCurrentScrollY()),
      ts: Date.now(),
      mode: String(state?.mode || ''),
    };
    snapshot.reason = String(reason || 'generic');
    sessionStorage.setItem(FEED_SCROLL_STATE_KEY, JSON.stringify(snapshot));
    __feedLastKnownScrollY = Number(snapshot.scrollY || 0);
  } catch {}
}

function scheduleSaveFeedScrollState(reason = 'generic') {
  try {
    if (__feedScrollSaveTimer) window.clearTimeout(__feedScrollSaveTimer);
  } catch {}
  __feedScrollSaveTimer = window.setTimeout(() => {
    __feedScrollSaveTimer = null;
    saveFeedScrollState(reason);
  }, FEED_SCROLL_SAVE_THROTTLE_MS);
}

function restoreFeedScrollFromState(opts = {}) {
  try {
    if (!isFeedModeActiveForScrollState()) return false;
    const raw = sessionStorage.getItem(FEED_SCROLL_STATE_KEY);
    if (!raw) return false;
    const parsed = JSON.parse(raw);
    if (!parsed || parsed.mode !== 'feed') return false;
    const ts = Number(parsed.ts || 0);
    if (!Number.isFinite(ts) || (Date.now() - ts) > FEED_SCROLL_RESTORE_WINDOW_MS) return false;

    const desiredY = Number(parsed.scrollY || 0);
    const desiredTop = Number(parsed.deltaTop || 0);
    const anchorId = String(parsed.id || '').trim();
    let restored = false;

    if (anchorId) {
      const anchor = document.querySelector(`.newsCard[data-id="${CSS.escape(anchorId)}"]`);
      if (anchor) {
        const rect = anchor.getBoundingClientRect();
        const absoluteTop = getCurrentScrollY() + rect.top;
        const targetY = Math.max(0, Math.round(absoluteTop - desiredTop));
        window.scrollTo({ top: targetY, left: window.pageXOffset || 0, behavior: 'auto' });
        restored = true;
      }
    }

    if (!restored && Number.isFinite(desiredY)) {
      window.scrollTo({ top: Math.max(0, Math.round(desiredY)), left: window.pageXOffset || 0, behavior: 'auto' });
      restored = true;
    }

    if (restored && opts.persist !== true) {
      sessionStorage.removeItem(FEED_SCROLL_STATE_KEY);
    }
    return restored;
  } catch {
    return false;
  }
}

function queueFeedScrollRestore(reason = 'generic') {
  try {
    if (__feedRestoreTimer) window.clearTimeout(__feedRestoreTimer);
  } catch {}
  __feedRestoreTimer = window.setTimeout(() => {
    __feedRestoreTimer = null;
    restoreFeedScrollFromState({ reason });
  }, 26);
}

function shouldUseLoadMoreMagnet() {
  try {
    return window.matchMedia ? window.matchMedia('(max-width: 900px) and (pointer: coarse)').matches : ((window.innerWidth || 0) <= 900);
  } catch {
    return (window.innerWidth || 0) <= 900;
  }
}

function getLoadMoreMagnetTargetY(wrap) {
  if (!wrap) return null;
  const rect = wrap.getBoundingClientRect();
  const viewportH = window.innerHeight || document.documentElement?.clientHeight || 0;
  const targetTop = Math.round(viewportH * 0.28);
  const absoluteTop = getCurrentScrollY() + rect.top;
  return Math.max(0, Math.round(absoluteTop - targetTop));
}

function canApplyLoadMoreMagnet(wrap) {
  if (!wrap || !shouldUseLoadMoreMagnet()) return false;
  if (feedExpanded || state.mode !== 'feed' || __feedAutoPaused || __feedAutoExpandBusy) return false;
  const now = Date.now();
  if (__feedMagnetLock || (now - __feedLastMagnetAt) < FEED_LOAD_MORE_MAGNET_COOLDOWN_MS) return false;
  if (__feedLastScrollDir <= 0) return false;

  const rect = wrap.getBoundingClientRect();
  const viewportH = window.innerHeight || document.documentElement?.clientHeight || 0;
  if (rect.height <= 0 || viewportH <= 0) return false;

  const triggerTopMin = Math.round(viewportH * 0.14);
  const triggerTopMax = Math.round(viewportH * 0.62);
  const footer = document.querySelector('footer, .footer, #footer, .siteFooter');
  if (footer) {
    const footerRect = footer.getBoundingClientRect();
    if (footerRect.top < viewportH + 64) return false;
  }

  return rect.top >= triggerTopMin && rect.top <= triggerTopMax;
}

function maybeApplyLoadMoreMagnet() {
  const wrap = document.getElementById('loadMoreWrap');
  if (!canApplyLoadMoreMagnet(wrap)) return;
  const targetY = getLoadMoreMagnetTargetY(wrap);
  if (!Number.isFinite(targetY)) return;
  const currentY = getCurrentScrollY();
  if (Math.abs(targetY - currentY) < 18) return;

  __feedMagnetLock = true;
  __feedLastMagnetAt = Date.now();
  window.scrollTo({ top: targetY, left: window.pageXOffset || 0, behavior: 'smooth' });
  window.setTimeout(() => {
    __feedMagnetLock = false;
    saveFeedScrollState('magnet-settle');
  }, 420);
}

function installFeedScrollPersistence() {
  if (window.__checkneFeedScrollPersistenceInstalled) return;
  window.__checkneFeedScrollPersistenceInstalled = true;

  try {
    if ('scrollRestoration' in history) history.scrollRestoration = 'manual';
  } catch {}

  window.addEventListener('scroll', () => {
    const currentY = getCurrentScrollY();
    __feedLastScrollDir = currentY > __feedLastKnownScrollY ? 1 : (currentY < __feedLastKnownScrollY ? -1 : __feedLastScrollDir);
    __feedLastKnownScrollY = currentY;
    scheduleSaveFeedScrollState('scroll');
  }, { passive: true });

  document.addEventListener('visibilitychange', () => {
    if (document.hidden) {
      saveFeedScrollState('hidden');
      return;
    }
    queueFeedScrollRestore('visible');
  });

  window.addEventListener('pagehide', () => saveFeedScrollState('pagehide'));
  window.addEventListener('beforeunload', () => saveFeedScrollState('beforeunload'));
  window.addEventListener('pageshow', () => queueFeedScrollRestore('pageshow'));
  window.addEventListener('focus', () => queueFeedScrollRestore('focus'));
}

installFeedScrollPersistence();

function getFeedVisibleLimit(totalCount) {
  const pageSize = (typeof FEED_PAGE_SIZE !== 'undefined' ? FEED_PAGE_SIZE : 10);
  const total = Math.max(0, Number(totalCount || 0));
  if (feedExpanded) return total;
  __feedVisibleLimit = Math.max(pageSize, Number(__feedVisibleLimit || pageSize));
  return Math.min(total, __feedVisibleLimit);
}

function revealNextFeedBatch(totalCount) {
  const total = Math.max(0, Number(totalCount || 0));
  const pageSize = (typeof FEED_PAGE_SIZE !== 'undefined' ? FEED_PAGE_SIZE : 10);
  __feedVisibleLimit = Math.max(pageSize, Number(__feedVisibleLimit || pageSize));
  const nextLimit = Math.min(total, __feedVisibleLimit + FEED_AUTO_BATCH_SIZE);
  const reachedEnd = nextLimit >= total;
  __feedVisibleLimit = nextLimit;
  __feedAutoExpandLatch = true;
  if (reachedEnd) {
    setFeedExpanded(true);
    return;
  }
  renderCards(Array.isArray(lastFeedItems) ? lastFeedItems : [], { incremental: false });
}

// Build or update the animated load-more block at the bottom of the feed.
function createLoadMoreLoader(opts) {
  const totalCount = Number(opts?.totalCount || 0);
  const hiddenCount = Math.max(0, Number(opts?.hiddenCount || 0));
  const isPaused = !!__feedAutoPaused;
  const isAuthed = !!authState?.authenticated;

  const wrap = document.createElement('div');
  wrap.className = 'loadMoreWrap';
  wrap.id = 'loadMoreWrap';
  if (isPaused) wrap.classList.add('is-paused');

  const hint = document.createElement('div');
  hint.className = 'loadMoreHint';
  hint.textContent = feedExpanded || hiddenCount <= 0
    ? t("ui.feed.shown", "Showing {count} news").replace("{count}", totalCount)
    : t("ui.feed.hidden", "Hidden {count} news").replace("{count}", hiddenCount);
  wrap.appendChild(hint);

  if (!feedExpanded) {
    if (isPaused && isAuthed) {
      const actions = document.createElement('div');
      actions.className = 'loadMoreActions';

      const resumeBtn = document.createElement('button');
      resumeBtn.type = 'button';
      resumeBtn.className = 'loadMorePauseBtn isPrimary';
      resumeBtn.textContent = 'Resume auto-load';
      resumeBtn.addEventListener('click', () => {
        __feedAutoPaused = false;
        __feedAutoExpandLatch = false;
        clearFeedAutoExpandTimer();
        renderCards(Array.isArray(lastFeedItems) ? lastFeedItems : [], { incremental: false });
      });
      actions.appendChild(resumeBtn);
      wrap.appendChild(actions);
    } else {
      const loader = document.createElement('div');
      loader.className = 'loadMoreLoader';
      loader.innerHTML = `
        <span class="loadMoreSpinner" aria-hidden="true"></span>
        <span class="loadMoreText">Loading more stories</span>
        <span class="loadMoreDots" aria-hidden="true"><i></i><i></i><i></i></span>
      `;
      wrap.appendChild(loader);

      const authNote = document.createElement('div');
      authNote.className = 'loadMoreSubtle';
      authNote.textContent = isAuthed
        ? 'Keep scrolling — 10 more stories will open automatically.'
        : 'Sign in to unlock the rest of the feed.';
      wrap.appendChild(authNote);

      if (isAuthed) {
        const actions = document.createElement('div');
        actions.className = 'loadMoreActions';

        const pauseBtn = document.createElement('button');
        pauseBtn.type = 'button';
        pauseBtn.className = 'loadMorePauseBtn';
        pauseBtn.textContent = 'Pause auto-load';
        pauseBtn.addEventListener('click', () => {
          __feedAutoPaused = true;
          __feedAutoExpandLatch = false;
          clearFeedAutoExpandTimer();
          resetLoadMoreLoaderState();
          renderCards(Array.isArray(lastFeedItems) ? lastFeedItems : [], { incremental: false });
        });
        actions.appendChild(pauseBtn);
        wrap.appendChild(actions);
      }
    }
  } else {
    const done = document.createElement('div');
    done.className = 'loadMoreDone';
    done.textContent = t("ui.feed.shown", "Showing {count} news").replace("{count}", totalCount);
    wrap.appendChild(done);
  }

  return wrap;
}

function updateLoadMoreBlock(totalCount) {
  const cards = qs('cards');
  if (!cards) return;
  const existing = document.getElementById('loadMoreWrap');
  if (existing) existing.remove();

  if (state.mode !== 'feed') {
    bindFeedAutoExpandObserver(null);
    return;
  }
  if (!(totalCount > FEED_PAGE_SIZE)) {
    bindFeedAutoExpandObserver(null);
    return;
  }

  const hiddenCountNow = Math.max(0, totalCount - getFeedVisibleLimit(totalCount));
  const wrap = createLoadMoreLoader({
    totalCount,
    hiddenCount: hiddenCountNow,
  });

  cards.appendChild(wrap);
  bindFeedAutoExpandObserver(feedExpanded ? null : wrap);
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
  const filteredBase = (sortedItems || [])
    .filter((it) => isUrlQuery(q) ? true : itemMatchesSearch(it, q))
    .filter((it) => itemPassesFilters(it));
  const filtered = ensurePendingStoryIncluded(sortedItems, filteredBase);

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
    visible = visible.slice(0, getFeedVisibleLimit(filtered.length));
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
    while (countRenderedNewsCards() > getFeedVisibleLimit(filtered.length)) {
      removeLastRenderedCard();
    }
  }

  updateLoadMoreBlock(filtered.length);
  syncPersonalRecoBanner(visible);
  tryResolvePendingStoryFocus({ context: 'incremental-render' });
}


function clearFeedAutoExpandTimer() {
  if (__feedAutoExpandTimer) {
    window.clearTimeout(__feedAutoExpandTimer);
    __feedAutoExpandTimer = null;
  }
}

function getFeedAutoExpandThresholdPx() {
  const viewportH = window.innerHeight || document.documentElement?.clientHeight || 0;
  // Trigger a bit earlier on phones so users do not have to scroll through the full footer.
  // Examples: phone ≈ 220-260px, desktop ≈ 280-360px.
  return Math.max(160, Math.min(360, Math.round(viewportH * 0.32)));
}

function isUserPinnedToFeedBottom() {
  const doc = document.documentElement;
  const body = document.body;
  const scrollTop = Math.max(window.pageYOffset || 0, doc?.scrollTop || 0, body?.scrollTop || 0);
  const viewportH = window.innerHeight || doc?.clientHeight || 0;
  const fullH = Math.max(
    body?.scrollHeight || 0,
    doc?.scrollHeight || 0,
    body?.offsetHeight || 0,
    doc?.offsetHeight || 0,
    body?.clientHeight || 0,
    doc?.clientHeight || 0,
  );
  const threshold = getFeedAutoExpandThresholdPx();
  return (scrollTop + viewportH) >= (fullH - threshold);
}

function isLoadMoreZoneVisible() {
  const wrap = document.getElementById('loadMoreWrap');
  if (!wrap) return false;
  const rect = wrap.getBoundingClientRect();
  const viewportH = window.innerHeight || document.documentElement?.clientHeight || 0;
  const topGate = Math.max(0, viewportH * 0.18);
  const bottomGate = viewportH + Math.min(120, viewportH * 0.08);
  return rect.top <= bottomGate && rect.bottom >= topGate;
}

function setLoadMoreLoaderState(stateName) {
  const wrap = document.getElementById('loadMoreWrap');
  if (!wrap) return;
  wrap.classList.remove('is-armed', 'is-loading', 'is-done');
  if (stateName) wrap.classList.add(`is-${stateName}`);
}

function resetLoadMoreLoaderState() {
  const wrap = document.getElementById('loadMoreWrap');
  if (!wrap) return;
  wrap.classList.remove('is-armed', 'is-loading', 'is-done');
}

function triggerFeedAutoExpand() {
  clearFeedAutoExpandTimer();
  if (__feedAutoExpandBusy || state.mode !== 'feed' || feedExpanded || !authState?.authenticated || __feedAutoPaused || __feedAutoExpandLatch) return;
  if (!isUserPinnedToFeedBottom()) {
    resetLoadMoreLoaderState();
    return;
  }
  const wrap = document.getElementById('loadMoreWrap');
  if (!wrap) return;
  const totalCards = Array.isArray(lastFeedItems) ? lastFeedItems.filter((it) => {
    const q = (state.q || '').trim();
    return (isUrlQuery(q) ? true : itemMatchesSearch(it, q)) && itemPassesFilters(it);
  }).length : 0;
  if (getFeedVisibleLimit(totalCards) >= totalCards) return;
  __feedAutoExpandBusy = true;
  setLoadMoreLoaderState('loading');
  window.setTimeout(() => {
    revealNextFeedBatch(totalCards);
    setLoadMoreLoaderState('done');
    window.setTimeout(() => { __feedAutoExpandBusy = false; }, 450);
  }, 900);
}

function scheduleFeedAutoExpand() {
  clearFeedAutoExpandTimer();
  if (state.mode !== 'feed' || feedExpanded || __feedAutoPaused || __feedAutoExpandLatch) return;
  const wrap = document.getElementById('loadMoreWrap');
  if (!wrap) return;
  if (!isUserPinnedToFeedBottom()) {
    resetLoadMoreLoaderState();
    return;
  }
  if (!authState?.authenticated) {
    setLoadMoreLoaderState('armed');
    return;
  }
  setLoadMoreLoaderState('loading');
  __feedAutoExpandTimer = window.setTimeout(() => {
    __feedAutoExpandTimer = null;
    triggerFeedAutoExpand();
  }, 900);
}

function bindFeedAutoExpandObserver(targetEl) {
  clearFeedAutoExpandTimer();
  if (__feedAutoExpandObserver) {
    try { __feedAutoExpandObserver.disconnect(); } catch {}
    __feedAutoExpandObserver = null;
  }
  if (!targetEl || feedExpanded || state.mode !== 'feed') return;

  if ('IntersectionObserver' in window) {
    __feedAutoExpandObserver = new IntersectionObserver((entries) => {
      const entry = entries && entries[0];
      if (!entry) return;
      if (entry.isIntersecting && isUserPinnedToFeedBottom()) scheduleFeedAutoExpand();
      else {
        __feedAutoExpandLatch = false;
        clearFeedAutoExpandTimer();
        resetLoadMoreLoaderState();
      }
    }, {
      root: null,
      // Start a little earlier than the absolute end, especially on mobile.
      rootMargin: `0px 0px ${Math.round(getFeedAutoExpandThresholdPx() * 0.45)}px 0px`,
      threshold: 0.15,
    });
    try { __feedAutoExpandObserver.observe(targetEl); } catch {}
    return;
  }

  const rect = targetEl.getBoundingClientRect();
  const viewportH = window.innerHeight || document.documentElement.clientHeight || 0;
  if (rect.top <= (viewportH + getFeedAutoExpandThresholdPx() * 0.25) && isUserPinnedToFeedBottom()) scheduleFeedAutoExpand();
}

window.addEventListener('scroll', () => {
  const wrap = document.getElementById('loadMoreWrap');
  if (!wrap || feedExpanded || state.mode !== 'feed') return;
  maybeApplyLoadMoreMagnet();
  if (isLoadMoreZoneVisible() && isUserPinnedToFeedBottom()) scheduleFeedAutoExpand();
  else {
    __feedAutoExpandLatch = false;
    clearFeedAutoExpandTimer();
    resetLoadMoreLoaderState();
  }
}, { passive: true });
window.addEventListener('resize', () => {
  const wrap = document.getElementById('loadMoreWrap');
  if (!wrap || feedExpanded || state.mode !== 'feed') return;
  maybeApplyLoadMoreMagnet();
  if (isLoadMoreZoneVisible() && isUserPinnedToFeedBottom()) scheduleFeedAutoExpand();
  else {
    __feedAutoExpandLatch = false;
    clearFeedAutoExpandTimer();
    resetLoadMoreLoaderState();
  }
}, { passive: true });

function getFeedLimitForCurrentPlan() {
  const plan = String((typeof billingState !== 'undefined' && billingState && billingState.plan) ? billingState.plan : 'free').toLowerCase();
  if (plan === 'analyst') return 500;
  if (plan === 'pro') return 300;
  return 120;
}

async function fetchFeed(opts) {
  const options = opts || {};
  const quiet = !!options.quiet;
  const forceReset = !!options.reset;
  const externalSignal = options.signal;
  const requestReason = String(options.reason || '').trim();
  const requestSeq = ++__feedRequestSeq;
  let controller = null;
  let signal = externalSignal;
  if (!signal) {
    try { if (__feedActiveAbortController) __feedActiveAbortController.abort(); } catch {}
    try {
      controller = new AbortController();
      signal = controller.signal;
      __feedActiveAbortController = controller;
    } catch {}
  }
  logRecoStoryDiagnostic('fetch-feed-start', {
    requestSeq,
    reason: requestReason,
    reset: forceReset,
    quiet,
    country: String(state.country || ''),
    mode: String(state.mode || ''),
  });

  const interests = encodeURIComponent((state.interests || []).join(","));
  const rawSearchQ = (state.q || "").trim();
  // 🔥 topics can be multi-selected. We build a query string from them without touching the Search input.
  const topicArr = Array.isArray(state.topicQs) ? state.topicQs : [];
  const rawTopicQ = (topicArr.length ? topicArr.join(" ") : (state.topicQ || "")).trim();
  // Keep `topicQ` in sync for older code paths.
  state.topicQ = rawTopicQ;
  // Effective query: Search box has priority. TopicQ is used by 🔥 chips and must not touch the Search input.
  const rawQ = rawSearchQ || rawTopicQ;
  const q = encodeURIComponent(rawQ);
  const trendId = (state && state.trendClusterId) ? encodeURIComponent(String(state.trendClusterId)) : "";

  // If the user pasted a URL into Search, show similar items from the feed.
  // URL search should only trigger when the user actually pasted a URL into the Search input.
  const isUrl = /^https?:\/\//i.test(rawSearchQ);

  const url = isUrl
    ? `${API_BASE}/api/news/similar?url=${q}` +
      `&ui_lang=${encodeURIComponent(state.language || "en")}`
    : `${API_BASE}/api/news?interests=${interests}` +
      `&country=${encodeURIComponent(state.country)}` +
      `&language=all` +
      `&ui_lang=${encodeURIComponent(state.language || "en")}` +
      `&limit=${encodeURIComponent(String(getFeedLimitForCurrentPlan()))}` +
      (trendId ? `&trend_cluster_id=${trendId}` : "") +
      (q ? `&q=${q}` : "");


  const feedKey = `${state.country}|${(state.interests || []).join(",")}|q=${rawSearchQ}|topic=${rawTopicQ}|${state.trendClusterId || ""}`;

  const keyChanged = (typeof currentFeedKey === "string") && (currentFeedKey !== feedKey);
  const shouldReset = forceReset || !currentFeedKey || keyChanged;

  // On first load (or after key reset), suppress NEW badges and avoid animations.
  const suppressNewBadges = !hasInitialFeedLoaded || shouldReset;

  if (!quiet) setStatus(t("ui.loading_feed","Loading feed..."));

  // Allow the caller to abort (we use this to prevent overlapping requests on slow hosts like Render)
  let res;
  try {
    res = await fetch(url, signal ? { signal } : undefined);
  } catch (err) {
    if (err && (err.name === 'AbortError' || String(err.message || '').toLowerCase().includes('abort'))) {
      logRecoStoryDiagnostic('fetch-feed-aborted', { requestSeq, reason: requestReason });
      if (controller && __feedActiveAbortController === controller) __feedActiveAbortController = null;
      return;
    }
    if (controller && __feedActiveAbortController === controller) __feedActiveAbortController = null;
    throw err;
  }
  if (requestSeq !== __feedRequestSeq) {
    logRecoStoryDiagnostic('fetch-feed-stale-response', { requestSeq, currentSeq: __feedRequestSeq, reason: requestReason });
    if (controller && __feedActiveAbortController === controller) __feedActiveAbortController = null;
    return;
  }
  if (!res.ok) {
    if (!quiet) setStatus(`${t("ui.error_api_news","Error /api/news")}: ${res.status}`);
    logRecoStoryDiagnostic('fetch-feed-http-error', { requestSeq, status: res.status, reason: requestReason });
    if (controller && __feedActiveAbortController === controller) __feedActiveAbortController = null;
    return;
  }

  const data = await res.json();
  if (requestSeq !== __feedRequestSeq) {
    logRecoStoryDiagnostic('fetch-feed-stale-json', { requestSeq, currentSeq: __feedRequestSeq, reason: requestReason });
    if (controller && __feedActiveAbortController === controller) __feedActiveAbortController = null;
    return;
  }
  const items = data.items || [];
  logRecoStoryDiagnostic('fetch-feed-success', { requestSeq, reason: requestReason, items: items.length });

  try { window.__checkneFeedItems = items; } catch {}
  try { document.dispatchEvent(new CustomEvent("checkne:feedItemsUpdated", { detail: { items } })); } catch {}

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
  preserveScroll: quiet,
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
  if (controller && __feedActiveAbortController === controller) {
    __feedActiveAbortController = null;
  }
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

    try { window.__checkneFeedItems = items; } catch {}
    try { document.dispatchEvent(new CustomEvent("checkne:feedItemsUpdated", { detail: { items } })); } catch {}

    lastFavItems = items;

    // Tracking page uses server-side deltas (delta_score / delta_sources_count)
    const useIncremental = !!opts.quiet && !opts.reset;
    renderCards(items, { nowTs: Date.now(), newIds: new Set(), suppressNewBadges: true, incremental: useIncremental, animate: false, preserveScroll: !!opts.quiet });

    // Hydrate trust history charts (server-side) for newly rendered cards
    if (!opts.quiet || opts.reset) hydrateTrustHistorySections();

    setStatus(items.length ? '' : 'Tracking is empty. Tap ★ on a news card to add.');
    updateCounts();

    try {
      if (typeof window.__consumeTrackingFocus === 'function') {
        setTimeout(() => { void window.__consumeTrackingFocus(); }, 40);
      }
    } catch {}
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
    try { document.dispatchEvent(new CustomEvent('checkne:trackingUpdated', { detail: { count: n } })); } catch {}
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

    resetFeedAutoLoadState();
    resetFeedAutoLoadState();
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
    state.visualSearch = null;
    savePrefs();
    resetFeedAutoLoadState();
    setFeedExpanded(false);
    if (state.mode === "feed") await fetchFeed({ reset: !!reset });
    else await fetchFavorites();
  }

  function scheduleSearch(){
    if (__searchT) clearTimeout(__searchT);
    __searchT = setTimeout(() => { applySearch({ reset: true }); }, 250);
  }

  if (btnSearch) btnSearch.onclick = () => applySearch({ reset: true });
  if (searchEl) {
    searchEl.addEventListener('input', () => scheduleSearch());
    searchEl.addEventListener('change', () => applySearch({ reset: true }));
    searchEl.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') {
        e.preventDefault();
        applySearch({ reset: true });
      }
    });
  }


function ensureVisualSearchModal(){
  if (document.getElementById('visualSearchModal')) return;
  const host = document.createElement('div');
  host.innerHTML = `
  <div id="visualSearchModal" class="visualSearchModal" aria-hidden="true">
    <div class="visualSearchModal__backdrop" data-visual-close="1"></div>
    <div class="visualSearchModal__dialog" role="dialog" aria-modal="true" aria-labelledby="visualSearchModalTitle">
      <div class="visualSearchModal__header">
        <div>
          <div class="visualSearchModal__eyebrow">Visual search</div>
          <div id="visualSearchModalTitle" class="visualSearchModal__title">Find related news from a screenshot</div>
          <div class="visualSearchModal__sub">Upload a screenshot, drag and drop an image, or paste it from your clipboard. We will analyze the text and show matching stories in your feed.</div>
        </div>
        <button id="visualSearchClose" class="visualSearchModal__close" type="button" aria-label="Close visual search">✕</button>
      </div>
      <div class="visualSearchModal__body">
        <div id="visualSearchDropzone" class="visualSearchDropzone" data-processing="0">
          <div class="visualSearchDropzone__empty">
            <div class="visualSearchDropzone__icon" aria-hidden="true"></div>
            <div class="visualSearchDropzone__title">Drop your screenshot here</div>
            <div class="visualSearchDropzone__hint">Works with screenshots of headlines, cards, articles and posts. Better crops usually give better matches.</div>
            <div class="visualSearchDropzone__actions">
              <button id="visualSearchChooseBtn" class="visualSearchPrimaryBtn" type="button">Choose image</button>
              <button id="visualSearchPasteBtn" class="visualSearchGhostBtn" type="button">Paste image</button>
            </div>
            <div class="visualSearchDropzone__paste">You can also press Ctrl/Cmd + V</div>
          </div>
          <div class="visualSearchDropzone__previewWrap">
            <img id="visualSearchPreview" class="visualSearchPreviewImg" alt="Selected image preview" />
            <div class="visualSearchPreviewMeta">
              <div class="visualSearchPreviewName">
                <div class="visualSearchPreviewLabel">Selected file</div>
                <div id="visualSearchFileName" class="visualSearchPreviewFile">—</div>
              </div>
              <div class="visualSearchPreviewActions">
                <button id="visualSearchReplaceBtn" class="visualSearchSecondaryBtn" type="button">Replace image</button>
                <button id="visualSearchRunBtn" class="visualSearchPrimaryBtn" type="button" disabled>Analyze & find news</button>
              </div>
            </div>
          </div>
          <div class="visualSearchProcessing" aria-hidden="true">
            <div class="visualSearchProcessing__card">
              <div class="visualSearchProcessing__top">
                <div class="visualSearchSpinner" aria-hidden="true"></div>
                <div>
                  <div class="visualSearchProcessing__title">Analyzing your screenshot</div>
                  <div class="visualSearchProcessing__sub">Extracting text, understanding the topic and looking for related stories in your feed.</div>
                </div>
              </div>
              <div class="visualSearchProcessing__steps">
                <div class="visualSearchProcessing__step">Read image</div>
                <div class="visualSearchProcessing__step">Understand topic</div>
                <div class="visualSearchProcessing__step">Match stories</div>
              </div>
            </div>
          </div>
        </div>
        <div class="visualSearchModal__footer">
          <div id="visualSearchModalStatus" class="visualSearchModal__status"></div>
        </div>
      </div>
    </div>
  </div>
  <div id="visualSearchResultModal" class="visualResultModal" aria-hidden="true">
    <div class="visualResultModal__backdrop" data-visual-result-close="1"></div>
    <div class="visualResultModal__dialog" role="dialog" aria-modal="true" aria-labelledby="visualResultModalTitle">
      <div class="visualResultModal__header">
        <div>
          <div class="visualResultModal__eyebrow">Visual search</div>
          <div id="visualResultModalTitle" class="visualResultModal__title">News found</div>
          <div id="visualResultModalSub" class="visualResultModal__sub">We found the closest match and up to 5 related stories.</div>
        </div>
        <button id="visualResultClose" class="visualResultModal__close" type="button" aria-label="Close results">✕</button>
      </div>
      <div class="visualResultModal__body">
        <div id="visualResultSummary" class="visualResultSummary"></div>
        <div id="visualResultList" class="visualResultList"></div>
      </div>
    </div>
  </div>`;
  Array.from(host.children).forEach((node) => document.body.appendChild(node));
}
ensureVisualSearchModal();

const visualInputEl = qs("visualSearchInput");
const visualBtnEl = qs("btnVisualSearch");
const visualModalEl = qs("visualSearchModal");
const visualDropzoneEl = qs("visualSearchDropzone");
const visualPreviewEl = qs("visualSearchPreview");
const visualChooseBtnEl = qs("visualSearchChooseBtn");
const visualPasteBtnEl = qs("visualSearchPasteBtn");
const visualReplaceBtnEl = qs("visualSearchReplaceBtn");
const visualRunBtnEl = qs("visualSearchRunBtn");
const visualCloseBtnEl = qs("visualSearchClose");
const visualStatusEl = qs("visualSearchModalStatus");
const visualFileNameEl = qs("visualSearchFileName");
const visualResultModalEl = qs("visualSearchResultModal");
const visualResultCloseBtnEl = qs("visualResultClose");
const visualResultSummaryEl = qs("visualResultSummary");
const visualResultSubEl = qs("visualResultModalSub");
const visualResultListEl = qs("visualResultList");
let visualSelectedFile = null;
let visualPreviewUrl = "";
let visualPreviewReaderToken = 0;
let visualProcessingStepsTimer = null;
const visualAllowedTypes = new Set(['image/png', 'image/jpeg', 'image/jpg', 'image/webp']);

const VISUAL_SEARCH_LIMITS = Object.freeze({
  free: { limit: 3, resetHours: 24 },
  pro: { limit: 15, resetHours: 24 },
  analyst: { limit: -1, resetHours: 0 },
});
const VISUAL_SEARCH_LIMIT_NOTICE_MS = 6500;
let visualQuotaBubbleEl = null;
let visualQuotaNoticeEl = null;
let visualQuotaNoticeTimer = null;

function getVisualSearchPlan(){
  try {
    return String((typeof billingState !== 'undefined' && billingState && billingState.plan) ? billingState.plan : 'free').trim().toLowerCase() || 'free';
  } catch {
    return 'free';
  }
}

function getVisualSearchQuotaConfig(){
  const plan = getVisualSearchPlan();
  return VISUAL_SEARCH_LIMITS[plan] || VISUAL_SEARCH_LIMITS.free;
}

function getVisualSearchQuotaStorageKey(){
  let who = 'guest';
  try {
    if (authState?.authenticated && authState?.user?.id) who = `user:${String(authState.user.id)}`;
  } catch {}
  return `checkne.visualSearchQuota.v1.${who}`;
}

function readVisualSearchQuotaState(){
  const cfg = getVisualSearchQuotaConfig();
  const now = Date.now();
  if (!cfg || Number(cfg.limit) < 0) {
    return { used: 0, windowStart: now, resetAt: null };
  }
  let raw = null;
  try { raw = localStorage.getItem(getVisualSearchQuotaStorageKey()); } catch {}
  let parsed = {};
  if (raw) {
    try { parsed = JSON.parse(raw) || {}; } catch { parsed = {}; }
  }
  let windowStart = Number(parsed.windowStart || 0);
  let used = Math.max(0, Number(parsed.used || 0));
  const resetMs = Math.max(1, Number(cfg.resetHours || 24)) * 60 * 60 * 1000;
  if (!Number.isFinite(windowStart) || windowStart <= 0 || (windowStart + resetMs) <= now) {
    windowStart = now;
    used = 0;
    try { localStorage.setItem(getVisualSearchQuotaStorageKey(), JSON.stringify({ windowStart, used })); } catch {}
  }
  return { used, windowStart, resetAt: windowStart + resetMs };
}

function writeVisualSearchQuotaState(next){
  try {
    localStorage.setItem(getVisualSearchQuotaStorageKey(), JSON.stringify({
      used: Math.max(0, Number(next?.used || 0)),
      windowStart: Math.max(0, Number(next?.windowStart || Date.now())),
    }));
  } catch {}
}

function getVisualSearchQuotaInfo(){
  const cfg = getVisualSearchQuotaConfig();
  const plan = getVisualSearchPlan();
  if (!cfg || Number(cfg.limit) < 0) {
    return { plan, unlimited: true, limit: -1, remaining: Infinity, locked: false, resetAt: null, used: 0 };
  }
  const state = readVisualSearchQuotaState();
  const limit = Math.max(0, Number(cfg.limit || 0));
  const used = Math.max(0, Number(state.used || 0));
  const remaining = Math.max(0, limit - used);
  return {
    plan,
    unlimited: false,
    limit,
    used,
    remaining,
    locked: remaining <= 0,
    resetAt: Number(state.resetAt || 0) || null,
    windowStart: Number(state.windowStart || 0) || Date.now(),
  };
}

function consumeVisualSearchAttempt(){
  const info = getVisualSearchQuotaInfo();
  if (info.unlimited) return info;
  const used = Math.min(info.limit, Math.max(0, Number(info.used || 0)) + 1);
  writeVisualSearchQuotaState({ used, windowStart: info.windowStart });
  return getVisualSearchQuotaInfo();
}

function formatVisualSearchTimeLeft(resetAt){
  const target = Number(resetAt || 0);
  const diff = Math.max(0, target - Date.now());
  if (!diff) return 'less than a minute';
  const totalMinutes = Math.ceil(diff / 60000);
  const days = Math.floor(totalMinutes / (60 * 24));
  const hours = Math.floor((totalMinutes % (60 * 24)) / 60);
  const minutes = totalMinutes % 60;
  if (days >= 1) {
    return hours > 0 ? `${days}d ${hours}h` : `${days}d`;
  }
  if (hours >= 1) {
    return minutes > 0 ? `${hours}h ${minutes}m` : `${hours}h`;
  }
  return `${minutes}m`;
}

function ensureVisualQuotaBubble(){
  if (visualQuotaBubbleEl && document.body.contains(visualQuotaBubbleEl)) return visualQuotaBubbleEl;
  const el = document.createElement('div');
  el.className = 'visualSearchQuotaBubble';
  el.id = 'visualSearchQuotaBubble';
  el.setAttribute('aria-hidden', 'true');
  el.innerHTML = '<div class="visualSearchQuotaBubble__title"></div><div class="visualSearchQuotaBubble__text"></div>';
  document.body.appendChild(el);
  visualQuotaBubbleEl = el;
  return el;
}

function positionVisualQuotaBubble(){
  if (!visualQuotaBubbleEl || !visualBtnEl) return;
  const rect = visualBtnEl.getBoundingClientRect();
  const bubbleRect = visualQuotaBubbleEl.getBoundingClientRect();
  const left = Math.min(window.innerWidth - bubbleRect.width - 10, Math.max(10, rect.left + (rect.width / 2) - (bubbleRect.width / 2)));
  const top = Math.max(10, rect.top - bubbleRect.height - 14);
  visualQuotaBubbleEl.style.left = `${left}px`;
  visualQuotaBubbleEl.style.top = `${top}px`;
}

function hideVisualQuotaBubble(){
  if (!visualQuotaBubbleEl) return;
  visualQuotaBubbleEl.classList.remove('isVisible');
  visualQuotaBubbleEl.setAttribute('aria-hidden', 'true');
}

function showVisualQuotaBubble(){
  if (!visualBtnEl) return;
  const info = getVisualSearchQuotaInfo();
  if (!info.locked) {
    hideVisualQuotaBubble();
    return;
  }
  const el = ensureVisualQuotaBubble();
  const titleEl = el.querySelector('.visualSearchQuotaBubble__title');
  const textEl = el.querySelector('.visualSearchQuotaBubble__text');
  if (titleEl) titleEl.textContent = 'Image search is recharging';
  if (textEl) textEl.textContent = `Available again in ${formatVisualSearchTimeLeft(info.resetAt)}.`;
  el.setAttribute('aria-hidden', 'false');
  el.classList.add('isVisible');
  requestAnimationFrame(positionVisualQuotaBubble);
}

function ensureVisualQuotaNotice(){
  if (visualQuotaNoticeEl && document.body.contains(visualQuotaNoticeEl)) return visualQuotaNoticeEl;
  const el = document.createElement('div');
  el.className = 'visualSearchLimitNotice';
  el.id = 'visualSearchLimitNotice';
  el.setAttribute('aria-hidden', 'true');
  el.innerHTML = `
    <div class="visualSearchLimitNotice__copy">
      <div class="visualSearchLimitNotice__title"></div>
      <div class="visualSearchLimitNotice__text"></div>
    </div>
    <div class="visualSearchLimitNotice__actions">
      <button type="button" class="visualSearchLimitNotice__btn">See plans</button>
      <button type="button" class="visualSearchLimitNotice__close" aria-label="Close">✕</button>
    </div>`;
  document.body.appendChild(el);
  const close = () => hideVisualQuotaNotice();
  const cta = el.querySelector('.visualSearchLimitNotice__btn');
  const closeBtn = el.querySelector('.visualSearchLimitNotice__close');
  if (cta) cta.addEventListener('click', () => {
    hideVisualQuotaNotice();
    try {
      if (typeof window.__setMainPage === 'function') {
        window.history.pushState({}, '', '/pricing');
        window.__setMainPage('pricing');
      } else {
        window.location.href = '/pricing';
      }
    } catch {
      window.location.href = '/pricing';
    }
  });
  if (closeBtn) closeBtn.addEventListener('click', close);
  visualQuotaNoticeEl = el;
  return el;
}

function hideVisualQuotaNotice(){
  if (visualQuotaNoticeTimer) {
    clearTimeout(visualQuotaNoticeTimer);
    visualQuotaNoticeTimer = null;
  }
  if (!visualQuotaNoticeEl) return;
  visualQuotaNoticeEl.classList.remove('isVisible');
  visualQuotaNoticeEl.setAttribute('aria-hidden', 'true');
}

function showVisualQuotaNotice(){
  const info = getVisualSearchQuotaInfo();
  if (!info.locked) return;
  const el = ensureVisualQuotaNotice();
  const titleEl = el.querySelector('.visualSearchLimitNotice__title');
  const textEl = el.querySelector('.visualSearchLimitNotice__text');
  if (titleEl) titleEl.textContent = 'No image searches left right now';
  if (textEl) textEl.textContent = `Your next image search unlocks in ${formatVisualSearchTimeLeft(info.resetAt)}. Upgrade your plan to get more searches.`;
  el.setAttribute('aria-hidden', 'false');
  el.classList.add('isVisible');
  if (visualQuotaNoticeTimer) clearTimeout(visualQuotaNoticeTimer);
  visualQuotaNoticeTimer = setTimeout(() => hideVisualQuotaNotice(), VISUAL_SEARCH_LIMIT_NOTICE_MS);
}

function updateVisualSearchButtonQuotaUI(){
  if (!visualBtnEl) return;
  const info = getVisualSearchQuotaInfo();
  if (info.unlimited) {
    visualBtnEl.removeAttribute('data-has-count');
    visualBtnEl.removeAttribute('data-count');
    visualBtnEl.removeAttribute('data-locked');
    visualBtnEl.title = 'Search from image';
    return;
  }
  visualBtnEl.setAttribute('data-has-count', '1');
  visualBtnEl.setAttribute('data-count', String(info.remaining));
  visualBtnEl.setAttribute('data-locked', info.locked ? '1' : '0');
  visualBtnEl.title = info.locked
    ? `Image search available again in ${formatVisualSearchTimeLeft(info.resetAt)}`
    : `Search from image · ${info.remaining} left`;
}

function isVisualSearchQuotaLocked(){
  return !!getVisualSearchQuotaInfo().locked;
}

function setVisualStatus(msg = ""){
  if (visualStatusEl) visualStatusEl.textContent = String(msg || "");
}

function setVisualProcessingStep(index = 0){
  const steps = Array.from(document.querySelectorAll('.visualSearchProcessing__step'));
  steps.forEach((el, i) => el.classList.toggle('isActive', i <= index));
}

function startVisualProcessingAnimation(){
  stopVisualProcessingAnimation();
  let step = 0;
  setVisualProcessingStep(step);
  visualProcessingStepsTimer = setInterval(() => {
    step = (step + 1) % 3;
    setVisualProcessingStep(step);
  }, 900);
}

function stopVisualProcessingAnimation(){
  if (visualProcessingStepsTimer) {
    clearInterval(visualProcessingStepsTimer);
    visualProcessingStepsTimer = null;
  }
  setVisualProcessingStep(0);
}

function revokeVisualPreview(){
  visualPreviewReaderToken += 1;
  if (visualPreviewUrl) {
    try { URL.revokeObjectURL(visualPreviewUrl); } catch {}
    visualPreviewUrl = "";
  }
}

function loadVisualPreviewWithFileReader(file, token){
  try {
    const reader = new FileReader();
    reader.onload = () => {
      if (!visualPreviewEl || token !== visualPreviewReaderToken) return;
      const dataUrl = String(reader.result || '');
      if (!dataUrl) return;
      visualPreviewEl.src = dataUrl;
      setVisualStatus('');
    };
    reader.onerror = () => {
      if (token !== visualPreviewReaderToken) return;
      setVisualStatus('Could not show the image preview, but search will still work.');
    };
    reader.readAsDataURL(file);
  } catch {
    setVisualStatus('Could not show the image preview, but search will still work.');
  }
}

function clearVisualInputValue(){
  try { if (visualInputEl) visualInputEl.value = ''; } catch {}
}


async function loadVisualImageForOptimization(file){
  return await new Promise((resolve, reject) => {
    try {
      const url = URL.createObjectURL(file);
      const img = new Image();
      img.onload = () => {
        try { URL.revokeObjectURL(url); } catch {}
        resolve(img);
      };
      img.onerror = () => {
        try { URL.revokeObjectURL(url); } catch {}
        reject(new Error('Could not read this image.'));
      };
      img.src = url;
    } catch (err) {
      reject(err);
    }
  });
}

async function canvasToBlobAsync(canvas, type, quality){
  return await new Promise((resolve, reject) => {
    try {
      canvas.toBlob((blob) => {
        if (blob) resolve(blob);
        else reject(new Error('Could not compress image.'));
      }, type, quality);
    } catch (err) {
      reject(err);
    }
  });
}

async function optimizeVisualFileForUpload(file){
  if (!file) return { file, optimized: false, reason: 'empty' };

  const originalSize = Number(file.size || 0);
  const type = String(file.type || '').toLowerCase();
  const alreadySafe = originalSize <= VISUAL_SEARCH_MAX_UPLOAD_BYTES;
  if (alreadySafe && (type === 'image/jpeg' || type === 'image/jpg')) {
    return { file, optimized: false, reason: 'already-small', originalSize, finalSize: originalSize };
  }

  const img = await loadVisualImageForOptimization(file);
  const originalWidth = Math.max(1, Number(img.naturalWidth || img.width || 1));
  const originalHeight = Math.max(1, Number(img.naturalHeight || img.height || 1));
  const longestSide = Math.max(originalWidth, originalHeight);
  const initialScale = Math.min(1, VISUAL_SEARCH_MAX_DIMENSION / longestSide);

  let bestBlob = null;
  let bestWidth = originalWidth;
  let bestHeight = originalHeight;

  const qualities = [0.88, 0.8, 0.72, 0.64, 0.58, 0.5, 0.44];
  const scaleSteps = [
    initialScale,
    initialScale * 0.9,
    initialScale * 0.8,
    initialScale * 0.7,
    initialScale * 0.6,
    initialScale * 0.5,
  ].filter((value, index, arr) => value > 0 && arr.indexOf(value) === index);

  for (const scaleValue of scaleSteps) {
    const width = Math.max(VISUAL_SEARCH_MIN_DIMENSION, Math.round(originalWidth * Math.min(1, scaleValue || 1)));
    const height = Math.max(Math.round((width / originalWidth) * originalHeight), Math.min(500, VISUAL_SEARCH_MIN_DIMENSION));

    const canvas = document.createElement('canvas');
    canvas.width = width;
    canvas.height = height;
    const ctx = canvas.getContext('2d', { alpha: false });
    if (!ctx) continue;

    ctx.fillStyle = '#ffffff';
    ctx.fillRect(0, 0, width, height);
    ctx.imageSmoothingEnabled = true;
    ctx.imageSmoothingQuality = 'high';
    ctx.drawImage(img, 0, 0, width, height);

    for (const quality of qualities) {
      let blob = null;
      try {
        blob = await canvasToBlobAsync(canvas, 'image/jpeg', quality);
      } catch {
        blob = null;
      }
      if (!blob) continue;

      if (!bestBlob || blob.size < bestBlob.size) {
        bestBlob = blob;
        bestWidth = width;
        bestHeight = height;
      }

      if (blob.size <= VISUAL_SEARCH_SOFT_TARGET_BYTES) {
        const safeName = String(file.name || 'visual-search-image').replace(/\.[^.]+$/, '') || 'visual-search-image';
        return {
          file: new File([blob], `${safeName}.jpg`, { type: 'image/jpeg', lastModified: Date.now() }),
          optimized: true,
          reason: 'compressed',
          originalSize,
          finalSize: blob.size,
          width,
          height,
        };
      }
    }
  }

  if (bestBlob) {
    const safeName = String(file.name || 'visual-search-image').replace(/\.[^.]+$/, '') || 'visual-search-image';
    return {
      file: new File([bestBlob], `${safeName}.jpg`, { type: 'image/jpeg', lastModified: Date.now() }),
      optimized: bestBlob.size < originalSize,
      reason: 'best-effort',
      originalSize,
      finalSize: bestBlob.size,
      width: bestWidth,
      height: bestHeight,
    };
  }

  return { file, optimized: false, reason: 'fallback', originalSize, finalSize: originalSize, width: originalWidth, height: originalHeight };
}

function validateVisualFile(file){
  if (!file) return { ok:false, message: t('ui.visual_search_pick_image', 'Choose an image to start searching.') };
  const type = String(file.type || '').toLowerCase();
  if (!visualAllowedTypes.has(type)) {
    return { ok:false, message: t('ui.visual_search_bad_type', 'Please upload PNG, JPG, JPEG or WEBP.') };
  }
  if ((file.size || 0) > VISUAL_SEARCH_HARD_MAX_BYTES) {
    return { ok:false, message: t('ui.visual_search_too_large', 'Image is too large. Max 24 MB before optimization.') };
  }
  return { ok:true, message:'' };
}

function resetVisualModalState(){
  clearVisualInputValue();
  renderVisualPreview(null);
  setVisualStatus('');
}

function renderVisualPreview(file){
  visualSelectedFile = file || null;
  if (!visualDropzoneEl) return;
  if (!file) {
    visualDropzoneEl.classList.remove('hasImage');
    visualDropzoneEl.dataset.processing = "0";
    revokeVisualPreview();
    if (visualPreviewEl) {
      visualPreviewEl.removeAttribute('src');
      visualPreviewEl.style.visibility = 'hidden';
      visualPreviewEl.onload = null;
      visualPreviewEl.onerror = null;
    }
    if (visualFileNameEl) visualFileNameEl.textContent = '—';
    if (visualRunBtnEl) visualRunBtnEl.disabled = true;
    return;
  }
  const validation = validateVisualFile(file);
  if (!validation.ok) {
    setVisualStatus(validation.message);
    visualSelectedFile = null;
    if (visualRunBtnEl) visualRunBtnEl.disabled = true;
    return;
  }
  visualDropzoneEl.classList.add('hasImage');
  revokeVisualPreview();
  const token = visualPreviewReaderToken;
  if (visualPreviewEl) {
    visualPreviewEl.style.visibility = 'hidden';
    visualPreviewEl.onload = () => {
      if (token !== visualPreviewReaderToken) return;
      visualPreviewEl.style.visibility = 'visible';
      setVisualStatus('');
    };
    visualPreviewEl.onerror = () => {
      if (token !== visualPreviewReaderToken) return;
      loadVisualPreviewWithFileReader(file, token);
    };
  }
  let usedObjectUrl = false;
  try {
    visualPreviewUrl = URL.createObjectURL(file);
    usedObjectUrl = !!visualPreviewUrl;
    if (visualPreviewEl && visualPreviewUrl) visualPreviewEl.src = visualPreviewUrl;
  } catch {}
  if (!usedObjectUrl) loadVisualPreviewWithFileReader(file, token);
  if (visualFileNameEl) {
    const kb = Math.max(1, Math.round((file.size || 0) / 1024));
    visualFileNameEl.textContent = `${file.name || 'image'} · ${kb} KB`;
  }
  if (visualRunBtnEl) visualRunBtnEl.disabled = false;
}

function requireLoginForVisualSearch() {
  try {
    if (authState?.authenticated) return false;
    if (typeof window.toast === 'function') {
      window.toast('Please sign in first to use image search.', 'info');
    }
    if (typeof window.openAuthModal === 'function') window.openAuthModal('login');
    return true;
  } catch {
    return false;
  }
}

function openVisualModal(){
  if (!visualModalEl) return;
  visualModalEl.classList.add('isOpen');
  visualModalEl.setAttribute('aria-hidden', 'false');
  document.body.classList.add('visualSearchLock');
  setVisualStatus('');
}

function closeVisualModal(){
  if (!visualModalEl) return;
  if (visualDropzoneEl && visualDropzoneEl.dataset.processing === '1') return;
  visualModalEl.classList.remove('isOpen');
  visualModalEl.setAttribute('aria-hidden', 'true');
  document.body.classList.remove('visualSearchLock');
  resetVisualModalState();
}

function closeVisualResultModal(){
  if (!visualResultModalEl) return;
  visualResultModalEl.classList.remove('isOpen');
  visualResultModalEl.setAttribute('aria-hidden', 'true');
  document.body.classList.remove('visualSearchLock');
}

function openVisualResultModal(items, meta = {}){
  if (!visualResultModalEl || !visualResultListEl || !visualResultSummaryEl) return;
  const list = Array.isArray(items) ? items.slice(0, 5) : [];
  const query = String(meta.query || '').trim();
  const count = Number.isFinite(Number(meta.count)) ? Number(meta.count) : list.length;
  const top = list[0] || null;

  if (visualResultSubEl) {
    visualResultSubEl.textContent = query
      ? `We found a strong match for “${query}” and up to 5 related stories in your feed.`
      : 'We found the closest match and up to 5 related stories in your feed.';
  }

  const getItemImage = (item) => {
    try {
      return String(getNewsImage(item, 'thumb') || getNewsImage(item, 'card') || '').trim();
    } catch {
      return '';
    }
  };

  const renderThumb = (item, cls = '') => {
    const url = escapeHtml(getItemImage(item));
    const title = escapeHtml(String(item?.title || 'Story'));
    if (url) {
      return `<div class="visualResultThumb ${cls}"><img src="${url}" alt="" loading="lazy" onerror="this.closest('.visualResultThumb')?.setAttribute('data-image-state','empty'); this.remove();" /></div>`;
    }
    return `<div class="visualResultThumb ${cls}" data-image-state="empty" aria-hidden="true"><div class="visualResultThumb__ph">No image</div></div>`;
  };

  if (top) {
    const topTitle = escapeHtml(String(top.title || 'Story found'));
    const topSource = escapeHtml(String(top.source || top.outlet || 'Related coverage'));
    visualResultSummaryEl.innerHTML = `
      <div class="visualResultSummary__grid">
        ${renderThumb(top, 'visualResultSummary__thumb')}
        <div class="visualResultSummary__content">
          <div class="visualResultSummary__label">News found</div>
          <div class="visualResultSummary__title">${topTitle}</div>
          <div class="visualResultSummary__meta">${topSource} · ${Math.max(1, count)} result${Math.max(1, count) === 1 ? '' : 's'}</div>
        </div>
      </div>
    `;
  } else {
    visualResultSummaryEl.innerHTML = `
      <div class="visualResultSummary__label">News found</div>
      <div class="visualResultSummary__title">Story found</div>
      <div class="visualResultSummary__meta">${Math.max(1, count)} result${Math.max(1, count) === 1 ? '' : 's'}</div>
    `;
  }

  visualResultListEl.innerHTML = list.map((item, idx) => {
    const id = escapeHtml(getItemId(item));
    const titleRaw = String(item?.title || 'Untitled story');
    const title = escapeHtml(titleRaw);
    const source = escapeHtml(String(item?.source || item?.outlet || item?.topic || 'Related'));
    const topic = escapeHtml(String(item?.topic || 'general'));
    const country = escapeHtml(String(item?.country || ''));
    const score = Number(item?.score ?? item?.credibility_score ?? item?.credibility ?? 0) || 0;
    return `
      <button class="visualResultItem ${idx === 0 ? 'isPrimary' : ''}" type="button" data-visual-result-id="${id}" data-visual-result-title="${escapeHtml(titleRaw)}" data-visual-result-country="${country}">
        ${renderThumb(item)}
        <div class="visualResultItem__content">
          <div class="visualResultItem__topline">
            <div class="visualResultItem__rank">${idx === 0 ? 'Top match' : `Similar ${idx}`}</div>
            <div class="visualResultItem__score">${score}</div>
          </div>
          <div class="visualResultItem__title">${title}</div>
          <div class="visualResultItem__meta">${source} · ${topic}</div>
        </div>
      </button>`;
  }).join('');

  visualResultModalEl.classList.add('isOpen');
  visualResultModalEl.setAttribute('aria-hidden', 'false');
  document.body.classList.add('visualSearchLock');
}

function closeUploadAndShowVisualResults(items, meta = {}){
  if (visualModalEl) {
    visualModalEl.classList.remove('isOpen');
    visualModalEl.setAttribute('aria-hidden', 'true');
  }
  resetVisualModalState();
  openVisualResultModal(items, meta);
}

async function openVisualSearchResultAction(target = {}) {
  const id = String(target?.id || '').trim();
  const title = String(target?.title || '').trim();
  const desiredCountry = normalizeStoryCountry(target?.country);

  closeVisualResultModal();
  await ensurePersonalRecoOpenContext();

  let opened = false;
  try {
    if (typeof window.openStoryInFeed === 'function') {
      opened = !!(await window.openStoryInFeed({
        clusterId: id || null,
        title,
        exactTitleOnly: !!title,
        allowLooseTitleMatch: !title,
      }));
    }
  } catch (err) {
    console.warn('[visual-search] open in current feed failed', err);
  }
  if (opened) return true;

  if (desiredCountry && desiredCountry !== 'world' && desiredCountry !== String(state.country || '').trim().toLowerCase()) {
    try {
      await switchFeedCountryForPersonalReco(desiredCountry);
    } catch (err) {
      console.warn('[visual-search] switch feed country failed', err);
    }

    try {
      if (typeof window.openStoryInFeed === 'function') {
        opened = !!(await window.openStoryInFeed({
          clusterId: id || null,
          title,
          exactTitleOnly: !!title,
          allowLooseTitleMatch: !title,
        }));
      }
    } catch (err) {
      console.warn('[visual-search] open after country switch failed', err);
    }
    if (opened) return true;
  }

  if (id) {
    try {
      opened = focusNewsCardById(id, { open: true, block: 'center', maxAttempts: 28, delayMs: 120 });
    } catch {}
    if (opened) return true;
  }

  try {
    await fetchFeed({ reset: true, reason: 'visual-search-open-story' });
    await new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)));
    if (typeof window.openStoryInFeed === 'function') {
      opened = !!(await window.openStoryInFeed({
        clusterId: id || null,
        title,
        exactTitleOnly: !!title,
        allowLooseTitleMatch: !title,
      }));
    }
  } catch (err) {
    console.warn('[visual-search] refetch + open failed', err);
  }

  return !!opened;
}

async function pickVisualClipboardImage(){
  try {
    if (!navigator.clipboard || !navigator.clipboard.read) {
      throw new Error(t('ui.visual_search_clipboard_unavailable', 'Clipboard paste is not supported in this browser.'));
    }
    const items = await navigator.clipboard.read();
    for (const item of items) {
      const type = (item.types || []).find((tp) => String(tp || '').startsWith('image/'));
      if (!type) continue;
      const blob = await item.getType(type);
      const ext = String(type.split('/')[1] || 'png').replace(/[^a-z0-9]/gi, '') || 'png';
      const file = new File([blob], `clipboard-image.${ext}`, { type });
      clearVisualInputValue();
      renderVisualPreview(file);
      setVisualStatus('');
      return;
    }
    throw new Error(t('ui.visual_search_clipboard_empty', 'No image found in clipboard.'));
  } catch (e) {
    const msg = e?.message || t('ui.visual_search_clipboard_error', 'Could not read image from clipboard.');
    setVisualStatus(msg);
  }
}

function attachVisualFile(file){
  if (!file) return;
  clearVisualInputValue();
  renderVisualPreview(file);
  if (visualSelectedFile) setVisualStatus('');
}

if (visualBtnEl && visualInputEl) {
  const handleVisualTrigger = () => {
    if (requireLoginForVisualSearch()) return;
    if (isVisualSearchQuotaLocked()) {
      showVisualQuotaNotice();
      showVisualQuotaBubble();
      return;
    }
    hideVisualQuotaBubble();
    closeVisualResultModal();
    openVisualModal();
  };

  visualBtnEl.onclick = handleVisualTrigger;
  visualBtnEl.addEventListener('mouseenter', () => {
    if (isVisualSearchQuotaLocked()) showVisualQuotaBubble();
  });
  visualBtnEl.addEventListener('focus', () => {
    if (isVisualSearchQuotaLocked()) showVisualQuotaBubble();
  });
  visualBtnEl.addEventListener('mouseleave', hideVisualQuotaBubble);
  visualBtnEl.addEventListener('blur', hideVisualQuotaBubble);

  visualInputEl.addEventListener('change', async () => {
    if (requireLoginForVisualSearch()) { clearVisualInputValue(); return; }
    if (isVisualSearchQuotaLocked()) { clearVisualInputValue(); showVisualQuotaNotice(); return; }
    const file = visualInputEl.files && visualInputEl.files[0] ? visualInputEl.files[0] : null;
    attachVisualFile(file);
  });
}
if (visualChooseBtnEl) visualChooseBtnEl.onclick = () => { if (requireLoginForVisualSearch()) return; if (isVisualSearchQuotaLocked()) { showVisualQuotaNotice(); return; } try { visualInputEl.click(); } catch {} };
if (visualReplaceBtnEl) visualReplaceBtnEl.onclick = () => { if (requireLoginForVisualSearch()) return; if (isVisualSearchQuotaLocked()) { showVisualQuotaNotice(); return; } try { visualInputEl.click(); } catch {} };
if (visualRunBtnEl) visualRunBtnEl.onclick = () => { if (requireLoginForVisualSearch()) return; if (isVisualSearchQuotaLocked()) { showVisualQuotaNotice(); return; } runVisualSearch(visualSelectedFile); };
if (visualCloseBtnEl) visualCloseBtnEl.onclick = () => closeVisualModal();
if (visualPasteBtnEl) visualPasteBtnEl.onclick = () => { if (requireLoginForVisualSearch()) return; if (isVisualSearchQuotaLocked()) { showVisualQuotaNotice(); return; } pickVisualClipboardImage(); };
if (visualModalEl) {
  visualModalEl.addEventListener('click', (e) => {
    if (e.target && e.target.closest('[data-visual-close="1"]')) closeVisualModal();
  });
}
if (visualResultCloseBtnEl) visualResultCloseBtnEl.onclick = () => closeVisualResultModal();
if (visualResultModalEl) {
  visualResultModalEl.addEventListener('click', (e) => {
    if (e.target && e.target.closest('[data-visual-result-close="1"]')) {
      closeVisualResultModal();
      return;
    }
    const btn = e.target && e.target.closest('[data-visual-result-id]');
    if (!btn) return;
    const cardId = btn.getAttribute('data-visual-result-id') || '';
    const title = btn.getAttribute('data-visual-result-title') || '';
    const country = btn.getAttribute('data-visual-result-country') || '';
    void openVisualSearchResultAction({ id: cardId, title, country });
  });
}
if (visualDropzoneEl) {
  ['dragenter', 'dragover'].forEach((evt) => visualDropzoneEl.addEventListener(evt, (e) => {
    e.preventDefault();
    visualDropzoneEl.classList.add('isHover');
  }));
  ['dragleave', 'dragend', 'drop'].forEach((evt) => visualDropzoneEl.addEventListener(evt, (e) => {
    e.preventDefault();
    if (evt !== 'drop') visualDropzoneEl.classList.remove('isHover');
  }));
  visualDropzoneEl.addEventListener('drop', (e) => {
    visualDropzoneEl.classList.remove('isHover');
    const dt = e.dataTransfer;
    const file = dt && dt.files && dt.files[0] ? dt.files[0] : null;
    if (file) {
      if (isVisualSearchQuotaLocked()) { showVisualQuotaNotice(); return; }
      attachVisualFile(file);
    }
  });
}
window.addEventListener('resize', () => { if (visualQuotaBubbleEl && visualQuotaBubbleEl.classList.contains('isVisible')) positionVisualQuotaBubble(); });
document.addEventListener('scroll', () => { if (visualQuotaBubbleEl && visualQuotaBubbleEl.classList.contains('isVisible')) positionVisualQuotaBubble(); }, true);
document.addEventListener('click', (e) => {
  if (!visualQuotaNoticeEl || !visualQuotaNoticeEl.classList.contains('isVisible')) return;
  if (visualQuotaNoticeEl.contains(e.target)) return;
  if (visualBtnEl && visualBtnEl.contains(e.target)) return;
  hideVisualQuotaNotice();
});
window.addEventListener('checkne:auth-state', () => {
  hideVisualQuotaBubble();
  hideVisualQuotaNotice();
  updateVisualSearchButtonQuotaUI();
});
document.addEventListener('checkne:billingUpdated', () => {
  hideVisualQuotaBubble();
  hideVisualQuotaNotice();
  updateVisualSearchButtonQuotaUI();
});
updateVisualSearchButtonQuotaUI();

document.addEventListener('keydown', (e) => {
  const uploadOpen = !!(visualModalEl && visualModalEl.classList.contains('isOpen'));
  const resultOpen = !!(visualResultModalEl && visualResultModalEl.classList.contains('isOpen'));
  if (!uploadOpen && !resultOpen) return;
  if (e.key === 'Escape') {
    e.preventDefault();
    if (resultOpen) closeVisualResultModal();
    else closeVisualModal();
    return;
  }
  if (uploadOpen && (e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'v' && !visualSelectedFile) {
    setVisualStatus(t('ui.visual_search_paste_tip', 'Paste an image from your clipboard.'));
  }
});
document.addEventListener('paste', (e) => {
  if (!visualModalEl || !visualModalEl.classList.contains('isOpen')) return;
  if (requireLoginForVisualSearch()) return;
  if (isVisualSearchQuotaLocked()) { showVisualQuotaNotice(); return; }
  const items = Array.from(e.clipboardData?.items || []);
  const imgItem = items.find((it) => String(it.type || '').startsWith('image/'));
  if (!imgItem) return;
  const file = imgItem.getAsFile ? imgItem.getAsFile() : null;
  if (!file) return;
  e.preventDefault();
  attachVisualFile(file);
});

async function runVisualSearch(file){
  const validation = validateVisualFile(file);
  if (!validation.ok) {
    setVisualStatus(validation.message);
    return;
  }
  if (isVisualSearchQuotaLocked()) {
    showVisualQuotaNotice();
    setVisualStatus(`Image search becomes available again in ${formatVisualSearchTimeLeft(getVisualSearchQuotaInfo().resetAt)}.`);
    return;
  }

  let uploadFile = file;
  try {
    if ((file.size || 0) > VISUAL_SEARCH_MAX_UPLOAD_BYTES || /^image\/(png|heic|heif|webp)$/i.test(String(file.type || ''))) {
      setVisualStatus(t('ui.visual_search_step_preparing', 'Preparing image for upload...'));
      const optimized = await optimizeVisualFileForUpload(file);
      if (optimized && optimized.file) {
        uploadFile = optimized.file;
        const savedMb = Math.max(0, ((Number(optimized.originalSize || file.size || 0) - Number(optimized.finalSize || uploadFile.size || 0)) / (1024 * 1024)));
        if (optimized.optimized && savedMb > 0.05) {
          setVisualStatus(`Prepared image for upload · saved ${savedMb.toFixed(1)} MB`);
        }
      }
    }

    if ((uploadFile.size || 0) > VISUAL_SEARCH_MAX_UPLOAD_BYTES) {
      setVisualStatus('Large screenshot detected. Compressing more aggressively for production upload...');
      const retryOptimized = await optimizeVisualFileForUpload(uploadFile);
      if (retryOptimized && retryOptimized.file) uploadFile = retryOptimized.file;
    }

    if ((uploadFile.size || 0) > VISUAL_SEARCH_MAX_UPLOAD_BYTES) {
      throw new Error(`Image is still too large to upload safely (${Math.round((uploadFile.size || 0) / 1024)} KB). Try a tighter crop.`);
    }
  } catch (prepErr) {
    console.warn('[visual-search] upload optimization failed', prepErr);
    const prepMessage = prepErr?.message || 'Could not prepare this image for upload. Try a tighter crop or a smaller screenshot.';
    setVisualStatus(prepMessage);
    return;
  }

  state.visualSearch = { active: true, filename: String(file.name || 'image') };
  setFeedExpanded(false);
  setStatus(t('ui.visual_search_loading', 'Analyzing image and looking for related news...'));
  setVisualStatus(t('ui.visual_search_step_reading', 'Reading text from screenshot...'));

  const fd = new FormData();
  fd.append('image', uploadFile);
  fd.append('original_filename', String(file.name || uploadFile.name || 'image'));
  fd.append('ui_lang', String(state.language || 'en'));
  fd.append('country', String(state.country || 'world'));
  fd.append('language', 'all');
  fd.append('interests', (state.interests || []).join(','));
  fd.append('limit', String(getFeedLimitForCurrentPlan()));

  consumeVisualSearchAttempt();
  updateVisualSearchButtonQuotaUI();

  let btn = qs('btnVisualSearch');
  let input = qs('visualSearchInput');
  try {
    if (btn) {
      btn.disabled = true;
      btn.dataset.loading = '1';
    }
    if (visualDropzoneEl) visualDropzoneEl.dataset.processing = '1';
    if (visualRunBtnEl) visualRunBtnEl.disabled = true;
    if (visualChooseBtnEl) visualChooseBtnEl.disabled = true;
    if (visualReplaceBtnEl) visualReplaceBtnEl.disabled = true;
    if (visualPasteBtnEl) visualPasteBtnEl.disabled = true;
    startVisualProcessingAnimation();
  } catch {}

  try {
    const res = await fetch(`${API_BASE}/api/news/visual-search`, {
      method: 'POST',
      body: fd,
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(String(data?.detail || `HTTP ${res.status}`));

    const items = Array.isArray(data?.items) ? data.items : [];
    const extractedQuery = String(data?.query_used || data?.query || '').trim();
    const matchType = String(data?.match_type || 'related');
    const statusMessage = String(data?.message || '').trim();

    state.visualSearch = {
      active: true,
      filename: String(file.name || 'image'),
      query: extractedQuery,
      matchType,
      count: items.length,
    };
    savePrefs();

    try { window.__checkneFeedItems = items; } catch {}
    try { document.dispatchEvent(new CustomEvent('checkne:feedItemsUpdated', { detail: { items } })); } catch {}

    lastFeedItems = items;
    const newIds = updateSeenStateFromItems(items);
    currentFeedKey = `visual|${state.country}|${(state.interests || []).join(',')}|${Date.now()}`;

    renderCards(items, {
      nowTs: Date.now(),
      newIds,
      suppressNewBadges: !hasInitialFeedLoaded,
      incremental: false,
      animate: false,
    });
    updateTopStoriesCarousel(items);
    hasInitialFeedLoaded = true;

    const lastUpdatedEl = qs('lastUpdated');
    if (lastUpdatedEl) {
      const prefix = matchType === 'exact'
        ? t('ui.visual_search_result_exact', 'Exact match found')
        : matchType === 'high_confidence'
          ? t('ui.visual_search_result_strong', 'Strong matches found')
          : matchType === 'fallback'
            ? t('ui.visual_search_result_fallback', 'Fallback matches shown')
            : t('ui.visual_search_result_related', 'Related matches found');
      lastUpdatedEl.textContent = `${prefix} · ${items.length}`;
    }

    const statusText = extractedQuery
      ? t('ui.visual_search_done', 'Found related news for: {query}').replace('{query}', extractedQuery)
      : t('ui.visual_search_done_generic', 'Found related news from your image.');
    setStatus(statusMessage || statusText);
    setVisualStatus(statusMessage || t('ui.visual_search_success', 'Done. Matching stories are now shown in your feed.'));

    clearVisualInputValue();
    setTimeout(() => closeUploadAndShowVisualResults(items, {
      query: extractedQuery,
      count: items.length,
      matchType,
    }), 220);
  } catch (e) {
    console.error(e);
    const detail = String(e?.message || '').trim();
    const msg = /HTTP 413|too large/i.test(detail)
      ? 'This image is still too large for the live server. Try a smaller screenshot or a cropped area.'
      : `${t('ui.visual_search_error', 'Could not analyze this image.')} ${detail}`.trim();
    setStatus(msg);
    setVisualStatus(msg);
  } finally {
    stopVisualProcessingAnimation();
    try {
      if (btn) {
        btn.disabled = false;
        btn.dataset.loading = '0';
      }
      clearVisualInputValue();
      if (visualDropzoneEl) visualDropzoneEl.dataset.processing = '0';
      if (visualRunBtnEl) visualRunBtnEl.disabled = !visualSelectedFile;
      if (visualChooseBtnEl) visualChooseBtnEl.disabled = false;
      if (visualReplaceBtnEl) visualReplaceBtnEl.disabled = false;
      if (visualPasteBtnEl) visualPasteBtnEl.disabled = false;
      updateVisualSearchButtonQuotaUI();
    } catch {}
  }
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
    const resetBtn = qs('sortResetBtn');
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
    if (resetBtn) {
      resetBtn.addEventListener('click', ()=>{
        const newest = document.querySelector('input[name="sortOrder"][value="newest"]');
        const onlyConfirmedEl = qs('onlyConfirmed');
        const onlyAiSummaryEl = qs('onlyAiSummary');
        if (newest) newest.checked = true;
        if (minEl) minEl.value = '0';
        if (maxEl) maxEl.value = '100';
        if (onlyConfirmedEl) onlyConfirmedEl.checked = false;
        if (onlyAiSummaryEl) onlyAiSummaryEl.checked = false;
        applyFiltersUIToState();
        render();
      });
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
  if (tabFav)  tabFav.onclick  = () => { try { if (typeof window.__navigate === 'function') window.__navigate('/tracking'); else void setMode('fav'); } catch(_) { void setMode('fav'); } };

  const btnTracking = document.getElementById('btnTracking');
  if (btnTracking) {
    btnTracking.onclick = (e) => {
      e.preventDefault();
      e.stopPropagation();

      const currentPath = (() => {
        try {
          let p = String(window.location?.pathname || '/');
          p = p.split('?')[0].split('#')[0];
          if (p.length > 1) p = p.replace(/\/+$/, '');
          return p || '/';
        } catch { return '/'; }
      })();

      // When we are already inside Tracking, do not re-route the page again.
      // Just refresh the tab and re-apply the widgets visibility preference.
      if (currentPath === '/tracking' && state.mode === 'fav') {
        try {
          const trackingWidgetsOn = (typeof window.__trackingWidgetsVisible === 'function') ? !!window.__trackingWidgetsVisible() : false;
          if (typeof window.__setWidgetsEnabled === 'function') window.__setWidgetsEnabled(trackingWidgetsOn);
        } catch {}
        try{ applyTabs(); }catch{}
        try{ if (typeof fetchFavorites === 'function') fetchFavorites(); }catch{}
        return;
      }

      // Always route to /tracking so it works from ANY page (pricing/profile/info).
      try{
        if (typeof window.__navigate === 'function') { window.__navigate('/tracking'); return; }
      }catch{}

      // Fallback: ensure the main feed view is visible, then switch mode.
      try{ if (typeof setPage === 'function') setPage('feed'); }catch{}
      if (state.mode !== 'fav') void setMode('fav');
      else {
        try{ applyTabs(); }catch{}
        try{ if (typeof fetchFavorites === 'function') fetchFavorites(); }catch{}
      }
    };
  }

}

// FIX: widget scroll lock

function __openWidgetFix() {
  document.body.classList.add('widget-open');
}
function __closeWidgetFix() {
  document.body.classList.remove('widget-open');
}

(function(){
 const orig=window.renderCards;
 if(typeof orig==='function'){window.renderCards=function(){const r=orig.apply(this,arguments);try{window.dispatchEvent(new Event('feed:first-render'));}catch(e){} return r;}}
})();