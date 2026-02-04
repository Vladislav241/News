const API_BASE = ""; // same-origin

// --- Deep-link support (shared URLs) ---
// We keep the shared URL as /share/<id> for OG meta tags, but users get
// redirected to /?open=<id>&shared=1. Here we auto-open that card.
let pendingOpenClusterId = null;
let pendingOpenRequiresAuth = false; // true when coming from a shared link

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
  const cards = document.getElementById('cards');
  if (!cards) return false;
  const card = cards.querySelector(`.newsCard[data-id="${String(clusterId)}"]`);
  if (!card) return false;
  const details = card.querySelector('details.newsDetails');
  if (details) details.open = true;
  // Scroll the opened card into view (nicely)
  try {
    card.scrollIntoView({ behavior: 'smooth', block: 'start' });
  } catch {
    card.scrollIntoView();
  }
  // Brief highlight so user notices the opened item
  card.classList.add('isDeepLinked');
  setTimeout(() => card.classList.remove('isDeepLinked'), 1400);
  return true;
}

async function ensureItemInFeedAndOpen(clusterId) {
  // 1) If already rendered -> open
  if (openCardInDOM(clusterId)) return true;

  // 2) Try to fetch this single item and inject into current feed
  try {
    const interests = encodeURIComponent((state.interests || []).join(","));
    const country = encodeURIComponent(state.country || "world");
    const language = encodeURIComponent(state.language || "en");
    const r = await fetch(
      `${API_BASE}/api/news/by_ids?ids=${encodeURIComponent(String(clusterId))}` +
        `&interests=${interests}&country=${country}&language=${language}`
    );
    if (!r.ok) return false;
    const j = await r.json();
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
  const id = item?.id ?? item?.cluster_id ?? item?.clusterId;
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
    title: item?.title || 'CHECK news',
    score: item?.score ?? item?.trust_score ?? null,
    outlets: item?.sources_count ?? item?.outlet_count ?? null,
  });
}

function openShareModal(data) {
  const backdrop = document.getElementById('shareBackdrop');
  const closeBtn = document.getElementById('shareCloseBtn'); // may be null if removed in UI
  const noThanks = document.getElementById('shareNoThanks');
  const img = document.getElementById('sharePreviewImg');
  const headline = document.getElementById('shareHeadline');
  const toX = document.getElementById('shareToXBtn');
  const toThreads = document.getElementById('shareToThreadsBtn');
  const copyBtn = document.getElementById('shareCopyBtn');

  if (!backdrop || !img || !headline || !toX || !toThreads || !copyBtn) {
    // Safety fallback: just copy link
    return copyShareLink(data.url);
  }

  // Populate UI
  headline.textContent = data.title || 'Share';
  img.src = `/api/share-image/${encodeURIComponent(data.id)}.png?dpr=2&v=${encodeURIComponent(data.v || Date.now())}`;


  img.onerror = () => {
    // If image generator fails, still allow share
    img.removeAttribute('src');
    img.style.display = 'none';
  };

  const encodedUrl = encodeURIComponent(data.url);
  const tweetText = encodeURIComponent(`Trust score • ${data.title || 'CHECK news'}`);
  const xUrl = `https://twitter.com/intent/tweet?url=${encodedUrl}&text=${tweetText}`;

  toX.onclick = () => window.open(xUrl, '_blank', 'noopener,noreferrer');

  // Threads doesn't provide a fully reliable web intent. Best UX: open Threads and copy the link.
  toThreads.onclick = async () => {
    await copyShareLink(data.url);
    window.open('https://www.threads.net/', '_blank', 'noopener,noreferrer');
  };

  copyBtn.onclick = () => copyShareLink(data.url);

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
  const backdrop = document.getElementById('shareBackdrop');
  if (!backdrop) return;
  backdrop.classList.remove('isOpen');
  backdrop.setAttribute('aria-hidden', 'true');
}

async function copyShareLink(url){
  try{
    await navigator.clipboard.writeText(url);
    if (typeof toast === 'function') toast('Link copied');
    else alert('Link copied');
  }catch(e){
    prompt('Copy link:', url);
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

const STORAGE_KEY = "news_prefs_v1";
const FAV_KEY = "news_favs_v1";
const DEVICE_KEY = "news_device_id_v1";
const SEEN_KEY = "news_seen_state_v1";
const FILTERS_KEY = "news_filters_v1";
const THUMBS_KEY = "news_thumbs_v1";

// UI config
// If score < LOW_SCORE_THRESHOLD => dark card (as in the provided design). Easy to tweak.
const LOW_SCORE_THRESHOLD = 70;
let feedExpanded = false;
const FEED_PAGE_SIZE = 10; // показываем только первые 10 событий, остальное раскрывается кнопкой

// Cache last loaded lists so expand/collapse doesn't need a refetch.
let lastFeedItems = [];
let lastFavItems = [];

// "New" flame badge window (how long the item stays marked as new since first appearance)
const NEW_BADGE_WINDOW_MS = 60 * 60 * 1000; // 1 hour

// Used to avoid marking everything as new on the very first load.
let hasInitialFeedLoaded = false;
let currentFeedKey = "";

// ----------------------------
// Auth state (cookie-based)
// ----------------------------
let authState = {
  authenticated: false,
  user: null,
};

let _resetToken = "";

// ----------------------------
// Billing / Pricing (MVP)
// ----------------------------
let billingInterval = 'monthly';
let pendingCheckout = null; // { plan, interval }
let billingState = { plan: 'free', status: 'active', interval: 'monthly' };

function setFeedExpanded(v) {
  const target = !!v;
  const cardsEl = document.getElementById('cards');

  // Smooth transition: fade list out, swap content, fade back in.
  if (cardsEl) cardsEl.classList.add('is-fading');

  window.setTimeout(() => {
    feedExpanded = target;
    if (state.mode === 'feed') {
      renderCards(lastFeedItems, { incremental: false });
    } else if (state.mode === 'fav') {
      // Tracking doesn't use show more / hide, but keep it safe.
      renderCards(state.trackingItems || [], { incremental: false });
    } else {
      renderCards(lastFavItems, { incremental: false });
    }

    // Next frame: remove fade class so it animates back to normal.
    requestAnimationFrame(() => {
      const el = document.getElementById('cards');
      if (el) el.classList.remove('is-fading');
    });
  }, 120);
}


let state = {
  interests: ["general"],
  country: "world",
  language: "en",
  mode: "feed",
  q: "",
  cooldownUntil: 0,

  // UI preferences
  showThumbs: false,

  filters: {
    onlyConfirmed: false,
    onlyAI: false,
    minScore: 0,
  },
};

function qs(id) { return document.getElementById(id); }
function setStatus(text) { qs("status").textContent = text || ""; }

function escapeHtml(s) {
  return (s || "").replace(/[&<>"']/g, (c) => ({
    "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;",
  }[c]));
}

function getDeviceId() {
  let id = localStorage.getItem(DEVICE_KEY);
  if (!id) {
    id = (crypto.randomUUID ? crypto.randomUUID() : String(Date.now()) + Math.random());
    localStorage.setItem(DEVICE_KEY, id);
  }
  return id;
}
const DEVICE_ID = getDeviceId();

function loadPrefs() {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return;
    const p = JSON.parse(raw);
    // Keep interests deterministic & deduplicated (prevents duplicate chips like "technology" twice)
    const ints = Array.isArray(p.interests) ? p.interests : state.interests;
    state.interests = [...new Set(ints.map(String))].filter(Boolean);
    state.country = p.country || state.country;
    state.language = p.language || state.language;
  } catch {}
}

