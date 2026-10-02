const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { acquireApps } = require("../src/acquisition");
const { readJson } = require("../src/storage");

function fixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "apk-acquire-test-"));
  const settings = {
    dataDir: path.join(root, "data"),
    apkDir: path.join(root, "apks"),
    pipeline: { force: false },
    packages: [],
    excludePackages: [],
    developers: [],
    pull: {
      source: "device",
      device: "emulator-5554",
      adb: "adb",
      retries: 0,
      splitApk: false,
      downloadParallel: 1,
      apkeep: "apkeep",
      email: null,
      aasToken: null
    }
  };
  return { root, settings };
}

test("ADB pulls every split APK before publishing the package directory", async () => {
  const { root, settings } = fixture();
  const pulled = [];

  try {
    const result = await acquireApps(
      settings,
      [{ package: "com.example.app", version: null }],
      {
        logger: { log() {}, error() {} },
        runTool: async (_executable, args) => {
          if (args.includes("pm")) {
            return {
              code: 0,
              stdout:
                "package:/data/app/base.apk\n" +
                "package:/data/app/split_config.apk\n"
            };
          }
          if (args.includes("pull")) {
            const destination = args.at(-1);
            fs.writeFileSync(destination, path.basename(destination));
            pulled.push(path.basename(destination));
            return { code: 0, stdout: "" };
          }
          throw new Error(`Unexpected ADB arguments: ${args.join(" ")}`);
        }
      }
    );

    assert.equal(result.failed, false);
    assert.deepEqual(pulled.sort(), ["base.apk", "split_config.apk"]);
    assert.equal(
      result.results[0].acquisition.files.length,
      2
    );
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("an incomplete ADB split pull preserves the previous successful APKs", async () => {
  const { root, settings } = fixture();
  const packageDirectory = path.join(settings.apkDir, "com.example.app");
  fs.mkdirSync(packageDirectory, { recursive: true });
  fs.writeFileSync(path.join(packageDirectory, "old.apk"), "previous");
  settings.pipeline.force = true;

  try {
    const result = await acquireApps(
      settings,
      [{ package: "com.example.app", version: null }],
      {
        logger: { log() {}, error() {} },
        runTool: async (_executable, args) => {
          if (args.includes("pm")) {
            return {
              code: 0,
              stdout:
                "package:/data/app/base.apk\n" +
                "package:/data/app/split.apk\n"
            };
          }
          if (args.includes("pull")) {
            if (args.includes("/data/app/split.apk")) {
              return { code: 1, stdout: "" };
            }
            fs.writeFileSync(args.at(-1), "partial");
            return { code: 0, stdout: "" };
          }
          throw new Error("Unexpected ADB command.");
        }
      }
    );

    assert.equal(result.failed, true);
    assert.equal(
      fs.readFileSync(path.join(packageDirectory, "old.apk"), "utf8"),
      "previous"
    );
    assert.equal(
      readJson(path.join(settings.dataDir, "processing-state.json"), null)
        .packages["com.example.app"].acquisition,
      undefined
    );
    assert.equal(
      fs.existsSync(path.join(settings.apkDir, ".staging-com.example.app-0")),
      false
    );
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("APKeep retries split downloads and falls back to a base APK", async () => {
  const { root, settings } = fixture();
  settings.pull.source = "playstore";
  settings.pull.device = null;
  settings.pull.email = "researcher@example.test";
  settings.pull.aasToken = "private-token";
  settings.pull.splitApk = true;
  settings.pull.retries = 1;
  const calls = [];

  try {
    const result = await acquireApps(
      settings,
      [{ package: "com.example.app", version: "1.0" }],
      {
        logger: { log() {}, error() {} },
        runTool: async (_executable, args) => {
          const splitMode = args.find(value => value.startsWith("split_apk="));
          calls.push(splitMode || "default");
          if (splitMode === "split_apk=true") {
            return { code: 1, stdout: "" };
          }

          fs.mkdirSync(args.at(-1), { recursive: true });
          fs.writeFileSync(path.join(args.at(-1), "base.apk"), "downloaded");
          return { code: 0, stdout: "" };
        }
      }
    );

    assert.equal(result.failed, false);
    assert.deepEqual(calls, [
      "split_apk=true",
      "split_apk=true",
      "split_apk=false"
    ]);
    assert.equal(result.results[0].apkFiles.length, 1);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
