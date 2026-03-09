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
    accountMenu.classList.remove("open");
  }
});

// ✅ Profile click
if(menuProfile){
  menuProfile.addEventListener("click", () => {
    accountMenu.classList.remove("open");
    try { if (typeof window.__navigate === 'function') window.__navigate('/account'); else location.href = '/account'; } catch(_) {}
  });
}

// ✅ Pricing click
if(menuPricing){
  menuPricing.addEventListener("click", () => {
    accountMenu.classList.remove("open");
    try { if (typeof window.__navigate === 'function') window.__navigate('/pricing'); else location.href = '/pricing'; } catch(_) {}
  });
}

// ✅ Logout click
menuLogout.addEventListener("click", async () => {
  accountMenu.classList.remove("open");

  try {
    // Cookie session logout
    const res = await fetch("/api/auth/logout", {
      method: "POST",
      credentials: "include",
    });

    // 2) если у тебя токены в localStorage/sessionStorage — очищаем на всякий
    localStorage.removeItem("access_token");
    localStorage.removeItem("token");
    localStorage.removeItem("user");
    sessionStorage.removeItem("access_token");
    sessionStorage.removeItem("token");

    if (!res.ok) {
      // иногда backend возвращает 204 без тела — это ок, но !ok значит 4xx/5xx
      const txt = await res.text().catch(() => "");
      console.error("Logout failed:", res.status, txt);
      alert("Logout failed. Check console.");
      return;
    }

    // Update in-memory state + UI
    authState = { authenticated: false, user: null };
    billingState = null;
    updateAuthUI();
    updatePricingUI();

    // Clear Tracking UI state so nothing from the previous account is visible.
    try {
      const trackingCountEl = document.getElementById('trackingCount');
      if (trackingCountEl) trackingCountEl.textContent = '0';
    } catch {}
    try {
      state.trackingItems = [];
      if (state.mode === 'fav') {
        renderCards([], { incremental: false });
      }
    } catch {}

    alert("Logged out!");

  } catch (e) {
    console.error(e);
    alert("Network error while logging out.");
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
// Smooth <details> animations
// ------------------------------
// Native <details> opens instantly. We intercept clicks on summaries and
// animate the content container height + opacity.
let _smoothDetailsInit = false;

function _animateDetails(detailsEl, contentEl, shouldOpen){
  if (!detailsEl || !contentEl) return;

  // Mobile browsers sometimes adjust scroll position while a <details> element
  // changes height (especially during animations), causing a small "jump".
  // We lock scrollY during the animation on coarse pointers / small screens.
  const isMobileViewport = (() => {
    try {
      return !!(window.matchMedia && (
        window.matchMedia('(pointer: coarse)').matches ||
        window.matchMedia('(max-width: 820px)').matches
      ));
    } catch { return false; }
  })();

  let _lockedScrollY = null;
  let _scrollLockRaf = 0;
  const startScrollLock = () => {
    if (!isMobileViewport) return;
    try { _lockedScrollY = window.scrollY || 0; } catch { _lockedScrollY = 0; }
    const tick = () => {
      if (detailsEl.dataset.animating !== '1') return;
      try {
        const nowY = window.scrollY || 0;
        // Keep the page stable during the height transition.
        if (_lockedScrollY !== null && Math.abs(nowY - _lockedScrollY) > 1) {
          window.scrollTo(0, _lockedScrollY);
        }
      } catch {}
      _scrollLockRaf = requestAnimationFrame(tick);
    };
    _scrollLockRaf = requestAnimationFrame(tick);
  };

  const stopScrollLock = () => {
    try { if (_scrollLockRaf) cancelAnimationFrame(_scrollLockRaf); } catch {}
    _scrollLockRaf = 0;
    _lockedScrollY = null;
  };

  const prefersReduced = !!(window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches);
  if (prefersReduced){
    detailsEl.open = !!shouldOpen;
    contentEl.style.height = '';
    contentEl.style.opacity = '';
    contentEl.style.transform = '';
    contentEl.style.transition = '';
    contentEl.style.overflow = detailsEl.open ? 'visible' : '';
    detailsEl.dataset.animating = '';
    try { if (detailsEl._flipAnim) detailsEl._flipAnim.cancel(); } catch {}
    detailsEl._flipAnim = null;
    detailsEl.style.height = '';
    detailsEl.style.overflow = '';
    try { detailsEl.classList.remove('is-opening','is-closing','is-animating'); } catch {}
    try { if (contentEl._smoothRO) contentEl._smoothRO.disconnect(); } catch {}
    contentEl._smoothRO = null;
    return;
  }

  // Premium feel: slightly longer + softer easing.
  const duration = 420;
  const ease = 'cubic-bezier(.16,1,.3,1)';

  // We also animate the overall <details> height (summary + body).
  // This eliminates the classic "teleport" at the end when summary layout
  // changes due to [open] styles.
  const summaryEl = detailsEl.querySelector('summary');

  // If an animation is in-flight, cancel it and continue from the current visual state.
  // This prevents "snaps" when the user taps fast (open->close->open).
  const cancelInFlight = () => {
    try {
      if (contentEl._smoothOnEnd) contentEl.removeEventListener('transitionend', contentEl._smoothOnEnd);
    } catch {}
    contentEl._smoothOnEnd = null;

    try { if (contentEl._smoothRO) contentEl._smoothRO.disconnect(); } catch {}
    contentEl._smoothRO = null;

    // Freeze current height so the next animation starts smoothly.
    try {
      const h = contentEl.getBoundingClientRect ? contentEl.getBoundingClientRect().height : contentEl.scrollHeight;
      contentEl.style.transition = 'none';
      contentEl.style.height = `${Math.max(0, Math.round(h))}px`;
      contentEl.style.opacity = getComputedStyle(contentEl).opacity || '1';
      // Use a deterministic transform baseline
      contentEl.style.transform = 'translateY(0)';
      void contentEl.offsetHeight;
      contentEl.style.transition = '';
    } catch {}

    try { if (detailsEl._flipAnim) detailsEl._flipAnim.cancel(); } catch {}
    detailsEl._flipAnim = null;
    // Keep current overall height as the new baseline.
    try {
      const dh = detailsEl.getBoundingClientRect().height;
      detailsEl.style.height = `${Math.max(0, Math.round(dh))}px`;
      detailsEl.style.overflow = 'hidden';
      void detailsEl.offsetHeight;
    } catch {}
  };

  if (detailsEl.dataset.animating === '1') {
    cancelInFlight();
  }

  detailsEl.dataset.animating = '1';
  contentEl.style.overflow = 'hidden';

  // Freeze the overall height so layout changes can't snap.
  const freezeDetailsHeight = () => {
    try {
      const h = detailsEl.getBoundingClientRect().height;
      detailsEl.style.height = `${Math.max(0, Math.round(h))}px`;
      detailsEl.style.overflow = 'hidden';
      void detailsEl.offsetHeight; // reflow
    } catch {}
  };

  const animateDetailsHeight = (toPx) => {
    try {
      const fromH = detailsEl.getBoundingClientRect().height;
      const toH = Math.max(0, Math.round(toPx));
      if (!Number.isFinite(fromH) || !Number.isFinite(toH)) return;
      try { if (detailsEl._flipAnim) detailsEl._flipAnim.cancel(); } catch {}
      detailsEl._flipAnim = detailsEl.animate(
        [{ height: `${fromH}px` }, { height: `${toH}px` }],
        { duration, easing: ease }
      );
      detailsEl._flipAnim.onfinish = () => { detailsEl._flipAnim = null; };
      detailsEl._flipAnim.oncancel = () => { detailsEl._flipAnim = null; };
    } catch {}
  };

  // Apple-like smoothness: content (especially images) can change height mid-animation.
  // Keep the target height in sync while opening.
  const startResizeWatch = () => {
    if (!('ResizeObserver' in window)) return;
    try {
      const ro = new ResizeObserver(() => {
        if (detailsEl.dataset.animating !== '1') return;
        if (!detailsEl.open) return;
        contentEl.style.height = `${contentEl.scrollHeight}px`;
      });
      ro.observe(contentEl);
      contentEl._smoothRO = ro;
    } catch {}
  };

  const cleanup = () => {
    detailsEl.dataset.animating = '';
    contentEl.style.height = '';
    contentEl.style.opacity = '';
    contentEl.style.transform = '';
    contentEl.style.transition = '';
    try { if (contentEl._smoothRO) contentEl._smoothRO.disconnect(); } catch {}
    contentEl._smoothRO = null;
    if (detailsEl.open) contentEl.style.overflow = 'visible';

    try { if (detailsEl._flipAnim) detailsEl._flipAnim.cancel(); } catch {}
    detailsEl._flipAnim = null;
    detailsEl.style.height = '';
    detailsEl.style.overflow = '';
    try { detailsEl.classList.remove('is-opening','is-closing','is-animating'); } catch {}

    // Release mobile scroll lock if any.
    stopScrollLock();
  };

  const setTransition = () => {
    contentEl.style.transition = `height ${duration}ms ${ease}, opacity ${duration}ms ${ease}, transform ${duration}ms ${ease}`;
  };

  const raf2 = (fn) => requestAnimationFrame(() => requestAnimationFrame(fn));

  if (shouldOpen){
    try {
      detailsEl.classList.remove('is-closing');
      detailsEl.classList.add('is-opening','is-animating');
    } catch {}

    // Freeze BEFORE toggling open, so we can animate the overall height.
    freezeDetailsHeight();
    detailsEl.open = true;

    // Prevent small scroll jumps on mobile during the height animation.
    startScrollLock();

    // Start state
    contentEl.style.height = '0px';
    contentEl.style.opacity = '0';
    contentEl.style.transform = 'translateY(-6px)';

    // End state
    const endH = contentEl.scrollHeight;
    startResizeWatch();

    // Animate <details> height too (summary + body)
    raf2(() => {
      const sumH = summaryEl ? summaryEl.getBoundingClientRect().height : 0;
      animateDetailsHeight(sumH + endH);
    });

    raf2(() => {
      setTransition();
      contentEl.style.height = `${endH}px`;
      contentEl.style.opacity = '1';
      contentEl.style.transform = 'translateY(0)';
    });

    const onEnd = (e) => {
      if (e && e.target !== contentEl) return;
      contentEl.removeEventListener('transitionend', onEnd);
      contentEl._smoothOnEnd = null;
      cleanup();
    };
    contentEl._smoothOnEnd = onEnd;
    contentEl.addEventListener('transitionend', onEnd);
  } else {
    // Closing
    try {
      detailsEl.classList.remove('is-opening');
      detailsEl.classList.add('is-closing','is-animating');
    } catch {}

    // Freeze BEFORE summary layout switches back.
    freezeDetailsHeight();

    // Prevent small scroll jumps on mobile during the height animation.
    startScrollLock();

    try { if (contentEl._smoothRO) contentEl._smoothRO.disconnect(); } catch {}
    contentEl._smoothRO = null;

    const startH = contentEl.scrollHeight;
    contentEl.style.height = `${startH}px`;
    contentEl.style.opacity = '1';
    contentEl.style.transform = 'translateY(0)';

    // Animate towards the summary height (with closing layout applied)
    raf2(() => {
      const sumH = summaryEl ? summaryEl.getBoundingClientRect().height : 0;
      animateDetailsHeight(sumH);
    });

    raf2(() => {
      setTransition();
      contentEl.style.height = '0px';
      contentEl.style.opacity = '0';
      contentEl.style.transform = 'translateY(-6px)';
    });

    const onEnd = (e) => {
      if (e && e.target !== contentEl) return;
      contentEl.removeEventListener('transitionend', onEnd);
      contentEl._smoothOnEnd = null;
      detailsEl.open = false;
      cleanup();
    };
    contentEl._smoothOnEnd = onEnd;
    contentEl.addEventListener('transitionend', onEnd);
  }
}

// Expose for programmatic opens (deep links etc.)
try { window.__checkneAnimateDetails = _animateDetails; } catch {}

function initSmoothDetails(){
  if (_smoothDetailsInit) return;
  _smoothDetailsInit = true;

  // Use capture so we can prevent the native toggle before it happens.
  document.addEventListener('click', (e) => {
    const sum = e.target && e.target.closest ? e.target.closest('summary.accordionSummary, summary.newsSummary') : null;
    if (!sum) return;

    const detailsEl = sum.parentElement;
    if (!detailsEl || detailsEl.tagName !== 'DETAILS') return;

    // Ignore clicks on interactive elements inside the summary (buttons/links etc.)
    if (sum.classList.contains('newsSummary')){
      if (e.target.closest('button, a, input, textarea, select, .trackToggle, .shareBtn, .iconBtn')) return;

      // Guest-locked feed cards must NOT start the smooth <details> animation.
      // On mobile that animation temporarily scroll-locks the page, so if we let it
      // start and then open the auth modal afterwards, the page can remain jerky or
      // appear frozen after closing the modal.
      const lockedCard = detailsEl.closest && detailsEl.closest('[data-locked="1"]');
      const isGuest = !(window.authState && window.authState.authenticated);
      if (lockedCard && isGuest){
        e.preventDefault();
        e.stopPropagation();
        try { detailsEl.open = false; } catch {}
        try { detailsEl.dataset.animating = ''; } catch {}
        try { detailsEl.style.height = ''; detailsEl.style.overflow = ''; } catch {}
        try {
          const body = detailsEl.querySelector('.newsOpenBody');
          if (body){
            body.style.height = '';
            body.style.opacity = '';
            body.style.transform = '';
            body.style.transition = '';
            body.style.overflow = '';
          }
        } catch {}
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


requestAnimationFrame(updateFooterShadeGap);
initSmoothDetails();
main();


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

    const plotLeft = Number(svg.getAttribute('data-plot-left') || 0);
    const plotRight = Number(svg.getAttribute('data-plot-right') || 0);
    const viewW = Number(svg.getAttribute('data-view-w') || 0);
    if (!Number.isFinite(plotLeft) || !Number.isFinite(plotRight) || !Number.isFinite(viewW) || viewW <= 0) return;

    const clamp = (v, a, b) => Math.max(a, Math.min(b, v));
    const MAX_ZOOM = 20;

    // per-chart state
    const st = {
      sx: 1,
      tx: 0,
      dragging: false,
      dragStartX: 0,
      txStart: 0,
      pinch: null,
      // Remember the last interaction point so +/- zoom from where the user focused.
      lastViewX: (plotLeft + plotRight) / 2,
    };

    // Keep dots visually circular when we zoom only along X.
    // Without compensation, scaling the plot group on X turns circles into ellipses.
    function updateDotCompensation() {
      const inv = 1 / (st.sx || 1);
      svg.querySelectorAll('g.trustPlotXform circle.ptDot, g.trustPlotXform circle.ptHalo').forEach((c) => {
        const cx = Number(c.getAttribute('cx'));
        const cy = Number(c.getAttribute('cy'));
        if (!Number.isFinite(cx) || !Number.isFinite(cy)) return;
        // Apply inverse X-scale around the circle center.
        c.setAttribute('transform', `translate(${cx} ${cy}) scale(${inv} 1) translate(${-cx} ${-cy})`);
      });
    }

    function boundsFor(sx) {
      // Keep content covering the plot area (avoid blank gaps).
      const minTx = plotRight - sx * plotRight;
      const maxTx = plotLeft - sx * plotLeft;
      return { minTx, maxTx };
    }

    function apply() {
      const b = boundsFor(st.sx);
      st.tx = clamp(st.tx, b.minTx, b.maxTx);
      xform.setAttribute('transform', `matrix(${st.sx} 0 0 1 ${st.tx} 0)`);
      updateDotCompensation();
      // Cursor feedback
      panLayer.style.cursor = (st.sx > 1.001) ? (st.dragging ? 'grabbing' : 'grab') : 'default';
    }

    function clientXToViewBoxX(clientX) {
      const r = svg.getBoundingClientRect();
      const px = (clientX - r.left) / (r.width || 1);
      return clamp(px, 0, 1) * viewW;
    }

    function zoomAt(viewX, factor) {
      const next = clamp(st.sx * factor, 1, MAX_ZOOM);
      if (Math.abs(next - st.sx) < 0.0001) return;
      // Keep viewX stable under the cursor
      st.tx = st.tx + (st.sx - next) * viewX;
      st.sx = next;
      apply();
    }

    function rememberFocusFromClientX(clientX) {
      // Keep focus inside the plot area for nicer behavior.
      const viewX = clientXToViewBoxX(clientX);
      st.lastViewX = clamp(viewX, plotLeft, plotRight);
    }

    function reset() {
      st.sx = 1;
      st.tx = 0;
      st.dragging = false;
      st.pinch = null;
      apply();
    }

    // Buttons (controls live in header outside chartCard)
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

    // Wheel zoom (trackpad/mouse)
    svg.addEventListener('wheel', (e) => {
      // Only if inside plot area
      const r = svg.getBoundingClientRect();
      const inside = e.clientX >= r.left && e.clientX <= r.right && e.clientY >= r.top && e.clientY <= r.bottom;
      if (!inside) return;
      e.preventDefault();
      rememberFocusFromClientX(e.clientX);
      const viewX = clientXToViewBoxX(e.clientX);
      const factor = (e.deltaY < 0) ? 1.18 : (1 / 1.18);
      zoomAt(viewX, factor);
    }, { passive: false });

    // Drag to pan (Pointer Events)
    panLayer.addEventListener('pointerdown', (e) => {
      // Always remember where the user touched/clicked, so subsequent +/- zoom
      // feels anchored to their intent.
      rememberFocusFromClientX(e.clientX);

      if (st.sx <= 1.001) return; // no pan when not zoomed
      st.dragging = true;
      st.dragStartX = e.clientX;
      st.txStart = st.tx;
      try { panLayer.setPointerCapture(e.pointerId); } catch {}
      apply();
      e.preventDefault();
      e.stopPropagation();
    });
    panLayer.addEventListener('pointermove', (e) => {
      if (!st.dragging) return;
      rememberFocusFromClientX(e.clientX);
      const r = svg.getBoundingClientRect();
      const dxPx = e.clientX - st.dragStartX;
      // Convert screen px to viewBox units
      const dxView = (dxPx / (r.width || 1)) * viewW;
      st.tx = st.txStart + dxView;
      apply();
      e.preventDefault();
      e.stopPropagation();
    });
    const endDrag = () => {
      if (!st.dragging) return;
      st.dragging = false;
      apply();
    };
    panLayer.addEventListener('pointerup', endDrag);
    panLayer.addEventListener('pointercancel', endDrag);
    panLayer.addEventListener('pointerleave', endDrag);

    // Pinch zoom (touch)
    svg.addEventListener('touchstart', (e) => {
      if (e.touches && e.touches.length === 2) {
        const a = e.touches[0], b = e.touches[1];
        const dist = Math.hypot(a.clientX - b.clientX, a.clientY - b.clientY);
        const midX = (a.clientX + b.clientX) / 2;
        rememberFocusFromClientX(midX);
        st.pinch = { dist, sx: st.sx, tx: st.tx, midViewX: clientXToViewBoxX(midX) };
      }
    }, { passive: true });
    svg.addEventListener('touchmove', (e) => {
      if (!st.pinch || !(e.touches && e.touches.length === 2)) return;
      e.preventDefault();
      const a = e.touches[0], b = e.touches[1];
      const dist = Math.hypot(a.clientX - b.clientX, a.clientY - b.clientY);
      const ratio = dist / (st.pinch.dist || dist || 1);
      const next = clamp(st.pinch.sx * ratio, 1, MAX_ZOOM);
      st.tx = st.pinch.tx + (st.pinch.sx - next) * st.pinch.midViewX;
      st.sx = next;
      apply();
    }, { passive: false });
    svg.addEventListener('touchend', () => { st.pinch = null; }, { passive: true });
    svg.addEventListener('touchcancel', () => { st.pinch = null; }, { passive: true });

    // Init
    apply();
  } catch {
    // never break the tracking page if something goes wrong
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