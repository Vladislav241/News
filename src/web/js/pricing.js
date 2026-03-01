/*
 * CHECKNE Web App — pricing.js
 * Pricing/Billing UI + Info pages (legal/support) + billing query params
 *
 * Split from the former monolithic app.js to keep responsibilities separated.
 * Keep files loaded in order (see index.html).
 */

// ----------------------------
// Pricing / Billing UI
// ----------------------------
function bindPricingUI(){
  const pricingSection = document.getElementById('pricingSection');
  const profileSection = document.getElementById('profileSection');
  const feedView = document.getElementById('feedView');
  if(!pricingSection || !feedView) return;


// Info pages (Legal / Support)
const infoSection = document.getElementById('infoSection');
const infoTitleEl = document.getElementById('infoTitle');
const infoMetaEl  = document.getElementById('infoMeta');
const infoBodyEl  = document.getElementById('infoBody');
const infoBackBtn = document.getElementById('infoBackBtn');

// Professional copy (lightweight templates; customize anytime)
const INFO_PAGES = {
  email: {
    title: "Email Policy",
    updated: "2026-02-27",
    html: `
      <p class="infoLead">This page explains how CHECKNE sends email and how you can control notifications.</p>

      <h2>What emails we send</h2>
      <ul>
        <li><b>Account emails</b>: email verification, password reset, security notices.</li>
        <li><b>Subscription emails</b>: payment confirmations, renewal/cancellation status (when applicable).</li>
        <li><b>Alerts you enable</b>: tracking notifications you explicitly switch on in your account settings.</li>
      </ul>

      <h2>We do not send spam</h2>
      <p>We don’t purchase lists and we don’t send unsolicited marketing blasts. Emails are sent only to users who created an account on CHECKNE.</p>

      <h2>Unsubscribe / manage emails</h2>
      <ul>
        <li>You can disable email alerts in <b>Tracking settings</b> at any time.</li>
        <li>Where available, emails include an <b>Unsubscribe</b> link for one‑click opt‑out from alerts.</li>
        <li>If you need help, contact us at <a href="mailto:support@checkne.com">support@checkne.com</a>.</li>
      </ul>

      <h2>Abuse reports</h2>
      <p>If you believe you received an email from CHECKNE by mistake, please forward it to <a href="mailto:abuse@checkne.com">abuse@checkne.com</a> and we’ll investigate.</p>
    `
  },
  contact: {
    title: "Contact",
    updated: "2026-02-21",
    html: `
      <p class="infoLead">Questions, feedback, partnerships, or support — we’re here to help.</p>

      <div class="infoCallout">
        <b>Email</b><br/>
        <a href="mailto:contact@checkne.com">contact@checkne.com</a>
      </div>

      <h2>Include in your message</h2>
      <ul>
        <li>A short description of what you need</li>
        <li>A link (or screenshot) that shows the issue</li>
        <li>Your device and browser</li>
        <li>If it’s billing-related: the email on your account (never send passwords)</li>
      </ul>

      <h2>Response time</h2>
      <p>We typically reply on business days. If your request is urgent, put <b>URGENT</b> in the subject line.</p>
    `
  },
  status: {
  title: "Status",
  updated: "2026-02-21",
  html: `
    <p class="infoLead">Live operational status of CHECKNE services.</p>

    <h2>Current status</h2>
    <ul class="statusList" id="statusList">
      <li class="statusRow" data-svc="web_app">
        <div class="statusLeft">
          <span class="statusDot status-warn" aria-hidden="true"></span>
          <span class="statusName">Web app</span>
        </div>
        <div class="statusText" data-svc-text="web_app">Checking…</div>
      </li>
      <li class="statusRow" data-svc="api">
        <div class="statusLeft">
          <span class="statusDot status-warn" aria-hidden="true"></span>
          <span class="statusName">API</span>
        </div>
        <div class="statusText" data-svc-text="api">Checking…</div>
      </li>
      <li class="statusRow" data-svc="tracking">
        <div class="statusLeft">
          <span class="statusDot status-warn" aria-hidden="true"></span>
          <span class="statusName">Tracking / ingest</span>
        </div>
        <div class="statusText" data-svc-text="tracking">Checking…</div>
      </li>
      <li class="statusRow" data-svc="email">
        <div class="statusLeft">
          <span class="statusDot status-warn" aria-hidden="true"></span>
          <span class="statusName">Email notifications</span>
        </div>
        <div class="statusText" data-svc-text="email">Checking…</div>
      </li>
    </ul>

    <div class="statusMetaRow" id="statusMeta">Checking status…</div>

    <h2>Report an issue</h2>
    <p>If something looks wrong, send us a message: <a class="statusSmallLink" href="https://mail.google.com/mail/?view=cm&fs=1&to=support%40checkne.com&su=Status%20issue%20%E2%80%94%20CHECKNE&body=Hi%20CHECKNE%20support%2C%0A%0AI%20think%20there%27s%20a%20status%20issue%3A%0A%0A%E2%80%94%20What%20I%20see%3A%0A%E2%80%94%20Link%20%2F%20screenshot%3A%0A%E2%80%94%20Device%20%2F%20browser%3A%0A%0AThanks!" target="_blank" rel="noopener">Open email</a></p>
  `
},

  privacy: {
    title: "Privacy Policy",
    updated: "2026-02-21",
    html: `
      <p class="infoLead">This Privacy Policy explains how CHECKNE (“we”, “us”) processes personal data when you use our website and services.</p>

      <h2>1. Controller</h2>
      <p>CHECKNE is operated by an individual founder based in Germany (the “Controller”).<br/>
      Contact: <a href="mailto:support@checkne.com">support@checkne.com</a></p>

      <h2>2. Data we collect</h2>
      <ul>
        <li><b>Account data</b> (e.g., email address, authentication identifiers)</li>
        <li><b>Subscription & billing metadata</b> (e.g., plan, payment status, renewal/cancellation state; we do not store full card details)</li>
        <li><b>Usage data</b> (e.g., pages viewed, actions taken, error logs, approximate timestamps)</li>
        <li><b>Technical data</b> (e.g., IP address, device/browser information, cookies/local storage identifiers)</li>
        <li><b>Support messages</b> you send to us (content + attachments you choose to provide)</li>
      </ul>

      <h2>3. How we use data</h2>
      <ul>
        <li>Provide and operate the Service (authentication, tracking, alerts)</li>
        <li>Process subscriptions and prevent fraud</li>
        <li>Improve reliability, performance, and security</li>
        <li>Communicate with you (service emails, support replies)</li>
        <li>Comply with legal obligations</li>
      </ul>

      <h2>4. Legal bases (GDPR)</h2>
      <ul>
        <li><b>Contract</b> (Art. 6(1)(b)) — to provide your account and subscription</li>
        <li><b>Legitimate interests</b> (Art. 6(1)(f)) — security, abuse prevention, service improvement</li>
        <li><b>Consent</b> (Art. 6(1)(a)) — where required (e.g., non-essential cookies)</li>
        <li><b>Legal obligation</b> (Art. 6(1)(c)) — accounting/tax and compliance</li>
      </ul>

      <h2>5. Sharing and processors</h2>
      <p>We share data only as necessary to run the Service — for example with hosting, analytics (if enabled), email delivery, and payment providers. These providers act as processors under GDPR where applicable.</p>

      <h2>6. International transfers</h2>
      <p>Some providers may process data outside the EU/EEA. Where required, we rely on appropriate safeguards (such as Standard Contractual Clauses) or other lawful mechanisms.</p>

      <h2>7. Retention</h2>
      <p>We keep personal data only as long as needed for the purposes above, including legal and accounting requirements. You can request deletion of your account, subject to mandatory retention obligations.</p>

      <h2>8. Security</h2>
      <p>We use reasonable technical and organizational measures to protect personal data. No method of transmission or storage is 100% secure.</p>

      <h2>9. Your rights</h2>
      <p>Depending on your location, you may have rights such as access, correction, deletion, portability, restriction, objection, and withdrawing consent. To exercise these rights, email <a href="mailto:support@checkne.com">support@checkne.com</a>.</p>

      <h2>10. Cookies</h2>
      <p>We use cookies and similar technologies to keep the Service working and remember preferences. See our <a href="/cookies">Cookie Policy</a> for details.</p>

      <h2>11. Children</h2>
      <p>The Service is not intended for children. If you believe a child provided personal data, contact us and we will take appropriate steps.</p>

      <h2>12. Changes</h2>
      <p>We may update this Privacy Policy from time to time. We will update the “Last updated” date and, where appropriate, provide additional notice.</p>
    `
  },
  terms: {
    title: "Terms of Service",
    updated: "2026-02-21",
    html: `
      <p class="infoLead">These Terms of Service (“Terms”) govern your access to and use of CHECKNE (“Service”). By using the Service, you agree to these Terms.</p>

      <h2>1. Service</h2>
      <p>CHECKNE provides AI-assisted news tracking and signal intelligence features. We may add, modify, or remove features to improve the Service.</p>

      <h2>2. Accounts</h2>
      <ul>
        <li>You must provide accurate information and keep it up to date.</li>
        <li>You are responsible for your account credentials and all activity under your account.</li>
        <li>You must not share accounts or use the Service on behalf of someone else without permission.</li>
      </ul>

      <h2>3. Paid subscriptions</h2>
      <p>Certain features require a paid subscription.</p>
      <h3>Billing & renewal</h3>
      <p>Subscriptions are billed on a recurring basis (monthly or annually, depending on the plan) and renew automatically unless canceled before the renewal date.</p>
      <h3>Cancellation</h3>
      <p>You can cancel at any time from your account settings. Cancellation stops future renewals; you keep access until the end of the current paid period.</p>
      <h3>Refunds</h3>
      <p>Payments are non-refundable except where required by applicable law.</p>

      <h2>4. Acceptable use</h2>
      <ul>
        <li>Do not misuse the Service, attempt to disrupt it, or access it in unauthorized ways.</li>
        <li>Do not scrape, reverse-engineer, or abuse the Service or its rate limits.</li>
        <li>Do not upload or distribute unlawful, harmful, or misleading content.</li>
        <li>Do not use CHECKNE to build a competing product or provide a competing service.</li>
      </ul>

      <h2>5. Content and third‑party links</h2>
      <p>CHECKNE may link to third‑party websites and sources. Third‑party content is governed by their terms and policies, and we are not responsible for it.</p>

      <h2>6. AI output disclaimer</h2>
      <p>The Service uses automated systems and AI-generated analysis. Outputs may be incomplete, inaccurate, or outdated. You are responsible for verifying information before relying on it.</p>

      <h2>7. Disclaimers</h2>
      <p>The Service is provided “as is” and “as available”. We do not guarantee uninterrupted operation or error-free results.</p>

      <h2>8. Limitation of liability</h2>
      <p>To the maximum extent permitted by law, CHECKNE is not liable for indirect, incidental, special, consequential, or punitive damages.</p>

      <h2>9. Termination</h2>
      <p>We may suspend or terminate access if you violate these Terms or to protect the Service, users, or third parties.</p>

      <h2>10. Governing law</h2>
      <p>These Terms are governed by the laws of Germany.</p>

      <h2>Contact</h2>
      <p>Questions about these Terms: <a href="mailto:contact@checkne.com?subject=Terms%20question%20%E2%80%94%20CHECKNE">contact@checkne.com</a></p>
    `
  },
  cookies: {
    title: "Cookie Policy",
    updated: "2026-02-21",
    html: `
      <p class="infoLead">This Cookie Policy explains how CHECKNE uses cookies and similar technologies.</p>
      <h2>What are cookies?</h2>
      <p>Cookies are small text files stored on your device to help websites function and remember preferences.</p>
      <h2>Types of cookies we may use</h2>
      <ul>
        <li><b>Essential cookies</b> (required for core functionality and security)</li>
        <li><b>Preferences cookies</b> (remember language or UI settings)</li>
        <li><b>Analytics cookies</b> (help us understand usage and improve performance)</li>
      </ul>
      <h2>Managing cookies</h2>
      <p>You can control cookies through your browser settings. Disabling some cookies may affect site functionality.</p>
      <h2>Contact</h2>
      <p>Cookie questions: <a href="mailto:contact@checkne.com?subject=Cookie%20question%20%E2%80%94%20CHECKNE">contact@checkne.com</a></p>
    `
  },
  impressum: {
    title: "Impressum",
    updated: "2026-02-21",
    html: `
      <p class="infoLead">Information according to applicable German law (e.g., § 5 TMG / § 18 MStV, as relevant).</p>
      <h2>Service provider</h2>
      <p><b>CHECKNE</b><br/>Contact: <a href="mailto:contact@checkne.com">contact@checkne.com</a></p>
      <h2>Responsible for content</h2>
      <p>Responsible person (content): CHECKNE (see contact above).</p>
      <h2>Disclaimer</h2>
      <p>Despite careful control, we assume no liability for external links. The operators of linked pages are solely responsible for their content.</p>
    `
  }
};

let __statusPollTimer = null;

function __statusClassFromState(s){
  const v = String(s || '').toLowerCase();
  if(v === 'operational' || v === 'ok' || v === 'green') return 'status-ok';
  if(v === 'degraded' || v === 'warning' || v === 'warn' || v === 'yellow') return 'status-warn';
  return 'status-down';
}

function __stopStatusPoll(){
  if(__statusPollTimer){
    clearInterval(__statusPollTimer);
    __statusPollTimer = null;
  }
}

async function __refreshStatusOnce(){
  const meta = document.getElementById('statusMeta');
  const list = document.getElementById('statusList');
  if(!list) return;

  if(meta) meta.textContent = 'Checking status…';

  try{
    const r = await fetch(`${API_BASE}/api/status`, { cache: 'no-store' });
    if(!r.ok) throw new Error(`HTTP ${r.status}`);
    const data = await r.json();

    const services = (data && data.services) ? data.services : {};
    const updatedAt = (data && data.generated_at) ? String(data.generated_at) : '';

    Object.keys(services).forEach((k)=>{
      const item = services[k] || {};
      const state = item.status || 'down';
      const text = item.message || state;

      const row = list.querySelector(`[data-svc="${k}"]`);
      if(!row) return;

      const dot = row.querySelector('.statusDot');
      if(dot){
        dot.classList.remove('status-ok','status-warn','status-down');
        dot.classList.add(__statusClassFromState(state));
      }

      const t = row.querySelector(`[data-svc-text="${k}"]`);
      if(t) t.textContent = text;
    });

    if(meta){
      meta.textContent = updatedAt ? (`Last checked: ${updatedAt}`) : 'Last checked just now';
    }
  }catch(e){
    // Mark everything as degraded/down if API cannot be reached
    list.querySelectorAll('.statusRow').forEach((row)=>{
      const dot = row.querySelector('.statusDot');
      const t = row.querySelector('.statusText');
      if(dot){
        dot.classList.remove('status-ok','status-warn');
        dot.classList.add('status-down');
      }
      if(t) t.textContent = 'Unavailable';
    });
    if(meta) meta.textContent = 'Status check failed. Please try again later.';
  }
}

function __initStatusPage(){
  __stopStatusPoll();
  __refreshStatusOnce();
  __statusPollTimer = setInterval(__refreshStatusOnce, 20000);
}

function setInfoPage(slug){
  if(!infoSection || !infoTitleEl || !infoBodyEl) return;

  const page = INFO_PAGES[slug];
  if(!page) return;

  // Hide other main views
  feedView.style.display = 'none';
  pricingSection.style.display = 'none';
  if(profileSection) profileSection.style.display = 'none';

  // Render content
  infoTitleEl.textContent = page.title;
  if(infoMetaEl) infoMetaEl.textContent = `Last updated: ${page.updated}`;
  infoBodyEl.innerHTML = page.html;

  if(slug === 'status') __initStatusPage(); else __stopStatusPoll();

  infoSection.style.display = 'block';
  window.scrollTo({ top: 0, behavior: 'instant' });
}

function setMainFeed(){
  if(infoSection) infoSection.style.display = 'none';
  __stopStatusPoll();
  pricingSection.style.display = 'none';
  if(profileSection) profileSection.style.display = 'none';
  feedView.style.display = 'block';
  window.scrollTo({ top: 0, behavior: 'instant' });
}

  // Selected plan for the single CTA button under the cards
  let selectedPlan = (billingState?.plan || 'free').toLowerCase();

  // Optional query params:
  //  - ?plan=pro|analyst|free   (preselect a card)
  //  - ?interval=monthly|yearly (preselect billing interval)
  //  - ?checkout=1              (auto start checkout after render)
  let __autoCheckout = false;
  try{
    const sp = new URLSearchParams(String(location.search || ''));
    const qpPlan = String(sp.get('plan') || '').toLowerCase();
    const qpInterval = String(sp.get('interval') || '').toLowerCase();
    if (qpPlan === 'free' || qpPlan === 'pro' || qpPlan === 'analyst') selectedPlan = qpPlan;
    if (qpInterval === 'monthly' || qpInterval === 'yearly') {
      try { setBillingInterval(qpInterval); } catch {}
      try { billingInterval = qpInterval; } catch {}
    }
    __autoCheckout = String(sp.get('checkout') || '') === '1';
  }catch{}

  function setPage(page){
    // page: 'feed' | 'pricing' | 'info:<slug>'
    // Widgets: only show on the main feed page (Tracking tab is handled in mode.js).
    try{
      if (typeof window.__setWidgetsEnabled === 'function'){
        window.__setWidgetsEnabled(page === 'feed');
      }
    }catch{}

    if(page === 'pricing'){
      if(infoSection) infoSection.style.display = 'none';
      feedView.style.display = 'none';
      if(profileSection) profileSection.style.display = 'none';
      pricingSection.style.display = 'block';
      window.scrollTo({ top: 0, behavior: 'instant' });
      const btn = document.getElementById('btnPricing');
      if(btn) btn.setAttribute('aria-current','page');
      return;
    }

    if(page === 'profile'){
      if(infoSection) infoSection.style.display = 'none';
      feedView.style.display = 'none';
      pricingSection.style.display = 'none';
      if(profileSection) profileSection.style.display = 'block';
      try{ window.scrollTo({ top: 0, behavior: 'instant' }); }catch{}
      // Keep UI in sync
      try{ updateProfileUI(); }catch{}
      return;
    }

    if(page && page.startsWith('info:')){
      const slug = page.slice('info:'.length);
      const btn = document.getElementById('btnPricing');
      if(btn) btn.removeAttribute('aria-current');
      setInfoPage(slug);
      return;
    }

    // Default: main feed (with tabs/tracking inside)
    const btn = document.getElementById('btnPricing');
    if(btn) btn.removeAttribute('aria-current');
    setMainFeed();
  }

  // Expose for other handlers (Tracking / Login, etc.)
  window.__setMainPage = setPage;

window.__openInfoPage = (slug)=> setPage(`info:${slug}`);

// Back button for info pages
if(infoBackBtn){
  infoBackBtn.addEventListener('click', ()=>{
    // Go back to feed by default
    try { window.__navigate('/'); } catch(_) { try { history.pushState({},'', '/'); } catch{}; setPage('feed'); }
  });
}

function _normPath(p){
  let path = String(p || '/');
  if (!path.startsWith('/')) path = '/' + path;
  // drop query/hash
  path = path.split('?')[0].split('#')[0];
  // trim trailing slash (except root)
  if (path.length > 1) path = path.replace(/\/+$/,'');
  return path;
}

// History routing (clean URLs like /privacy)
function routeFromLocation(){
  // Compatibility: if someone opens an old hash URL (/#/privacy)
  // transparently convert it to /privacy.
  try{
    const h = String(location.hash || '');
    if (h.startsWith('#/')){
      const target = _normPath(h.slice(1));
      history.replaceState({}, '', target + (location.search || ''));
      // clear hash
      try { location.hash = ''; } catch {}
    }
  }catch{}

  const path = _normPath(location.pathname);

  if (path === '/pricing'){
    setPage('pricing');
    return;
  }
  if (path === '/account' || path === '/profile'){
    setPage('profile');
    return;
  }
  if (path === '/tracking'){
    setPage('feed');
    switchMode('fav');
    return;
  }
  if (path === '/contact') return setPage('info:contact');
  if (path === '/email') return setPage('info:email');
  if (path === '/status') return setPage('info:status');
  if (path === '/privacy') return setPage('info:privacy');
  if (path === '/terms') return setPage('info:terms');
  if (path === '/cookies') return setPage('info:cookies');
  if (path === '/impressum') return setPage('info:impressum');

  // Default: main feed (/) and anything unknown
  setPage('feed');
}

function navigateTo(path){
  const p = _normPath(path);
  try { history.pushState({}, '', p); } catch(_){ try { location.assign(p); } catch{} }
  try { routeFromLocation(); } catch(_) {}
}

// Expose router so other modules can navigate / route
window.__routeFromLocation = routeFromLocation;
window.__navigate = navigateTo;

// React to browser back/forward
window.addEventListener('popstate', routeFromLocation);

// Handle direct loads
setTimeout(()=>{
  try { routeFromLocation(); } catch(_) {}
}, 0);


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
    brand.addEventListener('click', async (e)=>{
      e.preventDefault();
      setPage('feed');
      await switchMode('feed');
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

  // If opened from widgets with checkout=1, start payment flow immediately.
  if (__autoCheckout) {
    setTimeout(() => {
      try {
        const btn = document.getElementById('pricingMainCta');
        if (btn && !btn.disabled) btn.click();
      } catch {}
    }, 60);
  }
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

function _fmtPeriodEnd(iso){
  if(!iso) return '';
  try{
    const d = new Date(String(iso));
    if(Number.isNaN(d.getTime())) return '';
    return d.toLocaleDateString('en-US', { year:'numeric', month:'short', day:'2-digit' });
  }catch{
    return '';
  }
}

function _planLabel(plan){
  const p = String(plan || 'free').toLowerCase();
  if(p === 'pro') return 'Plus';
  if(p === 'analyst') return 'Analyst';
  return 'Free';
}

function updateProfileUI(){
  const sec = document.getElementById('profileSection');
  if(!sec) return;

  const nameEl  = document.getElementById('profileName');
  const emailEl = document.getElementById('profileEmail');

  const planPill   = document.getElementById('profilePlanPill');
  const statusPill = document.getElementById('profileStatusPill');
  const renewText  = document.getElementById('profileRenewText');
  const cancelHint = document.getElementById('profileCancelHint');

  const btnManage = document.getElementById('profileManageBtn');
  const btnCancel = document.getElementById('profileCancelBtn');
  const btnResume = document.getElementById('profileResumeBtn');

  const isAuthed = !!authState?.authenticated;
  const user = authState?.user || null;

  const name = isAuthed ? displayNameFromUser(user) : '—';
  const email = isAuthed ? String(user?.email || '').trim() : '';

  if(nameEl) nameEl.textContent = name;
  if(emailEl) emailEl.textContent = email || '—';

  const plan = String(billingState?.plan || 'free').toLowerCase();
  const status = String(billingState?.status || 'active');
  const cancelAt = !!billingState?.cancel_at_period_end;
  const end = _fmtPeriodEnd(billingState?.current_period_end);

  if(planPill) planPill.textContent = _planLabel(plan);
  if(statusPill) statusPill.textContent = (status ? status.charAt(0).toUpperCase() + status.slice(1) : 'Active');

  // Actions
  if(btnManage){
    btnManage.disabled = !isAuthed;
    btnManage.onclick = () => {
      try { if (typeof window.__navigate === 'function') window.__navigate('/pricing'); else location.href = '/pricing'; } catch(_) {}
    };
  }

  if(btnCancel) btnCancel.style.display = 'none';
  if(btnResume) btnResume.style.display = 'none';
  if(cancelHint) cancelHint.style.display = 'none';

  if(!isAuthed){
    if(renewText) renewText.textContent = 'Log in to manage your plan.';
    return;
  }

  if(plan === 'free'){
    if(renewText) renewText.textContent = 'You are on Free. Upgrade anytime to unlock premium features.';
    return;
  }

  if(cancelAt){
    if(renewText) renewText.textContent = end ? `Your subscription is set to cancel on ${end}.` : 'Your subscription is set to cancel at period end.';
    if(btnResume){
      btnResume.style.display = '';
      btnResume.disabled = false;
      btnResume.onclick = async ()=>{
        try{
          btnResume.disabled = true;
          const r = await fetch(`${API_BASE}/api/billing/resume`, { method:'POST' });
          const j = await r.json().catch(()=> ({}));
          if(!r.ok) throw new Error(j?.detail || `HTTP ${r.status}`);
          await refreshBillingState();
        }catch(e){
          alert(String(e?.message || e || 'Failed to resume subscription'));
        }finally{
          btnResume.disabled = false;
        }
      };
    }
    if(cancelHint){
      cancelHint.style.display = '';
      cancelHint.textContent = 'You will keep access until the end of your current billing period.';
    }
  }else{
    if(renewText) renewText.textContent = end ? `Renews on ${end}.` : 'Renews automatically unless canceled.';
    if(btnCancel){
      btnCancel.style.display = '';
      btnCancel.disabled = false;
      btnCancel.onclick = async ()=>{
        const ok = confirm('Cancel at period end? You will keep access until the end of the current billing period.');
        if(!ok) return;
        try{
          btnCancel.disabled = true;
          const r = await fetch(`${API_BASE}/api/billing/cancel`, { method:'POST' });
          const j = await r.json().catch(()=> ({}));
          if(!r.ok) throw new Error(j?.detail || `HTTP ${r.status}`);
          await refreshBillingState();
        }catch(e){
          alert(String(e?.message || e || 'Failed to cancel subscription'));
        }finally{
          btnCancel.disabled = false;
        }
      };
    }
  }
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
        // Make sure we never introduce duplicates
        state.interests = [...new Set([...(state.interests || []), tag])];
      }
      // Persist interests (account-scoped when logged in; localStorage for guests).
      try { savePrefs(); } catch {}
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

  // Hide Top stories carousel (🔥) when in Tracking tab
  const topStories = document.getElementById("topStories");
  if (topStories) topStories.style.display = isTracking ? "none" : "";

  updateTrashZone();
  
function updateTrackingHint() {
  const el = qs('trackingHint');
  if (!el) return;
  const show = (state.mode === 'fav') && (getFavIds().length > 0);
  el.style.display = show ? 'block' : 'none';
}
updateTrackingHint();
  updateEmailAlertsUI();
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
   return d.toLocaleTimeString('en-US', { hour: "2-digit", minute: "2-digit" });
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
  // Backwards-compatible signature: getNewsImage(item, kind)
  // kind: "thumb" | "card" | "hero"
  const kind = arguments.length >= 2 ? String(arguments[1] || "card") : "card";

  const isLikelyImageUrl = (u) => {
    const s = String(u || '').trim();
    if (!s) return false;
    // allow data URIs
    if (s.startsWith('data:image/')) return true;
    // allow protocol-relative
    if (s.startsWith('//')) return true;
    if (s.startsWith('http://') || s.startsWith('https://')) return true;
    return false;
  };

  const pickFromObject = (obj) => {
    if (!obj || typeof obj !== 'object') return '';

    // Common fields across providers
    const keys = [
      'image', 'image_url', 'imageUrl', 'imageURL', 'urlToImage', 'url_to_image',
      'thumbnail', 'thumbnail_url', 'thumb', 'thumb_url',
      'hero_image', 'heroImage', 'lead_image_url', 'leadImageUrl',
      'og_image', 'ogImage', 'open_graph_image', 'openGraphImage',
      'top_image', 'topImage', 'picture', 'photo',
    ];

    for (const k of keys) {
      const v = obj[k];
      if (typeof v === 'string' && isLikelyImageUrl(v)) return String(v).trim();
      if (v && typeof v === 'object') {
        const vv = v.url || v.href || v.src;
        if (typeof vv === 'string' && isLikelyImageUrl(vv)) return String(vv).trim();
      }
    }

    // Nested common containers
    const nested = [obj.meta, obj.metadata, obj.open_graph, obj.openGraph, obj.og, obj.twitter, obj.images];
    for (const n of nested) {
      if (!n) continue;
      if (typeof n === 'string' && isLikelyImageUrl(n)) return String(n).trim();
      if (Array.isArray(n)) {
        for (const it of n) {
          if (typeof it === 'string' && isLikelyImageUrl(it)) return String(it).trim();
          if (it && typeof it === 'object') {
            const vv = it.url || it.href || it.src;
            if (typeof vv === 'string' && isLikelyImageUrl(vv)) return String(vv).trim();
          }
        }
      } else if (typeof n === 'object') {
        const vv = n.image || n.image_url || n.imageUrl || n.urlToImage || n.thumbnail || n.thumb || n.url;
        if (typeof vv === 'string' && isLikelyImageUrl(vv)) return String(vv).trim();
      }
    }

    // Heuristic scan: if a key looks image-ish and value is a URL string
    for (const [k, v] of Object.entries(obj)) {
      if (typeof v !== 'string') continue;
      if (!isLikelyImageUrl(v)) continue;
      const kk = String(k).toLowerCase();
      if (kk.includes('image') || kk.includes('thumb') || kk.includes('photo') || kk.includes('pic')) {
        return String(v).trim();
      }
    }

    return '';
  };

  const pickRaw = () => {
    // Use an image ONLY if it is tied to the event.
    // Priority:
    // 1) cluster-level fields
    // 2) any image fields from sources
    const direct = pickFromObject(item);
    if (direct) return direct;

    const sources = Array.isArray(item?.sources) ? item.sources : [];
    for (const s of sources) {
      const u = pickFromObject(s);
      if (u) return u;
    }
    return "";
  };

  const raw = pickRaw();
  if (!raw) return "";

  // Protocol-relative -> https
  let url = raw.startsWith("//") ? ("https:" + raw) : raw;

  // Data URIs should not go through proxy
  if (url.startsWith("data:")) return url;

  // Already proxied
  if (url.startsWith("/api/image?")) return url;

  // Size strategy (client-side): thumbs stay light, hero is larger.
  const width = kind === "thumb" ? 520 : (kind === "hero" ? 1800 : 1200);

  // Serve via our own origin to avoid hotlink/header quirks and to request larger variants.
  return `/api/image?u=${encodeURIComponent(url)}&w=${encodeURIComponent(String(width))}`;
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