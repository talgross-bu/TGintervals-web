// TGintervals is a self-contained mobile interval timer. It uses Web Audio API
// buffers exclusively so its cues can mix with audio already playing on iOS.
// This file holds all of the timer, audio, and screen logic for index.html.

"use strict";

const configuration = Object.freeze({
  setupSeconds: 5,
  workSeconds: 30,
  restSeconds: 55,
  rounds: 7
});

// Cue audio lives in small MP3 files so index.html stays readable; the service
// worker caches them with the rest of the app shell.
const soundFiles = Object.freeze({
  countdown: "sounds/countdown.mp3",
  ding3: "sounds/ding3.mp3",
  completion: "sounds/completion.mp3"
});

const app = document.querySelector("#app");
const phaseLabel = document.querySelector("#phaseLabel");
const timeDisplay = document.querySelector("#timeDisplay");
const phaseDetail = document.querySelector("#phaseDetail");
const timeProgress = document.querySelector("#timeProgress");
const roundsElement = document.querySelector("#rounds");
const announcer = document.querySelector("#announcer");
const audioStatus = document.querySelector("#audioStatus");
const startButton = document.querySelector("#startButton");
const pauseButton = document.querySelector("#pauseButton");
const resetButton = document.querySelector("#resetButton");
const settingsButton = document.querySelector("#settingsButton");
const settingsDialog = document.querySelector("#settingsDialog");
const closeSettingsButton = document.querySelector("#closeSettingsButton");
const volumeSlider = document.querySelector("#volumeSlider");
const volumeValue = document.querySelector("#volumeValue");
const extraLoudToggle = document.querySelector("#extraLoudToggle");
const themeColor = document.querySelector('meta[name="theme-color"]');
let phase = "ready";
let currentRound = 1;
let displayedSeconds = configuration.setupSeconds;
let phaseDurationMilliseconds = 0;
let deadline = null;
let pausedMilliseconds = null;
let timerIdentifier = null;
let isPreparing = false;
let wakeLock = null;
let wakeLockGeneration = 0;
let startAttemptGeneration = 0;

let audioContext = null;
const decodedBuffers = new Map();
const activeSources = new Set();
let pendingCountdownSource = null;
let countdownArmed = false;
let cueVolume = Number(readPreference("cueVolume", "1"));
let extraLoudEnabled = readPreference("extraLoud", "false") === "true";

if (!Number.isFinite(cueVolume)) cueVolume = 1;
cueVolume = Math.min(Math.max(cueVolume, 0), 1);

function readPreference(key, fallback) {
  try {
    return localStorage.getItem(`TGintervals.${key}`) ?? fallback;
  } catch {
    return fallback;
  }
}

function writePreference(key, value) {
  try {
    localStorage.setItem(`TGintervals.${key}`, String(value));
  } catch {
    // Private browsing or local-file restrictions can make storage unavailable.
  }
}

function phaseSeconds() {
  if (phase === "setup") return configuration.setupSeconds;
  if (phase === "work") return configuration.workSeconds;
  if (phase === "rest") return configuration.restSeconds;
  return configuration.setupSeconds;
}

function isCounting() {
  return deadline !== null;
}

// The workout itself is every work round plus the rests between them; the
// five-second setup is warm-up and stays out of both figures.
function workoutTotalSeconds() {
  return configuration.rounds * configuration.workSeconds +
    (configuration.rounds - 1) * configuration.restSeconds;
}

function elapsedWorkoutSeconds() {
  const roundsFinished = currentRound - 1;
  const throughPreviousRounds = roundsFinished * (configuration.workSeconds + configuration.restSeconds);
  if (phase === "work") {
    return throughPreviousRounds + (configuration.workSeconds - displayedSeconds);
  }
  if (phase === "rest") {
    return throughPreviousRounds + configuration.workSeconds +
      (configuration.restSeconds - displayedSeconds);
  }
  return throughPreviousRounds;
}

function minutesPhrase(seconds) {
  const minutes = Math.round(seconds / 60);
  return `${minutes} ${minutes === 1 ? "minute" : "minutes"}`;
}

// Rounding to the nearest minute would otherwise read "about 0 minutes" at
// the two ends of the workout.
function progressSentence(elapsedSeconds, remainingSeconds) {
  const donePart = elapsedSeconds < 30 ? "Just started" : `About ${minutesPhrase(elapsedSeconds)} done`;
  const remainingPart = remainingSeconds < 30
    ? "less than a minute to go"
    : `about ${minutesPhrase(remainingSeconds)} to go`;
  return `${donePart} – ${remainingPart}.`;
}