function savePrefs() {
  const interests = [...new Set((state.interests || []).map(String))].filter(Boolean);
  localStorage.setItem(STORAGE_KEY, JSON.stringify({
    interests,
    country: state.country,
    language: state.language,
  }));
}

function loadFilters() {
  try {
    const raw = localStorage.getItem(FILTERS_KEY);
    if (!raw) return;
    const f = JSON.parse(raw);
    state.filters.onlyConfirmed = !!f.onlyConfirmed;
    state.filters.onlyAI = !!f.onlyAI;
    state.filters.minScore = Number(f.minScore || 0);
  } catch {}
}

function saveFilters() {
  localStorage.setItem(FILTERS_KEY, JSON.stringify(state.filters));
}

function loadThumbPrefs() {
  try {
    const raw = localStorage.getItem(THUMBS_KEY);
    if (raw === null) return;
    state.showThumbs = raw === '1' || raw === 'true';
  } catch {}
}

function saveThumbPrefs() {
  try {
    localStorage.setItem(THUMBS_KEY, state.showThumbs ? '1' : '0');
  } catch {}
}

function applyFiltersUIToState() {
  state.filters.onlyConfirmed = !!qs("fOnlyConfirmed").checked;
  state.filters.onlyAI = !!qs("fOnlyAI").checked;
  state.filters.minScore = Number(qs("fMinScore").value || 0);
  qs("fMinScoreVal").textContent = String(state.filters.minScore);
  saveFilters();
}

function syncFiltersStateToUI() {
  qs("fOnlyConfirmed").checked = !!state.filters.onlyConfirmed;
  qs("fOnlyAI").checked = !!state.filters.onlyAI;
  qs("fMinScore").value = String(state.filters.minScore || 0);
  qs("fMinScoreVal").textContent = String(state.filters.minScore || 0);
}

function syncThumbToggleUI() {
  const btn = document.getElementById('thumbToggle');
  if (!btn) return;
  btn.classList.toggle('on', !!state.showThumbs);
  btn.setAttribute('aria-checked', state.showThumbs ? 'true' : 'false');
}

function getFavIds() {
  try {
    const raw = localStorage.getItem(FAV_KEY);
    const arr = raw ? JSON.parse(raw) : [];
    const ids = Array.isArray(arr) ? arr.map((x) => Number(x)).filter((x) => Number.isFinite(x)) : [];
    return [...new Set(ids)];
  } catch { return []; }
}

function setFavIds(ids) {
  const uniq = [...new Set((ids || []).map((x) => Number(x)).filter((x) => Number.isFinite(x)))];
  localStorage.setItem(FAV_KEY, JSON.stringify(uniq));
  // legacy counter (hidden)
  const favCountEl = document.getElementById("favCount");
  if (favCountEl) favCountEl.textContent = String(uniq.length);

  // new header badge
  const trackingCountEl = document.getElementById("trackingCount");
  if (trackingCountEl) trackingCountEl.textContent = String(uniq.length);
}

function isFav(id) { return getFavIds().includes(Number(id)); }

function toggleFav(id) {
  if (!authState.authenticated) {
    openAuthModal('tracking');
    return isFav(id);
  }
  id = Number(id);
  const ids = getFavIds();
  if (ids.includes(id)) {
    setFavIds(ids.filter((x) => x !== id));
    syncFavoritesToServer().catch(() => {});
    return false;
  } else {
    ids.unshift(id);
    setFavIds(ids);
    syncFavoritesToServer().catch(() => {});
    return true;
  }
}

function removeFav(id) {
  if (!authState.authenticated) {
    openAuthModal('tracking');
    return false;
  }
  // getFavIds() returns numeric ids; keep comparisons numeric
  id = Number(id);
  const ids = getFavIds();
  if (!ids.includes(id)) return false;
  setFavIds(ids.filter((x) => x !== id));
  syncFavoritesToServer().catch(() => {});
  return true;
}

function loadSeenState() {
  try { return JSON.parse(localStorage.getItem(SEEN_KEY) || "{}") || {}; }
  catch { return {}; }
}
function saveSeenState(obj) { localStorage.setItem(SEEN_KEY, JSON.stringify(obj || {})); }

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
  await fetch(`${API_BASE}/api/favorites/sync`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ ids }),
  });
}

async function pullFavoritesFromServerAndMerge() {
  try {
    if (!authState.authenticated) return;
    const res = await fetch(`${API_BASE}/api/favorites`);
    if (!res.ok) return;
    const data = await res.json();
    const serverIds = Array.isArray(data.ids) ? data.ids.map(Number).filter(Number.isFinite) : [];
    const localIds = getFavIds();
    const merged = [...new Set([...serverIds, ...localIds])];
    setFavIds(merged);
  } catch {}
}

// ----------------------------
// Auth modal helpers
// ----------------------------

function _showAuthError(elId, msg, asHtml = false) {
  const el = document.getElementById(elId);
  if (!el) return;
  el.classList.toggle('isShow', !!msg);
  if (!msg) {
    el.textContent = '';
    return;
  }
  if (asHtml) el.innerHTML = msg;
  else el.textContent = msg;
}

function setAuthStep(step) {
  const steps = {
    choose: 'authStepChoose',
    email: 'authStepEmail',
    forgot: 'authStepForgot',
    reset: 'authStepReset',
  };
  for (const k of Object.values(steps)) {
    const el = document.getElementById(k);
    if (el) el.style.display = 'none';
  }
  const id = steps[step] || steps.choose;
  const target = document.getElementById(id);
  if (target) target.style.display = '';

  // Clear errors
  _showAuthError('authError', '');
  _showAuthError('authForgotError', '');
  _showAuthError('authResetError', '');
}

function openAuthModal(reason = 'login') {
  const back = document.getElementById('authBackdrop');
  if (!back) return;
  back.classList.add('isOpen');
  back.setAttribute('aria-hidden', 'false');

  // Default step
  setAuthStep('choose');

  if (reason === 'verify_required') {
    setAuthStep('email');
    const emailEl = document.getElementById('authEmail');
    if (emailEl && authState.user?.email) emailEl.value = authState.user.email;
    _showAuthError(
      'authError',
      `Please verify your email to use Tracking and saving.\n\nCheck your inbox for a verification link.\n\n` +
        `<a href="#" id="authResendVerify" class="authLink">Resend verification email</a>`,
      true,
    );
    const a = document.getElementById('authResendVerify');
    if (a) {
      a.onclick = async (e) => {
        e.preventDefault();
        const em = (document.getElementById('authEmail')?.value || authState.user?.email || '').trim();
        if (!em) {
          _showAuthError('authError', 'Enter your email first.');
          return;
        }
        try {
          await fetch(`${API_BASE}/api/auth/verify/resend`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ email: em }),
          });
          _showAuthError('authError', 'Verification email sent. Check your inbox (and spam).');
        } catch {
          _showAuthError('authError', 'Failed to send email. Try again later.');
        }
      };
    }
  }
}

function closeAuthModal() {
  const back = document.getElementById('authBackdrop');
  if (!back) return;
  back.classList.remove('isOpen');
  back.setAttribute('aria-hidden', 'true');
  setAuthStep('choose');
}

