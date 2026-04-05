/*
 * CHECKNE Web App — bootstrap.js
 * Account dropdown + bindings + main() + startup
 *
 * Split from the former monolithic app.js to keep responsibilities separated.
 * Keep files loaded in order (see index.html).
 */

// --- Safety: unregister any previously installed Service Worker ---
// This project does not rely on a Service Worker, but an old SW (from a previous build)
// can accidentally duplicate fetches (e.g. /api/news/video) and waste server/API quota.
// Unregistering ensures a clean, deterministic network behavior across devices.
try {
  if ('serviceWorker' in navigator) {
    navigator.serviceWorker.getRegistrations()
      .then((regs) => {
        regs.forEach((r) => { try { r.unregister(); } catch (_) {} });
      })
      .catch(() => {});
  }
  // Also clear Cache Storage best-effort (old SW often leaves caches behind).
  if (typeof caches !== 'undefined' && caches?.keys) {
    caches.keys().then((keys) => keys.forEach((k) => { try { caches.delete(k); } catch (_) {} })).catch(() => {});
  }
} catch (_) {}

// ===== Account dropdown =====
const btnAccount = document.getElementById("btnAccount");
const accountMenu = document.getElementById("accountMenu");

const menuProfile = document.getElementById("menuProfile");
const menuPricing = document.getElementById("menuPricing");
const menuLogout = document.getElementById("menuLogout");

// открыть/закрыть меню
if (btnAccount && accountMenu) {
  btnAccount.addEventListener("click", (e) => {
    // If not logged in, the Account button behaves like Login.
    if (!authState.authenticated) {
      openAuthModal('login');
      return;
    }
    e.stopPropagation();
    accountMenu.classList.toggle("open");
  });

  // закрывать при клике вне
  document.addEventListener("click", (e) => {
    if (!accountMenu.contains(e.target) && !btnAccount.contains(e.target)) {
      if (accountMenu) accountMenu.classList.remove("open");
    }
  });
}

// ✅ Profile click
if(menuProfile){
  menuProfile.addEventListener("click", () => {
    if (accountMenu) accountMenu.classList.remove("open");
    try { if (typeof window.__navigate === 'function') window.__navigate('/account'); else location.href = '/account'; } catch(_) {}
  });
}

// ✅ Pricing click
if(menuPricing){
  menuPricing.addEventListener("click", () => {
    if (accountMenu) accountMenu.classList.remove("open");
    try { if (typeof window.__navigate === 'function') window.__navigate('/pricing'); else location.href = '/pricing'; } catch(_) {}
  });
}

// ✅ Logout click
if (menuLogout) menuLogout.addEventListener("click", async () => {
  if (accountMenu) accountMenu.classList.remove("open");

  let res = null;
  try {
    res = await fetch("/api/auth/logout", {
      method: "POST",
      credentials: "include",
    });
  } catch (e) {
    console.error('Logout request failed:', e);
    try {
      if (typeof window.uiAlert === 'function') {
        await window.uiAlert('Please check your connection and try again.', {
          title: 'Could not log out',
          meta: 'Account',
        });
      } else if (typeof window.toast === 'function') {
        window.toast('Could not log out. Try again.', 'error');
      }
    } catch {}
    return;
  }

  if (!res || !res.ok) {
    const txt = await res?.text?.().catch(() => "") || "";
    console.error("Logout failed:", res?.status, txt);
    try {
      if (typeof window.uiAlert === 'function') {
        await window.uiAlert('Something went wrong while ending your session.', {
          title: 'Could not log out',
          meta: 'Account',
        });
      } else if (typeof window.toast === 'function') {
        window.toast('Could not log out. Try again.', 'error');
      }
    } catch {}
    return;
  }

  try { localStorage.removeItem("access_token"); } catch {}
  try { localStorage.removeItem("token"); } catch {}
  try { localStorage.removeItem("user"); } catch {}
  try { sessionStorage.removeItem("access_token"); } catch {}
  try { sessionStorage.removeItem("token"); } catch {}

  try {
    authState = { authenticated: false, user: null };
    window.authState = authState;
  } catch (e) { console.error('logout auth state cleanup failed', e); }

  try { billingState = null; } catch (e) { console.error('logout billing cleanup failed', e); }
  try { if (typeof updateAuthUI === 'function') updateAuthUI(); } catch (e) { console.error('logout updateAuthUI failed', e); }
  try { if (typeof updatePricingUI === 'function') updatePricingUI(); } catch (e) { console.error('logout updatePricingUI failed', e); }

  try {
    const trackingCountEl = document.getElementById('trackingCount');
    if (trackingCountEl) trackingCountEl.textContent = '0';
  } catch (e) { console.error('logout tracking count cleanup failed', e); }

  try {
    state.trackingItems = [];
    if (state.mode === 'fav') renderCards([], { incremental: false });
  } catch (e) { console.error('logout tracking cleanup failed', e); }

  try {
    window.dispatchEvent(new CustomEvent('checkne:auth-state', { detail: { authenticated: false, user: null, wasAuthenticated: true } }));
  } catch (e) { console.error('logout auth-state event failed', e); }

  try {
    if (typeof window.__navigate === 'function') {
      window.__navigate('/');
      try { if (typeof window.__syncGuestLandingVisibility === 'function') window.__syncGuestLandingVisibility(); } catch {}
      try { window.dispatchEvent(new Event('popstate')); } catch {}
    } else {
      window.location.href = '/';
    }
  } catch (e) {
    console.error('logout navigation failed', e);
    window.location.href = '/';
  }
});

