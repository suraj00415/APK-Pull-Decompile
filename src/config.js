const fs = require("node:fs");
const path = require("node:path");
const { parseArgs } = require("node:util");

const COMMANDS = ["monitor", "pull", "decompile", "pipeline"];

const CLI_OPTIONS = {
  help: { type: "boolean" },
  config: { type: "string" },
  "no-config": { type: "boolean" },
  developer: { type: "string", multiple: true },
  packages: { type: "string", multiple: true },
  "exclude-packages": { type: "string", multiple: true },
  "data-dir": { type: "string" },
  "apk-dir": { type: "string" },
  "decompiled-dir": { type: "string" },
  source: { type: "string" },
  apkeep: { type: "string" },
  adb: { type: "string" },
  device: { type: "string" },
  email: { type: "string" },
  "aas-token": { type: "string" },
  "no-split-apk": { type: "boolean" },
  retries: { type: "string" },
  "download-parallel": { type: "string" },
  jadx: { type: "string" },
  fast: { type: "boolean" },
  "decompile-jobs": { type: "string" },
  language: { type: "string" },
  country: { type: "string" },
  "details-concurrency": { type: "string" },
  "request-delay-ms": { type: "string" },
  "slack-webhook": { type: "string" },
  all: { type: "boolean" },
  "from-app-list": { type: "string" },
  force: { type: "boolean" }
};

const COMMAND_OPTIONS = {
  monitor: [
    "developer",
    "packages",
    "exclude-packages",
    "data-dir",
    "language",
    "country",
    "details-concurrency",
    "request-delay-ms",
    "slack-webhook"
  ],
  pull: [
    "packages",
    "exclude-packages",
    "data-dir",
    "apk-dir",
    "source",
    "apkeep",
    "adb",
    "device",
    "email",
    "aas-token",
    "no-split-apk",
    "retries",
    "download-parallel",
    "all",
    "from-app-list",
    "force"
  ],
  decompile: [
    "packages",
    "exclude-packages",
    "data-dir",
    "apk-dir",
    "decompiled-dir",
    "jadx",
    "fast",
    "decompile-jobs",
    "all",
    "from-app-list",
    "force"
  ],
  pipeline: [
    "developer",
    "packages",
    "exclude-packages",
    "data-dir",
    "apk-dir",
    "decompiled-dir",
    "source",
    "apkeep",
    "adb",
    "device",
    "email",
    "aas-token",
    "no-split-apk",
    "retries",
    "download-parallel",
    "jadx",
    "fast",
    "decompile-jobs",
    "language",
    "country",
    "details-concurrency",
    "request-delay-ms",
    "slack-webhook",
    "all",
    "force"
  ]
};

function parseCommandLine(argv) {
  const command = argv[0];

  if (!command) {
    return { command: null, values: {} };
  }

  if (command === "--help" || command === "-h") {
    return { command: null, help: true, values: {} };
  }

  if (!COMMANDS.includes(command)) {
    throw new Error(
      `Unknown command "${command}". Run "npm start -- --help" to see available commands.`
    );
  }

  let parsed;

  try {
    parsed = parseArgs({
      args: argv.slice(1),
      options: CLI_OPTIONS,
      strict: true,
      allowPositionals: false,
      allowNegative: false
    }).values;
  } catch (error) {
    throw new Error(`${error.message} Run "npm run ${command} -- --help" for usage.`);
  }

  const unsupported = Object.keys(parsed).filter(
    key => key !== "help" && key !== "config" && key !== "no-config" &&
      !COMMAND_OPTIONS[command].includes(key)
  );

  if (unsupported.length > 0) {
    const names = unsupported.map(name => `--${name}`).join(", ");
    throw new Error(
      `${names} cannot be used with "${command}".`
    );
  }

  if (parsed.config && parsed["no-config"]) {
    throw new Error("Use either --config <path> or --no-config, not both.");
  }

  return { command, values: parsed };
}

function parseList(values, fieldName) {
  const result = [];
  const seen = new Set();

  for (const value of values || []) {
    for (const item of String(value).split(/[,\s]+/)) {
      const trimmed = item.trim();

      if (trimmed && !seen.has(trimmed)) {
        seen.add(trimmed);
        result.push(trimmed);
      }
    }
  }

  if (result.some(item => !/^[A-Za-z0-9][A-Za-z0-9._*-]*$/.test(item))) {
    throw new Error(
      `${fieldName} contains an invalid package name or wildcard pattern.`
    );
  }

  return result;
}