function updateAccountPlanPill() {
  const pill = document.getElementById('accountPlanPill');
  if (!pill) return;

  // Only show for paid plans.
  if (!authState.authenticated) {
    pill.style.display = 'none';
    return;
  }

  const plan = (billingState?.plan || 'free').toLowerCase();
  if (plan === 'pro') {
    pill.textContent = 'PRO';
    pill.style.display = 'inline-flex';
  } else if (plan === 'analyst') {
    pill.textContent = 'ANALYST';
    pill.style.display = 'inline-flex';
  } else {
    pill.style.display = 'none';
  }
}

function updateAuthUI() {
  // In this version the header uses btnAccount.
  const btnAccount = document.getElementById('btnAccount');
  const accountMenu = document.getElementById('accountMenu');
  const menuLogout = document.getElementById('menuLogout');

  if (btnAccount) {
    // Keep the visible label consistent with the design.
    const label = authState.authenticated ? 'Account' : 'Login';
    btnAccount.setAttribute('aria-label', label);

    // Also update the visible text (button contains a text node + optional plan pill span).
    const pill = document.getElementById('accountPlanPill');
    const textNode = Array.from(btnAccount.childNodes).find(n => n.nodeType === Node.TEXT_NODE);
    if (textNode) {
      textNode.textContent = label + ' ';
    } else {
      // Fallback: rebuild safely
      btnAccount.textContent = label + ' ';
      if (pill) btnAccount.appendChild(pill);
    }
  }

  // When logged out, ensure the dropdown is closed and logout item hidden.
  if (!authState.authenticated) {
    if (accountMenu) accountMenu.classList.remove('open');
    if (menuLogout) menuLogout.style.display = 'none';
  } else {
    if (menuLogout) menuLogout.style.display = '';
  }

  updateAccountPlanPill();
}

async function refreshAuthState() {
  try {
    const res = await fetch(`${API_BASE}/api/auth/me`);
    const data = await res.json();
    authState = {
      authenticated: !!data?.authenticated,
      user: data?.user || null,
    };
  } catch {
    authState = { authenticated: false, user: null };
  }
  updateAuthUI();

  if (authState.authenticated) {
    await pullFavoritesFromServerAndMerge();
    await syncFavoritesToServer();
  }

  // Billing state depends on auth
  await refreshBillingState();
}

async function refreshBillingState() {
  // If not logged in, treat as free.
  if (!authState.authenticated) {
    billingState = { plan: 'free', status: 'active', interval: 'monthly' };
    updatePricingUI();
    return;
  }
  try {
    const r = await fetch(`${API_BASE}/api/billing/me`);
    const j = await r.json();
    billingState = {
      plan: j?.plan || 'free',
      status: j?.status || 'active',
      interval: j?.interval || 'monthly',
      current_period_end: j?.current_period_end || null,
    };
  } catch {
    billingState = { plan: 'free', status: 'active', interval: 'monthly' };
  }
  updatePricingUI();
  updateAccountPlanPill();
}

function bindAuthModalUI() {
  const back = document.getElementById('authBackdrop');
  if (!back) return;

  const closeBtn = document.getElementById('authClose');
  if (closeBtn) closeBtn.onclick = closeAuthModal;
  back.addEventListener('click', (e) => {
    if (e.target === back) closeAuthModal();
  });

  const btnGoogle = document.getElementById('btnGoogle');
  if (btnGoogle) {
    btnGoogle.onclick = async () => {
      try {
        const r = await fetch(`${API_BASE}/api/auth/oauth/google/start`);
        const j = await r.json();
        if (j?.url) window.location.href = j.url;
      } catch {
        // noop
      }
    };
  }

  const btnEmail = document.getElementById('btnEmail');
  if (btnEmail) btnEmail.onclick = () => setAuthStep('email');

  const backLink = document.getElementById('authBack');
  if (backLink) backLink.onclick = (e) => { e.preventDefault(); setAuthStep('choose'); };

  const forgotLink = document.getElementById('authForgot');
  if (forgotLink) forgotLink.onclick = (e) => { e.preventDefault(); setAuthStep('forgot'); };

  const forgotBack = document.getElementById('authForgotBack');
  if (forgotBack) forgotBack.onclick = (e) => { e.preventDefault(); setAuthStep('email'); };

  const submit = document.getElementById('authSubmit');
  if (submit) {
    submit.onclick = async () => {
      const email = (document.getElementById('authEmail')?.value || '').trim();
      const password = (document.getElementById('authPassword')?.value || '').trim();
      if (!email || !password) {
        _showAuthError('authError', 'Enter email and password.');
        return;
      }

      // Try login first. If 401/404-ish -> register.
      try {
        let r = await fetch(`${API_BASE}/api/auth/login`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ email, password }),
        });

        if (r.ok) {
          await refreshAuthState();
          closeAuthModal();
          if (pendingCheckout) {
            const pc = pendingCheckout;
            pendingCheckout = null;
            await startCheckout(pc.plan, pc.interval);
            return;
          }
          // Reload feed so paywall disappears
          await fetchFeed({ reset: true });

          // If user came from a shared deep-link, open the requested article now.
          await maybeOpenDeepLinkedArticle();
          return;
        }

        const err = await safeReadError(r);

        // If invalid credentials -> attempt register (only if it's likely a new user)
        if (r.status === 401) {
          r = await fetch(`${API_BASE}/api/auth/register`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ email, password }),
          });
          if (r.ok) {
            _showAuthError('authError', 'Account created. Check your email to verify before using Tracking/saving.');
            return;
          }
          const err2 = await safeReadError(r);
          _showAuthError('authError', err2 || 'Registration failed.');
          return;
        }

        _showAuthError('authError', err || 'Login failed.');
      } catch {
        _showAuthError('authError', 'Network error. Try again.');
      }
    };
  }

  const forgotSubmit = document.getElementById('authForgotSubmit');
  if (forgotSubmit) {
    forgotSubmit.onclick = async () => {
      const email = (document.getElementById('authForgotEmail')?.value || '').trim();
      if (!email) {
        _showAuthError('authForgotError', 'Enter your email.');
        return;
      }
      try {
        await fetch(`${API_BASE}/api/auth/forgot`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ email }),
        });
        _showAuthError('authForgotError', 'If that email exists, we sent a reset link.');
      } catch {
        _showAuthError('authForgotError', 'Failed to send reset link.');
      }
    };
  }

  const resetSubmit = document.getElementById('authResetSubmit');
  if (resetSubmit) {
    resetSubmit.onclick = async () => {
      const newPassword = (document.getElementById('authResetPassword')?.value || '').trim();
      if (!_resetToken) {
        _showAuthError('authResetError', 'Missing reset token.');
        return;
      }
      if (!newPassword) {
        _showAuthError('authResetError', 'Enter a new password.');
        return;
      }
      try {
        const r = await fetch(`${API_BASE}/api/auth/reset`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ token: _resetToken, new_password: newPassword }),
        });
        if (!r.ok) {
          const err = await safeReadError(r);
          _showAuthError('authResetError', err || 'Reset failed.');
          return;
        }
        _showAuthError('authResetError', 'Password updated. You can log in now.');
        setAuthStep('email');
      } catch {
        _showAuthError('authResetError', 'Network error.');
      }
    };
  }
}

async function safeReadError(res) {
  try {
    const j = await res.json();
    const d = j?.detail;
    if (typeof d === 'string') return d;
    if (d?.message) return d.message;
    return '';
  } catch {
    return '';
  }
}