function initCookieBanner() {
  const key = "cookie_banner_ok_v1";
  const banner = document.getElementById("cookie-banner");
  const btn = document.getElementById("cookie-accept");
  if (!banner || !btn) return;

  // If already accepted -> don't show
  if (localStorage.getItem(key) === "1") return;

  banner.style.display = "block";

  btn.addEventListener("click", () => {
    localStorage.setItem(key, "1");
    banner.style.display = "none";
  });
}

// ------------------------------
// Premium motion-driven <details> animations
// ------------------------------
let _smoothDetailsInit = false;

function _syncDisclosureState(detailsEl){
  if (!detailsEl || detailsEl.tagName !== 'DETAILS') return;
  const summaryEl = detailsEl.querySelector('summary');
  if (!summaryEl) return;
  const isOpen = !!detailsEl.open && !detailsEl.classList.contains('is-closing');
  summaryEl.setAttribute('aria-expanded', isOpen ? 'true' : 'false');
}

function _syncAllDisclosureStates(root){
  const scope = root && root.querySelectorAll ? root : document;
  try { scope.querySelectorAll('details > summary.accordionSummary, details > summary.newsSummary').forEach((summaryEl) => {
    const detailsEl = summaryEl.parentElement;
    if (detailsEl && detailsEl.tagName === 'DETAILS') _syncDisclosureState(detailsEl);
  }); } catch {}
}

function _animateDetails(detailsEl, contentEl, shouldOpen){
  if (!detailsEl || !contentEl) return;

  const motion = window.__checkneMotion || {};
  const prefersReduced = !!(motion.reduced ? motion.reduced() : (window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches));
  const duration = Number(motion.duration?.accordion || 380);
  const ease = String(motion.ease?.decel || 'cubic-bezier(.16,1,.3,1)');

  const summaryEl = detailsEl.querySelector('summary');
  if (!summaryEl) return;

  const cancelCurrent = () => {
    try { contentEl._motionAnim?.cancel(); } catch {}
    try { detailsEl._motionAnim?.cancel(); } catch {}
    contentEl._motionAnim = null;
    detailsEl._motionAnim = null;
  };

  const finish = (openState) => {
    detailsEl.open = !!openState;
    _syncDisclosureState(detailsEl);
    detailsEl.dataset.animating = '';
    detailsEl.classList.remove('is-opening','is-closing','is-animating');
    contentEl.style.height = '';
    contentEl.style.opacity = '';
    contentEl.style.transform = '';
    contentEl.style.overflow = openState ? 'visible' : 'hidden';
    detailsEl.style.height = '';
    detailsEl.style.overflow = '';
  };

  if (prefersReduced){
    cancelCurrent();
    _syncDisclosureState(detailsEl);
    finish(!!shouldOpen);
    return;
  }

  cancelCurrent();
  summaryEl.setAttribute('aria-expanded', shouldOpen ? 'true' : 'false');
  detailsEl.dataset.animating = '1';
  detailsEl.classList.toggle('is-opening', !!shouldOpen);
  detailsEl.classList.toggle('is-closing', !shouldOpen);
  detailsEl.classList.add('is-animating');

  const currentDetailsHeight = Math.max(0, detailsEl.getBoundingClientRect().height || 0);
  const currentBodyHeight = Math.max(0, contentEl.getBoundingClientRect().height || 0);

  detailsEl.style.overflow = 'hidden';
  detailsEl.style.height = `${currentDetailsHeight}px`;
  contentEl.style.overflow = 'hidden';
  contentEl.style.height = `${currentBodyHeight}px`;
  contentEl.style.opacity = shouldOpen ? '0' : '1';
  contentEl.style.transform = shouldOpen ? 'translateY(-8px)' : 'translateY(0)';

  if (shouldOpen) detailsEl.open = true;

  const targetBodyHeight = Math.max(0, contentEl.scrollHeight || 0);
  const targetSummaryHeight = Math.max(0, summaryEl.getBoundingClientRect().height || 0);
  const targetDetailsHeight = shouldOpen ? (targetSummaryHeight + targetBodyHeight) : targetSummaryHeight;

  requestAnimationFrame(() => {
    const bodyFrames = shouldOpen
      ? [
          { height: `${currentBodyHeight}px`, opacity: 0, transform: 'translateY(-8px)' },
          { height: `${targetBodyHeight}px`, opacity: 1, transform: 'translateY(0)' }
        ]
      : [
          { height: `${currentBodyHeight}px`, opacity: 1, transform: 'translateY(0)' },
          { height: '0px', opacity: 0, transform: 'translateY(-8px)' }
        ];

    const detailsFrames = [
      { height: `${currentDetailsHeight}px` },
      { height: `${targetDetailsHeight}px` }
    ];

    try {
      contentEl._motionAnim = contentEl.animate(bodyFrames, { duration, easing: ease, fill: 'forwards' });
      detailsEl._motionAnim = detailsEl.animate(detailsFrames, { duration, easing: ease, fill: 'forwards' });
    } catch {
      contentEl.style.transition = `height ${duration}ms ${ease}, opacity ${duration}ms ${ease}, transform ${duration}ms ${ease}`;
      detailsEl.style.transition = `height ${duration}ms ${ease}`;
      contentEl.style.height = shouldOpen ? `${targetBodyHeight}px` : '0px';
      contentEl.style.opacity = shouldOpen ? '1' : '0';
      contentEl.style.transform = shouldOpen ? 'translateY(0)' : 'translateY(-8px)';
      detailsEl.style.height = `${targetDetailsHeight}px`;
    }

    const cleanupAndFinish = () => {
      cancelCurrent();
      if (!shouldOpen) detailsEl.open = false;
      finish(!!shouldOpen);
    };

    if (contentEl._motionAnim) {
      contentEl._motionAnim.onfinish = cleanupAndFinish;
      contentEl._motionAnim.oncancel = () => {};
    } else {
      window.setTimeout(cleanupAndFinish, duration + 32);
    }
  });
}

