/*
 * CHECKNE Web App — tracking.js
 * Tracking/favorites persistence + trust score history chart
 *
 * Split from the former monolithic app.js to keep responsibilities separated.
 * Keep files loaded in order (see index.html).
 */



const TRACKING_FOCUS_KEY = 'checkne_tracking_focus_v1';

function _readTrackingFocusPayload(){
  try {
    const raw = sessionStorage.getItem(TRACKING_FOCUS_KEY);
    if (raw) {
      const parsed = JSON.parse(raw);
      if (parsed && Number.isFinite(Number(parsed.cluster_id))) return parsed;
    }
  } catch {}

  try {
    const legacy = localStorage.getItem('checkne_pending_tracking_open');
    const cid = Number(legacy);
    if (Number.isFinite(cid) && cid > 0) {
      return { cluster_id: cid, open_card: true, scroll_to_graph: true, ts: Date.now() };
    }
  } catch {}

  return null;
}

function _clearTrackingFocusPayload(){
  try { sessionStorage.removeItem(TRACKING_FOCUS_KEY); } catch {}
  try { localStorage.removeItem('checkne_pending_tracking_open'); } catch {}
  try { delete window.__pendingTrackingOpenClusterId; } catch {}
}

window.__queueTrackingFocus = function(clusterId, opts = {}){
  const cid = Number(clusterId);
  if (!Number.isFinite(cid) || cid <= 0) return false;
  const payload = {
    cluster_id: cid,
    open_card: opts.open_card !== false,
    scroll_to_graph: opts.scroll_to_graph !== false,
    ts: Date.now(),
  };
  try { sessionStorage.setItem(TRACKING_FOCUS_KEY, JSON.stringify(payload)); } catch {}
  try { localStorage.setItem('checkne_pending_tracking_open', String(cid)); } catch {}
  try { window.__pendingTrackingOpenClusterId = cid; } catch {}
  return true;
};

function _sleepTrackingFocus(ms){
  return new Promise(resolve => setTimeout(resolve, ms));
}

async function _waitForTrackingFocusTarget(clusterId, maxWaitMs = 3200){
  const started = Date.now();
  while ((Date.now() - started) < maxWaitMs) {
    const card = document.querySelector(`.newsCard[data-id="${String(clusterId)}"]`);
    if (card) return card;
    await _sleepTrackingFocus(80);
  }
  return null;
}

async function _waitForTrackingGraph(card, maxWaitMs = 2200){
  const started = Date.now();
  while ((Date.now() - started) < maxWaitMs) {
    const graph = card?.querySelector('.trustHistoryWrap, .trustChartCard, .trustChartSvg');
    if (graph) return graph;
    await _sleepTrackingFocus(80);
  }
  return null;
}

let __trackingFocusInFlight = false;
window.__consumeTrackingFocus = async function(){
  if (__trackingFocusInFlight) return false;
  if (!authState?.authenticated) return false;
  if (!state || state.mode !== 'fav') return false;

  const payload = _readTrackingFocusPayload();
  if (!payload) return false;

  const clusterId = Number(payload.cluster_id);
  if (!Number.isFinite(clusterId) || clusterId <= 0) {
    _clearTrackingFocusPayload();
    return false;
  }

  __trackingFocusInFlight = true;
  try {
    const card = await _waitForTrackingFocusTarget(clusterId);
    if (!card) return false;

    if (payload.open_card !== false) {
      try {
        if (typeof window.__checkneOpenCardElement === 'function') {
          window.__checkneOpenCardElement(card);
        } else {
          const details = card.querySelector('details.newsDetails');
          if (details && !details.open) details.open = true;
          try { card.scrollIntoView({ behavior: 'smooth', block: 'start' }); } catch {}
        }
      } catch {}
    }

    await _sleepTrackingFocus(260);

    if (payload.scroll_to_graph !== false) {
      const graphTarget = await _waitForTrackingGraph(card);
      if (graphTarget) {
        try { graphTarget.scrollIntoView({ behavior: 'smooth', block: 'center', inline: 'nearest' }); } catch {}
        graphTarget.classList.add('isTrackingFocusTarget');
        setTimeout(() => {
          try { graphTarget.classList.remove('isTrackingFocusTarget'); } catch {}
        }, 1800);
      }
    }

    _clearTrackingFocusPayload();
    return true;
  } finally {
    __trackingFocusInFlight = false;
  }
};

