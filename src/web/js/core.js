/*
 * CHECKNE Web App — core.js
 * Config + utils + deep links + share modal + i18n
 *
 * Split from the former monolithic app.js to keep responsibilities separated.
 * Keep files loaded in order (see index.html).
 */

const API_BASE = ""; // same-origin

async function apiFetchJson(url, options = {}) {
  const timeoutMs = Number.isFinite(Number(options.timeoutMs)) ? Number(options.timeoutMs) : 15000;
  const controller = new AbortController();
  const timer = window.setTimeout(() => controller.abort(new DOMException('Request timeout', 'AbortError')), timeoutMs);
  const merged = { ...options, signal: options.signal || controller.signal };
  try {
    const response = await fetch(url, merged);
    let data = null;
    try {
      data = await response.json();
    } catch {}
    if (!response.ok) {
      const detail = (data && (data.detail || data.message)) ? String(data.detail || data.message) : `HTTP ${response.status}`;
      const err = new Error(detail);
      err.status = response.status;
      err.payload = data;
      throw err;
    }
    return { response, data };
  } finally {
    window.clearTimeout(timer);
  }
}
window.apiFetchJson = apiFetchJson;

const CHECKNE_SUPPORTED_COUNTRIES = new Set(['world', 'gb', 'de', 'fr']);

function checkneNormalizeCountrySelection(value, fallback = 'world') {
  const normalized = String(value || '').trim().toLowerCase();
  if (CHECKNE_SUPPORTED_COUNTRIES.has(normalized)) return normalized;
  const normalizedFallback = String(fallback || 'world').trim().toLowerCase();
  return CHECKNE_SUPPORTED_COUNTRIES.has(normalizedFallback) ? normalizedFallback : 'world';
}
window.checkneNormalizeCountrySelection = checkneNormalizeCountrySelection;

function checkneCountryLabel(value) {
  const normalized = checkneNormalizeCountrySelection(value, 'world');
  if (normalized === 'de') return 'Germany';
  if (normalized === 'fr') return 'France';
  if (normalized === 'gb') return 'United Kingdom';
  return 'World';
}
window.checkneCountryLabel = checkneCountryLabel;

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

function __checkneFindCardInFeed({ clusterId = null, title = '', exactTitleOnly = false, allowLooseTitleMatch = true } = {}) {
  const cards = document.getElementById('cards');
  if (!cards) return null;
  const id = String(clusterId ?? '').trim();
  const hasNumericId = id !== '' && !Number.isNaN(Number(id));
  if (hasNumericId) {
    const exact = cards.querySelector(`.newsCard[data-id="${id}"], .newsCard[data-cluster-id="${id}"]`);
    if (exact) return exact;
    if (!title || !allowLooseTitleMatch) return null;
  }

  const normalizedTitle = __checkneNormalizeStoryTitle(title);
  if (!normalizedTitle) return null;

  const list = Array.from(cards.querySelectorAll('.newsCard'));
  let exactTitleMatch = null;
  let best = null;
  let bestScore = -1;
  for (const card of list) {
    const rawTitle = String(card.getAttribute('data-title') || card.querySelector('.newsTitle')?.textContent || '');
    const cardNorm = String(card.getAttribute('data-title-normalized') || '').trim() || __checkneNormalizeStoryTitle(rawTitle);
    if (!cardNorm) continue;
    if (cardNorm === normalizedTitle) {
      exactTitleMatch = card;
      break;
    }
    if (exactTitleOnly || !allowLooseTitleMatch) continue;
    let score = -1;
    if (cardNorm.includes(normalizedTitle) || normalizedTitle.includes(cardNorm)) {
      score = Math.min(cardNorm.length, normalizedTitle.length);
    } else {
      const words = normalizedTitle.split(/\s+/).filter(Boolean);
      const hits = words.filter(w => w.length >= 5 && cardNorm.includes(w)).length;
      if (hits >= 2) score = hits;
    }
    if (score > bestScore) {
      bestScore = score;
      best = card;
    }
  }
  if (exactTitleMatch) return exactTitleMatch;
  return (!exactTitleOnly && allowLooseTitleMatch && bestScore > 1) ? best : null;
}

