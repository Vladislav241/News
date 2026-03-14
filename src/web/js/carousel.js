/*
 * CHECKNE Web App — carousel.js
 * Top stories carousel + image helpers
 *
 * Split from the former monolithic app.js to keep responsibilities separated.
 * Keep files loaded in order (see index.html).
 */

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
  if (!arr.length) return [];

  const MAX_TOP_STORIES = 6;
  const MIN_FILL_COUNT = 4;

  const byPriority = (a, b) => {
    const sa = Number(a?.sources_count ?? (a?.sources ? a.sources.length : 0));
    const sb = Number(b?.sources_count ?? (b?.sources ? b.sources.length : 0));
    if (sa !== sb) return sb - sa;

    const ia = Number(a?.importance ?? 0);
    const ib = Number(b?.importance ?? 0);
    if (ia !== ib) return ib - ia;

    const ua = Date.parse(a?.updated_at || a?.latest_published_at || a?.created_at || '') || 0;
    const ub = Date.parse(b?.updated_at || b?.latest_published_at || b?.created_at || '') || 0;
    return ub - ua;
  };

  const sorted = [...arr].sort(byPriority);
  const trending = sorted.filter(it => !!it?.is_trending);

  // Prefer trending stories, but do not leave the hero with only 1 item
  // when the current feed (for example "general") clearly has enough news.
  const selected = [];
  const seen = new Set();

  const pushUnique = (item) => {
    if (!item) return;
    const key = String(item?.cluster_id ?? item?.event_id ?? item?.id ?? '');
    if (!key || seen.has(key)) return;
    seen.add(key);
    selected.push(item);
  };

  trending.forEach(pushUnique);

  if (selected.length < MIN_FILL_COUNT) {
    sorted.forEach(pushUnique);
  }

  return selected.slice(0, MAX_TOP_STORIES);
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
    const imgUrl = getNewsImage(it, 'hero');

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
  if (st === "failed") {
    return { status: "empty", text: "AI summary is not available for this story yet." };
  }
  if (st === "ready") {
    return { status: "empty", text: "AI summary is not available for this story yet." };
  }
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
    const safeHref = (typeof buildSourceReaderUrl === 'function')
      ? buildSourceReaderUrl(url, ev.title || url, ev.source_name || ev.name || 'unknown')
      : url;
    return `<div class="evLine"><span class="evTag">${escapeHtml(label)}:</span> <b>${name}</b> — <a href="${safeHref}" target="_blank" rel="noopener noreferrer">${title || escapeHtml(url)}</a></div>`;
  }
  return `<div class="evLine"><span class="evTag">${escapeHtml(label)}:</span> <b>${name}</b> — ${title}</div>`;
}