// --- Tracking delta persistence ---
// We keep the latest non-zero delta received from the server and keep showing it
// until the user opens the card (so the indicator doesn't disappear on refresh).
function loadTrackingDeltaState() {
  if (!authState.authenticated) return {};
  try { return JSON.parse(localStorage.getItem(getScopedDeltaKey()) || "{}") || {}; }
  catch { return {}; }
}
function saveTrackingDeltaState(obj) {
  if (!authState.authenticated) return;
  try { localStorage.setItem(getScopedDeltaKey(), JSON.stringify(obj || {})); }
  catch {}
}


// --- Trust score history (server-side, per cluster) ---
// History points are stored on the backend (PostgreSQL) so they are stable across devices.
const TRUST_HISTORY_CACHE = new Map(); // clusterId -> { items, fetchedAt }
const TRUST_HISTORY_INFLIGHT = new Map();
async function fetchTrustHistory(clusterId, limit = 60) {
  const cid = Number(clusterId);
  if (!Number.isFinite(cid)) return [];

  const cacheKey = `${cid}:${Number(limit) || 60}`;
  const cached = TRUST_HISTORY_CACHE.get(cacheKey);
  // short cache (20s) to avoid spamming when user opens/closes cards
  if (cached && (Date.now() - cached.fetchedAt) < 20_000) return cached.items || [];
  if (TRUST_HISTORY_INFLIGHT.has(cacheKey)) return await TRUST_HISTORY_INFLIGHT.get(cacheKey);

  const request = (async () => {
    const r = await fetch(`/api/trust-history/${cid}?limit=${encodeURIComponent(String(limit))}`, {
      credentials: 'include'
    });
    const data = await r.json().catch(() => ({}));
    const items = Array.isArray(data.items) ? data.items : [];
    TRUST_HISTORY_CACHE.set(cacheKey, { items, fetchedAt: Date.now() });
    return items;
  })();

  TRUST_HISTORY_INFLIGHT.set(cacheKey, request);
  try {
    return await request;
  } catch {
    return cached?.items || [];
  } finally {
    TRUST_HISTORY_INFLIGHT.delete(cacheKey);
  }
}