async function handleAuthQueryParams() {
  const url = new URL(window.location.href);
  const verify = url.searchParams.get('verify');
  const reset = url.searchParams.get('reset');
  const login = url.searchParams.get('login');

  if (verify) {
    try {
      const r = await fetch(`${API_BASE}/api/auth/verify?token=${encodeURIComponent(verify)}`, { method: 'POST' });
      if (r.ok) {
        // Clean query
        url.searchParams.delete('verify');
        window.history.replaceState({}, '', url.toString());
        await refreshAuthState();
        openAuthModal('login');
        setAuthStep('email');
        _showAuthError('authError', 'Email verified. You can use Tracking now.');
      }
    } catch {}
  }

  if (reset) {
    _resetToken = reset;
    // Clean query
    url.searchParams.delete('reset');
    window.history.replaceState({}, '', url.toString());
    openAuthModal('login');
    setAuthStep('reset');
  }

  if (login === 'success') {
    url.searchParams.delete('login');
    window.history.replaceState({}, '', url.toString());
    await refreshAuthState();
    // After OAuth redirects back, refresh the feed and open any deep-link.
    await fetchFeed({ reset: true });
    await maybeOpenDeepLinkedArticle();
  }
}

// ----------------------------
// Pricing / Billing UI
// ----------------------------
function bindPricingUI(){
  const pricingSection = document.getElementById('pricingSection');
  const feedView = document.getElementById('feedView');
  if(!pricingSection || !feedView) return;

  // Selected plan for the single CTA button under the cards
  let selectedPlan = (billingState?.plan || 'free').toLowerCase();

  function setPage(page){
    if(page === 'pricing'){
      feedView.style.display = 'none';
      pricingSection.style.display = 'block';
      window.scrollTo({ top: 0, behavior: 'instant' });
      const btn = document.getElementById('btnPricing');
      if(btn) btn.setAttribute('aria-current','page');
    }else{
      pricingSection.style.display = 'none';
      feedView.style.display = 'block';
      const btn = document.getElementById('btnPricing');
      if(btn) btn.removeAttribute('aria-current');
    }
  }

  // Expose for other handlers (Tracking / Login, etc.)
  window.__setMainPage = setPage;

  const btnPricing = document.getElementById('btnPricing');
  if(btnPricing){
    btnPricing.addEventListener('click', (e)=>{
      e.preventDefault();
      setPage('pricing');
    });
  }

  // Clicking the logo/title returns to the feed
  const brand = document.getElementById('brand');
  if(brand){
    brand.addEventListener('click', (e)=>{
      e.preventDefault();
      setPage('feed');
      window.scrollTo({ top: 0, behavior: 'smooth' });
    });
  }

  const monthlyBtn = document.getElementById('billMonthly');
  const yearlyBtn  = document.getElementById('billYearly');

  function syncIntervalUI(){
    const isMonthly = (billingInterval === 'monthly');
    if(monthlyBtn){
      monthlyBtn.classList.toggle('on', isMonthly);
      monthlyBtn.setAttribute('aria-selected', isMonthly ? 'true':'false');
    }
    if(yearlyBtn){
      yearlyBtn.classList.toggle('on', !isMonthly);
      yearlyBtn.setAttribute('aria-selected', !isMonthly ? 'true':'false');
    }
    document.querySelectorAll('.planPrice').forEach(el=>{
      const monthlyStr = el.getAttribute('data-price-monthly') || '';
      const yearlyStr  = el.getAttribute('data-price-yearly') || '';

      const nowEl  = el.querySelector('.priceNow');
      const wasEl  = el.querySelector('.priceWas');
      const saveEl = el.querySelector('.priceSave');

      // Fallback: if HTML wasn't updated for some reason, keep previous behavior.
      if(!nowEl){
        const v = isMonthly ? monthlyStr : yearlyStr;
        if(v) el.textContent = v;
        return;
      }

      if(isMonthly){
        nowEl.textContent = monthlyStr;
        if(wasEl) wasEl.style.display = 'none';
        if(saveEl) saveEl.style.display = 'none';
        return;
      }

      // Yearly view: show new price + struck-through "would be" annual price + savings.
      nowEl.textContent = yearlyStr;

      const parsePrice = (s)=>{
        const n = parseFloat(String(s).replace(/[^0-9.]/g,''));
        return Number.isFinite(n) ? n : null;
      };

      const m = parsePrice(monthlyStr);
      const y = parsePrice(yearlyStr);
      if(m != null && y != null){
        const annual = m * 12;
        const pct = Math.max(0, Math.round((1 - (y / annual)) * 100));

        if(wasEl){
          wasEl.textContent = `$${annual.toFixed(2)}`;
          wasEl.style.display = 'inline';
        }
        if(saveEl){
          saveEl.textContent = pct > 0 ? `Save ${pct}%` : '';
          saveEl.style.display = pct > 0 ? 'inline' : 'none';
        }
      }else{
        if(wasEl) wasEl.style.display = 'none';
        if(saveEl) saveEl.style.display = 'none';
      }
    });
  }

  function syncSelectionUI(){
    document.querySelectorAll('.planCard').forEach(card=>{
      const plan = card.getAttribute('data-plan');
      card.classList.toggle('isSelected', plan === selectedPlan);
    });

    const mainBtn = document.getElementById('pricingMainCta');
    if(mainBtn){
      const currentPlan = (billingState?.plan || 'free').toLowerCase();
      const status = (billingState?.status || 'active').toLowerCase();
      const currentInterval = (billingState?.interval || 'monthly').toLowerCase();
      const hasActivePaid =
        authState.authenticated &&
        currentPlan !== 'free' &&
        (status === 'active' || status === 'trialing');

      const isCurrentSelected = hasActivePaid && selectedPlan === currentPlan && billingInterval === currentInterval;

      if (isCurrentSelected) {
        mainBtn.textContent = 'Current plan';
        mainBtn.disabled = true;
      } else {
        mainBtn.disabled = false;
        mainBtn.textContent =
          selectedPlan === 'free' ? 'Get Free' :
          selectedPlan === 'pro' ? 'Upgrade to Pro' :
          'Upgrade to Analyst';
      }
    }
  }

  // Select plan by clicking a card
  document.querySelectorAll('.planCard').forEach(card=>{
    card.addEventListener('click', ()=>{
      selectedPlan = card.getAttribute('data-plan') || 'free';
      syncSelectionUI();
    });
    card.addEventListener('keydown', (ev)=>{
      if(ev.key === 'Enter' || ev.key === ' '){
        ev.preventDefault();
        selectedPlan = card.getAttribute('data-plan') || 'free';
        syncSelectionUI();
      }
    });
  });

  if(monthlyBtn) monthlyBtn.addEventListener('click', ()=>{
    billingInterval = 'monthly';
    syncIntervalUI();
  });
  if(yearlyBtn) yearlyBtn.addEventListener('click', ()=>{
    billingInterval = 'yearly';
    syncIntervalUI();
  });

 const mainBtn = document.getElementById('pricingMainCta');

if (mainBtn) {
  mainBtn.addEventListener('click', async () => {

    const currentPlan = (billingState?.plan || 'free').toLowerCase();
    const status = (billingState?.status || '').toLowerCase();
    const currentInterval = (billingState?.interval || 'monthly').toLowerCase();

    const hasActivePaid =
      authState.authenticated &&
      currentPlan !== 'free' &&
      (status === 'active' || status === 'trialing');

    // ✅ Уже куплено → запрещаем повторную покупку
    if (
      hasActivePaid &&
      selectedPlan === currentPlan &&
      billingInterval === currentInterval
    ) {
      toast("✅ You already have this plan.");
      return;
    }

    // дальше твоя логика
    if (selectedPlan === 'free') {
      toast("Free plan enabled (no payment).");
      return;
    }

        await startCheckout(selectedPlan, billingInterval);
  });
}


  // Default state
  syncIntervalUI();
  syncSelectionUI();
}


