"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");
const vm = require("node:vm");

const projectRoot = path.resolve(__dirname, "..");
const applicationScript = fs.readFileSync(path.join(projectRoot, "app.js"), "utf8");

function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, reject, resolve };
}

function flushMicrotasks() {
  return new Promise((resolve) => setImmediate(resolve));
}

class FakeEventTarget {
  constructor() {
    this.listeners = new Map();
  }

  addEventListener(type, listener, options = {}) {
    const listeners = this.listeners.get(type) ?? [];
    listeners.push({ listener, once: options.once === true });
    this.listeners.set(type, listeners);
  }

  emit(type, event = {}) {
    const listeners = [...(this.listeners.get(type) ?? [])];
    for (const record of listeners) {
      if (record.once) {
        const current = this.listeners.get(type) ?? [];
        this.listeners.set(type, current.filter((item) => item !== record));
      }
      record.listener({ target: this, ...event });
    }
  }

  async dispatch(type, event = {}) {
    const listeners = [...(this.listeners.get(type) ?? [])];
    for (const record of listeners) {
      if (record.once) {
        const current = this.listeners.get(type) ?? [];
        this.listeners.set(type, current.filter((item) => item !== record));
      }
      await record.listener({ target: this, ...event });
    }
  }
}

class FakeElement extends FakeEventTarget {
  constructor() {
    super();
    this.checked = false;
    this.className = "";
    this.content = "";
    this.dataset = {};
    this.disabled = false;
    this.textContent = "";
    this.value = "";
    this.style = { setProperty() {} };
    this.classList = { add() {} };
  }

  append() {}
  close() {}
  replaceChildren() {}
  setAttribute(name, value) {
    this[name] = value;
  }
  showModal() {}
}

class FakeAudioNode {
  connect(nextNode) {
    return nextNode;
  }
  disconnect() {}
}

class FakeAudioSource extends FakeEventTarget {
  constructor(sourceStarts) {
    super();
    this.sourceStarts = sourceStarts;
    this.ended = false;
  }

  connect(nextNode) {
    return nextNode;
  }

  disconnect() {}

  start(...argumentsList) {
    this.sourceStarts.push({ buffer: this.buffer, argumentsList });
  }

  stop() {
    if (this.ended) return;
    this.ended = true;
    this.emit("ended");
  }
}

class FakeWakeLock extends FakeEventTarget {
  constructor(releaseGate = null) {
    super();
    this.releaseCalls = 0;
    this.releaseGate = releaseGate;
    this.released = false;
  }

  async release() {
    this.releaseCalls += 1;
    if (this.releaseGate !== null) await this.releaseGate.promise;
    if (this.released) return;
    this.released = true;
    this.emit("release");
  }
}

function createHarness(options = {}) {
  const elements = new Map();
  const elementFor = (selector) => {
    if (!elements.has(selector)) elements.set(selector, new FakeElement());
    return elements.get(selector);
  };

  const document = new FakeEventTarget();
  document.visibilityState = "visible";
  document.querySelector = elementFor;
  document.querySelectorAll = () => [];
  document.createElement = () => new FakeElement();

  const windowEvents = new FakeEventTarget();
  const intervalCallbacks = new Map();
  const audioContexts = [];
  const sourceStarts = [];
  const wakeLocks = [];
  let nextTimerIdentifier = 1;
  let currentTime = 0;
  let failingResumeCount = 0;

  class FakeAudioContext extends FakeEventTarget {
    constructor() {
      super();
      this.currentTime = 0;
      this.destination = new FakeAudioNode();
      this.sampleRate = 44_100;
      this.state = "suspended";
      audioContexts.push(this);
    }

    async close() {
      this.state = "closed";
      await this.dispatch("statechange");
    }

    createBuffer() {
      return {};
    }

    createBufferSource() {
      return new FakeAudioSource(sourceStarts);
    }

    createDynamicsCompressor() {
      return Object.assign(new FakeAudioNode(), {
        attack: {},
        knee: {},
        ratio: {},
        release: {},
        threshold: {}
      });
    }

    createGain() {
      return Object.assign(new FakeAudioNode(), { gain: {} });
    }

    async decodeAudioData(bytes) {
      if (options.decodeGate) return options.decodeGate.promise;
      // The fake fetch below tags each byte array with its URL so tests can tell cues apart.
      return { duration: 3, url: bytes.url };
    }

    async resume() {
      if (failingResumeCount > 0) {
        failingResumeCount -= 1;
        throw new Error("simulated iOS resume failure");
      }
      this.state = "running";
      await this.dispatch("statechange");
    }
  }

  const window = {
    AudioContext: FakeAudioContext,
    addEventListener: windowEvents.addEventListener.bind(windowEvents),
    clearInterval(identifier) {
      intervalCallbacks.delete(identifier);
    },
    location: { protocol: "https:" },
    matchMedia() {
      return { matches: false };
    },
    screen: {},
    setInterval(callback) {
      const identifier = nextTimerIdentifier++;
      intervalCallbacks.set(identifier, callback);
      return identifier;
    }
  };

  const storedPreferences = new Map();
  const appConsole = {
    ...console,
    error(message, ...details) {
      if (message === "Unable to prepare TGintervals audio") return;
      console.error(message, ...details);
    }
  };

  const wakeRequest = options.wakeRequest ?? (async () => {
    const lock = new FakeWakeLock();
    wakeLocks.push(lock);
    return lock;
  });

  const navigator = {
    standalone: false,
    wakeLock: {
      async request() {
        const lock = await wakeRequest();
        if (!wakeLocks.includes(lock)) wakeLocks.push(lock);
        return lock;
      }
    }
  };

  const context = vm.createContext({
    console: appConsole,
    document,
    async fetch(url) {
      return { ok: true, arrayBuffer: async () => ({ url }) };
    },
    localStorage: {
      getItem(key) {
        return storedPreferences.get(key) ?? null;
      },
      setItem(key, value) {
        storedPreferences.set(key, String(value));
      }
    },
    navigator,
    performance: {
      now() {
        return currentTime;
      }
    },
    Promise,
    setImmediate,
    window
  });
  new vm.Script(applicationScript, { filename: "app.js" }).runInContext(context);

  return {
    audioContexts,
    document,
    elementFor,
    evaluate(source) {
      return vm.runInContext(source, context);
    },
    latestIntervalCallback() {
      return [...intervalCallbacks.values()].at(-1);
    },
    // Cue names in the order they were scheduled; the silent unlock buffer has no URL.
    scheduledCues() {
      return sourceStarts
        .filter((record) => record.buffer?.url)
        .map((record) => path.basename(record.buffer.url, ".mp3"));
    },
    setCurrentTime(value) {
      currentTime = value;
    },
    setResumeFailures(value) {
      failingResumeCount = value;
    },
    sourceStarts,
    wakeLocks,
    windowEvents
  };
}

