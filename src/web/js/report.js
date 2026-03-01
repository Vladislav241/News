/*
 * CHECKNE Web App — report.js
 * Report button + modal + POST /api/report to Discord webhook.
 */

(function(){
  const API_BASE = "";

  const REASONS = [
    { v: 'Inaccuracy / wrong facts', k: 'report.reason_inaccuracy' },
    { v: 'Misleading title', k: 'report.reason_misleading' },
    { v: 'Spam / ads', k: 'report.reason_spam' },
    { v: 'Offensive / harmful content', k: 'report.reason_offensive' },
    { v: 'Duplicate / already covered', k: 'report.reason_duplicate' },
    { v: 'Broken source link', k: 'report.reason_broken' },
    { v: 'Other', k: 'report.reason_other' },
  ];

  function qs(id){ return document.getElementById(id); }

  function ensureToast(){
    if (typeof window.toast === 'function') return;
    const el = document.createElement('div');
    el.id = 'toast';
    el.style.cssText = 'position:fixed;left:50%;bottom:28px;transform:translateX(-50%);background:rgba(17,17,19,.92);color:#fff;padding:10px 14px;border-radius:999px;font-size:14px;font-weight:600;box-shadow:0 14px 40px rgba(0,0,0,.25);z-index:10000;opacity:0;pointer-events:none;transition:opacity .18s ease, transform .18s ease;';
    document.body.appendChild(el);
    window.toast = function(msg){
      try{
        el.textContent = String(msg||'');
        el.style.opacity = '1';
        el.style.transform = 'translateX(-50%) translateY(0)';
        clearTimeout(el._t);
        el._t = setTimeout(()=>{
          el.style.opacity = '0';
          el.style.transform = 'translateX(-50%) translateY(6px)';
        }, 1400);
      }catch{}
    };
  }

  function t(key, fallback){
    try{
      if (typeof window.t === 'function') return window.t(key, fallback);
    }catch{}
    return fallback;
  }

  function openReportModal(data){
    ensureToast();
    const backdrop = qs('reportBackdrop');
    if (!backdrop) return;

    const titleEl = qs('reportTitle');
    const idEl = qs('reportClusterId');
    const reasonEl = qs('reportReason');
    const msgEl = qs('reportMessage');
    const sendBtn = qs('reportSendBtn');

    if (titleEl) titleEl.textContent = data?.title || t('report.title','Report this news');
    if (idEl) idEl.textContent = String(data?.cluster_id || '');
    if (msgEl) msgEl.value = '';

    // Populate reasons once
    if (reasonEl && !reasonEl.dataset.ready) {
      reasonEl.innerHTML = '';
      for (const r of REASONS) {
        const opt = document.createElement('option');
        opt.value = r.v;
        opt.textContent = t(r.k, r.v);
        reasonEl.appendChild(opt);
      }
      reasonEl.dataset.ready = '1';
    }
    if (reasonEl) reasonEl.value = REASONS[0].v;

    backdrop.classList.add('isOpen');
    backdrop.setAttribute('aria-hidden','false');
    try { document.body.style.overflow = 'hidden'; } catch {}

    let busy = false;
    async function send(){
      if (busy) return;
      busy = true;
      if (sendBtn) { sendBtn.disabled = true; sendBtn.textContent = t('report.sending','Sending…'); }
      try{
        const reason = reasonEl ? String(reasonEl.value||'') : '';
        const message = msgEl ? String(msgEl.value||'').trim() : '';
        const payload = {
          cluster_id: Number(data?.cluster_id || 0),
          title: data?.title || '',
          page_url: window.location.href,
          reason,
          message,
        };
        const r = await fetch(`${API_BASE}/api/report`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(payload),
        });
        if (!r.ok) {
          let detail = 'Could not send report.';
          try { const j = await r.json(); if (j?.detail) detail = String(j.detail); } catch {}
          throw new Error(detail);
        }
        try { window.toast('✅ Report sent.'); } catch {}
        closeReportModal();
      }catch(e){
        try { window.toast('❌ ' + (e?.message || 'Could not send report.')); } catch {}
      }finally{
        busy = false;
        if (sendBtn) { sendBtn.disabled = false; sendBtn.textContent = t('report.send','Send report'); }
      }
    }

    if (sendBtn) sendBtn.onclick = (e)=>{ e.preventDefault(); send(); };
    setTimeout(()=>{ try{ reasonEl && reasonEl.focus(); }catch{} }, 50);
  }

  function closeReportModal(){
    const backdrop = qs('reportBackdrop');
    if (!backdrop) return;
    backdrop.classList.remove('isOpen');
    backdrop.setAttribute('aria-hidden','true');
    try { document.body.style.overflow = ''; } catch {}
  }

  // Close handlers
  function wireClose(){
    const backdrop = qs('reportBackdrop');
    if (!backdrop) return;
    backdrop.addEventListener('click', (e)=>{
      const tEl = e.target;
      if (!tEl) return;
      if (tEl === backdrop || (tEl.closest && tEl.closest('[data-report-close="1"]'))) closeReportModal();
    });
    window.addEventListener('keydown', (e)=>{
      if (e.key === 'Escape') closeReportModal();
    });
  }

  // Public API used by feed.js
  window.openReportModal = openReportModal;
  window.closeReportModal = closeReportModal;

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', wireClose);
  } else {
    wireClose();
  }
})();