function isPaused() {
  return pausedMilliseconds !== null;
}

function beginPhase(nextPhase, durationSeconds, boundary = performance.now()) {
  phase = nextPhase;
  phaseDurationMilliseconds = durationSeconds * 1000;
  deadline = boundary + phaseDurationMilliseconds;
  pausedMilliseconds = null;
  displayedSeconds = durationSeconds;
  countdownArmed = false;
  announcePhase();
  render();
}

function advancePhase(boundary) {
  // A work round opens with no cue of its own: the countdown was scheduled to finish here.
  if (phase === "setup") {
    currentRound = 1;
    beginPhase("work", configuration.workSeconds, boundary);
    return;
  }

  if (phase === "work" && currentRound < configuration.rounds) {
    beginPhase("rest", configuration.restSeconds, boundary);
    playBufferedSound("ding3");
    return;
  }

  if (phase === "rest") {
    currentRound += 1;
    beginPhase("work", configuration.workSeconds, boundary);
    return;
  }

  if (phase === "work") {
    phase = "completed";
    deadline = null;
    pausedMilliseconds = null;
    displayedSeconds = 0;
    stopTimerLoop();
    releaseWakeLock();
    announcePhase();
    render();
    const completionContext = audioContext;
    const completionSource = playBufferedSound("completion");
    if (completionSource === null) {
      invalidateAudioContext("Workout complete");
    } else {
      completionSource.addEventListener("ended", () => {
        if (phase === "completed" && audioContext === completionContext) {
          invalidateAudioContext("Workout complete");
        }
      }, { once: true });
    }
  }
}

function processTime() {
  if (deadline === null) return;
  const now = performance.now();

  if (now >= deadline) {
    const boundary = deadline;
    advancePhase(boundary);
    return;
  }

  if (phase === "setup" || phase === "rest") {
    armCountdown(deadline - now);
  }

  const nextSeconds = Math.max(1, Math.ceil((deadline - now) / 1000));
  if (nextSeconds !== displayedSeconds) {
    displayedSeconds = nextSeconds;
    render();
  } else {
    updateProgress();
  }
}

function startTimerLoop() {
  stopTimerLoop();
  timerIdentifier = window.setInterval(processTime, 50);
}

function stopTimerLoop() {
  if (timerIdentifier !== null) {
    window.clearInterval(timerIdentifier);
    timerIdentifier = null;
  }
}

async function handleStart() {
  if (isPreparing || isCounting() || phase === "completed") return;
  const isResumingPausedWorkout = isPaused();
  const attemptGeneration = ++startAttemptGeneration;
  isPreparing = true;
  render();
  requestPortraitOrientation();

  // Requested before the audio work below, which awaits an MP3 decode long enough to
  // leave the tap that triggered it behind.
  requestWakeLock();

  try {
    await initializeAudioFromUserGesture();
    await prepareWorkoutBuffers();
  } catch (error) {
    if (attemptGeneration !== startAttemptGeneration) return;
    console.error("Unable to prepare TGintervals audio", error);
    if (isResumingPausedWorkout) {
      isPreparing = false;
      releaseWakeLock();
      audioStatus.textContent = "Audio could not reconnect · tap Play to retry";
      render();
      return;
    }
    audioStatus.textContent = "Audio unavailable — timer will continue silently";
  }

  if (attemptGeneration !== startAttemptGeneration || document.visibilityState !== "visible") {
    if (attemptGeneration === startAttemptGeneration) {
      isPreparing = false;
      releaseWakeLock();
      render();
    }
    return;
  }

  if (isPaused()) {
    deadline = performance.now() + pausedMilliseconds;
    phaseDurationMilliseconds = phaseSeconds() * 1000;
    pausedMilliseconds = null;
  } else {
    currentRound = 1;
    beginPhase("setup", configuration.setupSeconds);
  }

  isPreparing = false;
  startTimerLoop();
  render();
}

function handlePause() {
  if (!isCounting()) return;
  pausedMilliseconds = Math.max(0, deadline - performance.now());
  deadline = null;
  stopTimerLoop();
  cancelPendingCountdown();
  releaseWakeLock();
  render();
}

