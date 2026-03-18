/*
 * CHECKNE Web App — onboarding.js
 * Account-scoped welcome flow shown after successful auth.
 * Isolated DOM/CSS namespace: onboarding*
 */
(function(){
  const STORAGE_KEY = 'checkne_onboarding_seen';
  const INTEREST_OPTIONS = ['general','business','technology','politics','science','sports','health'];
  const REGION_OPTIONS = [
    { value: 'world', label: 'World' },
    { value: 'us', label: 'US' },
    { value: 'gb', label: 'GB' },
    { value: 'de', label: 'DE' },
    { value: 'fr', label: 'FR' },
  ];
  const FALLBACK_LANG = 'en';
  const COPY = {
    en: {
      aria_label: 'Welcome to CHECKNE onboarding',
      skip: 'Skip',
      back: 'Back',
      next: 'Next',
      get_started: 'Get Started',
      detected: 'Detected',
      region_keep_hint: 'You can change it here and later in filters',
      interests_hint: 'Choose one or more — General stays on if nothing else is selected',
      slides: [
        {
          step: 'Welcome',
          title: 'Discover where news really starts',
          text: 'CHECKNE shows the earliest source behind a story, builds a cleaner feed, and helps you verify screenshots faster.',
          hint: 'Tap any story to expand its source trail',
        },
        {
          step: 'Step 1',
          title: 'We found your region',
          text: 'We detected {region} from your browser. Keep it for a local feed, or switch now before your first stories load.',
          hint: 'You can change it here and later in filters',
        },
        {
          step: 'Step 2',
          title: 'Choose topics for your first feed',
          text: 'Pick a few subjects you care about. We will use them to shape the first feed immediately.',
          hint: 'Choose one or more — General stays on if nothing else is selected',
        },
        {
          step: 'Step 3',
          title: 'Search news by screenshot',
          text: 'Drop a screenshot into Visual Search and CHECKNE will look for the original story across the feed.',
          hint: 'Try visual search when a post looks suspicious',
        },
        {
          step: 'Step 4',
          title: 'See who reported it first',
          text: 'Open any story to compare sources, timestamps, and find the outlet that reported it earliest.',
          hint: 'Scroll to load more stories as your feed grows',
        }
      ],
      interests: {
        general: 'General',
        business: 'Business',
        technology: 'Technology',
        politics: 'Politics',
        science: 'Science',
        sports: 'Sports',
        health: 'Health',
      }
    },
    de: {
      aria_label: 'Willkommen beim CHECKNE-Onboarding',
      skip: 'Überspringen',
      back: 'Zurück',
      next: 'Weiter',
      get_started: 'Los geht’s',
      detected: 'Erkannt',
      region_keep_hint: 'Du kannst das hier und später in den Filtern ändern',
      interests_hint: 'Wähle ein oder mehrere Themen — Allgemein bleibt aktiv, wenn nichts anderes gewählt ist',
      slides: [
        {
          step: 'Willkommen',
          title: 'Entdecke, wo Nachrichten wirklich beginnen',
          text: 'CHECKNE zeigt dir die früheste Quelle einer Story, baut einen saubereren Feed und hilft dir, Screenshots schneller zu prüfen.',
          hint: 'Tippe auf eine Story, um ihre Quellenkette zu öffnen',
        },
        {
          step: 'Schritt 1',
          title: 'Wir haben deine Region gefunden',
          text: 'Wir haben {region} in deinem Browser erkannt. Behalte die Region für einen lokalen Feed oder ändere sie jetzt vor dem Laden deiner ersten Stories.',
          hint: 'Du kannst das hier und später in den Filtern ändern',
        },
        {
          step: 'Schritt 2',
          title: 'Wähle Themen für deinen ersten Feed',
          text: 'Wähle ein paar Themen, die dich interessieren. Wir nutzen sie sofort für deinen ersten Feed.',
          hint: 'Wähle ein oder mehrere Themen — Allgemein bleibt aktiv, wenn nichts anderes gewählt ist',
        },
        {
          step: 'Schritt 3',
          title: 'Suche Nachrichten per Screenshot',
          text: 'Zieh einen Screenshot in die Bildsuche und CHECKNE sucht im Feed nach der Originalmeldung.',
          hint: 'Nutze die Bildsuche, wenn ein Beitrag verdächtig wirkt',
        },
        {
          step: 'Schritt 4',
          title: 'Sieh, wer zuerst berichtet hat',
          text: 'Öffne eine Story, um Quellen und Zeitstempel zu vergleichen und das zuerst berichtende Medium zu finden.',
          hint: 'Scrolle, um beim Wachsen des Feeds mehr Stories zu laden',
        }
      ],
      interests: {
        general: 'Allgemein',
        business: 'Wirtschaft',
        technology: 'Technologie',
        politics: 'Politik',
        science: 'Wissenschaft',
        sports: 'Sport',
        health: 'Gesundheit',
      }
    },
    fr: {
      aria_label: 'Bienvenue dans l’onboarding CHECKNE',
      skip: 'Passer',
      back: 'Retour',
      next: 'Suivant',
      get_started: 'Commencer',
      detected: 'Détecté',
      region_keep_hint: 'Tu peux le changer ici et plus tard dans les filtres',
      interests_hint: 'Choisis un ou plusieurs thèmes — Général reste actif si rien d’autre n’est sélectionné',
      slides: [
        {
          step: 'Bienvenue',
          title: 'Découvre où l’actualité commence vraiment',
          text: 'CHECKNE montre la source la plus ancienne derrière une histoire, construit un fil plus propre et t’aide à vérifier les captures plus vite.',
          hint: 'Appuie sur une histoire pour ouvrir sa piste de sources',
        },
        {
          step: 'Étape 1',
          title: 'Nous avons trouvé ta région',
          text: 'Nous avons détecté {region} dans ton navigateur. Garde-la pour un fil local ou change-la maintenant avant de charger tes premières stories.',
          hint: 'Tu peux le changer ici et plus tard dans les filtres',
        },
        {
          step: 'Étape 2',
          title: 'Choisis les thèmes de ton premier fil',
          text: 'Choisis quelques sujets qui t’intéressent. Nous les utiliserons immédiatement pour construire ton premier fil.',
          hint: 'Choisis un ou plusieurs thèmes — Général reste actif si rien d’autre n’est sélectionné',
        },
        {
          step: 'Étape 3',
          title: 'Recherche d’actualité par capture d’écran',
          text: 'Dépose une capture dans la recherche visuelle et CHECKNE cherchera l’histoire originale dans le fil.',
          hint: 'Essaie la recherche visuelle lorsqu’un post semble suspect',
        },
        {
          step: 'Étape 4',
          title: 'Vois qui l’a publié en premier',
          text: 'Ouvre une histoire pour comparer les sources, les horodatages et trouver le média qui a publié en premier.',
          hint: 'Fais défiler pour charger plus de stories à mesure que le fil grandit',
        }
      ],
      interests: {
        general: 'Général',
        business: 'Business',
        technology: 'Technologie',
        politics: 'Politique',
        science: 'Science',
        sports: 'Sport',
        health: 'Santé',
      }
    }
  };

  let root = null;
  let currentIndex = 0;
  let drag = null;
  let selectedCountry = 'world';
  let selectedInterests = ['general'];
  let initialized = false;
  let pendingOpen = false;
  let onboardingLang = FALLBACK_LANG;

  function getUserKey(){
    try {
      const u = (typeof authState !== 'undefined' && authState && authState.user) ? authState.user : ((window.authState && window.authState.user) ? window.authState.user : null);
      const raw = String(u?.id || u?.email || u?.sub || '').trim().toLowerCase();
      return raw || 'guest';
    } catch { return 'guest'; }
  }

  function getSeenKey(){ return `${STORAGE_KEY}:${getUserKey()}`; }
  function isSeen(){ try { return localStorage.getItem(getSeenKey()) === '1'; } catch { return false; } }
  function markSeen(){ try { localStorage.setItem(getSeenKey(), '1'); } catch {} }

  function clearSeen(forAll){
    try {
      if (forAll) {
        const keys = [];
        for (let i = 0; i < localStorage.length; i += 1) {
          const k = localStorage.key(i);
          if (k && k.indexOf(`${STORAGE_KEY}:`) === 0) keys.push(k);
        }
        keys.forEach((k) => localStorage.removeItem(k));
        return;
      }
      localStorage.removeItem(getSeenKey());
    } catch {}
  }

  function detectLanguage(){
    try {
      const nav = String((navigator.languages && navigator.languages[0]) || navigator.language || '').toLowerCase();
      if (nav.startsWith('de')) return 'de';
      if (nav.startsWith('fr')) return 'fr';
    } catch {}
    return FALLBACK_LANG;
  }

  function copy(){
    return COPY[onboardingLang] || COPY[FALLBACK_LANG];
  }

  function t(path, fallback){
    try {
      const value = String(path || '').split('.').reduce((acc, key) => acc && acc[key], copy());
      return (typeof value === 'string' && value) ? value : (fallback || '');
    } catch {
      return fallback || '';
    }
  }

  function detectRegion(){
    try {
      const current = String(((typeof state !== 'undefined' && state && state.country) ? state.country : (window.state && window.state.country)) || '').trim().toLowerCase();
      if (current) return current;
      const locale = String(Intl.DateTimeFormat().resolvedOptions().locale || navigator.language || '').toLowerCase();
      const match = locale.match(/[-_]([a-z]{2})\b/);
      if (match && match[1]) return match[1];
    } catch {}
    return 'world';
  }

  function normalizeInterestList(list){
    const set = new Set((Array.isArray(list) ? list : []).map((x) => String(x || '').trim().toLowerCase()).filter(Boolean));
    const filtered = INTEREST_OPTIONS.filter((x) => set.has(x) && x !== 'general');
    return filtered.length ? filtered : ['general'];
  }

  function titleCase(value){
    const s = String(value || '').trim();
    return s ? s.charAt(0).toUpperCase() + s.slice(1) : '';
  }

  function regionLabel(value){
    const option = REGION_OPTIONS.find((entry) => entry.value === String(value || '').toLowerCase());
    return option ? option.label : String(value || 'World').toUpperCase();
  }

  function interestLabel(value){
    const translated = copy()?.interests?.[value];
    return translated || titleCase(value);
  }

  function iconSvg(kind){
    const common = 'viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"';
    if (kind === 'logo') return `<svg ${common}><path d="M12 3.2c3.8 0 6.8 3.1 6.8 6.9 0 5.8-5.3 10.7-6.8 10.7S5.2 15.9 5.2 10.1c0-3.8 3-6.9 6.8-6.9Z"/><path d="M14.9 5.7c.2 1.8-.3 3.2-1.4 4.2-1.1 1-2.6 1.5-4.4 1.4.2-1.8.9-3.2 2.1-4.2 1.2-1 2.4-1.5 3.7-1.4Z"/></svg>`;
    if (kind === 'region') return `<svg ${common}><path d="M3.5 12a8.5 8.5 0 1 0 17 0a8.5 8.5 0 1 0-17 0"/><path d="M12 3.5c2.5 2.3 4 5.2 4 8.5s-1.5 6.2-4 8.5c-2.5-2.3-4-5.2-4-8.5s1.5-6.2 4-8.5Z"/><path d="M4.2 9h15.6"/><path d="M4.2 15h15.6"/></svg>`;
    if (kind === 'topics') return `<svg ${common}><rect x="4" y="5" width="7" height="6" rx="2"/><rect x="13" y="5" width="7" height="6" rx="2"/><rect x="4" y="13" width="7" height="6" rx="2"/><rect x="13" y="13" width="7" height="6" rx="2"/></svg>`;
    if (kind === 'visual') return `<svg ${common}><rect x="3.5" y="5" width="17" height="14" rx="3"/><path d="M8 10.5h.01"/><path d="m6.5 16 3.4-3.4a1.4 1.4 0 0 1 2 0l1.3 1.3"/><path d="m13.4 13.8 1-1a1.4 1.4 0 0 1 2 0l2.1 2.2"/></svg>`;
    return `<svg ${common}><path d="M12 4.5v15"/><path d="M4.5 12h15"/><circle cx="12" cy="12" r="8.5"/></svg>`;
  }

  function getSlides(){
    const region = regionLabel(selectedCountry === 'world' ? 'world' : String(selectedCountry || 'world').toLowerCase());
    const langCopy = copy();
    const slides = langCopy.slides || COPY.en.slides;
    return [
      { ...slides[0], icon: 'logo' },
      { ...slides[1], text: String(slides[1].text || '').replace('{region}', region), icon: 'region', region: true },
      { ...slides[2], icon: 'topics', interests: true },
      { ...slides[3], icon: 'visual', pulse: true },
      { ...slides[4], icon: 'logo' },
    ];
  }

  function ensureRoot(){
    if (root) return root;
    root = document.createElement('div');
    root.className = 'onboardingRoot';
    root.setAttribute('aria-hidden', 'true');
    root.innerHTML = `
      <div class="onboardingBackdrop"></div>
      <div class="onboardingShell" role="dialog" aria-modal="true" aria-label="${t('aria_label', 'Welcome to CHECKNE onboarding')}">
        <div class="onboardingTopBar">
          <button class="onboardingSkipBtn" type="button">${t('skip', 'Skip')}</button>
        </div>
        <div class="onboardingViewport">
          <div class="onboardingTrack"></div>
        </div>
        <div class="onboardingFooter">
          <div class="onboardingDots"></div>
          <div class="onboardingActions">
            <button class="onboardingAction onboardingAction--ghost" type="button" data-role="back">${t('back', 'Back')}</button>
            <button class="onboardingAction onboardingAction--primary" type="button" data-role="next">${t('next', 'Next')}</button>
            <button class="onboardingAction onboardingAction--primary isHidden" type="button" data-role="finish">${t('get_started', 'Get Started')}</button>
          </div>
        </div>
      </div>`;
    document.body.appendChild(root);
    bindRoot();
    render();
    return root;

    
  }

  function render(){
    if (!root) return;
    root.querySelector('.onboardingShell')?.setAttribute('aria-label', t('aria_label', 'Welcome to CHECKNE onboarding'));
    const skipBtn = root.querySelector('.onboardingSkipBtn');
    const backBtn = root.querySelector('[data-role="back"]');
    const nextBtn = root.querySelector('[data-role="next"]');
    const finishBtn = root.querySelector('[data-role="finish"]');
    if (skipBtn) skipBtn.textContent = t('skip', 'Skip');
    if (backBtn) backBtn.textContent = t('back', 'Back');
    if (nextBtn) nextBtn.textContent = t('next', 'Next');
    if (finishBtn) finishBtn.textContent = t('get_started', 'Get Started');

    const slides = getSlides();
    const track = root.querySelector('.onboardingTrack');
    const dots = root.querySelector('.onboardingDots');
    if (!track || !dots) return;
    track.innerHTML = slides.map((slide, index) => `
      <section class="onboardingSlide${index === currentIndex ? ' isActive' : ''}" data-slide-index="${index}">
        <div class="onboardingCard">
          <div class="onboardingCardGlow"></div>
          <div class="onboardingVisual${slide.pulse ? ' onboardingVisual--pulse' : ''}">
            <div class="onboardingVisualRing"></div>
            <div class="onboardingVisualPlate">
              <div class="onboardingIconWrap">${iconSvg(slide.icon)}</div>
            </div>
          </div>
          <div class="onboardingCopy">
            <div class="onboardingEyebrow">${slide.step}</div>
            <h2 class="onboardingTitle">${slide.title}</h2>
            <p class="onboardingText">${slide.text}</p>
            ${slide.region ? renderRegionSelector() : ''}
            ${slide.interests ? renderInterestSelector() : ''}
            <div class="onboardingHint"><span class="onboardingHintDot"></span><span>${slide.hint}</span></div>
          </div>
        </div>
      </section>`).join('');
    dots.innerHTML = slides.map((_, index) => `<button class="onboardingDot${index === currentIndex ? ' isActive' : ''}" type="button" aria-label="Go to slide ${index + 1}" data-index="${index}"></button>`).join('');
    updateControls();
    syncTrack(true);
    requestAnimationFrame(() => updateCardScroll());
  }

  function renderRegionSelector(){
    return `
      <div class="onboardingMeta">
        <div class="onboardingMetaLabel">${t('detected', 'Detected')}: <b>${regionLabel(selectedCountry || 'world')}</b></div>
        <div class="onboardingChipRow onboardingChipRow--regions">
          ${REGION_OPTIONS.map((option) => {
            const active = option.value === selectedCountry;
            return `<button class="onboardingChip${active ? ' isActive' : ''}" type="button" data-region="${option.value}">${option.label}</button>`;
          }).join('')}
        </div>
      </div>`;
  }

  function renderInterestSelector(){
    return `
      <div class="onboardingMeta">
        <div class="onboardingChipGrid">
          ${INTEREST_OPTIONS.map((interest) => {
            const active = selectedInterests.includes(interest);
            return `<button class="onboardingTopicChip${active ? ' isActive' : ''}" type="button" data-interest="${interest}">${interestLabel(interest)}</button>`;
          }).join('')}
        </div>
      </div>`;
  }

  function setBusy(isBusy){
    if (!root) return;
    root.dataset.busy = isBusy ? '1' : '0';
    root.querySelectorAll('.onboardingAction, .onboardingSkipBtn, .onboardingChip, .onboardingTopicChip, .onboardingDot').forEach((node) => {
      if (!(node instanceof HTMLButtonElement)) return;
      node.disabled = !!isBusy;
    });
    const finishBtn = root.querySelector('[data-role="finish"]');
    if (finishBtn && isBusy) finishBtn.textContent = '...';
    else if (finishBtn) finishBtn.textContent = t('get_started', 'Get Started');
  }

  function updateControls(){
    if (!root) return;
    const total = getSlides().length;
    const back = root.querySelector('[data-role="back"]');
    const next = root.querySelector('[data-role="next"]');
    const finish = root.querySelector('[data-role="finish"]');
    const dots = root.querySelectorAll('.onboardingDot');
    const slides = root.querySelectorAll('.onboardingSlide');
    slides.forEach((slide, idx) => slide.classList.toggle('isActive', idx === currentIndex));
    dots.forEach((dot, idx) => dot.classList.toggle('isActive', idx === currentIndex));
    if (back) back.disabled = currentIndex === 0;
    if (next) next.classList.toggle('isHidden', currentIndex === total - 1);
    if (finish) finish.classList.toggle('isHidden', currentIndex !== total - 1);
  }

  function syncTrack(immediate){
    if (!root) return;
    const track = root.querySelector('.onboardingTrack');
    if (!track) return;
    if (immediate) {
      track.classList.add('isImmediate');
      requestAnimationFrame(() => track.classList.remove('isImmediate'));
    }
    track.style.transform = `translate3d(${-currentIndex * 100}%,0,0)`;
    updateControls();
    try {
      const activeCard = root.querySelector(`.onboardingSlide[data-slide-index="${currentIndex}"] .onboardingCard`);
      if (activeCard) activeCard.scrollTop = 0;
    } catch {}
    requestAnimationFrame(updateCardScroll);
  }

  function goTo(index){
    const total = getSlides().length;
    currentIndex = Math.max(0, Math.min(total - 1, index));
    syncTrack(false);
  }

  function next(){
    const total = getSlides().length;
    if (currentIndex >= total - 1) return finish();
    goTo(currentIndex + 1);
  }

  function prev(){
    if (currentIndex <= 0) return;
    goTo(currentIndex - 1);
  }

  async function persistSelections(){
    const normalizedInterests = normalizeInterestList(selectedInterests);
    const normalizedCountry = selectedCountry || 'world';
    setBusy(true);
    try {
      if (typeof state !== 'undefined' && state) {
        state.country = normalizedCountry;
        state.interests = normalizedInterests;
      } else if (window.state) {
        window.state.country = normalizedCountry;
        window.state.interests = normalizedInterests;
      }

      if (typeof savePrefs === 'function') savePrefs();

      if (window.authState && window.authState.authenticated) {
        try {
          await (window.apiFetchJson
            ? window.apiFetchJson(`${window.API_BASE || ''}/api/preferences`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                credentials: 'include',
                body: JSON.stringify({
                  interests: normalizedInterests,
                  country: normalizedCountry,
                  language: (window.state && window.state.language) ? window.state.language : 'en'
                }),
                timeoutMs: 12000
              })
            : fetch(`${window.API_BASE || ''}/api/preferences`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                credentials: 'include',
                body: JSON.stringify({
                  interests: normalizedInterests,
                  country: normalizedCountry,
                  language: (window.state && window.state.language) ? window.state.language : 'en'
                })
              }));
        } catch (err) {
          console.warn('[onboarding] could not persist preferences', err);
        }
      }

      try {
        const countrySelect = document.getElementById('country');
        if (countrySelect) countrySelect.value = normalizedCountry;
      } catch {}
      try { if (typeof renderTags === 'function') renderTags(); } catch {}
      try { if (typeof syncDropdownsFromState === 'function') syncDropdownsFromState(); } catch {}
      try { if (typeof updateInterestSelectionUI === 'function') updateInterestSelectionUI(); } catch {}

      const modeValue = (typeof state !== 'undefined' && state) ? state.mode : (window.state && window.state.mode);
      if (typeof fetchFeed === 'function' && modeValue === 'feed') {
        await fetchFeed({ reset: true, reason: 'onboarding-finish' });
      }
    } catch (err) {
      console.error('[onboarding] finish failed', err);
    } finally {
      setBusy(false);
    }
  }

  function revealSiteUiSequentially(){
    try {
      const selectors = [
        '#siteHeader',
        '#leftSidebar > *',
        '#feedView > *',
        '#rightSidebar > *'
      ];
      const nodes = [];
      selectors.forEach((selector) => {
        document.querySelectorAll(selector).forEach((node) => {
          if (!(node instanceof HTMLElement)) return;
          if (!node.offsetParent && selector !== '#siteHeader') return;
          nodes.push(node);
        });
      });
      if (!nodes.length) return;
      document.documentElement.classList.add('checkneUiRevealActive');
      nodes.forEach((node, index) => {
        node.classList.add('checkneUiRevealItem');
        node.style.setProperty('--ui-reveal-delay', `${Math.min(index * 70, 700)}ms`);
      });
      requestAnimationFrame(() => {
        document.documentElement.classList.add('checkneUiRevealRun');
      });
      window.setTimeout(() => {
        nodes.forEach((node) => {
          node.classList.remove('checkneUiRevealItem');
          node.style.removeProperty('--ui-reveal-delay');
        });
        document.documentElement.classList.remove('checkneUiRevealActive');
        document.documentElement.classList.remove('checkneUiRevealRun');
      }, 1800);
    } catch {}
  }

  async function finish(){
    markSeen();
    await persistSelections();
    close({ runReveal: true });
  }

  function open(force){
    onboardingLang = detectLanguage();
    ensureRoot();
    if (!force && isSeen()) return;
    selectedCountry = String((((typeof state !== 'undefined' && state) ? state.country : (window.state && window.state.country)) || detectRegion()) || 'world').toLowerCase();
    selectedInterests = normalizeInterestList(((typeof state !== 'undefined' && state && state.interests) ? state.interests : (window.state && window.state.interests)) || ['general']);
    currentIndex = 0;
    render();
    document.documentElement.classList.add('onboardingLock');
    document.body.classList.add('onboardingLock');
    root.classList.remove('isClosing');
    root.classList.add('isOpen');
    root.setAttribute('aria-hidden', 'false');
  }

  function close(opts){
    if (!root) return;
    root.classList.remove('isOpen');
    root.classList.add('isClosing');
    root.setAttribute('aria-hidden', 'true');
    document.documentElement.classList.remove('onboardingLock');
    document.body.classList.remove('onboardingLock');
    if (opts && opts.runReveal) {
      window.setTimeout(revealSiteUiSequentially, 80);
      try { document.dispatchEvent(new CustomEvent('checkne:onboarding-finished')); } catch {}
    }
  }

  function handleRootClick(event){
    const target = event.target;
    if (!(target instanceof Element)) return;
    const dot = target.closest('.onboardingDot');
    if (dot) {
      const index = Number(dot.getAttribute('data-index'));
      if (Number.isFinite(index)) goTo(index);
      return;
    }
    const region = target.closest('[data-region]');
    if (region) {
      selectedCountry = String(region.getAttribute('data-region') || 'world').toLowerCase();
      render();
      goTo(currentIndex);
      return;
    }
    const interest = target.closest('[data-interest]');
    if (interest) {
      const value = String(interest.getAttribute('data-interest') || '').toLowerCase();
      if (!value) return;
      const set = new Set(selectedInterests);
      if (value === 'general') {
        selectedInterests = ['general'];
      } else if (set.has(value)) {
        set.delete(value);
        selectedInterests = normalizeInterestList([...set]);
      } else {
        set.delete('general');
        set.add(value);
        selectedInterests = normalizeInterestList([...set]);
      }
      render();
      goTo(currentIndex);
      return;
    }
    const action = target.closest('[data-role]');
    if (!action) return;
    const role = String(action.getAttribute('data-role') || '');
    if (role === 'back') prev();
    if (role === 'next') next();
    if (role === 'finish') void finish();
  }
