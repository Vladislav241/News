/* CHECKNE — notify.js
 * Minimal, premium in-app dialogs + toasts.
 * Replaces noisy browser popups with a compact branded layer.
 */
(function(){
  if (window.__checkneNotifyReady) return;
  window.__checkneNotifyReady = true;

  const DUR_DEFAULT = 2800;
  let modalResolver = null;
  let previousActive = null;

  function ensureRoot(){
    let root = document.getElementById('notifyRoot');
    if (root) return root;

    root = document.createElement('div');
    root.id = 'notifyRoot';
    root.innerHTML = `
      <div class="cnToastStack" aria-live="polite" aria-atomic="true"></div>
      <div class="cnDialog" aria-hidden="true">
        <div class="cnDialog__backdrop" data-ui-close="1"></div>
        <div class="cnDialog__sheet" role="dialog" aria-modal="true" aria-labelledby="cnDialogTitle" aria-describedby="cnDialogBody">
          <button class="cnDialog__close" type="button" data-ui-close="1" aria-label="Close">
            <span aria-hidden="true">✕</span>
          </button>
          <div class="cnDialog__meta" id="cnDialogMeta"></div>
          <div class="cnDialog__title" id="cnDialogTitle"></div>
          <div class="cnDialog__body" id="cnDialogBody"></div>
          <div class="cnDialog__actions" id="cnDialogActions"></div>
        </div>
      </div>
    `;
    document.body.appendChild(root);

    root.querySelectorAll('[data-ui-close]').forEach((el)=>{
      el.addEventListener('click', ()=> closeModal(false));
    });

    window.addEventListener('keydown', (e)=>{
      const modal = document.querySelector('.cnDialog');
      if (!modal || modal.getAttribute('aria-hidden') === 'true') return;
      if (e.key === 'Escape') {
        e.preventDefault();
        closeModal(false);
      }
    });

    return root;
  }

  function lockBody(){
    document.body.classList.add('cnDialogOpen');
  }

  function unlockBody(){
    document.body.classList.remove('cnDialogOpen');
  }

  function toast(message, type='info', opts={}){
    try {
      const root = ensureRoot();
      const stack = root.querySelector('.cnToastStack');
      if (!stack) return;

      const item = document.createElement('div');
      item.className = `cnToast cnToast--${String(type || 'info')}`;
      item.setAttribute('role', 'status');
      item.innerHTML = `
        <div class="cnToast__bar" aria-hidden="true"></div>
        <div class="cnToast__text"></div>
        <button class="cnToast__close" type="button" aria-label="Dismiss">✕</button>
      `;
      item.querySelector('.cnToast__text').textContent = String(message ?? '');

      const remove = ()=>{
        if (!item.isConnected) return;
        item.classList.add('is-leaving');
        window.setTimeout(()=>{ try{ item.remove(); }catch{} }, 180);
      };

      item.querySelector('.cnToast__close')?.addEventListener('click', remove);
      stack.appendChild(item);
      requestAnimationFrame(()=> item.classList.add('is-open'));

      const duration = Number.isFinite(opts.duration) ? opts.duration : DUR_DEFAULT;
      if (duration > 0) window.setTimeout(remove, duration);
    } catch (err) {
      console.error('toast failed', err);
    }
  }

  function openModal({ title, message, meta, actions, tone='default', lock = true }){
    const root = ensureRoot();
    const modal = root.querySelector('.cnDialog');
    const sheet = root.querySelector('.cnDialog__sheet');
    const metaEl = root.querySelector('#cnDialogMeta');
    const titleEl = root.querySelector('#cnDialogTitle');
    const bodyEl = root.querySelector('#cnDialogBody');
    const actionsEl = root.querySelector('#cnDialogActions');
    if (!modal || !sheet || !titleEl || !bodyEl || !actionsEl || !metaEl) return;

    previousActive = document.activeElement instanceof HTMLElement ? document.activeElement : null;

    sheet.dataset.tone = tone;
    metaEl.textContent = meta || '';
    metaEl.style.display = meta ? '' : 'none';
    titleEl.textContent = title || '';

    bodyEl.innerHTML = '';
    if (message instanceof HTMLElement) bodyEl.appendChild(message);
    else bodyEl.textContent = String(message ?? '');

    actionsEl.innerHTML = '';
    (actions || []).forEach((action)=>{
      const btn = document.createElement('button');
      btn.type = 'button';
      btn.className = `cnBtn ${action.variant === 'primary' ? 'cnBtn--primary' : 'cnBtn--secondary'}`;
      btn.textContent = action.label || 'OK';
      btn.addEventListener('click', ()=>{
        try { if (typeof action.onClick === 'function') action.onClick(); } catch (err) { console.error(err); }
      });
      actionsEl.appendChild(btn);
    });

    modal.classList.add('is-open');
    modal.setAttribute('aria-hidden', 'false');
    if (lock) lockBody();

    window.setTimeout(()=>{
      const focusEl = actionsEl.querySelector('.cnBtn--primary') || actionsEl.querySelector('.cnBtn') || root.querySelector('.cnDialog__close');
      try { focusEl?.focus(); } catch {}
    }, 10);
  }

  function closeModal(result){
    const root = document.getElementById('notifyRoot');
    const modal = root?.querySelector('.cnDialog');
    if (modal){
      modal.classList.remove('is-open');
      modal.setAttribute('aria-hidden', 'true');
    }
    unlockBody();
    if (previousActive) {
      try { previousActive.focus(); } catch {}
      previousActive = null;
    }
    if (typeof modalResolver === 'function'){
      const resolve = modalResolver;
      modalResolver = null;
      try { resolve(result); } catch {}
    }
  }

  function uiAlert(message, opts = {}){
    return new Promise((resolve)=>{
      modalResolver = ()=> resolve();
      openModal({
        title: opts.title || 'Notice',
        message,
        meta: opts.meta || '',
        tone: opts.tone || 'default',
        actions: [
          {
            label: opts.okText || 'OK',
            variant: 'primary',
            onClick: ()=> closeModal(true),
          }
        ]
      });
    });
  }

  function uiConfirm(message, opts = {}){
    return new Promise((resolve)=>{
      modalResolver = (value)=> resolve(!!value);
      openModal({
        title: opts.title || 'Confirm',
        message,
        meta: opts.meta || '',
        tone: opts.tone || 'default',
        actions: [
          {
            label: opts.cancelText || 'Cancel',
            variant: 'secondary',
            onClick: ()=> closeModal(false),
          },
          {
            label: opts.okText || 'Continue',
            variant: 'primary',
            onClick: ()=> closeModal(true),
          }
        ]
      });
    });
  }

  function openCopyModal(text, opts = {}){
    return new Promise((resolve)=>{
      const value = String(text ?? '');
      const wrap = document.createElement('div');
      wrap.className = 'cnCopy';

      if (opts.hint) {
        const hint = document.createElement('div');
        hint.className = 'cnCopy__hint';
        hint.textContent = opts.hint;
        wrap.appendChild(hint);
      }

      const input = document.createElement('input');
      input.className = 'cnCopy__input';
      input.type = 'text';
      input.readOnly = true;
      input.value = value;
      wrap.appendChild(input);

      modalResolver = ()=> resolve();
      openModal({
        title: opts.title || 'Copy link',
        message: wrap,
        meta: opts.meta || '',
        actions: [
          {
            label: opts.closeText || 'Close',
            variant: 'secondary',
            onClick: ()=> closeModal(false),
          },
          {
            label: opts.copyText || 'Copy',
            variant: 'primary',
            onClick: async ()=>{
              try {
                await navigator.clipboard.writeText(value);
                toast(opts.copiedText || 'Copied', 'success');
                closeModal(true);
              } catch {
                try {
                  input.focus();
                  input.select();
                  document.execCommand('copy');
                  toast(opts.copiedText || 'Copied', 'success');
                  closeModal(true);
                } catch {
                  toast(opts.manualText || 'Select and copy manually', 'info');
                }
              }
            }
          }
        ]
      });

      window.setTimeout(()=>{
        try { input.focus(); input.select(); } catch {}
      }, 20);
    });
  }

  window.toast = toast;
  window.uiAlert = uiAlert;
  window.uiConfirm = uiConfirm;
  window.openCopyModal = openCopyModal;
})();