// Build SVG line chart for trust score history (0..100)
function _sharpPolylinePath(coords) {
  if (!coords || !coords.length) return '';
  const pts = coords.slice().sort((a, b) => (a.x - b.x) || (a.y - b.y));
  if (pts.length === 1) {
    return `M ${pts[0].x.toFixed(2)} ${pts[0].y.toFixed(2)}`;
  }

  let d = `M ${pts[0].x.toFixed(2)} ${pts[0].y.toFixed(2)}`;
  for (let i = 1; i < pts.length; i++) {
    d += ` L ${pts[i].x.toFixed(2)} ${pts[i].y.toFixed(2)}`;
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
  // Straight market-style line with subtle corner rounding for a cleaner premium look.
  const pathD = _sharpPolylinePath(coords);

  const plotX = padL;
  const plotY = padT;
  const plotW = (W - padL - padR);
  const plotH = (H - padT - padB);

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
    const prevX = (i > 0) ? coords[i - 1].x : plotX;
    const nextX = (i < coords.length - 1) ? coords[i + 1].x : (plotX + plotW);
    const leftEdge = (i > 0) ? ((prevX + c.x) / 2) : plotX;
    const rightEdge = (i < coords.length - 1) ? ((c.x + nextX) / 2) : (plotX + plotW);
    const hitX = Math.max(plotX, leftEdge);
    const hitW = Math.max(18, Math.min(plotX + plotW, rightEdge) - hitX);

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
        <rect class="ptHit" x="${hitX}" y="${plotY}" width="${hitW}" height="${plotH}"></rect>
        <circle class="ptHalo" cx="${c.x}" cy="${c.y}" r="13"></circle>
        <circle class="ptDot" cx="${c.x}" cy="${c.y}" r="6"></circle>
      </g>
    `;
  }).join('');

  // The plot is clipped to rounded corners. However, the line stroke and dot radius
  // extend beyond the mathematical plot area (e.g., score=100 sits exactly at padT),
  // which can make the topmost segment look "cut". Expand the clip region slightly
  // while keeping gestures limited to the visual plot area.
  const CLIP_PAD = 12;
  const clipY = Math.max(0, plotY - CLIP_PAD);
  const clipH = Math.min(H - clipY, plotH + CLIP_PAD);

  return `
  <svg class="trustChartSvg" viewBox="0 0 ${W} ${H}" width="100%" height="260" role="img" aria-label="Trust score history chart"
       data-plot-left="${plotX}" data-plot-right="${plotX + plotW}" data-view-w="${W}" data-view-h="${H}" data-plot-top="${plotY}" data-plot-height="${plotH}">
    <defs>
      <clipPath id="${clipId}">
        <rect x="${plotX}" y="${clipY}" width="${plotW}" height="${clipH}" rx="12" ry="12"></rect>
      </clipPath>
    </defs>

    ${grid}
    <line class="axisLine" x1="${padL}" y1="${padT}" x2="${padL}" y2="${H - padB}"></line>

    <!-- Pan/zoom gesture layer (behind dots) -->
    <rect class="trustPanLayer" x="${plotX}" y="${plotY}" width="${plotW}" height="${plotH}" fill="transparent"></rect>
    <rect class="trustSelectRect" x="${plotX}" y="${plotY}" width="0" height="0" rx="10" ry="10" style="display:none;"></rect>

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

  const plan = String((typeof billingState !== 'undefined' && billingState && billingState.plan) ? billingState.plan : 'free').toLowerCase();
  const locked = (plan === 'free');

  // We render a placeholder, then hydrate asynchronously from the server.
  // In Free, the chart is visible as a blurred teaser with an upgrade CTA.
  return `
    <div class="trustHistoryWrap ${locked ? 'isLocked' : ''}" data-trust-cid="${cid}">
      <div class="trustHistoryHeader">
        <div class="trustHistoryTitle">${t("ui.trust_score_history","Trust score history")}</div>
        <div class="trustChartControlsSlot" aria-hidden="true"></div>
      </div>

      <div class="trustHistoryLockFrame">
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
        <div class="trustChartHint">${t("ui.chart_hint","Tip: hover or tap anywhere on the chart for details, then scroll/pinch or use + / − to zoom")}</div>

        ${locked ? `
          <div class="trustLockOverlay" role="button" tabindex="0" aria-label="Get Pro">
            <button class="trustLockBtn" type="button">Get Pro</button>
          </div>
        ` : ''}
      </div>
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
  try{
    const res = await fetch(`${API_BASE}/api/favorites/sync`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ ids }),
    });
    if (!res.ok) return;

    const j = await res.json().catch(()=>null);
    if (j && Array.isArray(j.ids)) {
      const serverIds = j.ids.map(x=>Number(x)).filter(x=>Number.isFinite(x));
      // If server trimmed due to plan limit, accept server as source of truth.
      try{
        const cur = getFavIds();
        const same = (cur.length === serverIds.length) && cur.every((v,i)=>v===serverIds[i]);
        if (!same){
          setFavIds(serverIds);
        // Show upgrade modal if server trimmed due to plan limit.
        try{
          if (j && j.trimmed && typeof window.openUpgradeModal === 'function'){
            window.openUpgradeModal({ plan: j.plan || (billingState?.plan || 'free'), max: (typeof j.max === 'undefined' ? null : j.max) });
          }
        }catch{}
        }
      }catch{
        try{ setFavIds(serverIds); }catch{}
      }

      if (j.trimmed) {
        const max = (j.max == null) ? null : Number(j.max);
        try{
          if (typeof toast === 'function') toast(`🔒 Tracking limit reached${max ? ` (${max})` : ''}. Upgrade to add more.`);
        }catch{}
      }
    }
  }catch{
    // ignore
  }
}

async function pullFavoritesFromServerAndMerge() {
  // Legacy name kept for compatibility.
  return reconcileFavoritesOnLogin();
}

async function reconcileFavoritesOnLogin() {
  // Safe reconcile strategy:
  // 1) Load server favorites (source of truth across devices).
  // 2) If server empty and guest has favorites -> migrate guest -> server.
  // 3) Never merge random local favorites from another user into this user.
  try {
    if (!authState.authenticated) return;

    // 1) Pull server ids
    const res = await fetch(`${API_BASE}/api/favorites`, { credentials: 'include' });
    const data = await res.json().catch(() => ({}));
    const serverIds = Array.isArray(data.ids) ? data.ids.map(Number).filter(Number.isFinite) : [];

    // 2) Check guest ids (stored under guest scope)
    let guestIds = [];
    try {
      const raw = localStorage.getItem(scopedKey(FAV_KEY, getGuestScope()));
      const arr = raw ? JSON.parse(raw) : [];
      guestIds = Array.isArray(arr) ? arr.map(Number).filter(Number.isFinite) : [];
      guestIds = [...new Set(guestIds)];
    } catch {}

    if (serverIds.length > 0) {
      setFavIds(serverIds);
      return;
    }

    if (guestIds.length > 0) {
      // Migrate guest -> user and push to server once.
      setFavIds(guestIds);
      await syncFavoritesToServer();
      try { localStorage.removeItem(scopedKey(FAV_KEY, getGuestScope())); } catch {}
      return;
    }

    // Nothing anywhere
    setFavIds([]);
  } catch {}
}

// Keep lock state in sync if billing changes without a full reload.
function applyTrustLockState(){
  try{
    const plan = String(billingState?.plan || 'free').toLowerCase();
    const locked = (plan === 'free');
    for (const el of Array.from(document.querySelectorAll('.trustHistoryWrap'))){
      el.classList.toggle('isLocked', locked);
      const ov = el.querySelector('.trustLockOverlay');
      if (locked){
        if (!ov){
          const frame = el.querySelector('.trustHistoryLockFrame');
          if (frame){
            const div = document.createElement('div');
            div.className = 'trustLockOverlay';
            div.setAttribute('role','button');
            div.setAttribute('tabindex','0');
            div.innerHTML = '<button class="trustLockBtn" type="button">Get Pro</button>';
            frame.appendChild(div);
          }
        }
      }else{
        if (ov) ov.remove();
      }
    }
  }catch{}
}

document.addEventListener('checkne:billingUpdated', ()=>{
  applyTrustLockState();
});

// Upgrade CTA for locked charts (Free)
function __trustGoPro(){
  try{
    const params = new URLSearchParams();
    params.set('plan','pro');
    const url = `/pricing?${params.toString()}`;
    if (typeof window.__navigate === 'function') window.__navigate(url);
    else location.href = url;
  }catch{
    try{ location.href = '/pricing?plan=pro'; }catch{}
  }
}

document.addEventListener('click', (e)=>{
  const t = e && e.target;
  if (!(t instanceof Element)) return;
  const btn = t.closest('.trustLockOverlay, .trustLockBtn');
  if (!btn) return;
  e.preventDefault();
  e.stopPropagation();
  __trustGoPro();
}, { passive: false });

document.addEventListener('keydown', (e)=>{
  if (e.key !== 'Enter' && e.key !== ' ') return;
  const t = e && e.target;
  if (!(t instanceof Element)) return;
  if (!t.closest('.trustLockOverlay')) return;
  e.preventDefault();
  __trustGoPro();
});