function setBillingInterval(interval) {
  billingInterval = interval;
  const bM = document.getElementById('billMonthly');
  const bY = document.getElementById('billYearly');
  if (bM && bY) {
    bM.classList.toggle('on', interval === 'monthly');
    bY.classList.toggle('on', interval === 'yearly');
    bM.setAttribute('aria-selected', interval === 'monthly' ? 'true' : 'false');
    bY.setAttribute('aria-selected', interval === 'yearly' ? 'true' : 'false');
  }
  // Update displayed prices (+ crossed out annual "was" when Yearly)
  document.querySelectorAll('.planPrice').forEach((el) => {
    const monthlyStr = el.getAttribute('data-price-monthly') || '';
    const yearlyStr  = el.getAttribute('data-price-yearly') || '';

    const now = el.querySelector('.priceNow');
    const was = el.querySelector('.priceWas');
    const save = el.querySelector('.priceSave');

    if (!now) return;

    if (interval === 'yearly') {
      now.textContent = yearlyStr || monthlyStr;

      const monthly = parseMoney(monthlyStr);
      const annualWas = monthly * 12;
      const yearly = parseMoney(yearlyStr);

      if (was) {
        was.style.display = (monthly > 0 && yearly > 0) ? 'block' : 'none';
        was.textContent = (monthly > 0 && yearly > 0) ? formatMoney(annualWas) : '';
      }

      if (save) {
        const pct = (annualWas > 0 && yearly > 0)
          ? Math.round(((annualWas - yearly) / annualWas) * 100)
          : 0;
        save.style.display = (pct > 0) ? 'block' : 'none';
        save.textContent = (pct > 0) ? `Save ${pct}%` : '';
      }
    } else {
      now.textContent = monthlyStr || yearlyStr;
      if (was) { was.style.display = 'none'; was.textContent = ''; }
      if (save) { save.style.display = 'none'; save.textContent = ''; }
    }
  });
}

function updatePricingUI() {
  // Highlight current plan + update CTA text
  document.querySelectorAll('.planCard').forEach((card) => {
    const plan = card.getAttribute('data-plan');
    const btn = card.querySelector('.planBtn');
    const isCurrent = plan === billingState.plan;
    card.classList.toggle('current', isCurrent);
    if (btn) {
      if (isCurrent) {
        btn.textContent = 'Current plan';
        btn.disabled = true;
      } else {
        btn.disabled = false;
        if (plan === 'free') btn.textContent = 'Switch to Free';
        else if (plan === 'pro') btn.textContent = 'Upgrade to Pro';
        else btn.textContent = 'Upgrade to Analyst';
      }
    }
  });
}

async function startCheckout(plan, interval) {
  try {
    if (plan === 'free') {
      await fetch(`${API_BASE}/api/billing/set-free`, { method: 'POST' });
      await refreshBillingState();
      // Refresh feed so paywall disappears
      await fetchFeed({ reset: true });
      const sec = document.getElementById('pricingSection');
      if (sec) sec.scrollIntoView({ behavior: 'smooth', block: 'start' });
      return;
    }

    const r = await fetch(`${API_BASE}/api/billing/checkout`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ plan, interval }),
    });
    const j = await r.json();
    if (!r.ok) {
      alert(j?.detail || 'Failed to start checkout');
      return;
    }
    if (j?.url) window.location.href = j.url;
  } catch {
    alert('Network error. Try again.');
  }
}

async function handleBillingQueryParams() {
  const url = new URL(window.location.href);
  const checkout = url.searchParams.get('checkout');
  const sessionId = url.searchParams.get('session_id');
  if (checkout === 'success' && sessionId) {
    try {
      const r = await fetch(`${API_BASE}/api/billing/checkout/complete?session_id=${encodeURIComponent(sessionId)}`, {
        method: 'POST',
      });
      // Clean query params either way
      url.searchParams.delete('checkout');
      url.searchParams.delete('session_id');
      window.history.replaceState({}, '', url.toString());
      if (r.ok) {
        await refreshBillingState();
        await fetchFeed({ reset: true });
      }
    } catch {
      // ignore
    }
  }
}

function renderTags() {
  const tagsEl = qs("tags");
  tagsEl.innerHTML = "";
  [...new Set(DEFAULT_INTERESTS)].forEach((tag) => {
    const el = document.createElement("div");
    el.className = "tag" + (state.interests.includes(tag) ? " on" : "");
    el.textContent = tag;
    el.onclick = async () => {
      // Guests can read the top 3 items, but changing interests requires an account.
      if (!authState?.authenticated) {
        openAuthModal('interests');
        return;
      }
      if (state.interests.includes(tag)) {
        state.interests = state.interests.filter((x) => x !== tag);
        if (state.interests.length === 0) state.interests = ["general"];
      } else {
        // Make sure we never introduce duplicates
        state.interests = [...new Set([...(state.interests || []), tag])];
      }
      renderTags();
      if (state.mode === "feed") await fetchFeed();
    };
    tagsEl.appendChild(el);
  });
}

function applyTabs() {
  const feed = qs("tabFeed");
  const fav = qs("tabFav");
  if (state.mode === "feed") {
    feed.classList.add("on");
    fav.classList.remove("on");
  } else {
    fav.classList.add("on");
    feed.classList.remove("on");
  }

  const isTracking = (state.mode !== "feed");
  // Hide feed-only UI when in Tracking tab
  const controlsWrap = qs("controlsWrap");
  const showMoreWrap = qs("showMoreWrap");
  const btnRefresh = qs("btnRefresh");
  const selectedBar = qs("selectedBar");
  if (controlsWrap) controlsWrap.style.display = isTracking ? "none" : "";
  if (showMoreWrap) showMoreWrap.style.display = isTracking ? "none" : "";
  if (btnRefresh) btnRefresh.style.display = isTracking ? "none" : "";
  if (selectedBar) selectedBar.style.display = isTracking ? "none" : "";

  updateTrashZone();
  
function updateTrackingHint() {
  const el = qs('trackingHint');
  if (!el) return;
  const show = (state.mode === 'fav') && (getFavIds().length > 0);
  el.style.display = show ? 'block' : 'none';
}
updateTrackingHint();
}

function updateTrashZone() {
  const z = qs('trashZone');
  if (!z) return;

  const show = (state.mode === 'fav') && !!state.isDragging; // show only while dragging
  z.style.display = show ? 'grid' : 'none';
  z.setAttribute('aria-hidden', show ? 'false' : 'true');

  if (show) updateTrashZonePosition();
}

function updateTrashZonePosition() {
  const z = qs('trashZone');
  if (!z) return;

  const baseBottom = 92; // must match CSS bottom
  const footer = document.querySelector('footer');
  if (!footer) {
    z.style.bottom = `${baseBottom}px`;
    return;
  }

  const r = footer.getBoundingClientRect();

  if (r.top >= window.innerHeight) {
    z.style.bottom = `${baseBottom}px`;
    return;
  }

  const overlap = window.innerHeight - r.top;
  const extra = overlap > 0 ? (overlap + 24) : 0;
  z.style.bottom = `${baseBottom + extra}px`;
}

