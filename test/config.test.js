const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { spawnSync } = require("node:child_process");
const { loadSettings, parseCommandLine } = require("../src/config");

function temporaryDirectory() {
  return fs.mkdtempSync(path.join(os.tmpdir(), "apk-config-test-"));
}

test("monitor needs no APK or decompiler credentials", () => {
  const settings = loadSettings(
    "monitor",
    { "no-config": true, developer: ["123"] },
    temporaryDirectory()
  );

  assert.equal(settings.developers[0].id, "123");
  assert.equal(settings.pull.email, null);
  assert.equal(settings.pull.aasToken, null);
  assert.equal(settings.decompile.jadx, "jadx");
});

test("root .env credentials load, with shell and CLI values taking priority", () => {
  const directory = temporaryDirectory();
  const names = [
    "PLAY_STORE_EMAIL",
    "PLAY_STORE_AAS_TOKEN",
    "SLACK_WEBHOOK_URL"
  ];
  const original = Object.fromEntries(
    names.map(name => [name, process.env[name]])
  );
  for (const name of names) {
    delete process.env[name];
  }
  fs.writeFileSync(
    path.join(directory, ".env"),
    [
      "# local credentials",
      "PLAY_STORE_EMAIL=file@example.test",
      'PLAY_STORE_AAS_TOKEN="file-token # retained"',
      "SLACK_WEBHOOK_URL='https://hooks.example.test/from-file'",
      ""
    ].join("\n")
  );
  const configPath = path.join(directory, "config.json");
  fs.writeFileSync(configPath, JSON.stringify({
    targets: { developers: [{ id: "123" }] },
    monitor: { slackWebhook: { env: "SLACK_WEBHOOK_URL" } }
  }));

  try {
    const fromFile = loadSettings(
      "pull",
      { "no-config": true, source: "playstore" },
      directory
    );
    assert.equal(fromFile.pull.email, "file@example.test");
    assert.equal(fromFile.pull.aasToken, "file-token # retained");

    process.env.PLAY_STORE_EMAIL = "shell@example.test";
    const fromShell = loadSettings(
      "pull",
      { "no-config": true, source: "playstore" },
      directory
    );
    assert.equal(fromShell.pull.email, "shell@example.test");

    const fromCli = loadSettings(
      "pull",
      {
        "no-config": true,
        source: "playstore",
        email: "cli@example.test"
      },
      directory
    );
    assert.equal(fromCli.pull.email, "cli@example.test");

    const monitor = loadSettings("monitor", { config: configPath }, directory);
    assert.equal(
      monitor.monitor.slackWebhookUrl,
      "https://hooks.example.test/from-file"
    );
  } finally {
    for (const name of names) {
      if (original[name] === undefined) {
        delete process.env[name];
      } else {
        process.env[name] = original[name];
      }
    }
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test("config paths use the config directory and CLI paths use the working directory", () => {
  const directory = temporaryDirectory();
  const configPath = path.join(directory, "config.json");
  fs.writeFileSync(configPath, JSON.stringify({
    targets: {
      developers: [{ id: "123", name: "Test" }],
      packages: ["com.example.fromconfig"]
    },
    paths: {
      data: "./state",
      apks: "./saved-apks",
      decompiled: "./saved-decompiled"
    },
    monitor: { slackWebhook: { env: "TEST_SLACK_URL" } }
  }));
  const original = process.env.TEST_SLACK_URL;
  process.env.TEST_SLACK_URL = "https://hooks.example.test/secret";
  try {
    const settings = loadSettings("monitor", { config: configPath }, directory);
    assert.equal(settings.dataDir, path.join(directory, "state"));
    assert.equal(settings.apkDir, path.join(directory, "saved-apks"));
    assert.equal(settings.monitor.slackWebhookUrl, process.env.TEST_SLACK_URL);

    const overridden = loadSettings("monitor", {
      config: configPath,
      "data-dir": "./cli-state",
      packages: ["com.example.cli,com.example.second"]
    }, directory);
    assert.equal(overridden.dataDir, path.join(directory, "cli-state"));
    assert.deepEqual(overridden.packages, [
      "com.example.cli",
      "com.example.second"
    ]);
  } finally {
    if (original === undefined) {
      delete process.env.TEST_SLACK_URL;
    } else {
      process.env.TEST_SLACK_URL = original;
    }
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test("CLI parsing accepts repeated lists and rejects flags on unrelated commands", () => {
  const parsed = parseCommandLine([
    "pipeline",
    "--developer",
    "123",
    "--developer",
    "https://play.google.com/store/apps/dev?id=456",
    "--packages",
    "com.example.one,com.example.two",
    "--no-split-apk"
  ]);

  assert.deepEqual(parsed.values.developer, [
    "123",
    "https://play.google.com/store/apps/dev?id=456"
  ]);
  assert.deepEqual(parsed.values.packages, ["com.example.one,com.example.two"]);
  assert.throws(
    () => parseCommandLine(["monitor", "--jadx", "jadx"]),
    /cannot be used with "monitor"/
  );
});

test("CLI-only developer URLs become Google Play developer IDs", () => {
  const settings = loadSettings("monitor", {
    "no-config": true,
    developer: ["https://play.google.com/store/apps/dev?id=987"]
  }, temporaryDirectory());

  assert.equal(settings.developers[0].id, "987");
});

test("monitor is the single discovery and version-check command", () => {
  const parsed = parseCommandLine([
    "monitor",
    "--developer", "123",
    "--language", "en",
    "--country", "us",
    "--details-concurrency", "3",
    "--request-delay-ms", "0",
    "--slack-webhook", "https://hooks.example.test/redacted"
  ]);

  assert.equal(parsed.command, "monitor");
  assert.equal(parsed.values["details-concurrency"], "3");
  assert.equal(parsed.values["request-delay-ms"], "0");
  assert.throws(
    () => parseCommandLine(["scrape"]),
    /Unknown command "scrape"/
  );
});

test("invalid config sources, numbers, and missing Play Store credentials fail clearly", () => {
  const directory = temporaryDirectory();
  assert.throws(
    () => loadSettings(
      "pull",
      { "no-config": true, source: "remote" },
      directory
    ),
    /--source must be either playstore or device/
  );
  assert.throws(
    () => loadSettings("monitor", {
      "no-config": true,
      developer: ["123"],
      "details-concurrency": "0"
    }, directory),
    /at least 1/
  );
  assert.throws(
    () => loadSettings("pull", { "no-config": true }, directory),
    /Missing pull.email/
  );
  fs.rmSync(directory, { recursive: true, force: true });
});

test("the CLI shows general and command help without loading config or prompting", () => {
  const cliPath = path.resolve(__dirname, "..", "cli.js");
  const general = spawnSync(process.execPath, [cliPath, "--help"], {
    encoding: "utf8"
  });
  const command = spawnSync(process.execPath, [cliPath, "pipeline", "--help"], {
    encoding: "utf8"
  });
  const monitor = spawnSync(process.execPath, [cliPath, "monitor", "--help"], {
    encoding: "utf8"
  });

  assert.equal(general.status, 0);
  assert.match(general.stdout, /monitor[\s\S]*pull[\s\S]*decompile[\s\S]*pipeline/);
  assert.doesNotMatch(general.stdout, /\bscrape\b/);
  assert.equal(command.status, 0);
  assert.match(command.stdout, /--decompile-jobs/);
  assert.match(command.stdout, /--no-config/);
  assert.equal(monitor.status, 0);
  assert.match(monitor.stdout, /Discover publisher apps, fetch versions/);
  assert.match(monitor.stdout, /--developer/);
  assert.match(monitor.stdout, /--details-concurrency/);
  assert.match(monitor.stdout, /--slack-webhook/);
});
