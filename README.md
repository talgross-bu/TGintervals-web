# TGintervals

TGintervals is a mobile interval timer optimized for iPhone. This repository
contains the current standalone web release. It has no third-party runtime
dependencies.

## Use on iPhone

Open the hosted URL once while online. For the app-style experience, offline
launching, and the portrait preference, use **Share → Add to Home Screen**.
Portrait is requested by the web app; iPhone Portrait Orientation Lock remains
the guaranteed way to prevent rotation in a regular browser tab.

The timer pauses when it leaves the foreground. When you return and tap Play,
it rebuilds its Web Audio context so transition cues can recover after another
audio app has been used.

## Deploy on Netlify

Upload the repository folder with `index.html` at its root. Keep
`manifest.webmanifest`, `service-worker.js`, `_headers`, and the `icons` folder
alongside it. Uploading only `index.html` removes the Home Screen metadata,
portrait preference, icon, security headers, and offline support.

Netlify must serve the site over HTTPS, which its standard site URLs do.

## Test

Run:

```sh
npm test
```

The test suite uses only Node.js built-in modules. It checks the timer and iOS
audio lifecycle, wake-lock races, overdue countdown handling, install assets,
and offline fallback.
