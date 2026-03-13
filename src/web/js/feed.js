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
const FEED_AUTO_BATCH_SIZE = 10;

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


function focusNewsCardById(cardId, opts = {}) {
  const id = String(cardId || '').trim();
  if (!id) return false;
  const maxAttempts = Number.isFinite(Number(opts.maxAttempts)) ? Number(opts.maxAttempts) : 24;
  const delayMs = Number.isFinite(Number(opts.delayMs)) ? Number(opts.delayMs) : 120;
  const shouldOpen = opts.open !== false;
  const scrollBlock = String(opts.block || 'center');

  let attempts = 0;
  const run = () => {
    const card = document.querySelector(`.newsCard[data-id="${id}"]`);
    if (!card) {
      if (attempts++ >= maxAttempts) return;
      setTimeout(run, delayMs);
      return;
    }

    const details = card.querySelector('details.newsDetails');
    if (details && shouldOpen && !details.open) {
      try { details.open = true; } catch {}
    }

    try {
      card.scrollIntoView({ behavior: 'smooth', block: scrollBlock, inline: 'nearest' });
    } catch {
      try { card.scrollIntoView(); } catch {}
    }

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
  const metaAge = formatRelativeTimeFromNow(metaTime);
  const primarySource = pickPrimarySourceName(item);
  const metaLabel = isNew ? t('ui.new', 'New') : t('ui.updated', 'Updated');
  const sourcePrefix = t('feed.source_prefix', 'Source');
  const outletsLabel = t('feed.outlets', 'outlets');
  const metaLine =
    `${escapeHtml(sourcePrefix)}: ${escapeHtml(primarySource)} · ${sourcesCount} ${escapeHtml(outletsLabel)} · ${escapeHtml(item.country || 'world')} / ${escapeHtml(item.language || 'en')}` +
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

  const sourcesHtml = (item.sources || [])
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
      return `<div class="sourceRow">• <b>${src}</b>${mark} — <a href="${openHref}" target="_blank" rel="noopener noreferrer">${t || escapeHtml(rawUrl || '#')}</a> <span class="muted">${escapeHtml(pub)}</span></div>`;
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
  } else if (aiState.status === 'empty') {
    summaryHtml = `<div class="aiSummaryBlock" data-status="empty">
      <div class="aiSummaryTitle">${t("ui.ai_summary","AI Summary")}</div>
      <div class="aiSummaryText"><span class="muted">${escapeHtml(aiState.text || 'AI summary is not available for this story yet.')}</span></div>
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

  // --- Event map
  let eventMapHtml = '';
  try {
    const mapLoc = item?.map_location;
    const lat = Number(mapLoc?.lat);
    const lng = Number(mapLoc?.lon ?? mapLoc?.lng);
    if (score > 70 && Number.isFinite(lat) && Number.isFinite(lng)) {
      const mapLabel = escapeHtml(String(mapLoc?.label || 'Mapped location'));
      eventMapHtml = `
        <details class="accordion" open>
          <summary class="accordionSummary">Event map</summary>
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
          <summary class="accordionSummary">Source differences</summary>
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
    <img class="shareIcon" src="/static/icons/Share.svg" alt="Share" />
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
                <div class="scoreBadge ${score < LOW_SCORE_THRESHOLD ? 'dark' : 'light'}">${score} / 100</div>
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
          <span class="chip">${escapeHtml(item.country || 'world')}/${escapeHtml(item.language || 'en')}</span>
          <span class="chip">Latest: ${escapeHtml(item.latest_published_at ? new Date(item.latest_published_at).toLocaleString() : '')}</span>
        </div>
        ${whyHtml}
        ${eventMapHtml}
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
    visible = visible.slice(0, getFeedVisibleLimit(filtered.length));
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

}


function resetFeedAutoLoadState() {
  __feedVisibleLimit = (typeof FEED_PAGE_SIZE !== 'undefined' ? FEED_PAGE_SIZE : 10);
  __feedAutoPaused = false;
  __feedAutoExpandLatch = false;
  clearFeedAutoExpandTimer();
  resetLoadMoreLoaderState();
}

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
  const signal = options.signal;

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
  const res = await fetch(url, signal ? { signal } : undefined);
  if (!res.ok) {
    if (!quiet) setStatus(`${t("ui.error_api_news","Error /api/news")}: ${res.status}`);
    return;
  }

  const data = await res.json();
  const items = data.items || [];

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

    try { window.__checkneFeedItems = items; } catch {}
    try { document.dispatchEvent(new CustomEvent("checkne:feedItemsUpdated", { detail: { items } })); } catch {}

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

function validateVisualFile(file){
  if (!file) return { ok:false, message: t('ui.visual_search_pick_image', 'Choose an image to start searching.') };
  const type = String(file.type || '').toLowerCase();
  if (!visualAllowedTypes.has(type)) {
    return { ok:false, message: t('ui.visual_search_bad_type', 'Please upload PNG, JPG, JPEG or WEBP.') };
  }
  if ((file.size || 0) > 8 * 1024 * 1024) {
    return { ok:false, message: t('ui.visual_search_too_large', 'Image is too large. Max 8 MB.') };
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
    const title = escapeHtml(String(item?.title || 'Untitled story'));
    const source = escapeHtml(String(item?.source || item?.outlet || item?.topic || 'Related'));
    const topic = escapeHtml(String(item?.topic || 'general'));
    const score = Number(item?.score ?? item?.credibility_score ?? item?.credibility ?? 0) || 0;
    return `
      <button class="visualResultItem ${idx === 0 ? 'isPrimary' : ''}" type="button" data-visual-result-id="${id}">
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
  visualBtnEl.onclick = () => {
    closeVisualResultModal();
    openVisualModal();
  };
  visualInputEl.addEventListener('change', async () => {
    const file = visualInputEl.files && visualInputEl.files[0] ? visualInputEl.files[0] : null;
    attachVisualFile(file);
  });
}
if (visualChooseBtnEl) visualChooseBtnEl.onclick = () => { try { visualInputEl.click(); } catch {} };
if (visualReplaceBtnEl) visualReplaceBtnEl.onclick = () => { try { visualInputEl.click(); } catch {} };
if (visualRunBtnEl) visualRunBtnEl.onclick = () => { runVisualSearch(visualSelectedFile); };
if (visualCloseBtnEl) visualCloseBtnEl.onclick = () => closeVisualModal();
if (visualPasteBtnEl) visualPasteBtnEl.onclick = () => pickVisualClipboardImage();
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
    closeVisualResultModal();
    focusNewsCardById(cardId, { open: true, block: 'center', maxAttempts: 28, delayMs: 120 });
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
    if (file) attachVisualFile(file);
  });
}
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

  state.visualSearch = { active: true, filename: String(file.name || 'image') };
  setFeedExpanded(false);
  setStatus(t('ui.visual_search_loading', 'Analyzing image and looking for related news...'));
  setVisualStatus(t('ui.visual_search_step_reading', 'Reading text from screenshot...'));

  const fd = new FormData();
  fd.append('image', file);
  fd.append('ui_lang', String(state.language || 'en'));
  fd.append('country', String(state.country || 'world'));
  fd.append('language', 'all');
  fd.append('interests', (state.interests || []).join(','));
  fd.append('limit', String(getFeedLimitForCurrentPlan()));

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
    const msg = `${t('ui.visual_search_error', 'Could not analyze this image.')} ${e?.message || ''}`.trim();
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
  if (tabFav)  tabFav.onclick  = () => { try { if (typeof window.__navigate === 'function') window.__navigate('/tracking'); else void setMode('fav'); } catch(_) { void setMode('fav'); } };

  const btnTracking = document.getElementById('btnTracking');
  if (btnTracking) {
    btnTracking.onclick = (e) => {
      e.preventDefault();
      e.stopPropagation();

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