function __checkneOpenCardElement(card) {
  if (!card) return false;
  const details = card.querySelector('details.newsDetails');
  const wasClosed = !!(details && !details.open);
  if (details && !details.open) {
    const body = details.querySelector('.newsOpenBody');
    if (body && typeof window.__checkneAnimateDetails === 'function') {
      try { window.__checkneAnimateDetails(details, body, true); } catch { details.open = true; }
    } else {
      details.open = true;
    }
  }
  if (typeof window.__checkneCenterNewsCardInViewport === 'function') {
    try {
      window.__checkneCenterNewsCardInViewport(card, {
        behavior: 'smooth',
        settlePasses: wasClosed ? 5 : 3,
        settleDelayMs: wasClosed ? 140 : 100,
      });
    } catch {
      try { card.scrollIntoView({ behavior: 'smooth', block: 'center', inline: 'nearest' }); } catch { try { card.scrollIntoView(); } catch {} }
    }
  } else {
    try { card.scrollIntoView({ behavior: 'smooth', block: 'center', inline: 'nearest' }); } catch { try { card.scrollIntoView(); } catch {} }
  }
  card.classList.add('isDeepLinked');
  setTimeout(() => card.classList.remove('isDeepLinked'), 1600);
  return true;
}

async function openStoryInFeed({ clusterId = null, title = '', exactTitleOnly = false, allowLooseTitleMatch = true } = {}) {
  const found = __checkneFindCardInFeed({ clusterId, title, exactTitleOnly, allowLooseTitleMatch });
  if (found) return __checkneOpenCardElement(found);
  if (clusterId != null && clusterId !== '' && !Number.isNaN(Number(clusterId))) {
    try {
      return await ensureItemInFeedAndOpen(Number(clusterId));
    } catch {}
  }
  if (title) {
    const exactTitleCard = __checkneFindCardInFeed({ title, exactTitleOnly: true, allowLooseTitleMatch: false });
    if (exactTitleCard) return __checkneOpenCardElement(exactTitleCard);
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

async function ensureTrackedAndOpenInTracking(clusterId) {
  const cid = Number(clusterId);
  if (!Number.isFinite(cid) || cid <= 0) return false;

  if (!authState?.authenticated) {
    openAuthModal('tracking');
    return false;
  }

  try {
    if (typeof isFav === 'function' && typeof toggleFav === 'function' && !isFav(cid)) {
      toggleFav(cid);
      if (typeof syncFavoritesToServer === 'function') {
        try { await syncFavoritesToServer(); } catch {}
      }
    }
  } catch {}

  try { localStorage.setItem('checkne_pending_tracking_open', String(cid)); } catch {}
  try { window.__pendingTrackingOpenClusterId = cid; } catch {}

  try {
    if (typeof window.__navigate === 'function') {
      window.__navigate('/tracking');
      return true;
    }
  } catch {}

  try {
    if (typeof setMode === 'function') {
      await setMode('fav');
      return true;
    }
  } catch {}

  return false;
}

window.ensureTrackedAndOpenInTracking = ensureTrackedAndOpenInTracking;

async function ensureItemInFeedAndOpen(clusterId) {
  // 1) If already rendered -> open
  if (openCardInDOM(clusterId)) return true;

  // 2) If the story already exists in the fetched feed but is hidden below the current
  // visible slice, reveal that part of the feed first, then open it.
  try {
    const idStr = String(clusterId ?? '').trim();
    const existingItems = Array.isArray(lastFeedItems) ? lastFeedItems : [];
    const existingIndex = existingItems.findIndex((it) => String(it?.cluster_id ?? it?.event_id ?? '') === idStr);
    if (existingIndex >= 0) {
      if (typeof window.ensureStoryVisibleInFeedById === 'function') {
        try { window.ensureStoryVisibleInFeedById(idStr); } catch {}
      }

      const story = existingItems[existingIndex];
      const reordered = existingItems.filter((_, idx) => idx !== existingIndex);
      const preferredInsertIndex = (typeof getPersonalRecoInsertIndex === 'function')
        ? getPersonalRecoInsertIndex(reordered)
        : 0;
      reordered.splice(Math.max(0, preferredInsertIndex), 0, story);
      lastFeedItems = reordered;
      if (typeof renderCards === 'function') {
        renderCards(reordered, {
          nowTs: Date.now(),
          newIds: new Set(),
          suppressNewBadges: true,
          incremental: false,
          animate: false,
        });
      }
      await new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)));
      if (openCardInDOM(clusterId)) return true;
    }
  } catch {}

  // 3) Try to fetch this single item and inject into current feed
  try {
    const interests = encodeURIComponent((state.interests || []).join(","));
    const country = encodeURIComponent(state.country || "world");
    const language = "all";
    const uiLang = encodeURIComponent(state.language || "en");
    const { data: j } = await apiFetchJson(
      `${API_BASE}/api/news/by_ids?ids=${encodeURIComponent(String(clusterId))}` +
        `&interests=${interests}&country=${country}&language=${language}&ui_lang=${uiLang}${(typeof window.__checkneBuildGuestPreviewIdsQuery === 'function' ? window.__checkneBuildGuestPreviewIdsQuery() : '')}`,
      { timeoutMs: 12000 }
    );
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
  const id = item?.cluster_id ?? item?.clusterId ?? item?.event_id ?? item?.eventId ?? item?.id;
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
    score: item?.score ?? item?.credibility_score ?? item?.credibility ?? item?.trust_score ?? item?.rating ?? null,
    outlets: item?.sources_count ?? item?.outlet_count ?? (Array.isArray(item?.sources) ? item.sources.length : null),
    sourceName: item?.primary_source || (Array.isArray(item?.sources) ? String(item.sources?.[0]?.source_name || '').trim() : ''),
    imageUrl: item?.image || item?.thumbnail || item?.thumb || item?.image_url || item?.imageUrl || item?.urlToImage || item?.thumbnail_url || item?.thumb_url || item?.hero_image || item?.heroImage || item?.lead_image_url || item?.leadImageUrl || item?.og_image || item?.ogImage || item?.open_graph_image || item?.openGraphImage || '',
  });
}

