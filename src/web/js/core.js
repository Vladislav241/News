/*
 * CHECKNE Web App — core.js
 * Config + utils + deep links + share modal + i18n
 *
 * Split from the former monolithic app.js to keep responsibilities separated.
 * Keep files loaded in order (see index.html).
 */

const API_BASE = ""; // same-origin

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
    const language = "all";
    const uiLang = encodeURIComponent(state.language || "en");
    const r = await fetch(
      `${API_BASE}/api/news/by_ids?ids=${encodeURIComponent(String(clusterId))}` +
        `&interests=${interests}&country=${country}&language=${language}&ui_lang=${uiLang}`
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
    title: item?.title || 'CHECKNE.',
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
  const tweetText = encodeURIComponent(`Trust score • ${data.title || 'CHECKNE.'}`);
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
const TRACKING_DELTA_KEY = "news_tracking_deltas_v1";
const TRACKING_HISTORY_KEY = "news_tracking_history_v1";
const FILTERS_KEY = "news_filters_v1";
const THUMBS_KEY = "news_thumbs_v1";

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

function applyI18nToDOM() {
  document.querySelectorAll("[data-i18n]").forEach((el) => {
    const k = el.getAttribute("data-i18n");
    if (!k) return;
    el.textContent = t(k, el.textContent || "");
  });
  document.querySelectorAll("[data-i18n-placeholder]").forEach((el) => {
    const k = el.getAttribute("data-i18n-placeholder");
    if (!k) return;
    el.setAttribute("placeholder", t(k, el.getAttribute("placeholder") || ""));
  });
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



