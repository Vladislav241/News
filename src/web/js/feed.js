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
  // Notify side widgets (best-effort)
  try { document.dispatchEvent(new CustomEvent("checkne:feedRendered")); } catch {}

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
  const trendId = (state && state.trendClusterId) ? encodeURIComponent(String(state.trendClusterId)) : "";

  // If the user pasted a URL into Search, show similar items from the feed.
  const isUrl = /^https?:\/\//i.test(rawQ);

  const url = isUrl
    ? `${API_BASE}/api/news/similar?url=${q}` +
      `&ui_lang=${encodeURIComponent(state.language || "en")}`
    : `${API_BASE}/api/news?interests=${interests}` +
      `&country=${encodeURIComponent(state.country)}` +
      `&language=all` +
      `&ui_lang=${encodeURIComponent(state.language || "en")}` +
      (trendId ? `&trend_cluster_id=${trendId}` : "") +
      (q ? `&q=${q}` : "");


  const feedKey = `${state.country}|${(state.interests || []).join(",")}|${(state.q || "").trim()}|${state.trendClusterId || ""}`;

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