try { window.__checkneAnimateDetails = _animateDetails; } catch {}

function initSmoothDetails(){
  if (_smoothDetailsInit) return;
  _smoothDetailsInit = true;

  document.addEventListener('click', (e) => {
    const interactive = e.target && e.target.closest
      ? e.target.closest('.trackToggle, .shareBtn, .reportBtn, .openBtn, button, a, input, textarea, select, label')
      : null;
    if (interactive) return;

    const sum = e.target && e.target.closest ? e.target.closest('summary.accordionSummary, summary.newsSummary') : null;
    if (!sum) return;

    const detailsEl = sum.parentElement;
    if (!detailsEl || detailsEl.tagName !== 'DETAILS') return;

    if (sum.classList.contains('newsSummary')){
      if (e.target.closest('button, a, input, textarea, select, .trackToggle, .shareBtn, .iconBtn')) return;
      const lockedCard = detailsEl.closest && detailsEl.closest('[data-locked="1"]');
      const isGuest = !(window.authState && window.authState.authenticated);
      if (lockedCard && isGuest){
        e.preventDefault();
        e.stopPropagation();
        try { if (typeof window.openAuthModal === 'function') window.openAuthModal('paywall'); } catch {}
        return;
      }
      const body = detailsEl.querySelector('.newsOpenBody');
      if (!body) return;
      e.preventDefault();
      e.stopPropagation();
      _animateDetails(detailsEl, body, !detailsEl.open);
      return;
    }

    if (sum.classList.contains('accordionSummary')){
      const body = detailsEl.querySelector('.accordionBody');
      if (!body) return;
      e.preventDefault();
      e.stopPropagation();
      _animateDetails(detailsEl, body, !detailsEl.open);
    }
  }, true);
}


function __setGlobalAppBusy(active, opts = {}) {
  const body = document.body;
  const html = document.documentElement;
  if (!body || !html) return;

  const current = Number(body.dataset.appBusyCount || '0') || 0;
  let next = current + (active ? 1 : -1);
  if (!Number.isFinite(next) || next < 0) next = 0;
  body.dataset.appBusyCount = String(next);
  const token = String((Number(body.dataset.appBusyToken || '0') || 0) + 1);
  body.dataset.appBusyToken = token;

  if (active) {
    body.classList.add('app-busy');
    html.classList.add('app-booting');
    body.style.overflow = 'hidden';
    return;
  }

  if (next > 0) return;

  const release = () => {
    if ((body.dataset.appBusyToken || '') !== token) return;
    if ((Number(body.dataset.appBusyCount || '0') || 0) > 0) return;
    try { body.classList.remove('app-busy'); } catch {}
    try { html.classList.remove('app-booting'); } catch {}
    if (!authModalIsOpen || !authModalIsOpen()) {
      try { body.style.overflow = ''; } catch {}
    }
  };

  const delay = Math.max(0, Number(opts.delay || 0) || 0);
  if (delay > 0) window.setTimeout(release, delay);
  else release();
}

window.__setAppBusy = function(active, opts = {}){
  try { __setGlobalAppBusy(!!active, opts); } catch {}
};

initSmoothDetails();
_syncAllDisclosureStates(document);
try {
  const disclosureObserver = new MutationObserver((mutations) => {
    for (const mutation of mutations){
      for (const node of mutation.addedNodes || []){
        if (node && node.nodeType === 1) _syncAllDisclosureStates(node);
      }
      if (mutation.target && mutation.target.nodeType === 1 && mutation.type === 'attributes' && mutation.target.tagName === 'DETAILS'){
        _syncDisclosureState(mutation.target);
      }
    }
  });
  disclosureObserver.observe(document.body, { childList:true, subtree:true, attributes:true, attributeFilter:['open'] });
} catch {}

requestAnimationFrame(updateFooterShadeGap);
initSmoothDetails();
window.__setAppBusy(true);
Promise.resolve(main())
  .catch((err) => { console.error('main bootstrap failed', err); })
  .finally(() => { window.__setAppBusy(false, { delay: 120 }); });


let _emailAlertsInit = false;
let _emailAlertsLast = null;

// Consent modal for enabling email notifications
let _emailConsentModal = null;

function _emailConsentKey(){
  try{
    const uid = authState?.user?.id;
    return uid ? `checkne_email_consent_v1_u${uid}` : 'checkne_email_consent_v1_guest';
  }catch{ return 'checkne_email_consent_v1_guest'; }
}

