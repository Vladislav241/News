/*
 * CHECKNE Web App — interests.js
 * Interests & Trending topics (🔥) UI
 *
 * Responsibilities:
 *  - Render static interests chips
 *  - Fetch + render trending chips (topic-style)
 *  - Handle interactions (toggle interest, apply trending search)
 *
 * NOTE:
 *  - Static interests are account-scoped when logged in (via /api/preferences),
 *    and localStorage fallback for guests (savePrefs()).
 *  - Trending chips do NOT require auth: they simply apply a search query.
 */

// Config
const TRENDING_LIMIT = 8;
const TRENDING_CACHE_MS = 5 * 60 * 1000; // 5 min
const TRENDING_ICON_SRC = "/static/icons/new.svg";

let __trendingCache = { key: "", ts: 0, items: [] };

// Helpers
function __normTopicKey(s){
  s = String(s || "").trim().toLowerCase();
  s = s.replace(/[’'"]/g, "");
  s = s.replace(/[^a-z0-9\s\-]/g, " ");
  s = s.replace(/\s+/g, " ").trim();
  // collapse common demonyms/adjectives -> base nouns (simple & safe)
  const map = {
    "iranian": "iran",
    "israeli": "israel",
    "russian": "russia",
    "ukrainian": "ukraine",
    "american": "us",
    "u.s.": "us",
    "u s": "us",
  };
  if (map[s]) s = map[s];
  return s;
}

function __makeTrendChip(label){
  const el = document.createElement("div");
  el.className = "tag trend";
  // label
  const span = document.createElement("span");
  span.className = "tagLabel";
  span.textContent = label;
  el.appendChild(span);
  // icon after text (per request)
  const img = document.createElement("img");
  img.className = "tagFlame";
  img.alt = "Trending";
  img.src = TRENDING_ICON_SRC;
  img.loading = "lazy";
  el.appendChild(img);
  return el;
}

function __getSearchEl(){
  // index.html uses id="search"
  try { return qs("search"); } catch { return document.getElementById("search"); }
}

function __applySearchQuery(q){
  const searchEl = __getSearchEl();
  if (searchEl) searchEl.value = q || "";
  state.q = String(q || "");
  try { savePrefs(); } catch {}
  try { setFeedExpanded(false); } catch {}
  if (state.mode === "feed") {
    try { fetchFeed({ reset: true }); } catch { try { fetchFeed(); } catch {} }
  } else {
    try { fetchFavorites(); } catch {}
  }
}

async function loadTrendingInterests({ force } = { force: false }){
  const tagsEl = qs("tags");
  if (!tagsEl) return;

  const key = [
    (state.country || "world").toLowerCase(),
    (state.language || "all").toLowerCase(),
    (state.interests || []).slice().sort().join(","),
    (state.language || "en").toLowerCase(), // ui lang
  ].join("|");

  const now = Date.now();
  if (!force && __trendingCache.key === key && (now - __trendingCache.ts) < TRENDING_CACHE_MS){
    renderTrendingChips(__trendingCache.items);
    return;
  }

  const params = new URLSearchParams();
  params.set("ui_lang", (state.language || "en"));
  params.set("country", (state.country || "world"));
  params.set("language", (state.language || "all"));
  params.set("interests", (state.interests || ["general"]).join(","));
  params.set("limit", String(TRENDING_LIMIT));

  try {
    const r = await fetch(`${API_BASE}/api/interests/trending?${params.toString()}`);
    if (!r.ok) throw new Error(`HTTP ${r.status}`);
    const data = await r.json();
    const items = Array.isArray(data?.items) ? data.items : (Array.isArray(data) ? data : []);
    __trendingCache = { key, ts: now, items };
    renderTrendingChips(items);
  } catch (e) {
    console.warn("[interests] trending failed", e);
    // do not block static interests
    renderTrendingChips([]);
  }
}

function renderTrendingChips(items){
  const tagsEl = qs("tags");
  if (!tagsEl) return;

  // Remove previous trend chips only
  Array.from(tagsEl.querySelectorAll(".tag.trend")).forEach((n) => n.remove());

  // Build a stable, de-duplicated list
  const seen = new Set();
  const cleaned = [];

  for (const it of (items || [])){
    const labelRaw = (it?.label || it?.title || it?.full_title || "").trim();
    if (!labelRaw) continue;

    // Use backend-provided q if present; else use label
    const q = String(it?.q || labelRaw).trim();

    // Deduplicate by normalized topic key
    const key = __normTopicKey(labelRaw);
    if (!key || seen.has(key)) continue;
    seen.add(key);

    // Shorten label if needed (keep it "topic-like")
    let label = labelRaw;
    label = label.replace(/^what we know so far\s*/i, "").trim();
    label = label.replace(/\b(analysis|explainer|live updates)\b/i, "").trim();
    if (label.length > 18 && label.includes(" ")) {
      // keep up to 2 words
      label = label.split(" ").slice(0, 2).join(" ");
    }
    if (label.length > 22) label = label.slice(0, 22).trim();

    cleaned.push({ label, q });
    if (cleaned.length >= TRENDING_LIMIT) break;
  }

  if (!cleaned.length) return;

  // Append trend chips AFTER static interests
  for (const t of cleaned){
    const el = __makeTrendChip(t.label);
    el.onclick = async () => {
      // toggle: if same query already applied -> clear it
      const current = String(state.q || "").trim();
      if (current.toLowerCase() === String(t.q || "").trim().toLowerCase()) {
        __applySearchQuery("");
      } else {
        __applySearchQuery(t.q);
      }
      // optional: visual active state
      try {
        Array.from(tagsEl.querySelectorAll(".tag.trend")).forEach((n) => n.classList.remove("on"));
        if (String(state.q || "").trim()) el.classList.add("on");
      } catch {}
    };
    tagsEl.appendChild(el);
  }
}

// PUBLIC: called from other modules
function renderTags() {
  const tagsEl = qs("tags");
  if (!tagsEl) return;

  // Clear whole strip; we'll re-add static then trends
  tagsEl.innerHTML = "";

  // Render static interests
  [...new Set(DEFAULT_INTERESTS)].forEach((tag) => {
    const el = document.createElement("div");
    el.className = "tag" + (state.interests.includes(tag) ? " on" : "");
    el.textContent = t(`interests.${tag}`, tag);

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
        state.interests = [...new Set([...(state.interests || []), tag])];
      }
      try { savePrefs(); } catch {}
      renderTags();
      if (state.mode === "feed") await fetchFeed({ reset: true });
    };

    tagsEl.appendChild(el);
  });

  // Render trending after static interests (async)
  loadTrendingInterests({ force: false });
}

// Refresh trending when country/language/interests changes
async function refreshTrending(){
  try { await loadTrendingInterests({ force: true }); } catch {}
}

// Expose for other files
window.renderTags = renderTags;
window.refreshTrending = refreshTrending;