function numberOption(value, name, defaultValue, { min = 0, integer = false } = {}) {
  const result = value === undefined ? defaultValue : Number(value);

  if (!Number.isFinite(result) || result < min || (integer && !Number.isInteger(result))) {
    const expected = integer ? "an integer" : "a number";
    throw new Error(`--${name} must be ${expected} of at least ${min}.`);
  }

  return result;
}

function requiredObject(value, name) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`${name} in the configuration must be an object.`);
  }

  return value;
}

function resolvePath(value, base, fallback) {
  const selected = value ?? fallback;

  if (!selected) {
    return null;
  }

  if (typeof selected !== "string") {
    throw new Error(`Paths must be strings; received ${typeof selected}.`);
  }

  if (!selected.trim()) {
    throw new Error("Paths cannot be empty.");
  }

  return path.isAbsolute(selected) ? path.normalize(selected) : path.resolve(base, selected);
}

function packageListFromConfig(value, fieldName) {
  if (value === undefined) {
    return [];
  }

  if (!Array.isArray(value)) {
    throw new Error(`${fieldName} must be an array of package names or patterns.`);
  }

  return parseList(value.map(String), fieldName);
}

function parseEnvFile(directory) {
  const envPath = path.join(directory, ".env");

  if (!fs.existsSync(envPath)) {
    return Object.create(null);
  }

  let text;
  try {
    text = fs.readFileSync(envPath, "utf8").replace(/^\uFEFF/, "");
  } catch (error) {
    throw new Error(`Could not read environment file ${envPath}: ${error.message}`);
  }

  const result = Object.create(null);
  for (const line of text.split(/\r?\n/)) {
    const match = line.match(
      /^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*?)\s*$/
    );
    if (!match) {
      continue;
    }

    const [, name] = match;
    let value = match[2];
    if (value.startsWith('"')) {
      const quoted = value.match(/^"((?:\\.|[^"])*)"(?:\s+#.*)?$/);
      if (quoted) {
        value = quoted[1]
          .replace(/\\n/g, "\n")
          .replace(/\\r/g, "\r")
          .replace(/\\"/g, '"')
          .replace(/\\\\/g, "\\");
      }
    } else if (value.startsWith("'")) {
      const quoted = value.match(/^'([^']*)'(?:\s+#.*)?$/);
      if (quoted) {
        value = quoted[1];
      }
    } else {
      value = value.replace(/\s+#.*$/, "").trim();
    }

    result[name] = value;
  }

  return result;
}

function environmentValue(name, localEnvironment) {
  if (process.env[name] !== undefined) {
    return process.env[name];
  }
  return localEnvironment[name];
}

function credentialValue(
  value,
  defaultEnvironmentName,
  fieldName,
  optional = false,
  localEnvironment = Object.create(null)
) {
  let resolved = value;

  if (resolved && typeof resolved === "object" && !Array.isArray(resolved)) {
    if (typeof resolved.env !== "string" || !resolved.env.trim()) {
      throw new Error(`${fieldName} must use { "env": "VARIABLE_NAME" }.`);
    }

    resolved = environmentValue(resolved.env, localEnvironment);
  } else if (resolved === undefined && defaultEnvironmentName) {
    resolved = environmentValue(defaultEnvironmentName, localEnvironment);
  }

  if (resolved !== undefined && resolved !== null && typeof resolved !== "string") {
    throw new Error(`${fieldName} must be a string or an environment reference.`);
  }

  resolved = typeof resolved === "string" ? resolved.trim() : "";

  if (!resolved && !optional) {
    const environmentHint = defaultEnvironmentName
      ? ` Set ${defaultEnvironmentName} or configure ${fieldName}.`
      : "";
    throw new Error(`Missing ${fieldName}.${environmentHint}`);
  }

  return resolved || null;
}

