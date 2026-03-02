/* CHECKNE — notify.js
 * Replaces browser alert/confirm/prompt with in-app toasts + dialogs.
 * Exposes:
 *   - window.toast(message, type?, opts?)
 *   - window.uiConfirm(message, opts?) -> Promise<boolean>
 *   - window.openCopyModal(text, opts?)
 */
(function(){
  if (typeof window.toast === 'function' && typeof window.uiConfirm === 'function') return;

  const DUR_DEFAULT = 3200;

  function ensureRoot(){
    let root = document.getElementById('notifyRoot');
    if (root) return root;

    root = document.createElement('div');
    root.id = 'notifyRoot';
    root.innerHTML = `
      <div class="toastStack" aria-live="polite" aria-atomic="true"></div>

      <div class="uiModal" aria-hidden="true">
        <div class="uiModalBackdrop" data-ui-close="1"></div>
        <div class="uiModalSheet" role="dialog" aria-modal="true" aria-labelledby="uiModalTitle">
          <div class="uiModalHeader">
            <div id="uiModalTitle" class="uiModalTitle">Confirm</div>
            <button class="iconBtn" type="button" data-ui-close="1" aria-label="Close">✕</button>
          </div>
          <div class="uiModalBody" id="uiModalBody"></div>
          <div class="uiModalFooter" id="uiModalFooter"></div>
        </div>
      </div>
    `;
    document.body.appendChild(root);

    // Close handlers
    root.querySelectorAll('[data-ui-close]').forEach(el=>{
      el.addEventListener('click', ()=> closeModal(false));
    });
    window.addEventListener('keydown', (e)=>{
      const modal = root.querySelector('.uiModal');
      if (!modal || modal.getAttribute('aria-hidden') === 'true') return;
      if (e.key === 'Escape') { e.preventDefault(); closeModal(false); }
    });

    return root;
  }

  // -----------------
  // Toasts
  // -----------------
  function toast(msg, type='info', opts={}){
    try{
      const root = ensureRoot();
      const stack = root.querySelector('.toastStack');
      if (!stack) return;

      const el = document.createElement('div');
      el.className = `toastItem t-${String(type||'info')}`;
      el.setAttribute('role', 'status');
      el.innerHTML = `
        <div class="toastDot" aria-hidden="true"></div>
        <div class="toastMsg"></div>
        <button class="toastClose" type="button" aria-label="Dismiss">✕</button>
      `;
      el.querySelector('.toastMsg').textContent = String(msg ?? '');
      const closeBtn = el.querySelector('.toastClose');
      const duration = Number.isFinite(opts.duration) ? opts.duration : DUR_DEFAULT;

      let t=null;
      const remove = ()=>{
        if (!el.isConnected) return;
        el.classList.add('isLeaving');
        window.setTimeout(()=>{ try{ el.remove(); }catch{} }, 220);
      };

      closeBtn.addEventListener('click', ()=>{ if (t) clearTimeout(t); remove(); });

      stack.appendChild(el);
      // force reflow for animation
      void el.offsetHeight;
      el.classList.add('isOpen');

      if (duration > 0){
        t = window.setTimeout(remove, duration);
      }
    }catch(e){
      // Last resort: don't hard-crash the app
      console.error('toast failed', e);
    }
  }

  // -----------------
  // Modal (Confirm / Copy)
  // -----------------
  let modalResolve = null;

  function openModal({title, bodyEl, footerEl}){
    const root = ensureRoot();
    const modal = root.querySelector('.uiModal');
    if (!modal) return;

    const t = root.querySelector('#uiModalTitle');
    const b = root.querySelector('#uiModalBody');
    const f = root.querySelector('#uiModalFooter');

    if (t) t.textContent = title || 'Confirm';
    if (b){
      b.innerHTML = '';
      if (bodyEl) b.appendChild(bodyEl);
    }
    if (f){
      f.innerHTML = '';
      if (footerEl) f.appendChild(footerEl);
    }

    modal.classList.add('isOpen');
    modal.setAttribute('aria-hidden', 'false');

    // focus first button if any
    window.setTimeout(()=>{
      try{
        const focusEl = modal.querySelector('button.primary') || modal.querySelector('button');
        if (focusEl) focusEl.focus();
      }catch{}
    }, 10);
  }

  function closeModal(result){
    const root = document.getElementById('notifyRoot');
    const modal = root ? root.querySelector('.uiModal') : null;
    if (modal){
      modal.classList.remove('isOpen');
      modal.setAttribute('aria-hidden', 'true');
    }
    if (typeof modalResolve === 'function'){
      const r = modalResolve;
      modalResolve = null;
      try{ r(!!result); }catch{}
    }
  }

  function uiConfirm(message, opts={}){
    return new Promise((resolve)=>{
      modalResolve = resolve;

      const body = document.createElement('div');
      body.className = 'uiModalText';
      body.textContent = String(message ?? '');

      const footer = document.createElement('div');
      footer.className = 'uiModalActions';

      const cancel = document.createElement('button');
      cancel.type = 'button';
      cancel.className = 'miniBtn';
      cancel.textContent = opts.cancelText || 'Cancel';
      cancel.addEventListener('click', ()=> closeModal(false));

      const ok = document.createElement('button');
      ok.type = 'button';
      ok.className = 'btn primary';
      ok.textContent = opts.okText || 'OK';
      ok.addEventListener('click', ()=> closeModal(true));

      footer.appendChild(cancel);
      footer.appendChild(ok);

      openModal({ title: opts.title || 'Confirm', bodyEl: body, footerEl: footer });
    });
  }

  function openCopyModal(text, opts={}){
    const value = String(text ?? '');

    const body = document.createElement('div');
    body.className = 'uiCopyWrap';

    const hint = document.createElement('div');
    hint.className = 'uiModalText';
    hint.textContent = opts.hint || 'Copy this link:';

    const input = document.createElement('input');
    input.className = 'uiCopyInput';
    input.type = 'text';
    input.value = value;
    input.readOnly = true;

    body.appendChild(hint);
    body.appendChild(input);

    const footer = document.createElement('div');
    footer.className = 'uiModalActions';

    const close = document.createElement('button');
    close.type = 'button';
    close.className = 'miniBtn';
    close.textContent = 'Close';
    close.addEventListener('click', ()=> closeModal(false));

    const copy = document.createElement('button');
    copy.type = 'button';
    copy.className = 'btn primary';
    copy.textContent = 'Copy';
    copy.addEventListener('click', async ()=>{
      try{
        await navigator.clipboard.writeText(value);
        toast('Copied ✓', 'success');
      }catch{
        try{
          input.focus();
          input.select();
          document.execCommand('copy');
          toast('Copied ✓', 'success');
        }catch{
          toast('Select and copy manually', 'info');
        }
      }
    });

    footer.appendChild(close);
    footer.appendChild(copy);

    openModal({ title: opts.title || 'Copy', bodyEl: body, footerEl: footer });

    window.setTimeout(()=>{
      try{ input.focus(); input.select(); }catch{}
    }, 20);
  }

  window.toast = toast;
  window.uiConfirm = uiConfirm;
  window.openCopyModal = openCopyModal;
})();