function handleReset() {
  startAttemptGeneration += 1;
  phase = "ready";
  currentRound = 1;
  displayedSeconds = configuration.setupSeconds;
  phaseDurationMilliseconds = 0;
  deadline = null;
  pausedMilliseconds = null;
  isPreparing = false;
  stopTimerLoop();
  cancelPendingCountdown();
  invalidateAudioContext("Audio starts when you press Play");
  releaseWakeLock();
  announcer.textContent = "Timer reset";
  render();
}

function announcePhase() {
  if (phase === "setup") announcer.textContent = "Get ready. Five second countdown.";
  if (phase === "work") announcer.textContent = `Work. Round ${currentRound}.`;
  if (phase === "rest") announcer.textContent = `Rest. Round ${currentRound} complete.`;
  if (phase === "completed") announcer.textContent = "Workout complete.";
}

function render() {
  app.dataset.phase = phase;
  timeDisplay.textContent = String(displayedSeconds);

  if (phase === "ready") {
    phaseLabel.textContent = "Ready";
    phaseDetail.textContent = "7 rounds · 30s work · 55s rest";
    themeColor.content = "#101722";
  } else if (phase === "setup") {
    phaseLabel.textContent = "Set Up";
    phaseDetail.textContent = "Round 1 begins next";
    themeColor.content = "#5d4217";
  } else if (phase === "work") {
    phaseLabel.textContent = "Work";
    phaseDetail.textContent = `Round ${currentRound}`;
    themeColor.content = "#087542";
  } else if (phase === "rest") {
    phaseLabel.textContent = "Rest";
    phaseDetail.textContent = `Round ${currentRound} complete`;
    themeColor.content = "#b72d38";
  } else {
    phaseLabel.textContent = "Complete";
    phaseDetail.textContent = "7 rounds finished";
    themeColor.content = "#5943a0";
  }

  // Keep any iPhone safe-area or dynamic-viewport overflow the same color
  // as the app instead of exposing the root page's default background.
  document.documentElement?.style.setProperty("--app-surface", themeColor.content);

  if (phase === "work" || phase === "rest") {
    const elapsedSeconds = elapsedWorkoutSeconds();
    const remainingSeconds = workoutTotalSeconds() - elapsedSeconds;
    timeProgress.textContent = progressSentence(elapsedSeconds, remainingSeconds);
  } else {
    timeProgress.textContent = "";
  }

  const startActionLabel = isPaused() ? "Resume timer" : "Start timer";
  startButton.setAttribute("aria-label", isPreparing ? "Preparing audio" : startActionLabel);
  startButton.setAttribute("aria-busy", String(isPreparing));
  startButton.disabled = isPreparing || isCounting() || phase === "completed";
  pauseButton.disabled = !isCounting();
  resetButton.disabled = phase === "ready" && !isPaused();

  renderRounds();
  updateProgress();
}

function renderRounds() {
  roundsElement.replaceChildren();
  for (let round = 1; round <= configuration.rounds; round += 1) {
    const dot = document.createElement("span");
    dot.className = "round-dot";
    if (phase === "completed" || round < currentRound || (phase === "rest" && round === currentRound)) {
      dot.classList.add("is-complete");
    } else if (round === currentRound) {
      dot.classList.add("is-current");
    }
    roundsElement.append(dot);
  }
  roundsElement.setAttribute("aria-label", `Round ${currentRound} of ${configuration.rounds}`);
}

function updateProgress() {
  let progress = 0;
  if (phase === "completed") {
    progress = 1;
  } else if (deadline !== null && phaseDurationMilliseconds > 0) {
    progress = 1 - Math.max(0, deadline - performance.now()) / phaseDurationMilliseconds;
  } else if (pausedMilliseconds !== null && phaseDurationMilliseconds > 0) {
    progress = 1 - pausedMilliseconds / phaseDurationMilliseconds;
  }
  app.style.setProperty("--progress", String(Math.min(Math.max(progress, 0), 1)));
}

function invalidateAudioContext(statusMessage = null) {
  cancelPendingCountdown();
  stopActiveSounds();
  decodedBuffers.clear();

  const invalidatedContext = audioContext;
  audioContext = null;
  if (invalidatedContext !== null && invalidatedContext.state !== "closed") {
    invalidatedContext.close().catch((error) => {
      console.debug("Unable to close the interrupted audio context", error);
    });
  }

  if (statusMessage !== null) audioStatus.textContent = statusMessage;
}