function ensureEmailConsentModal(){
  if (_emailConsentModal) return _emailConsentModal;

  const buildLegalUrl = (path) => {
    try{
      const p = String(path || '/');
      return location.origin + (p.startsWith('/') ? p : ('/' + p));
    }catch{
      return String(path || '/');
    }
  };

  // Minimal styling (scoped)
  const style = document.createElement('style');
  style.textContent = `
  .ecmBack{ position:fixed; inset:0; background:rgba(0,0,0,.46); display:none; align-items:center; justify-content:center; z-index:9999; padding:16px; }
  .ecmBack.open{ display:flex; }
  .ecmBack{ -webkit-backdrop-filter: blur(6px); backdrop-filter: blur(6px); }
  .ecmCard{ width:min(560px, calc(100vw - 32px)); border-radius:22px; background:#fff; color:#111; box-shadow:0 24px 70px rgba(0,0,0,.28); overflow:hidden; border:1px solid rgba(15,23,42,.10); }
  .ecmHead{ padding:20px 20px 10px; font-weight:900; font-size:20px; letter-spacing:-.01em; }
  .ecmBody{ padding:0 20px 16px; font-size:14.5px; line-height:1.55; color:rgba(15,23,42,.82); }
  .ecmHint{ margin-top:10px; padding:10px 12px; border-radius:14px; background:rgba(15,23,42,.04); border:1px solid rgba(15,23,42,.08); font-size:13px; color:rgba(15,23,42,.78); }
  .ecmLinks{ display:flex; gap:10px; flex-wrap:wrap; margin-top:12px; }
  .ecmLink{ border:1px solid rgba(15,23,42,.12); background:rgba(255,255,255,.92); padding:9px 12px; border-radius:14px; font-weight:800; font-size:13px; cursor:pointer; transition: transform .08s ease, background .12s ease; }
  .ecmLink:hover{ background:rgba(15,23,42,.04); }
  .ecmLink:active{ transform: translateY(1px); }
  .ecmFoot{ display:flex; gap:10px; justify-content:flex-end; padding:16px 20px 20px; border-top:1px solid rgba(15,23,42,.08); }
  .ecmBtn{ border-radius:16px; padding:11px 16px; font-weight:900; border:1px solid rgba(15,23,42,.12); background:#fff; cursor:pointer; transition: transform .08s ease, background .12s ease; }
  .ecmBtn:hover{ background:rgba(15,23,42,.04); }
  .ecmBtn:active{ transform: translateY(1px); }
  .ecmBtnPrimary{ background:#111; color:#fff; border-color:#111; }
  .ecmBtnPrimary:hover{ background:#0b0b0b; }
  @media (max-width: 420px){
    .ecmFoot{ flex-direction:column-reverse; }
    .ecmBtn{ width:100%; }
  }
  `;
  document.head.appendChild(style);

  const back = document.createElement('div');
  back.className = 'ecmBack';
  back.innerHTML = `
    <div class="ecmCard" role="dialog" aria-modal="true" aria-label="Email notifications consent">
      <div class="ecmHead">Email notifications — consent</div>
      <div class="ecmBody">
        By turning this on, you agree that CHECKNE will send you emails when tracked events change.
        You can turn this off anytime in settings.
        <div class="ecmHint">We’ll only email you about changes to events you’re tracking.</div>
        <div class="ecmLinks">
          <button type="button" class="ecmLink" data-ecm-link="privacy">Privacy Policy</button>
          <button type="button" class="ecmLink" data-ecm-link="terms">Terms of Service</button>
        </div>
      </div>
      <div class="ecmFoot">
        <button type="button" class="ecmBtn" data-ecm-action="cancel">Cancel</button>
        <button type="button" class="ecmBtn ecmBtnPrimary" data-ecm-action="agree">I agree</button>
      </div>
    </div>
  `;
  // Backdrop click handled in showEmailConsentModal (per-open promise)
  document.body.appendChild(back);

  // Links
  back.querySelectorAll('[data-ecm-link]').forEach((btn)=>{
    btn.addEventListener('click', ()=>{
      const slug = btn.getAttribute('data-ecm-link');
      if (slug === 'privacy') window.open(buildLegalUrl('/privacy'), '_blank', 'noopener,noreferrer');
      if (slug === 'terms') window.open(buildLegalUrl('/terms'), '_blank', 'noopener,noreferrer');
    });
  });

  _emailConsentModal = back;
  return back;
}

function showEmailConsentModal(){
  return new Promise((resolve)=>{
    const back = ensureEmailConsentModal();
    back.classList.add('open');

    const cleanup = (v)=>{
      try { back.removeEventListener('click', onClick); } catch {}
      back.classList.remove('open');
      resolve(v === 'agree');
    };

    const onClick = (e)=>{
      // Backdrop click => cancel
      if (e.target === back) {
        e.preventDefault();
        cleanup('cancel');
        return;
      }
      const act = e.target && e.target.getAttribute && e.target.getAttribute('data-ecm-action');
      if (!act) return;
      e.preventDefault();
      cleanup(act);
    };
    back.addEventListener('click', onClick);
  });
}

async function updateEmailAlertsUI(){
  const wrap = qs('trackingSettings');
  const toggle = qs('emailAlertsToggle');
  if (!wrap || !toggle) return;

  const inTracking = (state.mode === 'fav');
  const loggedIn = !!(authState && authState.user && authState.user.email);

  wrap.style.display = (inTracking && loggedIn) ? 'flex' : 'none';
  if (!(inTracking && loggedIn)) return;

  // init listener once
  if (!_emailAlertsInit){
    _emailAlertsInit = true;
    toggle.addEventListener('change', async () => {
      const enabled = !!toggle.checked;

      // If enabling: require explicit consent once per account.
      if (enabled){
        try{
          const k = _emailConsentKey();
          const already = (localStorage.getItem(k) === '1');
          if (!already){
            const ok = await showEmailConsentModal();
            if (!ok){
              toggle.checked = false;
              return;
            }
            try { localStorage.setItem(k, '1'); } catch {}
          }
        }catch{}
      }

      try{
        const r = await fetch('/api/alerts/email', {
          method:'POST',
          headers:{'Content-Type':'application/json'},
          credentials:'include',
          body: JSON.stringify({ enabled })
        });
        const data = await r.json().catch(()=>({}));
        _emailAlertsLast = !!data.enabled;
        toggle.checked = _emailAlertsLast;
      }catch(e){
        // revert UI on error
        if (_emailAlertsLast !== null) toggle.checked = _emailAlertsLast;
      }
    });
  }

  // if we already have value from /api/auth/me
  if (typeof authState.user.email_alerts_enabled !== 'undefined'){
    toggle.checked = !!authState.user.email_alerts_enabled;
    _emailAlertsLast = !!toggle.checked;
  }

  // refresh from server (cheap)
  try{
    const r = await fetch('/api/alerts/email', { credentials:'include' });
    const data = await r.json().catch(()=>({}));
    const enabled = !!data.enabled;
    _emailAlertsLast = enabled;
    toggle.checked = enabled;
  }catch(e){
    // ignore
  }


}


