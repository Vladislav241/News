(function(){
  const CACHE_KEY = 'checkne_guest_landing_preview_v7';
  const CACHE_TTL_MS = 60 * 60 * 1000;
  const REFRESH_INTERVAL_MS = 60 * 60 * 1000;
  const MIN_SCORE = 80;
  const PREVIEW_LIMIT = 500;

  function q(id){ return document.getElementById(id); }
  function esc(v){
    return String(v == null ? '' : v)
      .replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;')
      .replace(/"/g,'&quot;').replace(/'/g,'&#39;');
  }
  function isAuthed(){ try { return !!authState?.authenticated; } catch { return false; } }
  function normPath(){
    try {
      let p = String(window.location?.pathname || '/').split('?')[0].split('#')[0];
      if (!p.startsWith('/')) p = '/' + p;
      if (p.length > 1) p = p.replace(/\/+$/,'');
      return p || '/';
    } catch { return '/'; }
  }
  function shouldShow(){ return !isAuthed() && normPath() === '/'; }
  function scoreOf(item){
    const n = Number(item?.credibility_score ?? item?.trust_score ?? item?.score ?? 0);
    return Number.isFinite(n) ? Math.max(0, Math.min(100, Math.round(n))) : 0;
  }
  function formatScore(item){ return `${scoreOf(item)}/100`; }
  function outletsCount(item){
    const n = Number(item?.sources_count ?? item?.outlets_count ?? item?.outlets ?? 0);
    return Number.isFinite(n) && n > 0 ? n : 0;
  }
  function firstSourceName(item){
    const direct = String(item?.first_source_name || item?.source_name || item?.source || '').trim();
    if (direct) return direct;
    const arr = Array.isArray(item?.sources) ? item.sources : [];
    for (const s of arr){
      const nm = String(s?.source_name || s?.name || '').trim();
      if (nm) return nm;
    }
    return 'Source';
  }
  function titleCase(s){ const v = String(s||'').trim(); return v ? v.charAt(0).toUpperCase() + v.slice(1) : ''; }
  function metaCountry(item){
    const map = { world:'world', us:'USA', gb:'UK', de:'Germany', fr:'France', ir:'Iran', iran:'Iran' };
    const country = String(item?.country || 'world').trim().toLowerCase();
    return map[country] || titleCase(country) || 'World';
  }
  function relativeUpdated(item){
    const raw = item?.updated_at || item?.published_at || item?.published || item?.updated;
    const ms = raw ? Date.parse(String(raw)) : NaN;
    if (!Number.isFinite(ms)) return '';
    const diff = Math.max(0, Date.now() - ms);
    const min = Math.floor(diff / 60000);
    if (min < 1) return 'Updated now';
    if (min < 60) return `Updated ${min}m ago`;
    const h = Math.floor(min / 60);
    if (h < 48) return `Updated ${h}h ago`;
    const d = Math.floor(h / 24);
    return `Updated ${d}d ago`;
  }
  function imageFor(item){ return item?.image_url || item?.image || item?.thumbnail || ''; }
  function flameIcon(){
    return '<img class="guestLandingFire" src="/static/icons/new.svg" alt="Trending">';
  }

  function normalizeOutletName(v){
    return String(v || '')
      .replace(/\s+(World|Top Stories|Top|UK|EN|FR|Politics|Business|Technology|International)$/i, '')
      .replace(/\s+/g, ' ')
      .trim();
  }
  function domainFromUrl(v){
    try {
      const u = new URL(String(v || '').trim());
      return String(u.hostname || '').replace(/^www\./i, '');
    } catch { return ''; }
  }
  function fallbackDomainForName(name){
    const key = String(name || '').trim().toLowerCase();
    const map = {
      'bbc':'bbc.com',
      'cnn':'cnn.com',
      'reuters':'reuters.com',
      'the guardian':'theguardian.com',
      'guardian':'theguardian.com',
      'ap':'apnews.com',
      'associated press':'apnews.com',
      'npr':'npr.org',
      'financial times':'ft.com',
      'al jazeera':'aljazeera.com',
      'france24':'france24.com',
      'france 24':'france24.com',
      'politico':'politico.com',
      'sky news':'news.sky.com',
      'axios':'axios.com',
      'semafor':'semafor.com',
      'the telegraph':'telegraph.co.uk',
      'the independent':'independent.co.uk',
      'usa today':'usatoday.com',
      'wall street journal':'wsj.com',
      'new york times':'nytimes.com'
    };
    return map[key] || '';
  }
  function sourceFavicon(domain){
    const d = String(domain || '').trim();
    if (!d) return '';
    return `https://www.google.com/s2/favicons?domain_url=${encodeURIComponent(`https://${d}`)}&sz=128`;
  }
  function buildSourcesMarquee(items){
    const host = q('guestLandingSources');
    if (!host) return;
    const seen = new Set();
    const sources = [];
    const push = (name, url='') => {
      const label = normalizeOutletName(name);
      if (!label) return;
      const key = label.toLowerCase();
      if (seen.has(key)) return;
      seen.add(key);
      const domain = domainFromUrl(url) || fallbackDomainForName(label);
      sources.push({ label, domain });
    };
    (Array.isArray(items) ? items : []).forEach((item) => {
      push(item?.first_source_name || item?.source_name || item?.source, item?.url || item?.link || item?.source_url);
      const srcs = Array.isArray(item?.sources) ? item.sources : [];
      srcs.forEach((s) => push(s?.source_name || s?.name, s?.url || s?.source_url || s?.link));
    });
    [
      ['The New York Times','nytimes.com'],
      ['The Guardian','theguardian.com'],
      ['BBC','bbc.com'],
      ['Reuters','reuters.com'],
      ['CNN','cnn.com'],
      ['AP','apnews.com'],
      ['NPR','npr.org'],
      ['Financial Times','ft.com'],
      ['Al Jazeera','aljazeera.com'],
      ['France 24','france24.com'],
      ['Politico','politico.com'],
      ['Sky News','news.sky.com']
    ].forEach(([name, domain]) => push(name, `https://${domain}`));
    const seed = sources.length ? sources.slice(0, 10) : [
      { label:'The New York Times', domain:'nytimes.com' },
      { label:'The Guardian', domain:'theguardian.com' },
      { label:'BBC', domain:'bbc.com' }
    ];
    const repeated = [...seed, ...seed, ...seed];
    host.innerHTML = `
      <div class="guestLandingSourcesHead">
        <h2 class="guestLandingSourcesTitle">Based On Data From<br>Diverse News Sources:</h2>
        <div class="guestLandingSourcesGlobe" aria-hidden="true"><img src="/static/icons/news.svg" alt=""></div>
      </div>
      <div class="guestLandingSourcesMarquee" aria-label="News sources">
        <div class="guestLandingSourcesTrack">${repeated.map((source) => `
          <div class="guestLandingSourceItem">
            <div class="guestLandingSourceImgWrap">${source.domain ? `<img class="guestLandingSourceImg" src="${esc(sourceFavicon(source.domain))}" alt="" loading="lazy" referrerpolicy="no-referrer" onerror="this.onerror=null;this.src='https://icons.duckduckgo.com/ip3/${esc(source.domain)}.ico';">` : ''}</div>
            <div class="guestLandingSourceLabel">${esc(source.label)}</div>
          </div>`).join('')}</div>
      </div>`;
  }

  function getPreviewCache(){
    try {
      const raw = localStorage.getItem(CACHE_KEY);
      if (!raw) return null;
      const parsed = JSON.parse(raw);
      if (!parsed || !Array.isArray(parsed.items)) return null;
      if ((Date.now() - Number(parsed.ts || 0)) > CACHE_TTL_MS) return null;
      return parsed.items;
    } catch { return null; }
  }
  function setPreviewCache(items){ try { localStorage.setItem(CACHE_KEY, JSON.stringify({ ts: Date.now(), items })); } catch {} }
  async function fetchWorldPreview(){
    const cached = getPreviewCache();
    if (cached && cached.length) return cached;
    const base = `${window.API_BASE || ''}/api/news`;
    const queries = [
      `${base}?country=world&language=all&ui_lang=en&limit=${PREVIEW_LIMIT}`,
      `${base}?interests=general&country=world&language=all&ui_lang=en&limit=${PREVIEW_LIMIT}`,
      `${base}?country=world&language=en&ui_lang=en&limit=${PREVIEW_LIMIT}`,
      `${base}?interests=general&country=world&language=en&ui_lang=en&limit=${PREVIEW_LIMIT}`
    ];
    let items = [];
    for (const url of queries) {
      const res = await fetch(url, { credentials:'include' });
      const data = await res.json().catch(() => ({}));
      const got = Array.isArray(data?.items) ? data.items : [];
      if (got.length > items.length) items = got;
      if (got.some((it) => scoreOf(it) >= MIN_SCORE)) { items = got; break; }
    }
    setPreviewCache(items);
    return items;
  }

  function strongItems(items){ return (items || []).filter((it) => scoreOf(it) >= MIN_SCORE); }
  function visibleItems(items){ return Array.isArray(items) ? items.slice() : []; }
  function sortCandidates(arr){
    return [...arr].sort((a,b) => (Number(!!b?.is_trending)-Number(!!a?.is_trending)) || (scoreOf(b)-scoreOf(a)) || (outletsCount(b)-outletsCount(a)));
  }
  function pickFeatured(items){
    const strong = sortCandidates(strongItems(items));
    return strong[0] || null;
  }
  function pickSecondary(items, featured){
    const featKey = String(featured?.cluster_id ?? featured?.id ?? featured?.event_id ?? '');
    const visible = visibleItems(items).filter((it) => String(it?.cluster_id ?? it?.id ?? it?.event_id ?? '') !== featKey);
    return sortCandidates(visible.filter((it) => scoreOf(it) >= MIN_SCORE)).slice(0,2);
  }
  function candidateOrder(items, featured, secondary){
    const out = [];
    const seen = new Set();
    const push = (it) => {
      if (!it) return;
      const key = String(it?.cluster_id ?? it?.id ?? it?.event_id ?? '');
      if (!key || seen.has(key)) return;
      seen.add(key); out.push(it);
    };
    push(featured);
    (secondary || []).forEach(push);
    sortCandidates(strongItems(items)).forEach(push);
    sortCandidates(visibleItems(items)).forEach(push);
    return out;
  }
  function buildPreviewCard(item){
    try {
      if (typeof createCardElement === 'function') {
        const card = createCardElement(item, {}, new Set(), 0);
        if (card) {
          card.classList.add('guestLandingFeedCard');
          card.setAttribute('data-landing-preview-card', '1');
          return card;
        }
      }
    } catch (err) { console.warn('[landing] failed to reuse feed card', err); }
    const fallback = document.createElement('div');
    fallback.className = 'guestLandingStoryFallback';
    fallback.innerHTML = `<div class="guestLandingStoryFallbackTitle">${esc(String(item?.title || 'Untitled'))}</div><div class="guestLandingStoryFallbackMeta">${esc(`${metaCountry(item)} · ${outletsCount(item)} outlets · First source: ${firstSourceName(item)} · ${relativeUpdated(item)}`)}</div>`;
    return fallback;
  }
  function renderSecondaryCards(items, mount){
    if (!mount) return;
    mount.innerHTML = '';
    (Array.isArray(items) ? items : []).slice(0,2).forEach((item) => mount.appendChild(buildPreviewCard(item)));
  }

  function extractEntities(items, limit = 8){
    const common = ['USA','US','UK','EU','NATO','UN','RUSSIA','UKRAINE','CHINA','IRAN','ISRAEL','GAZA','PAKISTAN','INDIA','FRANCE','GERMANY'];
    const counts = new Map();
    const add = (k) => {
      const key = String(k || '').trim();
      if (!key) return;
      counts.set(key, (counts.get(key) || 0) + 1);
    };
    for (const it of (items || [])) {
      const title = String(it?.title || '');
      const titleUpper = title.toUpperCase();
      for (const c of common) if (titleUpper.includes(c)) add(c);
      const toks = title.split(/\s+/).map((s) => s.replace(/[^A-Za-z\-]/g,'')).filter(Boolean);
      for (const t of toks){
        if (t.length < 4) continue;
        if (t.toUpperCase() === t && t.length <= 10) add(t);
      }
    }
    return Array.from(counts.entries()).sort((a,b) => (b[1]-a[1]) || a[0].localeCompare(b[0])).slice(0, Math.max(3, limit));
  }
  function renderEntitiesCard(items, mount){
    if (!mount) return;
    const ranked = extractEntities(items, 8);
    mount.innerHTML = `<div class="proHint">Tap an entity to search your feed. This helps you spot what’s trending across stories.</div><div class="entityGrid"></div>`;
    const grid = mount.querySelector('.entityGrid');
    if (!grid) return;
    if (!ranked.length) { grid.innerHTML = '<div class="muted" style="font-size:13px;">No entities yet.</div>'; return; }
    for (const [name, n] of ranked){
      const btn = document.createElement('button');
      btn.type = 'button';
      btn.className = 'entityChip';
      btn.innerHTML = `<span class="entityName">${esc(name)}</span><span class="entityCount">${n}</span>`;
      try { btn.addEventListener('click', () => typeof setSearchTerm === 'function' && setSearchTerm(name)); } catch {}
      grid.appendChild(btn);
    }
  }
  function pickHeadlines(items, featuredId, limit=4){
    const titles = [];
    for (const it of (items || [])) {
      const id = String(it?.cluster_id ?? it?.id ?? it?.event_id ?? '');
      if (featuredId && id === String(featuredId)) continue;
      const t = String(it?.title || '').trim();
      if (t && !titles.includes(t)) titles.push(t);
      if (titles.length >= limit) break;
    }
    return titles;
  }
  function renderHeadlinesCard(items, featuredId, mount){
    if (!mount) return;
    const titles = pickHeadlines(items, featuredId, 4);
    if (!titles.length) { mount.innerHTML = '<div class="muted" style="font-size:13px;">No headlines yet.</div>'; return; }
    const list = document.createElement('div');
    list.className = 'miniList';
    titles.forEach((t) => {
      const item = document.createElement('div');
      item.className = 'miniItem';
      item.innerHTML = `<div class="miniDot"></div><div class="miniText">${esc(t)}</div>`;
      list.appendChild(item);
    });
    mount.innerHTML = '';
    mount.appendChild(list);
  }

  function buildWidgetShell({ icon, title, pro=false, settings=false, bodyId }){
    return `<div class="guestLandingWidget"><div class="widgetCard" data-landing-widget="1"><div class="widgetHeader"><div class="widgetTitleWrap"><div class="widgetIcon"><img class="widgetIconImg" src="${esc(icon)}" alt=""></div><div class="widgetTitle">${esc(title)}${pro ? ' <span class="proPill">PRO</span>' : ''}</div></div><div class="widgetActions">${settings ? '<button class="iconBtn iconBtn--icon" type="button" aria-label="Configure" disabled><img class="iconBtnImg" src="/static/icons/gear.svg" alt=""></button>' : ''}<button class="iconBtn" type="button" aria-label="Close" disabled>✕</button></div></div><div id="${esc(bodyId)}" class="widgetBody"></div></div></div>`;
  }

  async function fetchMediaBiasForCluster(clusterId){
    const url = `/api/widgets/media-bias?cluster_id=${encodeURIComponent(String(clusterId))}`;
    const res = await fetch(url, { credentials:'include' });
    const payload = await res.json().catch(() => ({}));
    const data = payload?.data || payload;
    return data?.data || data || null;
  }
  async function renderMediaBiasCard(candidates, mount){
    if (!mount) return;
    mount.innerHTML = '<div class="muted" style="font-size:13px;">Loading…</div>';
    let d = null;
    for (const item of (candidates || [])) {
      const cid = Number(item?.cluster_id ?? item?.event_id ?? item?.id);
      if (!Number.isFinite(cid)) continue;
      try {
        const raw = await fetchMediaBiasForCluster(cid);
        if (raw && raw.left) { d = raw; break; }
      } catch {}
    }
    if (!d) { mount.innerHTML = '<div class="muted" style="font-size:13px; line-height:1.35;">Bias data is not available yet.</div>'; return; }
    const leftP = Math.max(0, Math.min(100, Number(d.left?.percent || 0) || 0));
    const centerP = Math.max(0, Math.min(100, Number(d.center?.percent || 0) || 0));
    const rightP = Math.max(0, Math.min(100, Number(d.right?.percent || 0) || 0));
    const leftC = Number(d.left?.count || 0) || 0;
    const centerC = Number(d.center?.count || 0) || 0;
    const rightC = Number(d.right?.count || 0) || 0;
    const unknownC = Number(d.unknown?.count || 0) || 0;
    const classified = Number(d.classified_sources || (leftC + centerC + rightC) || 0) || 0;
    const total = Number(d.total_sources || (classified + unknownC) || classified || 0) || 0;
    const conf = String(d.confidence || '').trim();
    const coveragePct = Math.max(0, Math.min(100, Number(d.coverage || 0) || 0));
    mount.innerHTML = `
      <div class="mbTop">
        <div class="mbBar" role="img" aria-label="Media bias distribution">
          <div class="mbSeg mbLeft" style="width:${leftP}%;"></div>
          <div class="mbSeg mbCenter" style="width:${centerP}%;"></div>
          <div class="mbSeg mbRight" style="width:${rightP}%;"></div>
        </div>
        <div class="mbStats">
          <div class="mbStat"><span class="mbDot mbLeft"></span><span class="mbLabel"><b>Left</b> ${leftC} sources</span><span class="mbPct">${leftP}%</span></div>
          <div class="mbStat"><span class="mbDot mbCenter"></span><span class="mbLabel"><b>Center</b> ${centerC} sources</span><span class="mbPct">${centerP}%</span></div>
          <div class="mbStat"><span class="mbDot mbRight"></span><span class="mbLabel"><b>Right</b> ${rightC} sources</span><span class="mbPct">${rightP}%</span></div>
        </div>
        <div class="mbMeta">
          ${conf ? `<span class="chip">Confidence:<b>${esc(conf.charAt(0).toUpperCase()+conf.slice(1))}</b></span>` : ''}
          ${total ? `<span class="chip">Coverage:<b>${classified}/${total}</b></span>` : ''}
          ${unknownC ? `<span class="chip">Unknown:<b>${unknownC}</b></span>` : ''}
          ${d.is_partial ? `<span class="chip">Partial classification · <b>${coveragePct}%</b></span>` : ''}
        </div>
        <div class="mbActions"><button type="button" class="mbToggleBtn" disabled>Show sources</button></div>
      </div>`;
  }

  async function fetchPublicTrustHistory(clusterId, limit=36){
    const cid = Number(clusterId);
    if (!Number.isFinite(cid)) return [];
    const res = await fetch(`/api/public/trust-history/${cid}?limit=${encodeURIComponent(String(limit))}`, { credentials:'include' });
    const data = await res.json().catch(() => ({}));
    return Array.isArray(data?.items) ? data.items : [];
  }
  function buildHistoryHtml(points){
    const scores = points.map((p) => Number(p?.score)).filter(Number.isFinite);
    const current = scores[scores.length - 1] ?? 0;
    const highest = scores.length ? Math.max(...scores) : current;
    const lowest = scores.length ? Math.min(...scores) : current;
    const change = current - (scores[0] ?? current);
    const controls = (typeof buildTrustHistoryControlsHtml === 'function') ? buildTrustHistoryControlsHtml() : '<div class="trustChartControls"><button class="trustCtl" type="button">−</button><button class="trustCtl" type="button">+</button><button class="trustCtl" type="button">↺</button></div>';
    const svg = (typeof buildTrustHistorySvg === 'function') ? buildTrustHistorySvg(points) : '';
    return `
      <div class="trustHistoryWrap" data-trust-cid="landing-preview">
        <div class="trustHistoryHeader">
          <div class="trustHistoryTitle">Trust score history</div>
          <div class="trustChartControlsSlot" aria-hidden="false">${controls}</div>
        </div>
        <div class="trustHistoryLockFrame">
          <div class="trustHistoryGrid">
            <div class="trustChartCard">${svg}<div class="trustTooltip" aria-hidden="true"></div></div>
            <div class="trustStatsCard">
              <div class="trustStatsRow"><span class="trustStatsLabel">Current</span><span class="trustStatsVal">${Math.round(current)}</span></div>
              <div class="trustStatsRow"><span class="trustStatsLabel">Highest</span><span class="trustStatsVal">${Math.round(highest)}</span></div>
              <div class="trustStatsRow"><span class="trustStatsLabel">Lowest</span><span class="trustStatsVal">${Math.round(lowest)}</span></div>
              <div class="trustStatsDivider"></div>
              <div class="trustStatsRow"><span class="trustStatsLabel">Change</span><span class="trustStatsVal">${change >= 0 ? '+' : ''}${Math.round(change)}</span></div>
              <div class="trustStatsSub">Since publication</div>
            </div>
          </div>
        </div>
      </div>`;
  }
  async function renderHistory(candidates, mount){
    if (!mount) return;
    mount.innerHTML = '<div class="guestLandingPreviewLoading">Loading chart…</div>';
    let points = [];
    for (const item of (candidates || [])) {
      const cid = Number(item?.cluster_id ?? item?.event_id ?? item?.id);
      if (!Number.isFinite(cid)) continue;
      try {
        const got = await fetchPublicTrustHistory(cid, 36);
        if (Array.isArray(got) && got.length) { points = got; break; }
      } catch {}
    }
    if (!points.length) { mount.innerHTML = '<div class="guestLandingPreviewError">No trust history yet.</div>'; return; }
    mount.innerHTML = buildHistoryHtml(points);
    try { if (typeof initTrustHistoryZoom === 'function') { const card = mount.querySelector('.trustChartCard'); if (card) initTrustHistoryZoom(card); } } catch {}
  }

  async function renderLanding(forceFresh = false){
    const host = q('guestLandingPreviewInner');
    if (!host || !shouldShow()) return;
    host.innerHTML = '<div class="guestLandingPreviewLoading">Loading preview…</div>';
    try {
      if (forceFresh) { try { localStorage.removeItem(CACHE_KEY); } catch {} }
      const items = await fetchWorldPreview();
      if (!shouldShow()) return;
      if (!items.length) { host.innerHTML = '<div class="guestLandingPreviewError">No world stories are available yet.</div>'; return; }
      buildSourcesMarquee(items);
      const featured = pickFeatured(items);
      if (!featured) { host.innerHTML = '<div class="guestLandingPreviewError">No 80+ rated world stories are available yet.</div>'; return; }
      const secondary = pickSecondary(items, featured);
      const widgetCandidates = candidateOrder(items, featured, secondary);
      const featuredId = String(featured?.cluster_id ?? featured?.id ?? featured?.event_id ?? '');
      const heroMeta = `Source: ${firstSourceName(featured)} · ${outletsCount(featured)} outlets · ${metaCountry(featured)} / en · ${relativeUpdated(featured) || 'Recently updated'}`;
      host.innerHTML = `
        <div class="guestLandingHeroHead">${flameIcon()}<h2 class="guestLandingHeroTitle">${esc(String(featured?.title || 'Featured world story'))}</h2></div>
        <div class="guestLandingHeroMedia">${imageFor(featured) ? `<img src="${esc(imageFor(featured))}" alt="">` : ''}</div>
        <div class="guestLandingHeroMetaRow"><div class="guestLandingScorePill">${esc(formatScore(featured))}</div><div class="guestLandingHeroMeta">${esc(heroMeta)}</div></div>
        <div id="guestLandingStoryList" class="guestLandingStoryList"></div>
        <div class="guestLandingWidgets">
          ${buildWidgetShell({ icon:'/static/icons/Perspective.svg', title:'MEDIA BIAS', bodyId:'guestLandingMediaBias' })}
          ${buildWidgetShell({ icon:'/static/icons/Entities.svg', title:'ENTITIES', pro:true, bodyId:'guestLandingEntities' })}
          ${buildWidgetShell({ icon:'/static/icons/TopHeadlines.svg', title:'TOP HEADLINES', settings:true, bodyId:'guestLandingHeadlines' })}
        </div>
        <div id="guestLandingHistory" class="guestLandingHistory"></div>`;
      renderSecondaryCards(secondary, q('guestLandingStoryList'));
      renderEntitiesCard(widgetCandidates, q('guestLandingEntities'));
      renderHeadlinesCard(widgetCandidates, featuredId, q('guestLandingHeadlines'));
      await Promise.all([
        renderMediaBiasCard(widgetCandidates, q('guestLandingMediaBias')),
        renderHistory(widgetCandidates, q('guestLandingHistory'))
      ]);
    } catch (err) {
      console.error('[landing] render failed', err);
      host.innerHTML = '<div class="guestLandingPreviewError">Failed to load landing preview.</div>';
    }
  }

  let refreshTimer = null;
  function stopRefreshTimer(){
    if (refreshTimer) { clearInterval(refreshTimer); refreshTimer = null; }
  }
  function startRefreshTimer(){
    stopRefreshTimer();
    refreshTimer = setInterval(() => {
      if (!shouldShow()) { stopRefreshTimer(); return; }
      renderLanding(true).catch(() => {});
    }, REFRESH_INTERVAL_MS);
  }

  function syncVisibility(){
    const active = shouldShow();
    document.body.classList.toggle('guestLandingActive', active);
    try {
      document.body.classList.toggle('widgets-disabled', active);
      document.body.classList.remove('hasMobileWidgetDock');
      document.body.classList.remove('widgetsDrawerOpen');
    } catch {}
    try {
      if (typeof window.__setWidgetsEnabled === 'function') window.__setWidgetsEnabled(!active);
    } catch {}
    try {
      const dock = q('mwDock');
      const sheet = q('mwSheet');
      const drawer = document.querySelector('.widgetsDrawer');
      const fab = document.querySelector('.widgetsFab');
      if (dock) dock.classList.remove('isOn');
      if (sheet) sheet.classList.remove('isOpen');
      if (drawer) drawer.classList.remove('isOpen');
      if (fab) fab.style.display = active ? 'none' : '';
    } catch {}
    const landing = q('guestLanding');
    if (landing) landing.style.display = active ? 'block' : 'none';
    if (active) { renderLanding(); startRefreshTimer(); }
    else stopRefreshTimer();
    return active;
  }
  window.__syncGuestLandingVisibility = syncVisibility;
  window.__isGuestLandingActive = shouldShow;
  window.__renderGuestLanding = renderLanding;

  document.addEventListener('click', (e) => {
    const rawTarget = e.target && e.target.closest ? e.target : null;
    const interactive = rawTarget && rawTarget.closest ? rawTarget.closest('.guestLandingPreview a, .guestLandingPreview button, .guestLandingPreview summary, .guestLandingPreview [role="button"], .guestLandingPreview [data-action], .guestLandingWidget a, .guestLandingWidget button, .guestLandingWidget summary, .guestLandingWidget [role="button"], .guestLandingHistory a, .guestLandingHistory button, .guestLandingHistory summary, .guestLandingFeedCard a, .guestLandingFeedCard button, .guestLandingFeedCard summary, .guestLandingFeedCard [role="button"]') : null;
    const target = rawTarget && rawTarget.closest ? rawTarget.closest('#guestLandingStartBtn, .guestLandingFeatureCard, .guestLandingSourcesCard, .guestLandingPreview, .guestLandingFeedCard, .guestLandingWidget, .guestLandingHistory, .guestLandingSourceItem') : null;
    if ((!target && !interactive) || isAuthed()) return;
    e.preventDefault();
    e.stopPropagation();
    if (typeof e.stopImmediatePropagation === 'function') e.stopImmediatePropagation();
    try { if (typeof openAuthModal === 'function') openAuthModal('login'); } catch {}
  }, true);
  window.addEventListener('checkne:auth-state', () => {
    const active = syncVisibility();
    if (!active && isAuthed() && normPath() === '/') {
      try { if (typeof fetchFeed === 'function') fetchFeed({ reset:true, quiet:true }); } catch {}
    }
  });
  window.addEventListener('popstate', syncVisibility);
  window.addEventListener('beforeunload', stopRefreshTimer);
  document.addEventListener('DOMContentLoaded', syncVisibility);
})();