function createAudioContext(AudioContextConstructor) {
  const context = new AudioContextConstructor({ latencyHint: "interactive" });
  audioContext = context;
  context.addEventListener("statechange", () => {
    // A context closed during background recovery must not affect its replacement.
    if (context !== audioContext) return;
    if (context.state === "running") {
      audioStatus.textContent = "";
    } else if (isCounting()) {
      handlePause();
      announcer.textContent = "Timer paused because iOS interrupted audio.";
      invalidateAudioContext("Audio interrupted by iOS · tap Play to reconnect");
    }
  });
  return context;
}

async function initializeAudioFromUserGesture() {
  const AudioContextConstructor = window.AudioContext || window.webkitAudioContext;
  if (!AudioContextConstructor) throw new Error("Web Audio is not supported in this browser.");

  let context = audioContext;
  if (context === null) context = createAudioContext(AudioContextConstructor);

  if (context.state !== "running") {
    try {
      await context.resume();
    } catch {
      // An interrupted iOS context may reject resume; replace it below.
    }
  }

  // iOS exposes a non-standard interrupted state and can refuse to revive it.
  // Replacing it while the Play tap still provides user activation is more reliable.
  if (context.state !== "running") {
    invalidateAudioContext();
    context = createAudioContext(AudioContextConstructor);
    if (context.state !== "running") await context.resume();
  }
  if (context !== audioContext || context.state !== "running") {
    throw new Error(`Web Audio did not enter the running state (${context.state}).`);
  }

  const unlockBuffer = context.createBuffer(1, 1, context.sampleRate);
  const unlockSource = context.createBufferSource();
  unlockSource.buffer = unlockBuffer;
  unlockSource.connect(context.destination);
  unlockSource.start(0);
  audioStatus.textContent = "";
}

async function prepareWorkoutBuffers() {
  await Promise.all([
    loadSoundBuffer("countdown"),
    loadSoundBuffer("ding3"),
    loadSoundBuffer("completion")
  ]);
}

async function loadSoundBuffer(soundIdentifier) {
  if (decodedBuffers.has(soundIdentifier)) return decodedBuffers.get(soundIdentifier);
  if (audioContext === null) throw new Error("Audio must be initialized by a user gesture first.");
  const decodingContext = audioContext;

  const response = await fetch(soundFiles[soundIdentifier]);
  if (!response.ok) {
    throw new Error(`Unable to load ${soundFiles[soundIdentifier]} (HTTP ${response.status}).`);
  }
  const bytes = await response.arrayBuffer();
  const buffer = await decodingContext.decodeAudioData(bytes);
  if (decodingContext !== audioContext) {
    throw new Error("Audio decoding was cancelled because the context changed.");
  }
  decodedBuffers.set(soundIdentifier, buffer);
  return buffer;
}

function playBufferedSound(soundIdentifier, startTime = 0, offsetSeconds = 0) {
  if (audioContext === null || audioContext.state !== "running") {
    audioStatus.textContent = "Audio paused by iOS · tap Pause, then Play";
    return null;
  }
  const buffer = decodedBuffers.get(soundIdentifier);
  if (!buffer) return null;

  const source = audioContext.createBufferSource();
  const gain = audioContext.createGain();
  const compressor = audioContext.createDynamicsCompressor();
  source.buffer = buffer;
  gain.gain.value = cueVolume * 1.45 * (extraLoudEnabled ? 2 : 1);
  compressor.threshold.value = -12;
  compressor.knee.value = 18;
  compressor.ratio.value = 8;
  compressor.attack.value = 0.003;
  compressor.release.value = 0.24;
  source.connect(gain).connect(compressor).connect(audioContext.destination);
  activeSources.add(source);
  source.addEventListener("ended", () => {
    activeSources.delete(source);
    if (pendingCountdownSource === source) pendingCountdownSource = null;
    source.disconnect();
    gain.disconnect();
    compressor.disconnect();
  }, { once: true });
  source.start(startTime, offsetSeconds);
  return source;
}

function stopActiveSounds() {
  for (const source of activeSources) {
    try {
      source.stop();
    } catch {
      // A source that just ended cannot be stopped again.
    }
  }
  activeSources.clear();
}

