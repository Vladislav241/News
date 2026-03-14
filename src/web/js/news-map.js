(function(){
  const state = { modal: null, map: null, layer: null, activeWindow: '3d', currentClusterId: null, miniMaps: new Map(), miniMapHandlers: new WeakSet() };

  function escapeHtml(s){ return String(s ?? '').replace(/[&<>"']/g, ch => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[ch])); }
  function ensureLeaflet(){ return !!(window.L && typeof window.L.map === 'function'); }
  function parseDate(s){ const t = Date.parse(s || ''); return Number.isFinite(t) ? t : 0; }
  function hoursForWindow(win){ return win === '7d' ? 168 : (win === '24h' ? 24 : 72); }
  function getItemTs(item){ return parseDate(item?.latest_published_at) || parseDate(item?.updated_at) || parseDate(item?.created_at) || 0; }
  function getFeedItems(){ return Array.isArray(window.__checkneFeedItems) ? window.__checkneFeedItems : []; }
  function isCoarsePointer(){
    try {
      return !!(window.matchMedia && (
        window.matchMedia('(pointer: coarse)').matches ||
        window.matchMedia('(max-width: 820px)').matches
      ));
    } catch {
      return false;
    }
  }
  function normalizeLocation(item){
    const loc = item?.map_location;
    if (!loc || typeof loc !== 'object') return null;
    const lat = Number(loc.lat), lng = Number(loc.lon ?? loc.lng);
    if (!Number.isFinite(lat) || !Number.isFinite(lng)) return null;
    return { lat, lng, label: String(loc.label || 'Mapped location'), kind: String(loc.kind || 'point') };
  }
  function getScore(item){ return Number(item?.credibility_score ?? item?.credibility ?? item?.score ?? item?.rating ?? 0) || 0; }
  function buildDataset(win){
    const now = Date.now();
    const maxAge = hoursForWindow(win) * 3600 * 1000;
    return getFeedItems()
      .filter(Boolean)
      .filter((it) => getScore(it) > 70)
      .filter((it) => normalizeLocation(it))
      .filter((it) => {
        const ts = getItemTs(it);
        return !ts || (now - ts) <= maxAge;
      });
  }
  function groupKey(loc){ return `${loc.label}|${loc.lat.toFixed(2)}|${loc.lng.toFixed(2)}`; }
  function groupItems(items){
    const map = new Map();
    for (const item of items){
      const loc = normalizeLocation(item);
      if (!loc) continue;
      const key = groupKey(loc);
      if (!map.has(key)) map.set(key, { loc, items: [] });
      map.get(key).items.push(item);
    }
    return Array.from(map.values()).sort((a, b) => b.items.length - a.items.length);
  }
  function firstImage(group){
    for (const it of group.items){
      const src = it?.image || it?.thumbnail || it?.thumb || it?.image_url || it?.imageUrl;
      if (src) return String(src);
    }
    return '';
  }
  function markerHtml(group, options = {}){
    const img = firstImage(group);
    const count = group.items.length;
    const cls = options.compact ? ' compact' : '';
    return `<div class="eventMapMarker${count > 1 ? ' hasCount' : ''}${cls}">${img ? `<img src="${escapeHtml(img)}" alt="" loading="lazy" draggable="false" />` : `<div class="eventMapMarkerFallback">${escapeHtml((group.loc.label || '•').charAt(0).toUpperCase())}</div>`}${count > 1 ? `<span class="eventMapMarkerCount">${count}</span>` : ''}</div>`;
  }
  function popupHtml(group){
    const title = `${group.items.length} mapped stor${group.items.length === 1 ? 'y' : 'ies'}`;
    const rows = group.items.map((it) => {
      const cid = Number(it?.cluster_id ?? it?.event_id ?? 0);
      const rawTitle = String(it?.title || 'Event');
      return `<li><a href="#" class="eventMapStoryLink" data-story-cluster-id="${cid}" data-story-title="${escapeHtml(rawTitle)}">${escapeHtml(rawTitle)}</a></li>`;
    }).join('');
    return `<div class="eventMapPopup"><div class="eventMapPopupHead"><div class="eventMapPopupTitle">${escapeHtml(title)}</div></div><div class="eventMapPopupSub">${escapeHtml(group.loc.label || '')}</div><ul class="eventMapPopupList">${rows}</ul></div>`;
  }
  async function fillSearchWithStory(storyTitle){
    const title = String(storyTitle || '').trim();
    closeModal();
    if (!title) return;

    try {
      if (window.location && window.location.pathname !== '/' && typeof window.__navigate === 'function') {
        window.__navigate('/');
      } else if (typeof window.__setMainPage === 'function') {
        window.__setMainPage('feed');
      }
    } catch {}

    try {
      if (typeof window.switchMode === 'function' && window.state && window.state.mode !== 'feed') {
        await window.switchMode('feed');
      } else if (window.state) {
        window.state.mode = 'feed';
        try { if (typeof window.applyTabs === 'function') window.applyTabs(); } catch {}
      }
    } catch {}

    const searchEl = document.getElementById('search');
    const btnSearch = document.getElementById('btnSearch');
    try { window.scrollTo({ top: 0, behavior: 'smooth' }); } catch {}
    if (!searchEl) return;

    searchEl.value = title;
    try {
      if (window.state) {
        window.state.q = title;
        window.state.topicQ = '';
        window.state.topicQs = [];
      }
    } catch {}

    searchEl.dispatchEvent(new Event('input', { bubbles: true }));
    searchEl.dispatchEvent(new Event('change', { bubbles: true }));

    setTimeout(() => {
      try {
        if (btnSearch && typeof btnSearch.click === 'function') {
          btnSearch.click();
          return;
        }
      } catch {}
      try { searchEl.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true })); } catch {}
    }, 40);
  }
  function bindStoryLinkDelegation(container){
    if (!container || container.__eventMapWired) return;
    container.__eventMapWired = true;
    const handler = (e) => {
      const storyBtn = e.target && e.target.closest ? e.target.closest('.eventMapStoryLink') : null;
      if (!storyBtn) return;
      e.preventDefault();
      e.stopPropagation();
      void fillSearchWithStory(storyBtn.getAttribute('data-story-title') || storyBtn.textContent || '');
    };
    container.addEventListener('click', handler);
    container.addEventListener('touchend', handler, { passive: false });
  }
  function clearMap(){ if (state.layer) { try { state.layer.clearLayers(); } catch(_) {} } }
  function updateCount(items, groups){ const el = document.getElementById('eventMapMeta'); if (!el) return; el.textContent = `${items.length} mapped stories · ${groups.length} locations`; }
  function renderFullMap(){
    if (!state.map || !ensureLeaflet()) return;
    const items = buildDataset(state.activeWindow);
    const groups = groupItems(items);
    updateCount(items, groups);
    clearMap();
    if (!groups.length) return;
    const bounds = [];
    for (const group of groups){
      const html = markerHtml(group);
      const icon = L.divIcon({ html, className: 'eventMapMarkerWrap', iconSize: [64, 64], iconAnchor: [32, 32], popupAnchor: [0, -24] });
      const marker = L.marker([group.loc.lat, group.loc.lng], { icon });
      marker.bindPopup(popupHtml(group), { maxWidth: 340, className: 'eventMapLeafletPopup' });
      marker.on('popupopen', (ev) => {
        try { bindStoryLinkDelegation(ev.popup && ev.popup.getElement ? ev.popup.getElement() : null); } catch {}
      });
      state.layer.addLayer(marker);
      bounds.push([group.loc.lat, group.loc.lng]);
    }
    if (bounds.length === 1) state.map.setView(bounds[0], 4);
    else state.map.fitBounds(bounds, { padding: [30, 30] });
  }
  function ensureModalMap(){
    const host = document.getElementById('eventMapCanvas');
    if (!host || !ensureLeaflet()) return null;
    if (!state.map){
      state.map = L.map(host, { zoomControl: true, worldCopyJump: true });
      L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', { maxZoom: 18, attribution: '&copy; OpenStreetMap contributors' }).addTo(state.map);
      state.layer = L.layerGroup().addTo(state.map);
    }
    return state.map;
  }
  function openModal(clusterId){
    state.currentClusterId = clusterId || null;
    state.modal = document.getElementById('eventMapModal');
    if (!state.modal) return;
    state.modal.classList.add('isOpen');
    document.body.classList.add('eventMapModalOpen');
    ensureModalMap();
    setTimeout(() => {
      try { state.map.invalidateSize(); } catch {}
      renderFullMap();
    }, 40);
  }
  function closeModal(){
    const modal = document.getElementById('eventMapModal');
    if (!modal) return;
    modal.classList.remove('isOpen');
    document.body.classList.remove('eventMapModalOpen');
  }
  function wireModal(){
    const modal = document.getElementById('eventMapModal');
    if (!modal) return;
    bindStoryLinkDelegation(modal);
    modal.addEventListener('click', (e) => {
      const close = e.target.closest('[data-event-map-close="1"]');
      if (close) {
        closeModal();
        return;
      }
      const winBtn = e.target.closest('[data-map-window]');
      if (winBtn){
        state.activeWindow = String(winBtn.getAttribute('data-map-window') || '3d');
        modal.querySelectorAll('[data-map-window]').forEach((btn) => btn.classList.toggle('isOn', btn === winBtn));
        renderFullMap();
      }
    });
  }
  function addMobileMiniMapTapTarget(host, item){
    if (!host || host.__eventMapTapReady || !isCoarsePointer()) return;
    host.__eventMapTapReady = true;
    const cid = Number(item?.cluster_id ?? item?.event_id ?? 0);
    if (!cid) return;

    let startX = 0;
    let startY = 0;
    let moved = false;

    host.addEventListener('pointerdown', (e) => {
      if (e.pointerType === 'mouse') return;
      startX = Number(e.clientX || 0);
      startY = Number(e.clientY || 0);
      moved = false;
    }, { passive: true });

    host.addEventListener('pointermove', (e) => {
      if (e.pointerType === 'mouse') return;
      const dx = Math.abs(Number(e.clientX || 0) - startX);
      const dy = Math.abs(Number(e.clientY || 0) - startY);
      if (dx > 10 || dy > 10) moved = true;
    }, { passive: true });

    host.addEventListener('pointerup', (e) => {
      if (e.pointerType === 'mouse') return;
      if (moved) return;
      if (e.target && e.target.closest && e.target.closest('.leaflet-control-zoom')) return;
      openModal(cid);
    });
  }
  function renderMiniMap(host, item){
    if (!host || state.miniMaps.has(host)) return;
    const loc = normalizeLocation(item);
    if (!loc || !ensureLeaflet() || getScore(item) <= 70) {
      host.textContent = 'No mapped location yet.';
      return;
    }
    const map = L.map(host, {
      zoomControl: true,
      attributionControl: false,
      dragging: true,
      scrollWheelZoom: false,
      doubleClickZoom: false,
      boxZoom: false,
      keyboard: false,
      tap: true,
      touchZoom: true,
    });
    L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', { maxZoom: 18 }).addTo(map);
    const single = { loc, items: [item] };
    const icon = L.divIcon({ html: markerHtml(single, { compact: true }), className: 'eventMapMarkerWrap', iconSize: [44, 44], iconAnchor: [22, 22] });
    const marker = L.marker([loc.lat, loc.lng], { icon }).addTo(map);
    marker.on('click', () => {
      const cid = Number(item?.cluster_id ?? item?.event_id ?? 0);
      if (cid) openModal(cid);
    });
    map.setView([loc.lat, loc.lng], loc.kind === 'city' ? 6 : 4);
    host.style.cursor = 'grab';
    host.addEventListener('dblclick', () => {
      const cid = Number(item?.cluster_id ?? item?.event_id ?? 0);
      if (cid) openModal(cid);
    });
    addMobileMiniMapTapTarget(host, item);
    state.miniMaps.set(host, map);
    setTimeout(() => { try { map.invalidateSize(); } catch {} }, 60);
  }
  function bootMiniMaps(){
    document.querySelectorAll('.eventMapMini').forEach((host) => {
      if (state.miniMaps.has(host)) return;
      const cid = Number(host.getAttribute('data-cluster-id') || 0);
      const item = getFeedItems().find((it) => Number(it?.cluster_id ?? it?.event_id ?? 0) === cid);
      if (item) renderMiniMap(host, item);
    });
  }
  function wireButtons(){
    document.addEventListener('click', (e) => {
      const btn = e.target.closest('[data-open-full-map]');
      if (btn){
        const cid = Number(btn.getAttribute('data-open-full-map') || 0);
        openModal(cid);
        return;
      }
      const storyBtn = e.target.closest('.eventMapStoryLink');
      if (storyBtn){
        e.preventDefault();
        e.stopPropagation();
        void fillSearchWithStory(storyBtn.getAttribute('data-story-title') || storyBtn.textContent || '');
      }
    });
    document.addEventListener('touchend', (e) => {
      const storyBtn = e.target && e.target.closest ? e.target.closest('.eventMapStoryLink') : null;
      if (!storyBtn) return;
      e.preventDefault();
      e.stopPropagation();
      void fillSearchWithStory(storyBtn.getAttribute('data-story-title') || storyBtn.textContent || '');
    }, { passive: false });
  }
  document.addEventListener('DOMContentLoaded', () => { wireButtons(); wireModal(); bootMiniMaps(); });
  document.addEventListener('checkne:feedItemsUpdated', () => {
    setTimeout(bootMiniMaps, 0);
    if (document.getElementById('eventMapModal')?.classList.contains('isOpen')) renderFullMap();
  });
  document.addEventListener('keydown', (e) => { if (e.key === 'Escape') closeModal(); });
})();