// -------------------------
// Trust score history interactions (tooltip on dots)
// -------------------------
async function hydrateTrustHistorySections() {
  const wraps = Array.from(document.querySelectorAll('.trustHistoryWrap[data-trust-cid]'));
  for (const w of wraps) {
    if (w.dataset.trustHydrated === '1') continue;
    const cid = Number(w.getAttribute('data-trust-cid') || w.dataset.trustCid);
    if (!Number.isFinite(cid)) continue;

    const points = await fetchTrustHistory(cid, 80);
    if (!points || !points.length) {
      // No history yet: hide section
      w.style.display = 'none';
      w.dataset.trustHydrated = '1';
      continue;
    }

    // Controls live in the header to avoid overlapping the tooltip.
    // IMPORTANT: inject controls before initTrustHistoryZoom so listeners can bind.
    const slot = w.querySelector('.trustChartControlsSlot');
    if (slot) {
      slot.innerHTML = buildTrustHistoryControlsHtml();
      slot.setAttribute('aria-hidden', 'false');
    }

    // Render SVG
    const svg = buildTrustHistorySvg(points);
    const chartCard = w.querySelector('.trustChartCard');
    if (chartCard) {
      chartCard.innerHTML = `${svg}<div class="trustTooltip" aria-hidden="true"></div>`;
      // zoom/pan setup (safe even if user never interacts)
      initTrustHistoryZoom(chartCard);
    }

    // Stats
    const scores = points.map(p => Number(p.score) || 0);
    const current = scores[scores.length - 1] ?? 0;
    const highest = Math.max(...scores);
    const lowest = Math.min(...scores);
    const change = current - (scores[0] ?? current);

    const rows = w.querySelectorAll('.trustStatsRow');
    if (rows && rows.length >= 4) {
      const setVal = (rowIdx, val) => {
        const el = rows[rowIdx]?.querySelector('.trustStatsVal');
        if (el) el.textContent = String(val);
      };
      setVal(0, current);
      setVal(1, highest);
      setVal(2, lowest);
      // change row is after divider: it's the last .trustStatsRow
      const changeRow = w.querySelectorAll('.trustStatsRow')[3];
      const changeEl = changeRow?.querySelector('.trustStatsVal');
      if (changeEl) changeEl.textContent = `${change >= 0 ? '+' : ''}${change}`;
    }

    w.dataset.trustHydrated = '1';
  }
}

function buildTrustHistoryControlsHtml() {
  return `
    <div class="trustChartControls" aria-label="Chart controls">
      <button class="trustCtl" type="button" data-action="zoomOut" aria-label="Zoom out">−</button>
      <button class="trustCtl" type="button" data-action="zoomIn" aria-label="Zoom in">+</button>
      <button class="trustCtl" type="button" data-action="reset" aria-label="Reset zoom">↺</button>
    </div>
  `;
}