function updateCardScroll() {
  if (!root) return;

  const activeCard = root.querySelector('.onboardingSlide.isActive .onboardingCard');
  if (!activeCard) return;

  if (activeCard.scrollHeight > activeCard.clientHeight + 2) {
    activeCard.classList.add('isScrollable');
  } else {
    activeCard.classList.remove('isScrollable');
  }
}

  function bindRoot(){
    if (!root) return;
    root.addEventListener('click', handleRootClick);
    const skip = root.querySelector('.onboardingSkipBtn');
    if (skip) skip.addEventListener('click', () => { markSeen(); close(); });

    const viewport = root.querySelector('.onboardingViewport');
    const track = root.querySelector('.onboardingTrack');
    if (!viewport || !track) return;

    window.addEventListener('resize', updateCardScroll);

    window.addEventListener('resize', updateCardScroll);

    viewport.addEventListener('pointerdown', (event) => {
      if (!(event.target instanceof Element)) return;
      const activeCard = event.target.closest('.onboardingSlide.isActive .onboardingCard');
      if (!activeCard) return;
      if (event.target.closest('button, a, input, select, textarea, label')) return;
      drag = {
        id: event.pointerId,
        startX: event.clientX,
        startY: event.clientY,
        dx: 0,
        active: false,
      };
    });

    viewport.addEventListener('pointermove', (event) => {
      if (!drag || event.pointerId !== drag.id) return;
      drag.dx = event.clientX - drag.startX;
      const dy = event.clientY - drag.startY;
      if (!drag.active) {
        if (Math.abs(drag.dx) < 10) return;
        if (Math.abs(dy) > Math.abs(drag.dx)) { drag = null; return; }
        drag.active = true;
        track.classList.add('isDragging');
      }
      const width = viewport.clientWidth || 1;
      const pct = (-currentIndex * width) + drag.dx;
      track.style.transform = `translate3d(${pct}px,0,0)`;
    }, { passive: true });

    const endDrag = () => {
      if (!drag) return;
      const dx = drag.dx || 0;
      track.classList.remove('isDragging');
      if (Math.abs(dx) > Math.min(80, (viewport.clientWidth || 0) * 0.18)) {
        if (dx < 0) next(); else prev();
      } else {
        syncTrack(false);
      }
      drag = null;
    };

    viewport.addEventListener('pointerup', endDrag);
    viewport.addEventListener('pointercancel', endDrag);
    viewport.addEventListener('pointerleave', endDrag);
  }

  function initOnboarding(opts){
    initialized = true;
    const force = !!(opts && opts.force);
    const authed = (typeof authState !== 'undefined' && authState) ? authState.authenticated : (window.authState && window.authState.authenticated);
    if (!authed) {
      pendingOpen = force;
      return;
    }
    if (!force && isSeen()) return;
    open(force);
  }

  document.addEventListener('checkne:auth-ready', () => {
    const force = pendingOpen;
    pendingOpen = false;
    initOnboarding({ force });
  });

  document.addEventListener('DOMContentLoaded', () => {
    setTimeout(() => initOnboarding(), 0);
  });

  window.initOnboarding = initOnboarding;
  window.checkneReplayOnboarding = function(){ clearSeen(false); initOnboarding({ force: true }); };
  window.checkneResetOnboardingSeen = function(){ clearSeen(false); };
  window.checkneResetAllOnboardingSeen = function(){ clearSeen(true); };
})();