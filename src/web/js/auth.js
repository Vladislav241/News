/*
 * CHECKNE Web App — auth.js
 * Auth modal + auth flows + session refresh
 *
 * Split from the former monolithic app.js to keep responsibilities separated.
 * Keep files loaded in order (see index.html).
 */

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
  const menuBadge = document.getElementById('menuPlanBadge');

  // Not logged in -> hide both
  if (!authState.authenticated) {
    if (pill) pill.style.display = 'none';
    if (menuBadge) menuBadge.style.display = 'none';
    return;
  }

  const plan = String((billingState && billingState.plan) ? billingState.plan : 'free').toLowerCase();

  // Header pill: only show for paid plans (keeps header clean on mobile)
  if (pill) {
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

  // Account menu badge: show for ALL plans (Free/Pro/Analyst) incl. mobile
  if (menuBadge) {
    menuBadge.classList.remove('isPro', 'isAnalyst');
    if (plan === 'pro') {
      menuBadge.textContent = 'PRO';
      menuBadge.classList.add('isPro');
    } else if (plan === 'analyst') {
      menuBadge.textContent = 'ANALYST';
      menuBadge.classList.add('isAnalyst');
    } else {
      menuBadge.textContent = 'FREE';
    }
    menuBadge.style.display = 'inline-flex';
  }
}

function _titleCaseWord(w){
  if(!w) return "";
  return w.charAt(0).toUpperCase() + w.slice(1).toLowerCase();
}
function displayNameFromUser(user){
  const full = (user?.full_name || user?.name || user?.display_name || "").trim();
  if(full) return full;

  const email = (user?.email || "").trim();
  if(!email) return "Account";
  let local = (email.split("@")[0] || "").trim();
  // remove digits
  local = local.replace(/\d+/g, "");
  const parts = local.split(/[._\-]+/).filter(Boolean).slice(0,2);
  if(parts.length === 0) return _titleCaseWord((email[0]||"A"));
  if(parts.length === 1) return _titleCaseWord(parts[0]);
  return parts.map(_titleCaseWord).join(" ");
}
function initialsFromName(name){
  const parts = (name||"").trim().split(/\s+/).filter(Boolean);
  if(parts.length===0) return "?";
  const a = parts[0][0] || "?";
  const b = (parts.length>1 ? parts[parts.length-1][0] : "");
  return (a + b).toUpperCase();
}

function updateAuthUI() {
  const btnAccount  = document.getElementById('btnAccount');
  const accountMenu = document.getElementById('accountMenu');
  const menuLogout  = document.getElementById('menuLogout');

  const avatar = document.getElementById('accountAvatar');

  const btnName =
    document.getElementById('accountBtnName') ||
    document.getElementById('accountName') ||
    document.getElementById('accountLabelText');

  const menuAvatar = document.getElementById('menuAvatar');
  const menuName   = document.getElementById('menuName');
  const menuEmail  = document.getElementById('menuEmail'); // ✅ добавили
  const menuPlan   = document.getElementById('menuPlan');

  const isAuthed = !!authState?.authenticated;
  // Mirror auth state into DOM for other isolated components (e.g., widgets).
  try{ document.documentElement.dataset.authed = isAuthed ? '1' : '0'; }catch{}

  const user = authState?.user || null;

  const name = isAuthed ? displayNameFromUser(user) : 'Login';
  const initials = isAuthed ? initialsFromName(name) : '';
  const email = isAuthed ? String(user?.email || '').trim() : '';

  if (btnAccount) {
    btnAccount.setAttribute('aria-label', name);
    btnAccount.classList.toggle('isAuth', isAuthed);
  }

  if (btnName) btnName.textContent = name;

  if (avatar) {
    if (isAuthed) {
      avatar.textContent = initials;
      avatar.style.display = 'grid';
    } else {
      avatar.textContent = '';
      avatar.style.display = 'none';
    }
  }

  // dropdown header
  if (menuName) menuName.textContent = isAuthed ? name : '—';
  if (menuAvatar) menuAvatar.textContent = isAuthed ? initials : '?';

  // ✅ email в dropdown
  if (menuEmail) {
    menuEmail.textContent = isAuthed ? email : '';
    menuEmail.style.display = (isAuthed && email) ? 'block' : 'none';
  }

  // plan label in dropdown
  if (menuPlan) {
    if (!isAuthed) {
      menuPlan.textContent = '';
    } else {
      const p = String(billingState?.plan || 'free').toLowerCase();
      menuPlan.textContent =
        (p === 'pro') ? 'Plus' :
        (p === 'analyst') ? 'Analyst' :
        'Free';
    }
  }

  if (!isAuthed) {
    if (accountMenu) accountMenu.classList.remove('open');
    if (menuLogout) menuLogout.style.display = 'none';
  } else {
    if (menuLogout) menuLogout.style.display = '';
  }

  updateAccountPlanPill();
  try{ updateProfileUI(); }catch{}
  try{ document.dispatchEvent(new CustomEvent('checkne:billingUpdated', { detail: { plan: (billingState?.plan||'free'), status: (billingState?.status||'active') } })); }catch{}
}




async function refreshAuthState() {
  const wasAuthed = !!authState?.authenticated;
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

  // Auth transition handling
  if (!authState.authenticated) {
    // Logged out -> clear any UI count/state (do NOT delete user-scoped storage).
    try {
      const trackingCountEl = document.getElementById('trackingCount');
      if (trackingCountEl) trackingCountEl.textContent = '0';
    } catch {}
    try { state.trackingItems = []; } catch {}
  } else {
    // Logged in -> reconcile favorites safely (server is truth; guest can migrate once).
    try { await pullFavoritesFromServerAndMerge(); } catch {}

    // Load account-scoped preferences (interests/country/language) so they persist per user.
    try { if (typeof window.checkneSyncPrefsFromServer === 'function') await window.checkneSyncPrefsFromServer(); } catch {}
  }

  // Billing state depends on auth
  await refreshBillingState();
}

async function refreshBillingState() {
  // If not logged in, treat as free.
  if (!authState.authenticated) {
    billingState = { plan: 'free', status: 'active', interval: 'monthly', current_period_end: null, cancel_at_period_end: false };
    updatePricingUI();
    try{ updateProfileUI(); }catch{}
    try{ document.dispatchEvent(new CustomEvent('checkne:billingUpdated', { detail: { plan: (billingState?.plan||'free'), status: (billingState?.status||'active') } })); }catch{}
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
      cancel_at_period_end: !!j?.cancel_at_period_end,
    };
  } catch {
    billingState = { plan: 'free', status: 'active', interval: 'monthly' };
  }
  updatePricingUI();
  updateAccountPlanPill();
  try{ updateProfileUI(); }catch{}
  try{ document.dispatchEvent(new CustomEvent('checkne:billingUpdated', { detail: { plan: (billingState?.plan||'free'), status: (billingState?.status||'active') } })); }catch{}
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