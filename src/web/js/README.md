# Frontend structure (no-build, but professional)

This repo intentionally keeps a **no-build** setup (plain HTML + JS). To keep it maintainable,
`app.js` was split **by responsibility** into `/src/web/js/*.js`.

Load order is defined in `src/web/index.html`.

## Files
- `core.js` — config + helpers + deep links + share modal + i18n loader
- `state.js` — app state + prefs keys + auth/billing state
- `mode.js` — premium page transition + swipe navigation
- `tracking.js` — favorites + tracking delta persistence + trust-history chart
- `auth.js` — auth modal + login/reset flows + session refresh
- `pricing.js` — pricing/profile/info pages + billing query params
- `carousel.js` — top-stories carousel
- `feed.js` — fetch feed + incremental render + cards UI
- `dropdowns.js` — custom dropdown widgets
- `bootstrap.js` — account dropdown + UI bindings + `main()` startup

## Backwards compatibility
`/static/app.js` remains as a small loader for older cached pages.

## Next "top company" step (optional)
If you later want the full top-company workflow:
- migrate to ES modules + bundler (Vite)
- add ESLint/Prettier, type checks (TypeScript)
- add unit tests (Vitest) + e2e (Playwright)

But for a release **without a build pipeline**, this split is the closest professional approach.