test("recovers audio after podcast app switching and keeps failed recovery paused", async () => {
  const harness = createHarness();
  const startButton = harness.elementFor("#startButton");
  const pauseButton = harness.elementFor("#pauseButton");
  const audioStatus = harness.elementFor("#audioStatus");
  const announcer = harness.elementFor("#announcer");

  await startButton.dispatch("click");
  assert.equal(harness.audioContexts.length, 1);
  assert.equal(harness.audioContexts[0].state, "running");
  assert.equal(pauseButton.disabled, false);

  await pauseButton.dispatch("click");
  harness.document.visibilityState = "hidden";
  await harness.document.dispatch("visibilitychange");
  assert.equal(harness.audioContexts[0].state, "closed");
  assert.match(audioStatus.textContent, /reconnect/);

  harness.document.visibilityState = "visible";
  await startButton.dispatch("click");
  assert.equal(harness.audioContexts.length, 2);
  assert.equal(harness.audioContexts[1].state, "running");
  // A recovered context clears the status line rather than announcing itself.
  assert.equal(audioStatus.textContent, "");
  assert.equal(pauseButton.disabled, false);

  harness.document.visibilityState = "hidden";
  await harness.document.dispatch("visibilitychange");
  assert.equal(harness.audioContexts[1].state, "closed");
  assert.equal(pauseButton.disabled, true);
  assert.match(announcer.textContent, /left the foreground/);

  harness.document.visibilityState = "visible";
  harness.setResumeFailures(2);
  await startButton.dispatch("click");
  assert.equal(harness.audioContexts.length, 4);
  assert.equal(startButton.disabled, false);
  assert.equal(pauseButton.disabled, true);
  assert.match(audioStatus.textContent, /tap Play to retry/);

  await startButton.dispatch("click");
  assert.equal(harness.audioContexts.length, 4);
  assert.equal(harness.audioContexts[3].state, "running");
  assert.equal(pauseButton.disabled, false);

  const sourceCountBeforeSecondSuccessfulRecovery = harness.sourceStarts.length;
  harness.document.visibilityState = "hidden";
  await harness.document.dispatch("visibilitychange");
  assert.equal(harness.audioContexts[3].state, "closed");
  assert.equal(pauseButton.disabled, true);

  harness.document.visibilityState = "visible";
  await startButton.dispatch("click");
  assert.equal(harness.audioContexts.length, 5);
  assert.equal(harness.audioContexts[4].state, "running");
  assert.equal(pauseButton.disabled, false);
  assert.ok(harness.sourceStarts.length > sourceCountBeforeSecondSuccessfulRecovery);
});

test("cancels a pending audio start when the app leaves the foreground", async () => {
  const decodeGate = deferred();
  const harness = createHarness({ decodeGate });
  const startButton = harness.elementFor("#startButton");
  const pauseButton = harness.elementFor("#pauseButton");
  const audioStatus = harness.elementFor("#audioStatus");

  const starting = startButton.dispatch("click");
  await flushMicrotasks();
  assert.equal(harness.evaluate("isPreparing"), true);

  harness.document.visibilityState = "hidden";
  await harness.document.dispatch("visibilitychange");
  decodeGate.resolve({ duration: 3 });
  await starting;

  assert.equal(harness.evaluate("isPreparing"), false);
  assert.equal(harness.evaluate("deadline"), null);
  assert.equal(startButton.disabled, false);
  assert.equal(pauseButton.disabled, true);
  assert.match(audioStatus.textContent, /reconnect/);
});

