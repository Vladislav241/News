/* CHECKNE share-promo campaign */
(function(){
  const API = '';
  let cfg = null;
  let status = null;
  let initialized = false;
  let lastDismissKey = null;
  let configInflight = null;
  let configLoadedAt = 0;

  function el(tag, cls, html){
    const n = document.createElement(tag);
    if (cls) n.className = cls;
    if (html != null) n.innerHTML = html;
    return n;
  }

  function qs(id){ return document.getElementById(id); }
  function isAuthed(){ try { return typeof authState !== 'undefined' && !!authState?.authenticated; } catch { return false; } }
  function currentPlan(){ try { return typeof billingState !== 'undefined' ? String((billingState && billingState.plan) || 'free').toLowerCase() : 'free'; } catch { return 'free'; } }
  function isEligiblePlan(){ const p = currentPlan(); return p !== 'pro' && p !== 'analyst'; }
  function dismissKey(){ return cfg ? `checkne_share_promo_dismissed:${cfg.campaign_id}` : null; }
  function isDismissed(){ const k = dismissKey(); return !!(k && localStorage.getItem(k) === '1'); }
  function setDismissed(){ const k = dismissKey(); if (k) localStorage.setItem(k, '1'); }

  async function fetchJson(url, opts){
    const r = await fetch(url, opts);
    let j = {};
    try { j = await r.json(); } catch {}
    if (!r.ok) {
      const detail = j?.detail;
      const msg = typeof detail === 'string' ? detail : (detail?.message || 'Request failed');
      throw new Error(msg);
    }
    return j;
  }

  async function loadConfig(opts){
    const force = !!(opts && opts.force);
    const now = Date.now();
    if (!force && cfg && (now - configLoadedAt) < 15000) {
      renderAll();
      return cfg;
    }
    if (!force && configInflight) {
      return await configInflight;
    }

    configInflight = (async () => {
      cfg = await fetchJson(`${API}/api/promo/share/config`);
      lastDismissKey = dismissKey();
      if (isAuthed()) {
        try { status = await fetchJson(`${API}/api/promo/share/status`); } catch { status = null; }
      } else {
        status = null;
      }
      configLoadedAt = Date.now();
      renderAll();
      return cfg;
    })();

    try {
      return await configInflight;
    } finally {
      configInflight = null;
    }
  }

  function promoCopy(){
    const progress = status?.progress || cfg?.progress || 0;
    const target = cfg?.target_shares || 10;
    return {
      title: cfg?.headline || 'Get 2 weeks of Pro for free',
      sub: cfg?.subline || `Share ${target} different news events on X or Threads and unlock Pro for 14 days.`,
      progressText: `${progress}/${target} verified shares`,
    };
  }

  function injectStyles(){
    if (qs('sharePromoStyles')) return;
    const s = el('style');
    s.id = 'sharePromoStyles';
    s.textContent = `
      .sharePromoBanner{position:fixed;left:50%;top:18px;transform:translateX(-50%);z-index:90;width:min(680px,calc(100vw - 24px));display:none}
      .sharePromoBanner.isVisible{display:block}
      .sharePromoCard{display:flex;align-items:center;gap:14px;background:rgba(255,255,255,.95);backdrop-filter:blur(12px);border:1px solid rgba(17,24,39,.12);border-radius:18px;padding:14px 16px;box-shadow:0 18px 40px rgba(0,0,0,.12)}
      .sharePromoAccent{width:40px;height:40px;border-radius:12px;background:#111;color:#fff;display:flex;align-items:center;justify-content:center;font-weight:700;font-size:18px;flex:0 0 auto}
      .sharePromoText{min-width:0;flex:1 1 auto}.sharePromoText strong{display:block;font-size:15px;line-height:1.25}.sharePromoText span{display:block;margin-top:4px;font-size:12px;color:rgba(0,0,0,.65);line-height:1.35}
      .sharePromoActions{display:flex;align-items:center;gap:8px;flex:0 0 auto}.sharePromoBtn,.sharePromoGhost,.sharePromoClose{border:0;border-radius:12px;cursor:pointer;font:inherit}
      .sharePromoBtn{background:#111;color:#fff;padding:10px 14px;font-weight:700}.sharePromoGhost{background:rgba(0,0,0,.05);padding:10px 12px;color:#111}.sharePromoClose{width:34px;height:34px;background:transparent;color:rgba(0,0,0,.55);font-size:20px}
      .sharePromoInline{margin:16px auto 0;max-width:760px;border:1px solid rgba(0,0,0,.12);background:linear-gradient(180deg,#fff,rgba(247,247,247,.98));border-radius:22px;padding:18px 20px;display:none}
      .sharePromoInline.isVisible{display:block}.sharePromoInlineHead{display:flex;align-items:center;justify-content:space-between;gap:12px;margin-bottom:8px}.sharePromoInlineTitle{font-size:18px;font-weight:700}.sharePromoInlineSub{color:rgba(0,0,0,.68);font-size:14px;line-height:1.5}
      .sharePromoInline .sharePromoBtn{padding:11px 16px}.sharePromoInline .sharePromoGhost{padding:11px 14px}
      .sharePromoModalBack{position:fixed;inset:0;background:rgba(10,12,16,.42);display:none;align-items:center;justify-content:center;z-index:120;padding:16px}.sharePromoModalBack.isOpen{display:flex}
      .sharePromoModal{width:min(720px,100%);background:#fff;border-radius:28px;border:1px solid rgba(0,0,0,.09);box-shadow:0 30px 80px rgba(0,0,0,.2);padding:24px 24px 20px}
      .sharePromoTop{display:flex;align-items:flex-start;justify-content:space-between;gap:12px}.sharePromoTop h3{margin:0;font-size:28px;line-height:1.05}.sharePromoTop p{margin:8px 0 0;color:rgba(0,0,0,.68);font-size:15px;line-height:1.55}.sharePromoModalClose{width:38px;height:38px;border:0;background:rgba(0,0,0,.05);border-radius:999px;cursor:pointer;font-size:20px}
      .sharePromoProgress{margin:18px 0 12px}.sharePromoBar{height:12px;border-radius:999px;background:rgba(0,0,0,.08);overflow:hidden}.sharePromoBar > i{display:block;height:100%;background:#111;border-radius:inherit;width:0%}.sharePromoMetrics{display:flex;justify-content:space-between;gap:12px;margin-top:8px;font-size:13px;color:rgba(0,0,0,.65)}
      .sharePromoGrid{display:grid;grid-template-columns:repeat(3,1fr);gap:12px;margin:18px 0}.sharePromoStep{border:1px solid rgba(0,0,0,.08);border-radius:18px;padding:14px;background:#fafafa}.sharePromoStep b{display:block;font-size:14px;margin-bottom:6px}.sharePromoStep span{display:block;color:rgba(0,0,0,.62);font-size:13px;line-height:1.45}
      .sharePromoBottom{display:flex;justify-content:space-between;align-items:center;gap:12px;flex-wrap:wrap}.sharePromoHint{font-size:12px;color:rgba(0,0,0,.55)}
      .sharePromoVerify{margin-top:16px;padding-top:16px;border-top:1px solid rgba(0,0,0,.08);display:none}.sharePromoVerify.isVisible{display:block}.sharePromoVerify h4{margin:0 0 8px;font-size:18px}.sharePromoVerify p{margin:0 0 12px;color:rgba(0,0,0,.64);font-size:14px;line-height:1.45}.sharePromoInputRow{display:flex;gap:10px;flex-wrap:wrap}.sharePromoInput{flex:1 1 360px;height:48px;border:1px solid rgba(0,0,0,.14);border-radius:14px;padding:0 14px;font:inherit}.sharePromoMsg{margin-top:10px;font-size:13px;color:rgba(0,0,0,.68)}
      .sharePromoShareHint{margin-top:14px;padding:12px 14px;border-radius:16px;background:rgba(0,0,0,.035);border:1px solid rgba(0,0,0,.08);display:none}.sharePromoShareHint.isVisible{display:block}.sharePromoShareHint strong{display:block;font-size:13px}.sharePromoShareHint span{display:block;margin-top:4px;font-size:12px;color:rgba(0,0,0,.64)}
      @media (max-width: 760px){.sharePromoBanner{top:12px;width:min(560px,calc(100vw - 20px))}.sharePromoCard{padding:14px;align-items:flex-start}.sharePromoActions{flex-wrap:wrap;justify-content:flex-end}.sharePromoGrid{grid-template-columns:1fr}.sharePromoTop h3{font-size:24px}.sharePromoModal{padding:20px 18px 18px}}
      @media (max-width: 640px){.sharePromoBanner{top:10px;width:calc(100vw - 16px)}.sharePromoCard{display:grid;grid-template-columns:56px minmax(0,1fr);gap:12px;padding:16px;border-radius:22px}.sharePromoAccent{width:56px;height:56px;border-radius:18px;font-size:24px;grid-row:1 / span 2}.sharePromoText{align-self:center}.sharePromoText strong{font-size:28px;line-height:1.04;letter-spacing:-.03em}.sharePromoText span{margin-top:8px;font-size:15px;line-height:1.4}.sharePromoActions{grid-column:1 / -1;display:grid;grid-template-columns:minmax(0,1fr) minmax(0,1fr) 44px;gap:10px;align-items:stretch}.sharePromoBtn,.sharePromoGhost{width:100%;min-height:48px;padding:0 14px;display:flex;align-items:center;justify-content:center;font-size:15px;text-align:center}.sharePromoClose{width:44px;height:44px;justify-self:end;border-radius:14px;background:rgba(0,0,0,.05)}.sharePromoModalBack{padding:12px}.sharePromoModal{max-height:min(88vh,900px);overflow:auto;border-radius:24px;padding:18px 16px 16px}.sharePromoTop{align-items:flex-start}.sharePromoTop h3{font-size:21px;line-height:1.08;padding-right:8px}.sharePromoTop p{font-size:14px;line-height:1.45}.sharePromoModalClose{width:42px;height:42px;flex:0 0 auto}.sharePromoGrid{gap:10px;margin:16px 0}.sharePromoStep{padding:12px 13px}.sharePromoBottom{align-items:stretch}.sharePromoBottom > div:last-child{width:100%}.sharePromoBottom > div:last-child .sharePromoBtn{width:100%;min-height:48px;display:flex;align-items:center;justify-content:center}.sharePromoInputRow{flex-direction:column}.sharePromoInput{flex:1 1 auto;width:100%;height:50px}.sharePromoInputRow .sharePromoBtn{width:100%;min-height:50px;display:flex;align-items:center;justify-content:center}}
      @media (max-width: 420px){.sharePromoCard{grid-template-columns:48px minmax(0,1fr);padding:14px}.sharePromoAccent{width:48px;height:48px;border-radius:15px;font-size:20px}.sharePromoText strong{font-size:24px}.sharePromoText span{font-size:14px}.sharePromoActions{grid-template-columns:1fr;gap:8px}.sharePromoClose{width:100%;height:42px;border-radius:12px}.sharePromoTop h3{font-size:19px}.sharePromoHint{font-size:11px;line-height:1.45}}
    `;
    document.head.appendChild(s);
  }

  function ensureDom(){
    injectStyles();
    if (!qs('sharePromoBanner')) {
      const wrap = el('div', 'sharePromoBanner');
      wrap.id = 'sharePromoBanner';
      wrap.innerHTML = `
        <div class="sharePromoCard">
          <div class="sharePromoAccent">PRO</div>
          <div class="sharePromoText"><strong></strong><span></span></div>
          <div class="sharePromoActions">
            <button class="sharePromoBtn" type="button">Get free Pro</button>
            <button class="sharePromoGhost" type="button">No, thanks</button>
            <button class="sharePromoClose" type="button" aria-label="Close">×</button>
          </div>
        </div>`;
      document.body.appendChild(wrap);
      wrap.querySelector('.sharePromoBtn').onclick = ()=> openPromoModal();
      wrap.querySelector('.sharePromoGhost').onclick = ()=>{ setDismissed(); updateBannerVisibility(); };
      wrap.querySelector('.sharePromoClose').onclick = ()=>{ setDismissed(); updateBannerVisibility(); };
    }
    if (!qs('sharePromoPricing')) {
      const hero = document.querySelector('#pricingSection .pricingHero');
      if (hero) {
        const box = el('div', 'sharePromoInline');
        box.id = 'sharePromoPricing';
        box.innerHTML = `
          <div class="sharePromoInlineHead"><div><div class="sharePromoInlineTitle"></div><div class="sharePromoInlineSub"></div></div><button class="sharePromoBtn" type="button">How it works</button></div>`;
        hero.appendChild(box);
        box.querySelector('.sharePromoBtn').onclick = ()=> openPromoModal();
      }
    }
    if (!qs('sharePromoModalBack')) {
      const back = el('div', 'sharePromoModalBack');
      back.id = 'sharePromoModalBack';
      back.innerHTML = `
        <div class="sharePromoModal" role="dialog" aria-modal="true" aria-labelledby="sharePromoTitle">
          <div class="sharePromoTop">
            <div><h3 id="sharePromoTitle"></h3><p id="sharePromoSub"></p></div>
            <button id="sharePromoModalClose" class="sharePromoModalClose" type="button" aria-label="Close">×</button>
          </div>
          <div class="sharePromoProgress"><div class="sharePromoBar"><i id="sharePromoBarFill"></i></div><div class="sharePromoMetrics"><span id="sharePromoMetricLeft"></span><span id="sharePromoMetricRight"></span></div></div>
          <div class="sharePromoGrid">
            <div class="sharePromoStep"><b>1. Open share</b><span>Use the regular Share button on any article card.</span></div>
            <div class="sharePromoStep"><b>2. Post publicly</b><span>Publish the CHECKNE link on X or Threads.</span></div>
            <div class="sharePromoStep"><b>3. Verify the post</b><span>Paste the public post link and we count it automatically.</span></div>
          </div>
          <div class="sharePromoBottom"><div class="sharePromoHint">Only public posts with the shared CHECKNE link count. Each story counts once.</div><div><button id="sharePromoModalOk" class="sharePromoBtn" type="button">Got it</button></div></div>
          <div id="sharePromoVerify" class="sharePromoVerify">
            <h4>Verify your post</h4>
            <p id="sharePromoVerifyText">Paste the public post URL from X or Threads.</p>
            <div class="sharePromoInputRow"><input id="sharePromoPostUrl" class="sharePromoInput" type="url" placeholder="https://x.com/... or https://www.threads.net/..." /><button id="sharePromoSubmitBtn" class="sharePromoBtn" type="button">Verify</button></div>
            <div id="sharePromoMsg" class="sharePromoMsg"></div>
          </div>
        </div>`;
      document.body.appendChild(back);
      const close = ()=> closePromoModal();
      qs('sharePromoModalClose').onclick = close;
      qs('sharePromoModalOk').onclick = close;
      back.addEventListener('click', (e)=>{ if (e.target === back) close(); });
      qs('sharePromoSubmitBtn').onclick = submitVerification;
    }
  }

  function renderAll(){
    ensureDom();
    renderTexts();
    updateBannerVisibility();
    updatePricingBanner();
    updateShareHint();
  }

  function renderTexts(){
    const copy = promoCopy();
    const banner = qs('sharePromoBanner');
    if (banner) {
      banner.querySelector('.sharePromoText strong').textContent = copy.title;
      banner.querySelector('.sharePromoText span').textContent = copy.sub;
    }
    const p = qs('sharePromoPricing');
    if (p) {
      p.querySelector('.sharePromoInlineTitle').textContent = copy.title;
      p.querySelector('.sharePromoInlineSub').textContent = `${copy.sub} ${copy.progressText}.`;
    }
    const title = qs('sharePromoTitle');
    if (title) title.textContent = copy.title;
    const sub = qs('sharePromoSub');
    if (sub) sub.textContent = copy.sub;
    const fill = qs('sharePromoBarFill');
    const left = qs('sharePromoMetricLeft');
    const right = qs('sharePromoMetricRight');
    const progress = Math.max(0, Number(status?.progress || cfg?.progress || 0));
    const target = Math.max(1, Number(cfg?.target_shares || 10));
    if (fill) fill.style.width = `${Math.min(100, Math.round(progress / target * 100))}%`;
    if (left) left.textContent = `${progress} verified`;
    if (right) right.textContent = `${Math.max(0, target - progress)} to go`;
  }

  function currentPage(){
    const pricing = qs('pricingSection');
    const feed = qs('feedView');
    if (pricing && pricing.style.display !== 'none') return 'pricing';
    if (feed && feed.style.display !== 'none') return 'feed';
    return 'other';
  }

  function updateBannerVisibility(){
    const banner = qs('sharePromoBanner');
    if (!banner) return;
    const should = !!(cfg?.enabled && currentPage() === 'feed' && isEligiblePlan() && !isDismissed() && !status?.reward_active_until);
    banner.classList.toggle('isVisible', should);
  }

  function updatePricingBanner(){
    const box = qs('sharePromoPricing');
    if (!box) return;
    const should = !!(cfg?.enabled && isEligiblePlan() && !status?.reward_active_until);
    box.classList.toggle('isVisible', should);
  }

  function updateShareHint(){
    const modal = qs('shareBackdrop');
    if (!modal) return;
    let hint = qs('sharePromoShareHint');
    const actions = modal.querySelector('.shareActions');
    if (!actions) return;
    if (!hint) {
      hint = el('div', 'sharePromoShareHint');
      hint.id = 'sharePromoShareHint';
      hint.innerHTML = `<strong>Count this share toward free Pro</strong><span>After posting, you’ll paste the public post link and we’ll verify it automatically.</span>`;
      actions.insertAdjacentElement('afterend', hint);
    }
    const should = !!(cfg?.enabled && isAuthed() && isEligiblePlan() && !status?.reward_active_until);
    hint.classList.toggle('isVisible', should);
  }

  function openPromoModal(opts){
    ensureDom();
    renderTexts();
    const back = qs('sharePromoModalBack');
    const verify = qs('sharePromoVerify');
    const msg = qs('sharePromoMsg');
    const input = qs('sharePromoPostUrl');
    if (msg) msg.textContent = '';
    if (input) input.value = '';
    if (verify) verify.classList.toggle('isVisible', !!opts?.verify);
    if (opts?.verifyText && qs('sharePromoVerifyText')) qs('sharePromoVerifyText').textContent = opts.verifyText;
    if (opts?.attempt) {
      back.dataset.attemptId = String(opts.attempt.id);
      back.dataset.platform = String(opts.attempt.platform);
    } else {
      delete back.dataset.attemptId;
      delete back.dataset.platform;
    }
    back.classList.add('isOpen');
  }
  function closePromoModal(){ const back = qs('sharePromoModalBack'); if (back) back.classList.remove('isOpen'); }

  async function submitVerification(){
    const back = qs('sharePromoModalBack');
    const msg = qs('sharePromoMsg');
    const btn = qs('sharePromoSubmitBtn');
    const input = qs('sharePromoPostUrl');
    const attemptId = Number(back?.dataset?.attemptId || 0);
    if (!attemptId || !input) return;
    if (msg) msg.textContent = 'Verifying…';
    if (btn) btn.disabled = true;
    try {
      const res = await fetchJson('/api/promo/share/submit', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ attempt_id: attemptId, post_url: input.value.trim() })
      });
      status = { ...(status || {}), progress: res.progress, reward_active_until: res.reward_active_until || status?.reward_active_until, reward_granted: !!res.reward_granted };
      renderAll();
      try { if (typeof refreshBillingState === 'function') await refreshBillingState(); } catch {}
      if (msg) {
        msg.textContent = res.reward_granted
          ? `Verified. Your free Pro access is now active.`
          : `Verified. Progress: ${res.progress}/${res.target}.`;
      }
    } catch (e) {
      if (msg) msg.textContent = e?.message || 'We could not verify this post yet.';
    } finally {
      if (btn) btn.disabled = false;
    }
  }

  window.__sharePromoBeforeOpen = async function(payload){
    try {
      if (!cfg?.enabled) return false;
      if (!isAuthed() || !isEligiblePlan()) return false;
      const started = await fetchJson('/api/promo/share/start', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ cluster_id: Number(payload?.item?.id || payload?.item?.cluster_id || 0), platform: payload.platform })
      });
      if (payload.platform === 'x') {
        const xIntent = `https://twitter.com/intent/tweet?url=${encodeURIComponent(started.share_url)}&text=${encodeURIComponent(started.share_text || 'Trust score')}`;
        window.open(xIntent, '_blank', 'noopener,noreferrer');
      } else {
        try { await navigator.clipboard.writeText(started.share_url); } catch {}
        window.open('https://www.threads.net/', '_blank', 'noopener,noreferrer');
      }
      try { if (typeof closeShareModal === 'function') closeShareModal(); } catch {}
      openPromoModal({
        verify: true,
        attempt: { id: started.attempt_id, platform: started.platform },
        verifyText: payload.platform === 'threads'
          ? 'Your CHECKNE link has been copied. Publish the post in Threads, then paste the public Threads post URL here.'
          : 'Publish the post on X, then paste the public X post URL here.'
      });
      return true;
    } catch (e) {
      console.warn('share promo start failed', e);
      return false;
    }
  };

  function installPageHooks(){
    if (window.__sharePromoHooksInstalled) return;
    window.__sharePromoHooksInstalled = true;
    const prev = window.__setMainPage;
    if (typeof prev === 'function') {
      window.__setMainPage = function(page){ const out = prev(page); setTimeout(renderAll, 0); return out; };
    }
    document.addEventListener('checkne:billingUpdated', ()=>{ loadConfig({ force:true }).catch(()=>{}); });
    document.addEventListener('click', ()=> setTimeout(updateShareHint, 0), true);
  }

  async function init(){
    if (initialized) return;
    initialized = true;
    ensureDom();
    installPageHooks();
    try { await loadConfig(); } catch (e) { console.warn('share promo disabled/unavailable', e); }
  }

  document.addEventListener('DOMContentLoaded', init);
})();