function itemMatchesSearch(item, q) {
  if (!q) return true;
  const qq = q.toLowerCase().trim();
  if (!qq) return true;
  if ((item.title || "").toLowerCase().includes(qq)) return true;
  for (const s of (item.sources || [])) {
    if ((s.title || "").toLowerCase().includes(qq)) return true;
    if ((s.source_name || "").toLowerCase().includes(qq)) return true;
  }
  return false;
}

function scoreClass(score) {
  if (score >= 80) return "good";
  if (score >= 60) return "warn";
  return "bad";
}

function clamp(n, a, b) {
  n = Number(n);
  if (!Number.isFinite(n)) n = a;
  return Math.max(a, Math.min(b, n));
}

function formatTimeHHMM(iso) {
  try {
    if (!iso) return "";
    const d = new Date(iso);
    if (Number.isNaN(d.getTime())) return "";
    return d.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
  } catch {
    return "";
  }
}

function pickPrimarySourceName(item) {
  const s = Array.isArray(item?.sources) ? item.sources : [];
  const name = (s[0]?.source_name || "").trim();
  const fallback = String(item?.primary_source || "").trim();
  return name || fallback || "Unknown";
}

function keywordsFromTitle(title) {
  const t = String(title || "").toLowerCase();
  const words = t
    .replace(/[^a-z0-9\s-]/g, " ")
    .split(/\s+/)
    .map((w) => w.trim())
    .filter(Boolean)
    .filter((w) => w.length >= 4)
    .slice(0, 4);
  return words.length ? words.join(",") : "news";
}

function getNewsImage(item) {
  // Use an image ONLY if it is tied to the event.
  // Priority:
  // 1) cluster-level fields (if backend adds them later)
  // 2) any image fields from sources
  const direct = String(item?.image || item?.urlToImage || item?.image_url || "").trim();
  if (direct) return direct;

  const sources = Array.isArray(item?.sources) ? item.sources : [];
  for (const s of sources) {
    const u = String(s?.image || s?.urlToImage || s?.image_url || "").trim();
    if (u) return u;
  }

  // No relevant image found.
  return "";
}

function onImgErrorToFallback(imgEl) {
  // No random fallbacks. If the provided image fails, switch to a neutral placeholder.
  if (!imgEl) return;
  imgEl.dataset.fallbackStage = "placeholder";
  imgEl.src = "data:image/svg+xml;charset=utf-8," +
    encodeURIComponent(
      `<svg xmlns='http://www.w3.org/2000/svg' width='600' height='400'>
        <rect width='100%' height='100%' fill='#e9e9ee'/>
        <text x='50%' y='50%' dominant-baseline='middle' text-anchor='middle' fill='#8a8a96' font-family='system-ui, -apple-system, Segoe UI, Roboto, Arial' font-size='20'>No related image available</text>
      </svg>`
    );
}

function itemPassesFilters(item) {
  const sourcesCount = Number(item.sources_count ?? (item.sources ? item.sources.length : 0));
  const score = Number(item.credibility_score ?? 0);

  if (state.filters.onlyConfirmed && sourcesCount < 2) return false;
  if (state.filters.onlyAI && !(item.summary || "").trim()) return false;
  if (score < Number(state.filters.minScore || 0)) return false;

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
  // If backend reports a failure, don't show a scary error in UI.
  if (st === "failed") {
    return { status: "empty", text: "" };
  }
  // Default: generating / not ready yet.
  return { status: "loading", text: "AI summary is being generated" };
}

function getWhyScoreState(item) {
  const expl = String(item?.credibility_explanation || "").trim();
  const factors = Array.isArray(item?.credibility_factors) ? item.credibility_factors : [];

  if (!expl && factors.length === 0) {
    return { status: "empty", text: "" };
  }

  // If scoring isn't really computed yet, show limited explanation.
  const notComputed = /скоринг\s+еще\s+не\s+рассчитан/i.test(expl);
  if (notComputed && factors.length === 0) {
    return { status: "empty", text: "Score explanation is limited due to insufficient data" };
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
    return `<div class="evLine"><span class="evTag">${escapeHtml(label)}:</span> <b>${name}</b> — <a href="${url}" target="_blank" rel="noopener noreferrer">${title || url}</a></div>`;
  }
  return `<div class="evLine"><span class="evTag">${escapeHtml(label)}:</span> <b>${name}</b> — ${title}</div>`;
}

