/*
 * CHECKNE Web App
 *
 * This file used to contain the full monolithic frontend.
 * It is kept as a backward-compatible loader (e.g. if some cached page still references /static/app.js).
 *
 * Source files live in /static/js/*.js and must be loaded in order.
 */

(function(){
  const files = [
    '/static/js/notify.js?v=2026-03-28-dialog-refresh',
    '/static/js/core.js?v=2026-03-28-dialog-refresh',
    '/static/js/state.js?v=2026-02-24',
    '/static/js/mode.js?v=2026-02-24',
    '/static/js/tracking.js?v=2026-02-24',
    '/static/js/auth.js?v=2026-02-24',
    '/static/js/pricing.js?v=2026-04-03-pricing-height-fix',
    '/static/js/carousel.js?v=2026-02-24',
    '/static/js/feed.js?v=2026-03-14-reco-open-fix',
    '/static/js/dropdowns.js?v=2026-02-24',
    '/static/js/bootstrap.js?v=2026-03-28-dialog-refresh'
  ];

  function load(i){
    if (i >= files.length) return;
    const s = document.createElement('script');
    s.src = files[i];
    // preserve order
    s.async = false;
    s.onload = () => load(i + 1);
    s.onerror = () => console.error('[CHECKNE] Failed to load', files[i]);
    document.head.appendChild(s);
  }

  load(0);
})();