let __sharePhotoDragCleanup = null;
let __sharePhotoCropState = null;

function __destroySharePhotoDrag(){
  try { if (typeof __sharePhotoDragCleanup === 'function') __sharePhotoDragCleanup(); } catch {}
  __sharePhotoDragCleanup = null;
  __sharePhotoCropState = null;
}

function __setupSharePhotoDrag(data) {
  __destroySharePhotoDrag();

  const pane = document.getElementById('sharePhotoDragPane');
  const viewport = document.getElementById('sharePhotoViewport');
  const dragImg = document.getElementById('sharePhotoDragImg');
  const baseImg = document.getElementById('sharePreviewImg');
  if (!pane || !viewport || !dragImg || !baseImg) return;

  const src = String(data?.imageUrl || '').trim();
  if (!src) {
    pane.style.display = 'none';
    dragImg.removeAttribute('src');
    return;
  }

  pane.style.display = '';
  dragImg.draggable = false;
  dragImg.src = src;
  __sharePhotoCropState = { fx: 0.5, fy: 0.5 };

  let destroyed = false;
  let raf = 0;
  let tx = 0;
  let ty = 0;
  let minX = 0;
  let minY = 0;
  let dragging = false;
  let activePointerId = null;
  let startX = 0;
  let startY = 0;
  let startTx = 0;
  let startTy = 0;

  const clamp = (value, min, max) => Math.min(max, Math.max(min, value));

  const paint = () => {
    raf = 0;
    dragImg.style.transform = `translate(${tx}px, ${ty}px)`;
  };

  const queuePaint = () => {
    if (raf) return;
    raf = requestAnimationFrame(paint);
  };

  const layout = () => {
    if (destroyed || !dragImg.naturalWidth || !dragImg.naturalHeight) return;
    const rect = viewport.getBoundingClientRect();
    const vw = Math.max(0, rect.width);
    const vh = Math.max(0, rect.height);
    if (!vw || !vh) return;

    const scale = Math.max(vw / dragImg.naturalWidth, vh / dragImg.naturalHeight);
    const renderW = dragImg.naturalWidth * scale;
    const renderH = dragImg.naturalHeight * scale;

    dragImg.style.width = `${renderW}px`;
    dragImg.style.height = `${renderH}px`;

    minX = Math.min(0, vw - renderW);
    minY = Math.min(0, vh - renderH);

    if (!Number.isFinite(tx) || !Number.isFinite(ty)) {
      tx = minX / 2;
      ty = minY / 2;
    } else {
      tx = clamp(tx, minX, 0);
      ty = clamp(ty, minY, 0);
    }
    __sharePhotoCropState = {
      fx: (minX < 0) ? clamp((-tx) / (-minX || 1), 0, 1) : 0.5,
      fy: (minY < 0) ? clamp((-ty) / (-minY || 1), 0, 1) : 0.5,
    };
    queuePaint();
  };

  const onPointerDown = (e) => {
    if (e.pointerType === 'mouse' && e.button !== 0) return;
    dragging = true;
    activePointerId = e.pointerId;
    startX = e.clientX;
    startY = e.clientY;
    startTx = tx;
    startTy = ty;
    pane.classList.add('isDragging');
    try { pane.setPointerCapture(e.pointerId); } catch {}
    e.preventDefault();
  };

  const onPointerMove = (e) => {
    if (!dragging || activePointerId !== e.pointerId) return;
    tx = clamp(startTx + (e.clientX - startX), minX, 0);
    ty = clamp(startTy + (e.clientY - startY), minY, 0);
    __sharePhotoCropState = {
      fx: (minX < 0) ? clamp((-tx) / (-minX || 1), 0, 1) : 0.5,
      fy: (minY < 0) ? clamp((-ty) / (-minY || 1), 0, 1) : 0.5,
    };
    queuePaint();
    e.preventDefault();
  };

  const stopDrag = (e) => {
    if (!dragging || (e && activePointerId !== e.pointerId)) return;
    dragging = false;
    pane.classList.remove('isDragging');
    if (e) {
      try { pane.releasePointerCapture(e.pointerId); } catch {}
    }
    activePointerId = null;
  };

  const onBaseLoad = () => { layout(); };
  const onDragLoad = () => { tx = NaN; ty = NaN; layout(); };
  const onResize = () => { layout(); };
  const onDragError = () => { pane.style.display = 'none'; };

  dragImg.addEventListener('load', onDragLoad);
  dragImg.addEventListener('error', onDragError);
  baseImg.addEventListener('load', onBaseLoad);
  pane.addEventListener('pointerdown', onPointerDown);
  pane.addEventListener('pointermove', onPointerMove);
  pane.addEventListener('pointerup', stopDrag);
  pane.addEventListener('pointercancel', stopDrag);
  window.addEventListener('resize', onResize);

  if (dragImg.complete && dragImg.naturalWidth) onDragLoad();
  if (baseImg.complete && baseImg.naturalWidth) onBaseLoad();

  __sharePhotoDragCleanup = () => {
    destroyed = true;
    if (raf) cancelAnimationFrame(raf);
    pane.classList.remove('isDragging');
    dragImg.removeEventListener('load', onDragLoad);
    dragImg.removeEventListener('error', onDragError);
    baseImg.removeEventListener('load', onBaseLoad);
    pane.removeEventListener('pointerdown', onPointerDown);
    pane.removeEventListener('pointermove', onPointerMove);
    pane.removeEventListener('pointerup', stopDrag);
    pane.removeEventListener('pointercancel', stopDrag);
    window.removeEventListener('resize', onResize);
  };
}