function initTrustHistoryZoom(chartCard) {
  try {
    const svg = chartCard.querySelector('svg.trustChartSvg');
    if (!svg) return;

    const xform = svg.querySelector('g.trustPlotXform');
    const panLayer = svg.querySelector('rect.trustPanLayer');
    if (!xform || !panLayer) return;
    try {
      svg.style.touchAction = 'none';
      panLayer.style.touchAction = 'none';
      panLayer.style.cursor = 'crosshair';
    } catch {}

    const plotLeft = Number(svg.getAttribute('data-plot-left') || 0);
    const plotRight = Number(svg.getAttribute('data-plot-right') || 0);
    const plotTop = Number(svg.getAttribute('data-plot-top') || 0);
    const plotHeight = Number(svg.getAttribute('data-plot-height') || 0);
    const viewW = Number(svg.getAttribute('data-view-w') || 0);
    const viewH = Number(svg.getAttribute('data-view-h') || 0);
    if (!Number.isFinite(plotLeft) || !Number.isFinite(plotRight) || !Number.isFinite(viewW) || viewW <= 0) return;

    const clamp = (v, a, b) => Math.max(a, Math.min(b, v));
    const MAX_ZOOM = 20;

    const existingRect = svg.querySelector('rect.trustSelectionRect');
    if (existingRect) existingRect.remove();
    const selectionRect = document.createElementNS('http://www.w3.org/2000/svg', 'rect');
    selectionRect.setAttribute('class', 'trustSelectionRect');
    selectionRect.setAttribute('fill', 'rgba(0,0,0,0.08)');
    selectionRect.setAttribute('stroke', 'rgba(0,0,0,0.42)');
    selectionRect.setAttribute('stroke-width', '1.5');
    selectionRect.setAttribute('stroke-dasharray', '7 5');
    selectionRect.setAttribute('vector-effect', 'non-scaling-stroke');
    selectionRect.style.display = 'none';
    selectionRect.style.pointerEvents = 'none';
    svg.appendChild(selectionRect);

    const st = {
      sx: 1,
      tx: 0,
      pinch: null,
      selecting: false,
      selectionMoved: false,
      pointerId: null,
      selectStartViewX: 0,
      selectCurrentViewX: 0,
      lastViewX: (plotLeft + plotRight) / 2,
    };

    function viewXToDataX(viewX) {
      return (viewX - st.tx) / (st.sx || 1);
    }

    function dataXToViewX(dataX) {
      return st.sx * dataX + st.tx;
    }

    function updateDotCompensation() {
      const inv = 1 / (st.sx || 1);
      svg.querySelectorAll('g.trustPlotXform circle.ptDot, g.trustPlotXform circle.ptHalo').forEach((c) => {
        const cx = Number(c.getAttribute('cx'));
        const cy = Number(c.getAttribute('cy'));
        if (!Number.isFinite(cx) || !Number.isFinite(cy)) return;
        c.setAttribute('transform', `translate(${cx} ${cy}) scale(${inv} 1) translate(${-cx} ${-cy})`);
      });
    }

    function boundsFor(sx) {
      const minTx = plotRight - sx * plotRight;
      const maxTx = plotLeft - sx * plotLeft;
      return { minTx, maxTx };
    }

    function hideSelection() {
      selectionRect.style.display = 'none';
    }

    function renderSelection() {
      const x1 = clamp(Math.min(st.selectStartViewX, st.selectCurrentViewX), plotLeft, plotRight);
      const x2 = clamp(Math.max(st.selectStartViewX, st.selectCurrentViewX), plotLeft, plotRight);
      const w = Math.max(0, x2 - x1);
      if (w < 2) {
        hideSelection();
        return;
      }
      selectionRect.setAttribute('x', String(x1));
      selectionRect.setAttribute('y', String(plotTop));
      selectionRect.setAttribute('width', String(w));
      selectionRect.setAttribute('height', String(Math.max(0, plotHeight || viewH || 260)));
      selectionRect.style.display = 'block';
    }

    function apply() {
      const b = boundsFor(st.sx);
      st.tx = clamp(st.tx, b.minTx, b.maxTx);
      xform.setAttribute('transform', `matrix(${st.sx} 0 0 1 ${st.tx} 0)`);
      updateDotCompensation();
      panLayer.style.cursor = 'crosshair';
    }

    function clientXToViewBoxX(clientX) {
      const r = svg.getBoundingClientRect();
      const px = (clientX - r.left) / (r.width || 1);
      return clamp(px, 0, 1) * viewW;
    }

    function clientYToViewBoxY(clientY) {
      const r = svg.getBoundingClientRect();
      const py = (clientY - r.top) / (r.height || 1);
      return clamp(py, 0, 1) * viewH;
    }

    function isInsidePlotClient(clientX, clientY) {
      const vx = clientXToViewBoxX(clientX);
      const vy = clientYToViewBoxY(clientY);
      return vx >= plotLeft && vx <= plotRight && vy >= plotTop && vy <= (plotTop + plotHeight);
    }

    function zoomAt(anchorViewX, factor) {
      const next = clamp(st.sx * factor, 1, MAX_ZOOM);
      if (Math.abs(next - st.sx) < 0.0001) return;
      const dataX = clamp(viewXToDataX(anchorViewX), plotLeft, plotRight);
      st.tx = anchorViewX - next * dataX;
      st.sx = next;
      apply();
    }

    function zoomToRange(startViewX, endViewX) {
      const selStartView = clamp(Math.min(startViewX, endViewX), plotLeft, plotRight);
      const selEndView = clamp(Math.max(startViewX, endViewX), plotLeft, plotRight);
      const selViewW = selEndView - selStartView;
      const plotW = Math.max(1, plotRight - plotLeft);
      if (selViewW < Math.max(14, plotW * 0.02)) {
        hideSelection();
        return;
      }
      const selStartData = clamp(viewXToDataX(selStartView), plotLeft, plotRight);
      const selEndData = clamp(viewXToDataX(selEndView), plotLeft, plotRight);
      const selDataW = Math.max(0.0001, selEndData - selStartData);
      const nextSx = clamp(plotW / selDataW, 1, MAX_ZOOM);
      st.sx = nextSx;
      st.tx = plotLeft - nextSx * selStartData;
      st.lastViewX = (selStartView + selEndView) / 2;
      hideSelection();
      apply();
    }

    function rememberFocusFromClientX(clientX) {
      const viewX = clientXToViewBoxX(clientX);
      st.lastViewX = clamp(viewX, plotLeft, plotRight);
    }

    function reset() {
      st.sx = 1;
      st.tx = 0;
      st.pinch = null;
      st.selecting = false;
      st.selectionMoved = false;
      st.pointerId = null;
      hideSelection();
      apply();
    }

    const wrap = chartCard.closest('.trustHistoryWrap') || chartCard;
    wrap.querySelectorAll('.trustChartControls .trustCtl').forEach((btn) => {
      btn.addEventListener('click', (e) => {
        const act = btn.getAttribute('data-action');
        const anchor = Number.isFinite(st.lastViewX) ? st.lastViewX : (plotLeft + plotRight) / 2;
        if (act === 'zoomIn') zoomAt(anchor, 1.25);
        else if (act === 'zoomOut') zoomAt(anchor, 1 / 1.25);
        else reset();
        e.preventDefault();
        e.stopPropagation();
      });
    });

    svg.addEventListener('wheel', (e) => {
      const r = svg.getBoundingClientRect();
      const inside = e.clientX >= r.left && e.clientX <= r.right && e.clientY >= r.top && e.clientY <= r.bottom;
      if (!inside) return;
      e.preventDefault();
      rememberFocusFromClientX(e.clientX);
      const viewX = clientXToViewBoxX(e.clientX);
      const factor = (e.deltaY < 0) ? 1.18 : (1 / 1.18);
      zoomAt(viewX, factor);
    }, { passive: false });

    const pointerSurface = svg;

    pointerSurface.addEventListener('pointerdown', (e) => {
      if (e.pointerType === 'mouse' && e.button !== 0) return;
      if (!isInsidePlotClient(e.clientX, e.clientY)) return;
      rememberFocusFromClientX(e.clientX);
      st.selecting = true;
      st.selectionMoved = false;
      st.pointerId = e.pointerId;
      st.selectStartViewX = clamp(clientXToViewBoxX(e.clientX), plotLeft, plotRight);
      st.selectCurrentViewX = st.selectStartViewX;
      renderSelection();
      try { pointerSurface.setPointerCapture(e.pointerId); } catch {}
      e.preventDefault();
      e.stopPropagation();
    }, true);

    pointerSurface.addEventListener('pointermove', (e) => {
      if (!st.selecting || st.pointerId !== e.pointerId) return;
      rememberFocusFromClientX(e.clientX);
      st.selectCurrentViewX = clamp(clientXToViewBoxX(e.clientX), plotLeft, plotRight);
      if (Math.abs(st.selectCurrentViewX - st.selectStartViewX) >= 3) st.selectionMoved = true;
      renderSelection();
      e.preventDefault();
      e.stopPropagation();
    }, true);

    const finishSelection = (e) => {
      if (!st.selecting) return;
      if (e && st.pointerId != null && e.pointerId !== st.pointerId) return;
      const startX = st.selectStartViewX;
      const endX = st.selectCurrentViewX;
      st.selecting = false;
      st.pointerId = null;
      if (e) {
        try { pointerSurface.releasePointerCapture(e.pointerId); } catch {}
      }
      if (st.selectionMoved) zoomToRange(startX, endX);
      else hideSelection();
      st.selectionMoved = false;
      apply();
    };

    pointerSurface.addEventListener('pointerup', finishSelection, true);
    pointerSurface.addEventListener('pointercancel', finishSelection, true);
    pointerSurface.addEventListener('pointerleave', (e) => {
      if (!st.selecting) return;
      if (e && st.pointerId != null && e.pointerId !== st.pointerId) return;
      st.selectCurrentViewX = clamp(clientXToViewBoxX(e.clientX), plotLeft, plotRight);
      renderSelection();
    }, true);
    window.addEventListener('pointerup', finishSelection, true);

    svg.addEventListener('touchstart', (e) => {
      if (e.touches && e.touches.length === 2) {
        hideSelection();
        st.selecting = false;
        st.selectionMoved = false;
        st.pointerId = null;
        const a = e.touches[0], b = e.touches[1];
        const dist = Math.hypot(a.clientX - b.clientX, a.clientY - b.clientY);
        const midX = (a.clientX + b.clientX) / 2;
        rememberFocusFromClientX(midX);
        const midViewX = clientXToViewBoxX(midX);
        st.pinch = { dist, sx: st.sx, tx: st.tx, midViewX, midDataX: clamp(viewXToDataX(midViewX), plotLeft, plotRight) };
      }
    }, { passive: true });
    svg.addEventListener('touchmove', (e) => {
      if (!st.pinch || !(e.touches && e.touches.length === 2)) return;
      e.preventDefault();
      const a = e.touches[0], b = e.touches[1];
      const dist = Math.hypot(a.clientX - b.clientX, a.clientY - b.clientY);
      const ratio = dist / (st.pinch.dist || dist || 1);
      const next = clamp(st.pinch.sx * ratio, 1, MAX_ZOOM);
      st.tx = st.pinch.midViewX - next * st.pinch.midDataX;
      st.sx = next;
      apply();
    }, { passive: false });
    svg.addEventListener('touchend', () => { st.pinch = null; }, { passive: true });
    svg.addEventListener('touchcancel', () => { st.pinch = null; }, { passive: true });

    apply();
  } catch {
  }
}