function developerId(value) {
  const trimmed = String(value || "").trim();

  if (!trimmed) {
    throw new Error("Developer IDs and URLs cannot be empty.");
  }

  if (/^https?:\/\//i.test(trimmed)) {
    let id;

    try {
      id = new URL(trimmed).searchParams.get("id");
    } catch {
      id = null;
    }

    if (!id) {
      throw new Error(`Developer URL has no ?id= value: ${trimmed}`);
    }

    return id;
  }

  if (!/^\d+$/.test(trimmed)) {
    throw new Error(
      `Invalid Google Play developer ID "${trimmed}". Pass the numeric ID from ?id=.`
    );
  }

  return trimmed;
}

function loadSettings(command, values, cwd = process.cwd()) {
  const localEnvironment = parseEnvFile(cwd);
  let raw = {};
  let configPath = null;

  if (!values["no-config"]) {
    configPath = values.config
      ? path.resolve(cwd, values.config)
      : path.join(cwd, "config.json");

    if (values.config || fs.existsSync(configPath)) {
      let text;

      try {
        text = fs.readFileSync(configPath, "utf8");
        raw = JSON.parse(text);
      } catch (error) {
        throw new Error(`Could not read configuration ${configPath}: ${error.message}`);
      }
    } else {
      configPath = null;
    }
  }

  raw = requiredObject(raw, "Configuration");
  const base = configPath ? path.dirname(configPath) : cwd;
  const targetsRaw = raw.targets === undefined ? {} : requiredObject(raw.targets, "targets");
  const pathsRaw = raw.paths === undefined ? {} : requiredObject(raw.paths, "paths");
  const monitorRaw = raw.monitor === undefined ? {} : requiredObject(raw.monitor, "monitor");
  const pullRaw = raw.pull === undefined ? {} : requiredObject(raw.pull, "pull");
  const decompileRaw = raw.decompile === undefined ? {} : requiredObject(raw.decompile, "decompile");
  const pipelineRaw = raw.pipeline === undefined ? {} : requiredObject(raw.pipeline, "pipeline");

  let developers = targetsRaw.developers || [];

  if (!Array.isArray(developers)) {
    throw new Error("targets.developers must be an array.");
  }

  developers = developers.map((developer, index) => {
    requiredObject(developer, `targets.developers[${index}]`);
    const id = developerId(developer.id);
    const includes = packageListFromConfig(
      developer.includePackages,
      `targets.developers[${index}].includePackages`
    );
    const excludes = packageListFromConfig(
      developer.excludePackages,
      `targets.developers[${index}].excludePackages`
    );
    return {
      id,
      name: String(developer.name || id).trim() || id,
      includePackages: includes,
      excludePackages: excludes
    };
  });

  if (values.developer) {
    developers = values.developer.map((developer, index) => {
      const id = developerId(developer);
      const existing = developers.find(item => item.id === id);
      return existing || {
        id,
        name: id,
        includePackages: [],
        excludePackages: []
      };
    });
  }
  const developerIds = new Set();
  for (const developer of developers) {
    if (developerIds.has(developer.id)) {
      throw new Error(`Developer ${developer.id} appears more than once.`);
    }
    developerIds.add(developer.id);
  }

  if ((command === "monitor" || command === "pipeline") &&
      developers.length === 0) {
    throw new Error(
      `No developers configured. Add targets.developers to config.json or pass --developer <id-or-url>.`
    );
  }

  const packages = values.packages !== undefined
    ? parseList(values.packages, "--packages")
    : packageListFromConfig(targetsRaw.packages, "targets.packages");
  const excludePackages = values["exclude-packages"] !== undefined
    ? parseList(values["exclude-packages"], "--exclude-packages")
    : packageListFromConfig(targetsRaw.excludePackages, "targets.excludePackages");
  const dataDir = resolvePath(
    values["data-dir"] ?? pathsRaw.data,
    values["data-dir"] === undefined ? base : cwd,
    "./data"
  );
  const apkDir = resolvePath(
    values["apk-dir"] ?? pathsRaw.apks,
    values["apk-dir"] === undefined ? base : cwd,
    "./apks"
  );
  const decompiledDir = resolvePath(
    values["decompiled-dir"] ?? pathsRaw.decompiled,
    values["decompiled-dir"] === undefined ? base : cwd,
    "./decompiled"
  );

  const monitor = {
    language: String(values.language ?? monitorRaw.language ?? "en"),
    country: String(values.country ?? monitorRaw.country ?? "in").toLowerCase(),
    detailsConcurrency: numberOption(
      values["details-concurrency"] ?? monitorRaw.detailsConcurrency,
      "details-concurrency",
      2,
      { min: 1, integer: true }
    ),
    requestDelayMs: numberOption(
      values["request-delay-ms"] ?? monitorRaw.requestDelayMs,
      "request-delay-ms",
      500
    ),
    slackWebhookUrl: credentialValue(
      values["slack-webhook"] ?? monitorRaw.slackWebhook,
      "SLACK_WEBHOOK_URL",
      "monitor.slackWebhook",
      true,
      localEnvironment
    )
  };

  const source = String(
    values.source ?? pullRaw.source ?? "playstore"
  );
  if (pullRaw.splitApk !== undefined && typeof pullRaw.splitApk !== "boolean") {
    throw new Error("pull.splitApk must be true or false.");
  }

  if ((command === "pull" || command === "pipeline") &&
      !["playstore", "device"].includes(source)) {
    throw new Error("--source must be either playstore or device.");
  }
  const requestedDevice = values.device ?? pullRaw.device ?? null;
  if (requestedDevice !== null && typeof requestedDevice !== "string") {
    throw new Error("pull.device must be a device serial string or null.");
  }

  const usePlayStoreCredentials =
    ["pull", "pipeline"].includes(command) && source === "playstore";
  const pull = {
    source,
    apkeep: String(values.apkeep ?? pullRaw.apkeep ?? "apkeep"),
    adb: String(values.adb ?? pullRaw.adb ?? "adb"),
    device: source === "device" ? requestedDevice : null,
    email: credentialValue(
      values.email ?? pullRaw.email,
      "PLAY_STORE_EMAIL",
      "pull.email",
      !usePlayStoreCredentials,
      localEnvironment
    ),
    aasToken: credentialValue(
      values["aas-token"] ?? pullRaw.aasToken,
      "PLAY_STORE_AAS_TOKEN",
      "pull.aasToken",
      !usePlayStoreCredentials,
      localEnvironment
    ),
    splitApk: values["no-split-apk"] ? false : pullRaw.splitApk !== false,
    retries: numberOption(
      values.retries ?? pullRaw.retries,
      "retries",
      2,
      { integer: true }
    ),
    downloadParallel: numberOption(
      values["download-parallel"] ?? pullRaw.downloadParallel,
      "download-parallel",
      1,
      { min: 1, integer: true }
    )
  };
  if (decompileRaw.fast !== undefined && typeof decompileRaw.fast !== "boolean") {
    throw new Error("decompile.fast must be true or false.");
  }
  const decompile = {
    jadx: String(values.jadx ?? decompileRaw.jadx ?? "jadx"),
    fast: Boolean(values.fast ?? decompileRaw.fast ?? false),
    jobs: numberOption(
      values["decompile-jobs"] ?? decompileRaw.jobs,
      "decompile-jobs",
      2,
      { min: 1, integer: true }
    )
  };

  const pipelineSelection = String(pipelineRaw.selection || "changed");
  if (!["changed", "all"].includes(pipelineSelection)) {
    throw new Error('pipeline.selection must be either "changed" or "all".');
  }

  return {
    command,
    configPath,
    configDirectory: base,
    dataDir,
    apkDir,
    decompiledDir,
    developers,
    packages,
    excludePackages,
    monitor,
    pull,
    decompile,
    pipeline: {
      selection: pipelineSelection,
      all: Boolean(values.all) || pipelineSelection === "all",
      force: Boolean(values.force),
      fromAppList: values["from-app-list"]
        ? resolvePath(values["from-app-list"], cwd)
        : null
    },
    standalone: {
      all: Boolean(values.all),
      force: Boolean(values.force),
      fromAppList: values["from-app-list"]
        ? resolvePath(values["from-app-list"], cwd)
        : null
    }
  };
}

function parseHelp(command) {
  return Boolean(command?.values?.help || command?.help);
}

module.exports = {
  COMMANDS,
  loadSettings,
  parseCommandLine,
  parseHelp
};