function __shareUrlWithCrop(url) {
  try {
    const u = new URL(String(url || ''), location.origin);
    const fx = Number(__sharePhotoCropState?.fx);
    const fy = Number(__sharePhotoCropState?.fy);
    if (Number.isFinite(fx)) u.searchParams.set('fx', fx.toFixed(4));
    if (Number.isFinite(fy)) u.searchParams.set('fy', fy.toFixed(4));
    return u.toString();
  } catch {
    return String(url || '');
  }
}


function __ensureShareModalDom(){
  let backdrop = document.getElementById('shareBackdrop');
  if (backdrop) return backdrop;
  const html = `
  <div id="shareBackdrop" class="shareBackdrop" aria-hidden="true">
    <div class="shareModal" role="dialog" aria-modal="true" aria-labelledby="shareHeroTitle">
      <div class="shareBody">
        <div class="shareHero">
          <h1 id="shareHeroTitle">Share this event</h1>
          <p>Share a news event you find important or relevant.</p>
        </div>
        <div class="sharePanel">
          <div class="sharePanelLabel">ARTICLE PREVIEW</div>
          <div class="sharePreviewFrame">
            <div class="sharePreviewCanvas">
              <img id="sharePreviewImg" class="sharePreviewImg" alt="" />
              <div id="sharePhotoDragPane" class="sharePhotoDragPane" aria-label="Adjust photo crop">
                <div id="sharePhotoViewport" class="sharePhotoViewport">
                  <img id="sharePhotoDragImg" class="sharePhotoDragImg" alt="" />
                </div>
              </div>
              <div class="sharePreviewShade sharePreviewShade--top" aria-hidden="true"></div>
              <div class="sharePreviewShade sharePreviewShade--bottom" aria-hidden="true"></div>
              <div id="shareTrustBadge" class="shareTrustBadge" aria-hidden="true">Trust 0/100</div>
              <div class="shareBrandBadge" aria-hidden="true">CHECKNE.</div>
              <div class="shareHeadlineBox">
                <div id="shareHeadline" class="shareHeadline"></div>
                <div id="shareSubline" class="shareSubline"></div>
              </div>
            </div>
            <div class="sharePhotoHint">Drag the photo to adjust the crop</div>
          </div>
        </div>
        <div class="shareActions">
          <button id="shareToXBtn" class="shareAction primary" type="button"><img src="/static/icons/x.png" alt="X" /><span>Share on X</span></button>
          <button id="shareToThreadsBtn" class="shareAction secondary" type="button"><img src="/static/icons/treds.png" alt="Threads" /><span>Share on Threads</span></button>
          <button id="shareCopyBtn" class="shareAction ghost" type="button"><img src="/static/icons/copy.png" alt="Copy" /><span>Copy link</span></button>
        </div>
        <button id="shareNoThanks" class="shareNoThanks" type="button">No thanks!</button>
      </div>
    </div>
  </div>`;
  document.body.insertAdjacentHTML('beforeend', html);
  return document.getElementById('shareBackdrop');
}

