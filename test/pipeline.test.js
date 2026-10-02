const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { runPipeline } = require("../src/pipeline");
const { readJson } = require("../src/storage");

function makeFixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "apk-pipeline-test-"));
  const settings = {
    dataDir: path.join(root, "data"),
    apkDir: path.join(root, "apks with spaces"),
    decompiledDir: path.join(root, "output with spaces"),
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
      detailsConcurrency: 1,
      requestDelayMs: 0,
      slackWebhookUrl: null
    },
    pull: {
      source: "playstore",
      email: "researcher@example.test",
      aasToken: "secret-token",
      apkeep: "apkeep",
      adb: "adb",
      device: null,
      splitApk: false,
      retries: 0,
      downloadParallel: 1
    },
    decompile: {
      jadx: "jadx",
      fast: false,
      jobs: 2
    },
    pipeline: {
      selection: "changed",
      all: false,
      force: false
    }
  };
  return { root, settings };
}

function scanFor(version, extra = []) {
  return async () => ({
    apps: [{
      package: "com.example.app",
      developerId: "123",
      developerName: "Test publisher",
      title: "Example",
      url: "https://play.google.com/store/apps/details?id=com.example.app",
      version
    }, ...extra],
    changes: [],
    failures: [],
    notification: { status: "console" }
  });
}

function createToolRunner(options = {}) {
  const calls = { apkeep: 0, jadx: 0 };
  let failApkeep = options.failApkeep || 0;
  let failJadx = options.failJadx || 0;

  const runTool = async (executable, args) => {
    if (executable === "apkeep") {
      calls.apkeep++;
      if (failApkeep > 0) {
        failApkeep--;
        return { code: 9, stdout: "", stderr: "" };
      }
      const destination = args.at(-1);
      fs.mkdirSync(destination, { recursive: true });
      fs.writeFileSync(path.join(destination, "base.apk"), `apk-${calls.apkeep}`);
      return { code: 0, stdout: "", stderr: "" };
    }

    if (executable === "jadx") {
      calls.jadx++;
      if (failJadx > 0) {
        failJadx--;
        return { code: 9, stdout: "", stderr: "" };
      }
      const output = args[args.indexOf("-d") + 1];
      fs.mkdirSync(path.join(output, "sources"), { recursive: true });
      fs.writeFileSync(
        path.join(output, "sources", "Example.java"),
        `decompiled-${calls.jadx}`
      );
      return { code: 0, stdout: "", stderr: "" };
    }

    throw new Error(`Unexpected executable: ${executable}`);
  };

  return { runTool, calls };
}

const logger = { log() {}, error() {} };

test("first pipeline run processes all targets, then skips unchanged APK and JADX work", async () => {
  const { root, settings } = makeFixture();
  const { runTool, calls } = createToolRunner();
  fs.mkdirSync(settings.dataDir, { recursive: true });
  fs.writeFileSync(
    path.join(settings.dataDir, "monitor-state.json"),
    JSON.stringify({ apps: {}, developers: { "123": {} } })
  );

  try {
    const options = {
      runTool,
      logger,
      runScan: scanFor("1.0")
    };
    const first = await runPipeline(settings, options);
    assert.equal(first.selected.length, 1);
    assert.deepEqual(calls, { apkeep: 1, jadx: 1 });

    const second = await runPipeline(settings, options);
    assert.equal(second.selected.length, 0);
    assert.deepEqual(calls, { apkeep: 1, jadx: 1 });
    assert.equal(
      readJson(path.join(settings.dataDir, "processing-state.json"), null)
        .packages["com.example.app"].pipeline.status,
      "complete"
    );
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("version changes refresh existing APKs and decompiled output", async () => {
  const { root, settings } = makeFixture();
  const { runTool, calls } = createToolRunner();

  try {
    await runPipeline(settings, {
      runTool,
      logger,
      runScan: scanFor("1.0")
    });
    await runPipeline(settings, {
      runTool,
      logger,
      runScan: scanFor("2.0")
    });
    assert.deepEqual(calls, { apkeep: 2, jadx: 2 });
    assert.equal(
      fs.readFileSync(
        path.join(settings.apkDir, "com.example.app", "base.apk"),
        "utf8"
      ),
      "apk-2"
    );
    assert.equal(
      fs.readFileSync(
        path.join(settings.decompiledDir, "com.example.app", "sources", "Example.java"),
        "utf8"
      ),
      "decompiled-2"
    );
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("failed JADX stays pending, and a retry reuses the verified acquisition", async () => {
  const { root, settings } = makeFixture();
  const { runTool, calls } = createToolRunner({ failJadx: 1 });

  try {
    const options = { runTool, logger, runScan: scanFor("1.0") };
    const first = await runPipeline(settings, options);
    assert.equal(first.failed, true);
    assert.deepEqual(calls, { apkeep: 1, jadx: 1 });

    const second = await runPipeline(settings, options);
    assert.equal(second.failed, false);
    assert.deepEqual(calls, { apkeep: 1, jadx: 2 });
    assert.equal(second.processing.packages["com.example.app"].pipeline.status, "complete");
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("failed acquisition is retried after another monitor scan", async () => {
  const { root, settings } = makeFixture();
  const { runTool, calls } = createToolRunner({ failApkeep: 1 });

  try {
    const options = { runTool, logger, runScan: scanFor("1.0") };
    const first = await runPipeline(settings, options);
    assert.equal(first.failed, true);
    assert.equal(first.acquisition.results[0].status, "failed");
    assert.deepEqual(calls, { apkeep: 1, jadx: 0 });

    const second = await runPipeline(settings, options);
    assert.equal(second.failed, false);
    assert.deepEqual(calls, { apkeep: 2, jadx: 1 });
    assert.equal(second.processing.packages["com.example.app"].pipeline.status, "complete");
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("device pipelines leave outdated installed apps pending", async () => {
  const { root, settings } = makeFixture();
  settings.pull.source = "device";
  settings.pull.device = "emulator-5554";
  const calls = [];

  try {
    const result = await runPipeline(settings, {
      logger,
      runScan: scanFor("2.0"),
      runTool: async (_executable, args) => {
        calls.push(args);
        return { code: 0, stdout: "versionName=1.0\n" };
      }
    });

    assert.equal(result.failed, true);
    assert.equal(calls.length, 1);
    assert.equal(result.decompilation.results.length, 0);
    const record = readJson(
      path.join(settings.dataDir, "processing-state.json"),
      null
    ).packages["com.example.app"];
    assert.equal(record.pipeline.status, "pending");
    assert.match(record.lastError, /Update the app on the device/);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("a monitor state established before the first pipeline does not hide initial APK work", async () => {
  const { root, settings } = makeFixture();
  const { runTool, calls } = createToolRunner();
  fs.mkdirSync(settings.dataDir, { recursive: true });
  fs.writeFileSync(
    path.join(settings.dataDir, "monitor-state.json"),
    JSON.stringify({ apps: { "123|com.example.app": { version: "1.0" } } })
  );

  try {
    await runPipeline(settings, {
      runTool,
      logger,
      runScan: scanFor("1.0")
    });
    assert.deepEqual(calls, { apkeep: 1, jadx: 1 });
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("Slack delivery failure is reported without stopping APK processing", async () => {
  const { root, settings } = makeFixture();
  const { runTool, calls } = createToolRunner();

  try {
    const result = await runPipeline(settings, {
      runTool,
      logger,
      runScan: async () => ({
        ...(await scanFor("1.0")()),
        notification: { status: "failed" }
      })
    });
    assert.equal(result.failed, true);
    assert.deepEqual(calls, { apkeep: 1, jadx: 1 });
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