function initTrustHistoryInteractions() {
  function hideAll() {
    document.querySelectorAll('.trustChartCard .trustTooltip.show').forEach((el) => {
      el.classList.remove('show');
      el.setAttribute('aria-hidden','true');
    });

    document.querySelectorAll('.trustChartSvg .hoverLine').forEach((l) => {
      l.style.display = 'none';
    });
    document.querySelectorAll('.trustChartSvg g.pt.active').forEach((pt) => {
      pt.classList.remove('active');
    });
  }

  function showForPoint(ptEl, anchorRect) {
    const card = ptEl.closest('.trustChartCard');
    if (!card) return;
    const tip = card.querySelector('.trustTooltip');
    if (!tip) return;

    let meta = null;
    try { meta = JSON.parse(decodeURIComponent(ptEl.getAttribute('data-meta') || '')); } catch {}
    if (!meta) return;

    const d = meta.ts ? new Date(meta.ts) : new Date();
   const userLocale = navigator.language || 'en-US';

const datePart = d.toLocaleDateString('en-GB', {
  day: '2-digit',
  month: 'short'
});

const timePart = d.toLocaleTimeString(userLocale, {
  hour: '2-digit',
  minute: '2-digit'
});

const dateStr = `${datePart}, ${timePart}`;

    const added = Number(meta.sources_added || 0);
    tip.innerHTML = `
      <div class="ttDate">${escapeHtml(dateStr)}</div>
      <div class="ttRow"><span class="ttLabel">${t("ui.trust_score","Trust score")}</span><b>${Number(meta.score || 0)}</b></div>
      <div class="ttRow"><span class="ttLabel">${t("ui.sources_added","Sources added")}</span><b>+${added}</b></div>
    `;

    // hover line + active point (like the reference)
    try {
      const svg = ptEl.closest('svg');
      const hoverLine = svg ? svg.querySelector('.hoverLine') : null;
      const dot = ptEl.querySelector('circle.ptDot');
      if (svg && hoverLine && dot) {
        const cx = Number(dot.getAttribute('cx') || 0);
        if (Number.isFinite(cx)) {
          hoverLine.setAttribute('x1', String(cx));
          hoverLine.setAttribute('x2', String(cx));
          hoverLine.style.display = '';
        }
      }
      svg && svg.querySelectorAll('g.pt.active').forEach((p) => p.classList.remove('active'));
      ptEl.classList.add('active');
    } catch {}

    const cardRect = card.getBoundingClientRect();
    const ar = anchorRect || ptEl.getBoundingClientRect();

    // Initial position near point
    tip.style.left = `${ar.left - cardRect.left}px`;
    tip.style.top = `${ar.top - cardRect.top}px`;

    tip.classList.add('show');
    tip.setAttribute('aria-hidden','false');

    // Clamp after layout
    requestAnimationFrame(() => {
      const w = tip.offsetWidth || 180;
      const h = tip.offsetHeight || 80;
      let left = (ar.left - cardRect.left) - w / 2;
      let top  = (ar.top - cardRect.top) - h - 12;

      const pad = 8;
      left = Math.max(pad, Math.min(left, cardRect.width - w - pad));
      top  = Math.max(pad, Math.min(top, cardRect.height - h - pad));

      tip.style.left = `${left}px`;
      tip.style.top  = `${top}px`;
    });
  }

  // Hover (desktop) + tap/click (mobile)
  document.addEventListener('pointerover', (e) => {
    const tgt = e.target;
    const pt = tgt && tgt.closest ? tgt.closest('g.pt') : null;
    if (!pt) return;
    showForPoint(pt, tgt.getBoundingClientRect ? tgt.getBoundingClientRect() : null);
  });

  document.addEventListener('click', (e) => {
    const tgt = e.target;
    const pt = tgt && tgt.closest ? tgt.closest('g.pt') : null;
    if (pt) {
      showForPoint(pt, tgt.getBoundingClientRect ? tgt.getBoundingClientRect() : null);
      e.stopPropagation();
      return;
    }
    // Click outside: hide all tooltips
    hideAll();
  });

  // When a card closes, hide its tooltip
  document.addEventListener('toggle', (e) => {
    const details = e.target;
    if (!details || details.tagName !== 'DETAILS') return;
    if (details.classList && details.classList.contains('newsDetails') && !details.open) hideAll();
  }, true);
}
initTrustHistoryInteractions();