function __shareScoreValue(data){
  const raw = Number(data?.score ?? data?.credibility_score ?? data?.credibility ?? data?.trust_score ?? data?.rating ?? 0);
  if (!Number.isFinite(raw)) return 0;
  return Math.max(0, Math.min(100, Math.round(raw)));
}

function __shareSublineText(data){
  const parts = [];
  const source = String(data?.sourceName || data?.primary_source || '').trim();
  const outlets = Number(data?.outlets);
  if (source) parts.push(source);
  if (Number.isFinite(outlets) && outlets > 0) parts.push(`${Math.round(outlets)} outlets`);
  return parts.join(' • ');
}

function openShareModal(data) {
  const backdrop = __ensureShareModalDom();
  const closeBtn = document.getElementById('shareCloseBtn'); // may be null if removed in UI
  const noThanks = document.getElementById('shareNoThanks');
  const img = document.getElementById('sharePreviewImg');
  const headline = document.getElementById('shareHeadline');
  const toX = document.getElementById('shareToXBtn');
  const toThreads = document.getElementById('shareToThreadsBtn');
  const copyBtn = document.getElementById('shareCopyBtn');
  const trustBadge = document.getElementById('shareTrustBadge');
  const subline = document.getElementById('shareSubline');

  if (!backdrop || !img || !headline || !toX || !toThreads || !copyBtn) {
    return copyShareLink(data.url);
  }

  // Populate UI
  headline.textContent = data.title || 'Share';
  if (trustBadge) trustBadge.textContent = `Trust ${__shareScoreValue(data)}/100`;
  if (subline) subline.textContent = __shareSublineText(data);
  img.style.display = '';
  img.src = `/api/share-image/${encodeURIComponent(data.id)}.png?dpr=2&v=${encodeURIComponent(data.v || Date.now())}`;
  __setupSharePhotoDrag(data);

  img.onerror = () => {
    img.removeAttribute('src');
    img.style.display = 'none';
    __destroySharePhotoDrag();
    const pane = document.getElementById('sharePhotoDragPane');
    const dragImg = document.getElementById('sharePhotoDragImg');
    if (pane) pane.style.display = 'none';
    if (dragImg) dragImg.removeAttribute('src');
  };

  const getShareUrl = () => __shareUrlWithCrop(data.url);
  const tweetText = encodeURIComponent(`Trust score • ${data.title || 'CHECKNE.'}`);
  const getXUrl = () => `https://twitter.com/intent/tweet?url=${encodeURIComponent(getShareUrl())}&text=${tweetText}`;

  toX.onclick = async () => {
    if (typeof window.__sharePromoBeforeOpen === 'function') {
      const shareUrl = getShareUrl();
      const handled = await window.__sharePromoBeforeOpen({ item: data, platform: 'x', defaultUrl: getXUrl(), defaultShareUrl: shareUrl });
      if (handled) return;
    }
    window.open(getXUrl(), '_blank', 'noopener,noreferrer');
  };

  // Threads doesn't provide a fully reliable web intent. Best UX: open Threads and copy the link.
  toThreads.onclick = async () => {
    if (typeof window.__sharePromoBeforeOpen === 'function') {
      const shareUrl = getShareUrl();
      const handled = await window.__sharePromoBeforeOpen({ item: data, platform: 'threads', defaultUrl: 'https://www.threads.net/', defaultShareUrl: shareUrl });
      if (handled) return;
    }
    await copyShareLink(getShareUrl());
    window.open('https://www.threads.net/', '_blank', 'noopener,noreferrer');
  };

  copyBtn.onclick = () => copyShareLink(getShareUrl());

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
  __destroySharePhotoDrag();
  const backdrop = document.getElementById('shareBackdrop');
  if (!backdrop) return;
  backdrop.classList.remove('isOpen');
  backdrop.setAttribute('aria-hidden', 'true');
}