test("releases a wake lock that resolves after the timer has already paused", async () => {
  const wakeRequestGate = deferred();
  const delayedLock = new FakeWakeLock();
  const harness = createHarness({
    wakeRequest: () => wakeRequestGate.promise
  });

  await harness.elementFor("#startButton").dispatch("click");
  await harness.elementFor("#pauseButton").dispatch("click");
  wakeRequestGate.resolve(delayedLock);
  await flushMicrotasks();

  assert.equal(delayedLock.releaseCalls, 1);
  assert.equal(delayedLock.released, true);
  assert.equal(harness.evaluate("wakeLock"), null);
});

test("an old wake-lock release event cannot clear a newer lock", async () => {
  const oldReleaseGate = deferred();
  const oldLock = new FakeWakeLock(oldReleaseGate);
  const newLock = new FakeWakeLock();
  const lockQueue = [oldLock, newLock];
  const harness = createHarness({
    wakeRequest: async () => lockQueue.shift()
  });

  await harness.elementFor("#startButton").dispatch("click");
  await flushMicrotasks();
  assert.equal(harness.evaluate("wakeLock"), oldLock);

  await harness.elementFor("#pauseButton").dispatch("click");
  await harness.elementFor("#startButton").dispatch("click");
  await flushMicrotasks();
  assert.equal(harness.evaluate("wakeLock"), newLock);

  oldReleaseGate.resolve();
  await flushMicrotasks();
  assert.equal(harness.evaluate("wakeLock"), newLock);
  assert.equal(newLock.released, false);
});

test("does not schedule stale countdown audio after a phase deadline", async () => {
  const harness = createHarness();
  await harness.elementFor("#startButton").dispatch("click");
  const startsBeforeDeadline = harness.sourceStarts.length;

  harness.setCurrentTime(6_000);
  harness.latestIntervalCallback()();

  assert.equal(harness.evaluate("phase"), "work");
  assert.equal(harness.sourceStarts.length, startsBeforeDeadline);
});

test("runs the full workout in order and plays each cue at its boundary", async () => {
  const harness = createHarness();
  const startButton = harness.elementFor("#startButton");
  const pauseButton = harness.elementFor("#pauseButton");
  const resetButton = harness.elementFor("#resetButton");
  const timeDisplay = harness.elementFor("#timeDisplay");
  const tick = (milliseconds) => {
    harness.setCurrentTime(milliseconds);
    harness.latestIntervalCallback()();
  };

  await startButton.dispatch("click");
  assert.equal(harness.evaluate("phase"), "setup");
  assert.equal(timeDisplay.textContent, "5");
  assert.deepEqual(harness.scheduledCues(), []);

  // The countdown clip lasts three seconds and is armed once it can end on the boundary.
  tick(2_000);
  assert.equal(timeDisplay.textContent, "3");
  assert.deepEqual(harness.scheduledCues(), ["countdown"]);

  tick(5_000);
  assert.equal(harness.evaluate("phase"), "work");
  assert.equal(harness.evaluate("currentRound"), 1);
  assert.equal(timeDisplay.textContent, "30");

  const expectedCues = ["countdown"];
  let workStart = 5_000;
  for (let round = 1; round <= 7; round += 1) {
    assert.equal(harness.evaluate("phase"), "work");
    assert.equal(harness.evaluate("currentRound"), round);
    assert.equal(pauseButton.disabled, false);

    tick(workStart + 30_000);
    if (round === 7) break;

    assert.equal(harness.evaluate("phase"), "rest");
    assert.equal(timeDisplay.textContent, "55");
    expectedCues.push("ding3");
    assert.deepEqual(harness.scheduledCues(), expectedCues);

    tick(workStart + 30_000 + 52_000);
    expectedCues.push("countdown");
    assert.deepEqual(harness.scheduledCues(), expectedCues);

    tick(workStart + 85_000);
    workStart += 85_000;
  }

  expectedCues.push("completion");
  assert.equal(harness.evaluate("phase"), "completed");
  assert.deepEqual(harness.scheduledCues(), expectedCues);
  assert.equal(timeDisplay.textContent, "0");
  assert.equal(startButton.disabled, true);
  assert.equal(pauseButton.disabled, true);
  assert.equal(resetButton.disabled, false);
  assert.equal(harness.latestIntervalCallback(), undefined);
});

test("describes workout progress in whole minutes without saying zero", () => {
  const harness = createHarness();
  const sentence = (elapsed, remaining) => harness.evaluate(`progressSentence(${elapsed}, ${remaining})`);

  assert.equal(sentence(0, 300), "Just started – about 5 minutes to go.");
  assert.equal(sentence(29, 300), "Just started – about 5 minutes to go.");
  assert.equal(sentence(30, 300), "About 1 minute done – about 5 minutes to go.");
  assert.equal(sentence(300, 29), "About 5 minutes done – less than a minute to go.");
  assert.equal(sentence(300, 90), "About 5 minutes done – about 2 minutes to go.");
});
