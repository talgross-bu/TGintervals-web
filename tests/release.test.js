"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");
const vm = require("node:vm");

const projectRoot = path.resolve(__dirname, "..");
const read = (relativePath) => fs.readFileSync(path.join(projectRoot, relativePath));

test("release manifest and install assets are complete", () => {
  const manifest = JSON.parse(read("manifest.webmanifest"));
  assert.equal(manifest.id, "./");
  assert.equal(manifest.name, "TGintervals");
  assert.equal(manifest.start_url, "./");
  assert.equal(manifest.scope, "./");
  assert.equal(manifest.display, "standalone");
  assert.equal(manifest.orientation, "portrait-primary");
  assert.equal(manifest.icons.length, 2);

  for (const icon of manifest.icons) {
    const bytes = read(icon.src);
    assert.equal(bytes.subarray(1, 4).toString(), "PNG");
    const [expectedWidth, expectedHeight] = icon.sizes.split("x").map(Number);
    assert.equal(bytes.readUInt32BE(16), expectedWidth);
    assert.equal(bytes.readUInt32BE(20), expectedHeight);
  }

  const appleTouchIcon = read("icons/tgintervals-180.png");
  assert.equal(appleTouchIcon.readUInt32BE(16), 180);
  assert.equal(appleTouchIcon.readUInt32BE(20), 180);
});

test("published scripts parse and HTML references the complete runtime bundle", () => {
  const html = read("index.html").toString();
  new vm.Script(read("app.js").toString(), { filename: "app.js" });
  new vm.Script(read("service-worker.js").toString(), { filename: "service-worker.js" });

  // Everything runs from separate files, so the policy can refuse inline code.
  assert.match(html, /<link rel="stylesheet" href="styles\.css">/);
  assert.match(html, /<script src="app\.js" defer><\/script>/);
  assert.doesNotMatch(html, /<script>/);
  assert.doesNotMatch(html, /<style>/);
  assert.doesNotMatch(html, /unsafe-inline/);
  assert.doesNotMatch(html, / style="/);

  assert.match(html, /manifest\.webmanifest/);
  assert.match(html, /icons\/tgintervals-180\.png/);
  assert.match(html, /icons\/tgintervals-192\.png/);
  assert.doesNotMatch(html, /embeddedIconURL/);
  assert.doesNotMatch(html, /TGintervals V4/);

  const appScript = read("app.js").toString();
  assert.match(appScript, /serviceWorker\.register\("\.\/service-worker\.js"\)/);
  assert.doesNotMatch(appScript, /atob\(/);

  const styles = read("styles.css").toString();
  assert.match(styles, /min-height: 100dvh/);
  assert.match(styles, /--app-surface/);

  const headers = read("_headers").toString();
  assert.match(headers, /Content-Security-Policy:/);
  assert.doesNotMatch(headers, /unsafe-inline/);
  assert.match(headers, /X-Content-Type-Options: nosniff/);
  assert.match(headers, /\/service-worker\.js[\s\S]*Cache-Control: no-cache/);

  const packageMetadata = JSON.parse(read("package.json"));
  const serviceWorker = read("service-worker.js").toString();
  assert.match(serviceWorker, new RegExp(`tgintervals-${packageMetadata.version.replaceAll(".", "\\.")}`));
});

test("service worker shell lists every file the app loads and the cues are MP3s", () => {
  const serviceWorker = read("service-worker.js").toString();
  for (const asset of ["./styles.css", "./app.js", "./manifest.webmanifest"]) {
    assert.match(serviceWorker, new RegExp(`"${asset.replaceAll(".", "\\.")}"`));
  }

  const appScript = read("app.js").toString();
  const soundPaths = [...appScript.matchAll(/"(sounds\/[a-z0-9]+\.mp3)"/g)].map((match) => match[1]);
  assert.deepEqual(soundPaths.sort(), ["sounds/completion.mp3", "sounds/countdown.mp3", "sounds/ding3.mp3"]);
  for (const soundPath of soundPaths) {
    assert.match(serviceWorker, new RegExp(`"\\./${soundPath.replaceAll(".", "\\.")}"`));
    // An MPEG audio frame opens with an 11-bit sync word: 0xFF followed by 0xFB for MPEG-1 Layer III.
    assert.equal(read(soundPath).subarray(0, 2).toString("hex"), "fffb");
  }
});

test("service worker installs the shell and serves cached HTML when offline", async () => {
  const listeners = new Map();
  const storedResponses = new Map();
  const cache = {
    async addAll(paths) {
      for (const item of paths) storedResponses.set(item, { cached: item });
    },
    async put(key, value) {
      storedResponses.set(key, value);
    }
  };
  const caches = {
    async delete() {
      return true;
    },
    async keys() {
      return [];
    },
    async match(key) {
      return storedResponses.get(key);
    },
    async open() {
      return cache;
    }
  };
  const self = {
    addEventListener(type, listener) {
      listeners.set(type, listener);
    },
    clients: {
      async claim() {}
    },
    location: { origin: "https://example.test" },
    async skipWaiting() {}
  };
  const context = vm.createContext({
    Promise,
    URL,
    caches,
    fetch: async () => {
      throw new Error("offline");
    },
    self
  });
  new vm.Script(read("service-worker.js").toString()).runInContext(context);

  let installation;
  listeners.get("install")({
    waitUntil(promise) {
      installation = promise;
    }
  });
  await installation;
  assert.ok(storedResponses.has("./index.html"));

  let navigationResponse;
  listeners.get("fetch")({
    request: {
      method: "GET",
      mode: "navigate",
      url: "https://example.test/"
    },
    respondWith(promise) {
      navigationResponse = promise;
    },
    waitUntil() {}
  });
  assert.deepEqual(await navigationResponse, { cached: "./index.html" });
});