async function copyShareLink(url){
  try{
    await navigator.clipboard.writeText(url);
    if (typeof toast === 'function') toast('Link copied');
    return true;
  }catch(e){
    try {
      if (typeof window.openCopyModal === 'function') {
        window.openCopyModal(url, {
          title: 'Copy link',
          meta: 'Share',
          hint: 'Copy this link manually if needed.'
        });
      }
    } catch {}
    return false;
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

function normalizeInterestSelection(list) {
  const allowed = new Set((DEFAULT_INTERESTS || []).map((x) => String(x || '').trim().toLowerCase()).filter(Boolean));
  const raw = Array.isArray(list) ? list : [];
  const uniq = [];
  const seen = new Set();

  for (const value of raw) {
    const v = String(value || '').trim().toLowerCase();
    if (!v || !allowed.has(v) || seen.has(v)) continue;
    seen.add(v);
    uniq.push(v);
  }

  const specifics = uniq.filter((x) => x !== 'general');
  if (specifics.length) return specifics;
  return ['general'];
}

window.normalizeInterestSelection = normalizeInterestSelection;


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


function getI18nOrphanMap() {
  try { return (I18N_DICT && I18N_DICT.orphans && typeof I18N_DICT.orphans === "object") ? I18N_DICT.orphans : {}; } catch {}
  return {};
}

function translateNodeTextByMap(root, dict) {
  if (!root || !dict || typeof dict !== 'object') return;
  const skipTags = new Set(['SCRIPT','STYLE','NOSCRIPT','CODE','PRE']);
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT, {
    acceptNode(node){
      if (!node || !node.parentElement) return NodeFilter.FILTER_REJECT;
      const parent = node.parentElement;
      if (skipTags.has(parent.tagName)) return NodeFilter.FILTER_REJECT;
      if (parent.closest('header, footer, #siteHeader, #siteFooter')) return NodeFilter.FILTER_REJECT;
      const raw = String(node.nodeValue || '');
      const normalized = raw.replace(/\s+/g, ' ').trim();
      if (!normalized) return NodeFilter.FILTER_REJECT;
      if (!Object.prototype.hasOwnProperty.call(dict, normalized)) return NodeFilter.FILTER_REJECT;
      return NodeFilter.FILTER_ACCEPT;
    }
  });
  const nodes = [];
  let current;
  while ((current = walker.nextNode())) nodes.push(current);
  nodes.forEach((node) => {
    const raw = String(node.nodeValue || '');
    const normalized = raw.replace(/\s+/g, ' ').trim();
    const translated = dict[normalized];
    if (!translated || translated === normalized) return;
    const leading = raw.match(/^\s*/)?.[0] || '';
    const trailing = raw.match(/\s*$/)?.[0] || '';
    node.nodeValue = `${leading}${translated}${trailing}`;
  });
}

function applyI18nOrphans(root = document.body) {
  const dict = getI18nOrphanMap();
  if (!root || !dict || !Object.keys(dict).length) return;
  translateNodeTextByMap(root, dict);
  const attrSelectors = [
    ['placeholder', 'input[placeholder], textarea[placeholder]'],
    ['title', '[title]'],
    ['aria-label', '[aria-label]']
  ];
  attrSelectors.forEach(([attr, selector]) => {
    root.querySelectorAll?.(selector)?.forEach((el) => {
      if (el.closest('header, footer, #siteHeader, #siteFooter')) return;
      const value = String(el.getAttribute(attr) || '').replace(/\s+/g, ' ').trim();
      if (!value) return;
      const translated = dict[value];
      if (translated && translated !== value) el.setAttribute(attr, translated);
    });
  });
}

let __i18nOrphanObserver = null;
let __i18nOrphanTimer = null;
function ensureI18nOrphanObserver() {
  if (__i18nOrphanObserver || typeof MutationObserver === 'undefined') return;
  __i18nOrphanObserver = new MutationObserver(() => {
    if (__i18nOrphanTimer) clearTimeout(__i18nOrphanTimer);
    __i18nOrphanTimer = setTimeout(() => applyI18nOrphans(document.body), 30);
  });
  try {
    __i18nOrphanObserver.observe(document.body, { childList: true, subtree: true, characterData: true, attributes: false });
  } catch {}
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
  applyI18nOrphans(document.body);
  ensureI18nOrphanObserver();
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