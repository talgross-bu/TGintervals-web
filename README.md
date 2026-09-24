# TGintervals

TGintervals is a mobile interval timer optimized for iPhone. This repository
contains the current standalone web release. It has no third-party runtime
dependencies.

## Files

| File | Role |
| --- | --- |
| `index.html` | Markup and meta tags only |
| `styles.css` | All styling |
| `app.js` | Timer, Web Audio, wake-lock, and screen logic |
| `sounds/` | The three MP3 cues (countdown, round-end ding, completion) |
| `icons/` | Home Screen and favicon artwork |
| `manifest.webmanifest` | Install metadata and portrait preference |
| `service-worker.js` | Offline cache of every file above |
| `_headers` | Security headers for hosts that honour the file (see below) |

All of these must ship together. The service worker lists each one in its
app shell, and `tests/release.test.js` checks that the list is complete.

## Use on iPhone

Open the hosted URL once while online. For the app-style experience, offline
launching, and the portrait preference, use **Share → Add to Home Screen**.
Portrait is requested by the web app; iPhone Portrait Orientation Lock remains
the guaranteed way to prevent rotation in a regular browser tab.

The timer pauses when it leaves the foreground. When you return and tap Play,
it rebuilds its Web Audio context so transition cues can recover after another
audio app has been used.

## Deploy on GitHub Pages

The site is served from the repository root. In the repository settings,
under **Pages**, choose the `main` branch and the `/ (root)` folder. GitHub
Pages serves over HTTPS, which the service worker requires.

GitHub Pages cannot send custom response headers, so it ignores `_headers`.
The Content Security Policy is therefore repeated as a `<meta>` tag in
`index.html`. Because no script or style is inline, that policy allows only
same-origin files. Keep the two copies of the policy in sync when editing
either one.

## Deploy on Netlify or Cloudflare Pages

Upload the repository folder with `index.html` at its root. These hosts read
`_headers` and send the security headers themselves, including
`frame-ancestors`, which a `<meta>` policy cannot express.

## Release a new version

Bump the version in `package.json` and the matching `CACHE_VERSION` in
`service-worker.js`. The release test fails if they differ. Installed copies
pick up the new cache on their next online launch.

## Test

Run:

```sh
npm test
```

The test suite uses only Node.js built-in modules. It runs the full workout
from setup to completion and checks which cue plays at each boundary, checks
the progress sentence, and covers the iOS audio lifecycle, wake-lock races,
overdue countdown handling, install assets, the service-worker shell, and the
offline fallback.
