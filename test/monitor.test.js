const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { runScan, statePaths } = require("../src/monitor");
const { readJson } = require("../src/storage");

function makeSettings(directory) {
  return {
    dataDir: directory,
    developers: [{
      id: "123",
      name: "Test publisher",
      includePackages: [],
      excludePackages: []
    }],
    packages: [],
    excludePackages: [],
    monitor: {
      language: "en",
      country: "us",
      detailsConcurrency: 2,
      requestDelayMs: 0,
      slackWebhookUrl: "https://hooks.example.test/redacted"
    }
  };
}

test("monitor establishes a baseline, reports additions and version changes, and retains versions on lookup failure", async () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "apk-monitor-test-"));
  const settings = makeSettings(directory);
  let currentApps = [{ package: "com.example.app", title: "Example" }];
  let versions = new Map([["com.example.app", "1.0"]]);
  let failedPackages = new Set();
  const slackSummaries = [];
  const adapters = {
    discoverDeveloperApps: async () => ({ apps: currentApps }),
    loadGooglePlayScraper: async () => ({
      app: async ({ appId }) => {
        if (failedPackages.has(appId)) {
          throw new Error("temporary lookup failure");
        }
        return { version: versions.get(appId) };
      }
    }),
    sendSlackNotification: async (url, summary) => {
      assert.equal(url, settings.monitor.slackWebhookUrl);
      slackSummaries.push(summary);
    }
  };

  try {
    const first = await runScan(settings, adapters);
    assert.equal(first.baseline, true);
    assert.deepEqual(first.changes, []);
    assert.equal(first.apps[0].version, "1.0");
    assert.deepEqual(readJson(first.locations.diff, null).changes, []);

    currentApps = [
      ...currentApps,
      { package: "com.example.new", title: "New app" }
    ];
    versions.set("com.example.app", "2.0");
    versions.set("com.example.new", "1");
    const second = await runScan(settings, adapters);
    assert.equal(second.changes.length, 2);
    assert.deepEqual(
      second.changes.map(change => change.type).sort(),
      ["added", "version"]
    );
    assert.deepEqual(readJson(second.locations.inventory, null), second.apps);
    assert.deepEqual(readJson(second.locations.diff, null).changes, second.changes);
    assert.deepEqual(readJson(second.locations.state, null), second.state);

    failedPackages = new Set(["com.example.new"]);
    const previousCalls = slackSummaries.length;
    const third = await runScan(settings, adapters);
    assert.equal(third.failures.length, 1);
    assert.equal(third.apps.find(app =>
      app.package === "com.example.new"
    ).version, "1");
    assert.deepEqual(third.changes, []);
    assert.equal(slackSummaries.length, previousCalls + 1);
    assert.equal(readJson(statePaths(directory).state, null).apps[
      "123|com.example.app"
    ].version, "2.0");
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test("failed discovery sends a failure summary without replacing the last snapshot", async () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "apk-monitor-failure-"));
  const settings = makeSettings(directory);
  const paths = statePaths(directory);
  fs.mkdirSync(directory, { recursive: true });
  const state = {
    apps: {},
    developers: { "123": { name: "Test" } }
  };
  fs.writeFileSync(paths.state, JSON.stringify(state));
  let sent;

  try {
    await assert.rejects(
      runScan(settings, {
        discoverDeveloperApps: async () => {
          throw new Error("Play Store unavailable");
        },
        loadGooglePlayScraper: async () => ({ app: async () => ({ version: "1" }) }),
        sendSlackNotification: async (_url, summary) => {
          sent = summary;
        }
      }),
      /Play Store unavailable/
    );
    assert.equal(sent.failed, true);
    assert.deepEqual(readJson(paths.state, null), state);
    assert.equal(fs.existsSync(paths.inventory), false);
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test("the combined scan discovers, filters, fetches versions, saves all outputs, and notifies once", async () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "apk-combined-scan-test-"));
  const settings = makeSettings(directory);
  settings.developers[0].includePackages = ["com.example.*"];
  settings.excludePackages = ["com.example.excluded"];
  const events = [];

  try {
    const result = await runScan(settings, {
      discoverDeveloperApps: async (url, options) => {
        events.push("discover");
        assert.equal(new URL(url).searchParams.get("id"), "123");
        assert.equal(new URL(url).searchParams.get("hl"), "en");
        assert.equal(new URL(url).searchParams.get("gl"), "us");
        assert.equal(options.saveArtifacts, false);
        assert.equal(options.quiet, false);
        return {
          apps: [
            { package: "com.example.app", title: "Example" },
            { package: "com.example.app", title: "Example" },
            { package: "com.example.excluded" },
            { package: "com.other.app" }
          ]
        };
      },
      loadGooglePlayScraper: async () => ({
        app: async ({ appId, lang, country }) => {
          events.push("version");
          assert.equal(appId, "com.example.app");
          assert.equal(lang, "en");
          assert.equal(country, "us");
          return { version: "1.2.3" };
        }
      }),
      sendSlackNotification: async (_url, summary) => {
        events.push("notify");
        assert.equal(summary.appsChecked, 1);
        assert.deepEqual(readJson(statePaths(directory).diff, null), summary);
      }
    });

    assert.deepEqual(events, ["discover", "version", "notify"]);
    assert.equal(result.apps.length, 1);
    assert.equal(result.apps[0].version, "1.2.3");
    assert.equal(result.apps[0].developerId, "123");
    assert.equal(
      result.apps[0].url,
      "https://play.google.com/store/apps/details?id=com.example.app"
    );
    assert.deepEqual(readJson(result.locations.inventory, null), result.apps);
    assert.deepEqual(readJson(result.locations.state, null), result.state);
    assert.equal(result.notification.status, "slack");
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});