// Schedules the countdown on the Web Audio clock so its last moment lands exactly on the
// work-round boundary. Arming a little early keeps the start time in the future, which is
// what lets Web Audio place it precisely instead of whenever the timer loop happens to tick.
function armCountdown(remainingMilliseconds) {
  if (countdownArmed) return;
  if (remainingMilliseconds <= 0) return;
  if (audioContext === null || audioContext.state !== "running") return;
  const buffer = decodedBuffers.get("countdown");
  if (!buffer) return;

  const leadSeconds = remainingMilliseconds / 1000 - buffer.duration;
  if (leadSeconds > 0.5) return;

  // A resume can leave less time than the clip needs; starting partway in still ends on time.
  const offsetSeconds = Math.max(0, -leadSeconds);
  const startTime = audioContext.currentTime + Math.max(0, leadSeconds);
  countdownArmed = true;
  pendingCountdownSource = playBufferedSound("countdown", startTime, offsetSeconds);
}

function cancelPendingCountdown() {
  countdownArmed = false;
  if (pendingCountdownSource === null) return;
  try {
    pendingCountdownSource.stop();
  } catch {
    // A source that already finished cannot be stopped again.
  }
  pendingCountdownSource = null;
}

function requestPortraitOrientation() {
  const isStandalone =
    window.matchMedia?.("(display-mode: standalone)").matches === true ||
    navigator.standalone === true;
  const orientation = window.screen?.orientation;
  if (!isStandalone || typeof orientation?.lock !== "function") return;
  try {
    Promise.resolve(orientation.lock("portrait-primary")).catch(() => {
      // The manifest remains the primary portrait preference when the API is unavailable.
    });
  } catch {
    // Some browsers expose the API but only allow it in specific display modes.
  }
}

async function requestWakeLock() {
  const generation = ++wakeLockGeneration;
  if (!("wakeLock" in navigator) || document.visibilityState !== "visible") return;
  try {
    const requestedLock = await navigator.wakeLock.request("screen");
    if (
      generation !== wakeLockGeneration ||
      document.visibilityState !== "visible" ||
      (!isPreparing && !isCounting())
    ) {
      try {
        await requestedLock.release();
      } catch {
        // The system may have released the stale request first.
      }
      return;
    }
    wakeLock = requestedLock;
    requestedLock.addEventListener("release", () => {
      if (wakeLock === requestedLock) wakeLock = null;
    }, { once: true });
  } catch {
    // Wake Lock is helpful but not required for timer correctness.
  }
}

async function releaseWakeLock() {
  wakeLockGeneration += 1;
  const lockToRelease = wakeLock;
  wakeLock = null;
  if (lockToRelease === null) return;
  try {
    await lockToRelease.release();
  } catch {
    // The system may already have released it.
  }
}

startButton.addEventListener("click", handleStart);
pauseButton.addEventListener("click", handlePause);
resetButton.addEventListener("click", handleReset);
settingsButton.addEventListener("click", () => settingsDialog.showModal());
closeSettingsButton.addEventListener("click", () => settingsDialog.close());
settingsDialog.addEventListener("click", (event) => {
  if (event.target === settingsDialog) settingsDialog.close();
});

volumeSlider.value = String(cueVolume);
volumeValue.textContent = `${Math.round(cueVolume * 100)}%`;
volumeSlider.setAttribute("aria-valuetext", volumeValue.textContent);
volumeSlider.addEventListener("input", () => {
  cueVolume = Number(volumeSlider.value);
  volumeValue.textContent = `${Math.round(cueVolume * 100)}%`;
  volumeSlider.setAttribute("aria-valuetext", volumeValue.textContent);
  writePreference("cueVolume", cueVolume);
});

extraLoudToggle.checked = extraLoudEnabled;
extraLoudToggle.addEventListener("change", () => {
  extraLoudEnabled = extraLoudToggle.checked;
  writePreference("extraLoud", extraLoudEnabled);
});

function pauseAndInvalidateAudioForBackground() {
  if (isPreparing) {
    startAttemptGeneration += 1;
    isPreparing = false;
    releaseWakeLock();
    render();
  }
  const wasCounting = isCounting();
  if (wasCounting) {
    handlePause();
    announcer.textContent = "Timer paused because TGintervals left the foreground.";
  }
  invalidateAudioContext("Audio will reconnect when you return and tap Play");
}

document.addEventListener("visibilitychange", () => {
  if (document.visibilityState === "hidden") {
    pauseAndInvalidateAudioForBackground();
  }
});

window.addEventListener("pagehide", pauseAndInvalidateAudioForBackground);

if ("serviceWorker" in navigator && window.location?.protocol.startsWith("http")) {
  window.addEventListener("load", () => {
    navigator.serviceWorker.register("./service-worker.js").catch((error) => {
      console.debug("Offline support could not be enabled", error);
    });
  });
}

requestPortraitOrientation();
render();
