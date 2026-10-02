const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { loadSettings } = require("../src/config");
const { selectApps } = require("../src/acquisition");
const { inventoryTargets } = require("../src/decompilation");

test("global exclusions take priority over explicit package lists", async () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "apk-target-test-"));

  try {
    const settings = loadSettings("pull", {
      "no-config": true,
      source: "device",
      packages: ["com.example.blocked"],
      "exclude-packages": ["com.example.blocked"],
      "data-dir": path.join(directory, "data")
    }, directory);

    await assert.rejects(
      selectApps(settings),
      /No app targets found/
    );
    assert.deepEqual(
      inventoryTargets(settings, { all: false }),
      []
    );
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test("config targets.packages selects standalone pull and decompile targets", async () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "apk-target-test-"));
  const configPath = path.join(directory, "config.json");
  fs.writeFileSync(configPath, JSON.stringify({
    targets: {
      developers: [],
      packages: ["com.example.selected"]
    },
    paths: {
      data: "./data",
      apks: "./apks",
      decompiled: "./decompiled"
    },
    pull: { source: "device" }
  }));

  try {
    const pullSettings = loadSettings("pull", { config: configPath }, directory);
    const decompileSettings = loadSettings(
      "decompile",
      { config: configPath },
      directory
    );

    assert.deepEqual(
      (await selectApps(pullSettings)).map(app => app.package),
      ["com.example.selected"]
    );
    assert.deepEqual(
      inventoryTargets(decompileSettings).map(app => app.package),
      ["com.example.selected"]
    );
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test("developer exclusions also block explicitly configured packages", async () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "apk-target-test-"));
  const configPath = path.join(directory, "config.json");
  fs.writeFileSync(configPath, JSON.stringify({
    targets: {
      developers: [{
        id: "123",
        excludePackages: ["com.example.blocked"]
      }],
      packages: ["com.example.blocked"]
    },
    paths: {
      data: "./data",
      apks: "./apks",
      decompiled: "./decompiled"
    },
    pull: { source: "device" }
  }));

  try {
    const pullSettings = loadSettings("pull", { config: configPath }, directory);
    const decompileSettings = loadSettings(
      "decompile",
      { config: configPath },
      directory
    );
    fs.mkdirSync(pullSettings.dataDir, { recursive: true });
    fs.writeFileSync(
      path.join(pullSettings.dataDir, "apps.json"),
      JSON.stringify([{
        package: "com.example.blocked",
        developerId: "123",
        title: "Blocked app"
      }])
    );

    await assert.rejects(selectApps(pullSettings), /No app targets found/);
    assert.deepEqual(inventoryTargets(decompileSettings), []);
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test("wildcard package filters include and exclude matching app IDs", async () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "apk-target-test-"));
  const configPath = path.join(directory, "config.json");
  fs.writeFileSync(configPath, JSON.stringify({
    targets: {
      developers: [{
        id: "123",
        includePackages: ["com.abc.*"],
        excludePackages: ["com.abc.blocked.*"]
      }],
      packages: ["com.abc.*"],
      excludePackages: ["com.abc.private.*"]
    },
    paths: {
      data: "./data",
      apks: "./apks",
      decompiled: "./decompiled"
    },
    pull: { source: "device" }
  }));

  try {
    const pullSettings = loadSettings("pull", { config: configPath }, directory);
    const decompileSettings = loadSettings(
      "decompile",
      { config: configPath },
      directory
    );
    fs.mkdirSync(pullSettings.dataDir, { recursive: true });
    fs.writeFileSync(
      path.join(pullSettings.dataDir, "apps.json"),
      JSON.stringify([
        { package: "com.abc.good", developerId: "123" },
        { package: "com.abc.blocked.app", developerId: "123" },
        { package: "com.abc.private.secret", developerId: "123" },
        { package: "comXabcXunmatched", developerId: "123" }
      ])
    );

    assert.deepEqual(
      (await selectApps(pullSettings)).map(app => app.package),
      ["com.abc.good"]
    );
    assert.deepEqual(
      inventoryTargets(decompileSettings).map(app => app.package),
      ["com.abc.good"]
    );
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test("--from-app-list supplies a custom JSON app inventory", async () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "apk-target-test-"));
  const appListPath = path.join(directory, "my-apps.json");
  fs.writeFileSync(appListPath, JSON.stringify([{
    package: "com.example.fromlist",
    title: "Inventory app"
  }]));

  try {
    const options = {
      "no-config": true,
      source: "device",
      "from-app-list": appListPath,
      "data-dir": path.join(directory, "data")
    };
    const pullSettings = loadSettings("pull", options, directory);
    const decompileSettings = loadSettings("decompile", options, directory);

    assert.deepEqual(
      (await selectApps(pullSettings)).map(app => app.package),
      ["com.example.fromlist"]
    );
    assert.deepEqual(
      (await selectApps(pullSettings, {
        all: true,
        runTool: async () => ({
          code: 0,
          stdout:
            "package:com.example.fromlist\n" +
            "package:com.example.not-listed\n"
        })
      })).map(app => app.package),
      ["com.example.fromlist"]
    );
    assert.deepEqual(
      inventoryTargets(decompileSettings).map(app => app.package),
      ["com.example.fromlist"]
    );
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});