/* =============================
   Tracking: plan limits UI
   Free=3, Pro=30, Analyst=∞
   Shows a compact limit bar ONLY in Tracking view.
   ============================= */

function _trackingMaxForPlan(plan){
  const p = String(plan || 'free').toLowerCase();
  if (p === 'pro') return 30;
  if (p === 'analyst') return Infinity;
  return 3;
}

function _trackingPlanLabel(plan){
  const p = String(plan || 'free').toLowerCase();
  if (p === 'pro') return 'Pro';
  if (p === 'analyst') return 'Analyst';
  return 'Free';
}

function updateTrackingLimitBarUI(){
  const bar = document.getElementById('trackingLimitBar');
  if (!bar) return;

  const inTracking = (typeof state !== 'undefined' && state && state.mode === 'fav');
  const loggedIn = !!(typeof authState !== 'undefined' && authState && authState.authenticated);

  // Only show inside Tracking view for logged-in users
  if (!inTracking || !loggedIn){
    bar.hidden = true;
    return;
  }

  const plan = (typeof billingState !== 'undefined' && billingState) ? billingState.plan : (authState?.user?.plan || 'free');
  const max = _trackingMaxForPlan(plan);
  const label = _trackingPlanLabel(plan);

  // Count from the canonical local storage list
  let count = 0;
  try{
    if (typeof getFavIds === 'function') count = (getFavIds() || []).length;
    else {
      const raw = localStorage.getItem(getScopedFavKey());
      const arr = raw ? JSON.parse(raw) : [];
      count = Array.isArray(arr) ? arr.length : 0;
    }
  }catch{ count = 0; }

  const sub = bar.querySelector('.tlSub');
  const pill = bar.querySelector('.tlPill');
  const fill = bar.querySelector('.tlFill');
  const prog = bar.querySelector('.tlProg');

  if (sub) sub.textContent = `${label} plan limit`;

  const maxText = (max === Infinity) ? '∞' : String(max);
  if (pill) pill.textContent = `${count}/${maxText}`;

  // Progress
  if (max === Infinity){
    if (fill) fill.style.width = (count > 0 ? '22%' : '0%');
    if (prog) prog.style.opacity = '0.45';
    bar.classList.remove('isFull');
  }else{
    const pct = max > 0 ? Math.max(0, Math.min(100, (count / max) * 100)) : 0;
    if (fill) fill.style.width = `${pct}%`;
    if (prog) prog.style.opacity = '';
    if (count >= max) bar.classList.add('isFull');
    else bar.classList.remove('isFull');
  }

  bar.hidden = false;
}

// Keep limit bar synced with changes
try{
  document.addEventListener('checkne:favsChanged', updateTrackingLimitBarUI);
  document.addEventListener('checkne:trackingUpdated', updateTrackingLimitBarUI);
  document.addEventListener('checkne:billingUpdated', updateTrackingLimitBarUI);
}catch{}

// Initial sync
try{ setTimeout(updateTrackingLimitBarUI, 0); }catch{}