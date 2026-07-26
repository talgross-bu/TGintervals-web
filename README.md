# TGintervals

TGintervals is a mobile interval timer optimized for iPhone. This repository
contains the current standalone web release.

## Use on iPhone

Open `index.html` from its hosted URL. For the app-style experience and
best-effort portrait preference, use **Share → Add to Home Screen**. iPhone
Portrait Orientation Lock is the guaranteed way to prevent landscape rotation.

The timer pauses when it leaves the foreground. When you return and tap Play,
it rebuilds its Web Audio context so transition cues can recover after another
audio app has been used.