// ===== Incremental feed rendering (no full rerender on refresh) =====
// We keep DOM nodes for already rendered feed items and only prepend truly new ones.
let feedRenderedOrder = []; // array of string ids in DOM order (top -> bottom)
let feedRenderedSet = new Set();
let lastFeedSignature = ""; // used to decide when we can do an incremental update


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
      const name = escapeHtml(f.name || '');
      const desc = escapeHtml(f.description || '');
      const impact = Number(f.impact || 0);
      const sign = impact > 0 ? '+' : '';
      return `<div class="factor"><div><span class="impact">${sign}${impact}</span> — <b>${name}</b></div><div class="muted">${desc}</div></div>`;
    })
    .join('');

  // --- AI Summary states: loading | ready | empty | locked
  const aiState = getAiSummaryState(item);
  let summaryHtml = '';
  if (aiState.status === 'ready') {
    summaryHtml = `<div class="aiSummaryBlock" data-status="ready">
      <div class="aiSummaryTitle">AI Summary</div>
      <div class="aiSummaryText">${escapeHtml(aiState.text)}</div>
    </div>`;
  } else if (aiState.status === 'loading') {
    summaryHtml = `<div class="aiSummaryBlock" data-status="loading">
      <div class="aiSummaryTitle">AI Summary</div>
      <div class="aiSummaryText"><span class="muted">${escapeHtml(aiState.text)}</span></div>
    </div>`;
  } else if (aiState.status === 'locked') {
    summaryHtml = `<div class="aiSummaryBlock" data-status="locked">
      <div class="aiSummaryTitle">AI Summary</div>
      <div class="aiSummaryText"><span class="muted">${escapeHtml(aiState.text)}</span></div>
    </div>`;
  }

  const unconfirmed = sourcesCount <= 1 ? `<span class="chip chipDanger">Unconfirmed</span>` : '';
  const changeBadges = '';

  // --- Why this score?
  const whyState = getWhyScoreState(item);
  let whyHtml = '';
  if (whyState.status === 'ready') {
    const expl = whyState.text
      ? `<div class="muted">${escapeHtml(whyState.text)}</div>`
      : `<div class="muted">Score explanation is limited due to insufficient data</div>`;
    whyHtml = `
        <details class="accordion">
          <summary class="accordionSummary">Why this score?</summary>
          <div class="accordionBody">
            ${expl}
            <div class="factors">${factorsHtml || '<div class="muted">Score explanation is limited due to insufficient data</div>'}</div>
          </div>
        </details>`;
  } else if (whyState.status === 'empty' && whyState.text) {
    whyHtml = `
        <details class="accordion">
          <summary class="accordionSummary">Why this score?</summary>
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

  const imageUrl = getNewsImage(item);
  const showThumb = !!state.showThumbs;
  const thumbHtml = showThumb
    ? `<div class="newsThumbWrap">${imageUrl ? `<img class="newsThumb" loading="lazy" alt="" src="${imageUrl}" />` : `<div class="newsThumbPh" aria-hidden="true"></div>`}</div>`
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
          <div class="newsImageWrap" data-image-state="${imageUrl ? 'loading' : 'empty'}">
            ${imageUrl ? `<img class="newsImage" loading="lazy" alt="" src="${imageUrl}" data-fallback-stage="0" />` : `<div class="newsImagePlaceholder">No related image available</div>`}
          </div>
        </div>

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
        if (!authState?.authenticated && detailsEl.open) {
          detailsEl.open = false;
          openAuthModal('paywall');
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
    .filter((it) => itemMatchesSearch(it, q))
    .filter((it) => itemPassesFilters(it));

  // IMPORTANT: do not sort on the client.
  // The server returns a deterministic order (and a time-bucketed snapshot),
  // so every device sees the same feed for the same interests.

  let visible = filtered;
  if (state.mode === 'feed' && !feedExpanded && filtered.length > FEED_PAGE_SIZE) {
    visible = filtered.slice(0, FEED_PAGE_SIZE);
  }

  if (filtered.length === 0) {
    cards.innerHTML = `<div class="panel muted">Ничего не найдено (проверь фильтры/поиск).</div>`;
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
      ? `Показано ${total} новостей`
      : `Скрыто ${hiddenCountNow} новостей`;

    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'loadMoreBtn';

    if (feedExpanded) {
      btn.textContent = 'Скрыть';
      btn.onclick = (e) => {
        e.preventDefault();
        e.stopPropagation();
        setFeedExpanded(false);
        window.scrollTo({ top: 0, behavior: 'smooth' });
      };
    } else {
      btn.textContent = `Показать ещё (+${hiddenCountNow})`;
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
    ? `Показано ${totalCount} новостей`
    : `Скрыто ${hiddenCountNow} новостей`;

  const btn = document.createElement('button');
  btn.type = 'button';
  btn.className = 'loadMoreBtn';

  if (feedExpanded) {
    btn.textContent = 'Скрыть';
    btn.onclick = (e) => {
      e.preventDefault();
      e.stopPropagation();
      setFeedExpanded(false);
      window.scrollTo({ top: 0, behavior: 'smooth' });
    };
  } else {
    btn.textContent = `Показать ещё (+${hiddenCountNow})`;
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
    .filter((it) => itemMatchesSearch(it, q))
    .filter((it) => itemPassesFilters(it));

  // We only display a slice when collapsed.
  let visible = filtered;
  if (state.mode === 'feed' && !feedExpanded && filtered.length > FEED_PAGE_SIZE) {
    visible = filtered.slice(0, FEED_PAGE_SIZE);
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
  const q = encodeURIComponent((state.q || "").trim());

  const url =
    `${API_BASE}/api/news?interests=${interests}` +
    `&country=${encodeURIComponent(state.country)}` +
    `&language=${encodeURIComponent(state.language)}` +
    (q ? `&q=${q}` : "");

  const feedKey = `${state.country}|${state.language}|${(state.interests || []).join(",")}|${(state.q || "").trim()}`;

  const keyChanged = (typeof currentFeedKey === "string") && (currentFeedKey !== feedKey);
  const shouldReset = forceReset || !currentFeedKey || keyChanged;

  // On first load (or after key reset), suppress NEW badges and avoid animations.
  const suppressNewBadges = !hasInitialFeedLoaded || shouldReset;

  if (!quiet) setStatus("Загрузка ленты...");

  // Allow the caller to abort (we use this to prevent overlapping requests on slow hosts like Render)
  const res = await fetch(url, signal ? { signal } : undefined);
  if (!res.ok) {
    if (!quiet) setStatus(`Ошибка /api/news: ${res.status}`);
    return;
  }

  const data = await res.json();
  const items = data.items || [];

  // keep cache for smooth expand/collapse
  lastFavItems = items;

  // keep cache for smooth expand/collapse
  lastFeedItems = items;

  // Update seen state first so first_seen_at is stable.
  const newIds = updateSeenStateFromItems(items);

  // Decide rendering mode
  currentFeedKey = feedKey;

  // ВСЕГДА полный ререндер, чтобы порядок был строго как на сервере
  renderCards(items, {
    nowTs: Date.now(),
    newIds,
    suppressNewBadges,
    incremental: false,
    animate: false, // можно true, но лучше false чтобы не "прыгало"
  });

  hasInitialFeedLoaded = true;


  const lastUpdatedEl = qs("lastUpdated");
  if (lastUpdatedEl) {
    lastUpdatedEl.textContent =
      `Лента: ${new Date().toLocaleString()} — событий: ${items.length} (новые сверху)`;
  }

  if (!quiet) setStatus("");
}


async function fetchFavorites() {
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

    // Tracking page uses server-side deltas (delta_score / delta_sources_count)
    renderCards(items, { nowTs: Date.now(), newIds: new Set(), suppressNewBadges: true, incremental: false, animate: false });
    setStatus(items.length ? '' : 'Tracking is empty. Tap ★ on a news card to add.');
    updateCounts();
  } catch (e) {
    console.error(e);
    setStatus('Failed to load tracking.');
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
    setStatus(`Обновление доступно через ${left}с`);
  } else {
    if (btn.disabled) {
      btn.disabled = false;
      setStatus("");
    }
  }
}

async function refreshBackend() {
  // "Refresh" now means "reload my feed". Ingest happens server-side on a schedule.
  setStatus("Обновляю ленту...");
  if (state.mode === "feed") await fetchFeed();
  else await fetchFavorites();
}

function bindUI() {
  qs("country").value = state.country;
  qs("language").value = state.language;

  // Apply country/language immediately (we keep the hidden Save button for compatibility).
  qs("btnSave").onclick = async () => {
    state.country = qs("country").value;
    state.language = qs("language").value;
    setFeedExpanded(false);
    savePrefs();
    if (state.mode === "feed") await fetchFeed();
    else await fetchFavorites();
  };

  // In the new UI we auto-apply on change.
  qs("country").onchange = qs("btnSave").onclick;
  qs("language").onchange = qs("btnSave").onclick;

  // filters init (controls are currently hidden in the new layout, but must keep working)
  syncFiltersStateToUI();
  qs("fOnlyConfirmed").onchange = async () => {
    applyFiltersUIToState();
    setFeedExpanded(false);
    if (state.mode === "feed") await fetchFeed();
    else await fetchFavorites();
  };
  qs("fOnlyAI").onchange = async () => {
    applyFiltersUIToState();
    setFeedExpanded(false);
    if (state.mode === "feed") await fetchFeed();
    else await fetchFavorites();
  };
  qs("fMinScore").oninput = async () => {
    applyFiltersUIToState();
    setFeedExpanded(false);
    if (state.mode === "feed") await fetchFeed();
    else await fetchFavorites();
  };

  qs("btnApplyFilters").onclick = async () => {
    applyFiltersUIToState();
    setFeedExpanded(false);
    if (state.mode === "feed") await fetchFeed();
    else await fetchFavorites();
  };

  qs("btnReload").onclick = async () => {
    setFeedExpanded(false);
    if (state.mode === "feed") await fetchFeed();
    else await fetchFavorites();
  };

  const btnRefresh = qs("btnRefresh");
  if (btnRefresh) btnRefresh.onclick = refreshBackend;


  // Header Tracking button (replaces Favorites tab)
  const btnTracking = document.getElementById("btnTracking");
  if (btnTracking) {
    btnTracking.onclick = async () => {
      if(window.__setMainPage) window.__setMainPage('feed');
      if (!authState.authenticated) {
        openAuthModal('tracking');
        return;
      }
      // If local email is not verified, keep user on Feed and prompt verification
      if (authState.user && authState.user.provider === 'local' && !authState.user.email_verified) {
        openAuthModal('verify_required');
        return;
      }

      state.mode = "fav";
      applyTabs();
      await fetchFavorites();
      // scroll to top so user sees list instantly
      window.scrollTo({ top: 0, behavior: "smooth" });
    };
  }

  // Header Login / Account button
  const btnLogin = document.getElementById('btnLogin');
  if (btnLogin) {
    btnLogin.onclick = async () => {
      if (!authState.authenticated) {
        openAuthModal('login');
        return;
      }
      // Minimal "Account" behavior: logout
      const ok = confirm('Log out from CHECK news?');
      if (!ok) return;
      await fetch(`${API_BASE}/api/auth/logout`, { method: 'POST' });
      authState = { authenticated: false, user: null };
      updateAuthUI();
      // After logout, go back to Feed
      state.mode = 'feed';
      setFeedExpanded(false);
      applyTabs();
      await fetchFeed();
    };
  }

  // Logo click => back to Feed
  const brand = document.getElementById("brand");
  if (brand) {
    brand.onclick = async () => {
      state.mode = "feed";
      setFeedExpanded(false);
      applyTabs();
      await fetchFeed();
      window.scrollTo({ top: 0, behavior: "smooth" });
    };
  }

  qs("tabFeed").onclick = async () => {
    state.mode = "feed";
    setFeedExpanded(false);
    applyTabs();
    await fetchFeed();
  };

  qs("tabFav").onclick = async () => {
    if (!authState?.authenticated) {
      openAuthModal('tracking');
      return;
    }
    // If local email is not verified, keep user on Feed and prompt verification
    if (authState.user && authState.user.provider === 'local' && !authState.user.email_verified) {
      openAuthModal('verify_required');
      return;
    }
    state.mode = "fav";
    applyTabs();
    await fetchFavorites();
  };

  const searchEl = qs("search");
  qs("btnSearch").onclick = async () => {
    state.q = searchEl.value || "";
    setFeedExpanded(false);
    if (state.mode === "feed") await fetchFeed();
    else await fetchFavorites();
  };

  searchEl.addEventListener("keydown", async (e) => {
    if (e.key === "Enter") {
      state.q = searchEl.value || "";
      setFeedExpanded(false);
      if (state.mode === "feed") await fetchFeed();
      else await fetchFavorites();
    }
  });

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
    thumbToggle.onclick = () => {
      state.showThumbs = !state.showThumbs;
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
}


async function refreshBackendQuiet() {
  // Server now ingests on a schedule. Clients should not trigger ingest.
  return;
}

async function autoUpdateTick(trigger) {
  // Fetch and incrementally insert new cards.
  if (state.mode === "feed") await fetchFeed({ quiet: true });
  else await fetchFavorites();
}

async function main() {
  loadPrefs();
  loadFilters();
  loadThumbPrefs();

  // Capture deep-link request early (before auth/feed fetch)
  const dl = readDeepLinkParams();
  if (dl.id) {
    pendingOpenClusterId = dl.id;
    pendingOpenRequiresAuth = !!dl.shared;
  }

  setFavIds(getFavIds());

  bindAuthModalUI();
  bindPricingUI();
  await refreshAuthState();
  await handleAuthQueryParams();
  await handleBillingQueryParams();

  bindUI();
  renderTags();
  syncThumbToggleUI();
  applyTabs();

  // initial load
  await fetchFeed({ reset: true });

  // If we arrived via a shared URL (/?open=...), open that article card.
  await maybeOpenDeepLinkedArticle();

  /**
   * Auto refresh strategy (Render can be slow):
   * - never run overlapping requests
   * - throttle visibility/focus refreshes
   * - keep the feed fresh while tab is visible, but without spamming
   */
  const AUTO_REFRESH_MS = 60 * 1000;      // baseline: 1 min while visible
  const WAKE_THROTTLE_MS = 15 * 1000;     // focus/visibility won't refresh more often than this
  let lastFetchAt = 0;
  let inFlight = null;

  async function safeRefresh(reason, opts = {}) {
    const now = Date.now();

    // Do nothing while hidden
    if (document.hidden) return;

    // Only refresh the active mode
    const isFeed = state.mode === 'feed';

    // Throttle wake-up spam (some browsers fire focus + visibility together)
    if ((reason === 'focus' || reason === 'visible') && (now - lastFetchAt) < WAKE_THROTTLE_MS) {
      return;
    }

    // Don't overlap network requests
    if (inFlight) return inFlight;

    inFlight = (async () => {
      try {
        if (isFeed) await fetchFeed(opts);
        else await fetchFavorites(opts);
        lastFetchAt = Date.now();
      } finally {
        inFlight = null;
      }
    })();

    return inFlight;
  }

  // Refresh when user comes back to the tab (after sleep/background throttling)
  document.addEventListener('visibilitychange', () => {
    if (!document.hidden) void safeRefresh('visible', { quiet: true });
  });
  window.addEventListener('focus', () => void safeRefresh('focus', { quiet: true }));

  // Periodic refresh while visible
  setInterval(() => {
    if (document.hidden) return;
    void safeRefresh('interval', { quiet: true });
  }, AUTO_REFRESH_MS);

  // cooldown UI tick (UI only; keep it light)
  setInterval(tickCooldownUI, 1000);
}

const monthlyBtn = document.getElementById("billMonthly");
const yearlyBtn  = document.getElementById("billYearly");

const prices = document.querySelectorAll(".planPriceBig");

function setBilling(mode){
  prices.forEach(el => {
    const monthly = parseFloat(el.dataset.monthly);
    const yearly  = parseFloat(el.dataset.yearly);

    const oldSpan = el.querySelector(".oldPrice");
    const newSpan = el.querySelector(".newPrice");

    if(mode === "monthly"){
      oldSpan.textContent = "";
      newSpan.textContent = `$${monthly.toFixed(2)}`;
    }

    if(mode === "yearly"){
      // старая цена = monthly * 12
      const old = monthly * 12;

      oldSpan.textContent = `$${old.toFixed(2)}`;
      newSpan.textContent = `$${yearly.toFixed(2)}`;
    }
  });

  monthlyBtn.classList.toggle("on", mode === "monthly");
  yearlyBtn.classList.toggle("on", mode === "yearly");
}

monthlyBtn.onclick = () => setBilling("monthly");
yearlyBtn.onclick  = () => setBilling("yearly");

// старт
setBilling("monthly");

// ===== Account dropdown =====
const btnAccount = document.getElementById("btnAccount");
const accountMenu = document.getElementById("accountMenu");

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

// ✅ Pricing click
menuPricing.addEventListener("click", () => {
  accountMenu.classList.remove("open");

  // вызвать твой Pricing экран
  document.getElementById("pricingSection").style.display = "block";
  document.getElementById("feedView").style.display = "none";
});

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

    alert("Logged out!");

  } catch (e) {
    console.error(e);
    alert("Network error while logging out.");
  }
});



main();