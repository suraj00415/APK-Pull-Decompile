const { spawn, spawnSync } = require("child_process");
const fs = require("fs");
const path = require("path");
const readline = require("readline");

const {
  discoverDeveloperApps
} = require("./playstore-developer-scraper");

const DEFAULTS = {
  mode: "full",
  source: "pull",
  splitApk: true,
  downloadRetries: 2,
  apkeepParallel: 1,
  decompileParallel: 2
};

const OPTION_ALIASES = {
  "apk-base-dir": "apkBaseDir",
  "apk-dir": "apkBaseDir",
  "decompiled-base-dir": "decompiledBaseDir",
  "decompiled-dir": "decompiledBaseDir",
  "jadx-path": "jadxPath",
  "apkeep-path": "apkeepPath",
  apkeep: "apkeepPath",
  "play-store-email": "playStoreEmail",
  email: "playStoreEmail",
  "aas-token": "asstoken",
  asstoken: "asstoken",
  token: "asstoken",
  emulator: "emulator",
  device: "emulator",
  "package-search": "packageSearch",
  search: "packageSearch",
  packages: "packages",
  package: "packages",
  "developer-url": "developerUrl",
  "split-apk": "splitApk",
  "no-split-apk": "noSplitApk",
  "download-only": "download",
  "pull-only": "pull",
  "decompile-only": "decompile",
  fast: "fast",
  retries: "retries",
  "retry-count": "retries",
  "apkeep-parallel": "apkeepParallel",
  parallel: "apkeepParallel",
  "decompile-parallel": "decompileParallel",
  force: "force",
  "all": "all"
};

const VALUE_OPTIONS = new Set([
  "mode",
  "source",
  "apkBaseDir",
  "decompiledBaseDir",
  "jadxPath",
  "apkeepPath",
  "playStoreEmail",
  "asstoken",
  "retries",
  "apkeepParallel",
  "decompileParallel",
  "emulator",
  "packageSearch",
  "packages",
  "developerUrl"
]);

const BOOLEAN_OPTIONS = new Set([
  "help",
  "all",
  "splitApk",
  "noSplitApk",
  "fast",
  "force",
  "download",
  "pull",
  "decompile",
  "full"
]);

function optionName(name) {
  return OPTION_ALIASES[name] || name;
}

function parseCliArgs(argv) {
  const options = {};
  const stageFlags = [];

  for (let i = 0; i < argv.length; i++) {
    const argument = argv[i];

    if (argument === "-h" || argument === "--help") {
      options.help = true;
      continue;
    }

    if (!argument.startsWith("--")) {
      throw new Error(
        `Unexpected argument: ${argument}. Use --help to see available options.`
      );
    }

    const withoutPrefix = argument.slice(2);
    const equalsIndex = withoutPrefix.indexOf("=");
    const rawName = equalsIndex === -1
      ? withoutPrefix
      : withoutPrefix.slice(0, equalsIndex);
    const key = optionName(rawName);
    const inlineValue = equalsIndex === -1
      ? undefined
      : withoutPrefix.slice(equalsIndex + 1);

    if (
      !VALUE_OPTIONS.has(key) &&
      !BOOLEAN_OPTIONS.has(key)
    ) {
      throw new Error(
        `Unknown option: --${rawName}. Use --help to see available options.`
      );
    }

    if (BOOLEAN_OPTIONS.has(key)) {
      if (inlineValue !== undefined) {
        throw new Error(
          `Option --${rawName} does not accept a value.`
        );
      }

      if (["download", "pull", "decompile", "full"].includes(key)) {
        stageFlags.push(key);
      } else {
        options[key] = true;
      }

      continue;
    }

    let value = inlineValue;

    if (
      value === undefined &&
      key === "packages"
    ) {
      const packageValues = [];

      while (
        argv[i + 1] !== undefined &&
        !argv[i + 1].startsWith("--")
      ) {
        packageValues.push(argv[i + 1]);
        i++;
      }

      if (packageValues.length === 0) {
        throw new Error(`Option --${rawName} requires a value.`);
      }

      value = packageValues.join(",");
    } else if (value === undefined) {
      const nextArgument = argv[i + 1];

      if (
        nextArgument === undefined ||
        nextArgument.startsWith("--")
      ) {
        throw new Error(`Option --${rawName} requires a value.`);
      }

      value = nextArgument;
      i++;
    }

    options[key] = value;
  }

  if (options.help) {
    return options;
  }

  if (
    options.splitApk &&
    options.noSplitApk
  ) {
    throw new Error(
      "Use only one of --split-apk or --no-split-apk."
    );
  }

  if (stageFlags.length > 1) {
    throw new Error(
      "Choose only one stage flag: --download, --pull, --decompile, or --full."
    );
  }

  if (
    stageFlags.length === 1 &&
    options.mode !== undefined
  ) {
    throw new Error(
      "Use either --mode <value> or a stage flag, not both."
    );
  }

  options.mode = stageFlags[0] || options.mode || DEFAULTS.mode;
  options.source = options.source || DEFAULTS.source;
  options.splitApk = options.noSplitApk
    ? false
    : options.splitApk === true || DEFAULTS.splitApk;

  if (!["full", "download", "pull", "decompile"].includes(options.mode)) {
    throw new Error(
      `Invalid mode: ${options.mode}. Use full, download, pull, or decompile.`
    );
  }

  if (!["download", "pull"].includes(options.source)) {
    throw new Error(
      `Invalid source: ${options.source}. Use download or pull.`
    );
  }

  const downloadRetries = options.retries === undefined
    ? DEFAULTS.downloadRetries
    : Number(options.retries);

  if (
    !Number.isInteger(downloadRetries) ||
    downloadRetries < 0
  ) {
    throw new Error(
      "The --retries value must be a non-negative integer."
    );
  }

  options.retries = downloadRetries;

  const apkeepParallel = options.apkeepParallel === undefined
    ? DEFAULTS.apkeepParallel
    : Number(options.apkeepParallel);

  if (
    !Number.isInteger(apkeepParallel) ||
    apkeepParallel < 1
  ) {
    throw new Error(
      "The --apkeep-parallel value must be a positive integer."
    );
  }

  options.apkeepParallel = apkeepParallel;

  const decompileParallel = options.decompileParallel === undefined
    ? DEFAULTS.decompileParallel
    : Number(options.decompileParallel);

  if (
    !Number.isInteger(decompileParallel) ||
    decompileParallel < 1
  ) {
    throw new Error(
      "The --decompile-parallel value must be a positive integer."
    );
  }

  options.decompileParallel = decompileParallel;

  return options;
}

function printUsage() {
  console.log(`
APK Pull/Download + JADX Decompiler

Usage:
  node apk-pull-decompile.js [options]

Modes:
  --mode full             Acquire APKs and decompile them (default).
  --mode download         Download APKs with APKeep only.
  --mode pull             Pull installed APKs from an emulator/device only.
  --mode decompile        Decompile APKs already present in --apk-base-dir.

Short mode flags are also supported:
  --download              Same as --mode download
  --pull                  Same as --mode pull
  --decompile             Same as --mode decompile
  --full                  Same as --mode full
  --download-only         Alias for --download
  --pull-only             Alias for --pull
  --decompile-only        Alias for --decompile

Common options:
  --apk-base-dir <path>       APK storage directory.
  --decompiled-base-dir <path>
                              JADX output directory (full/decompile modes).
  --jadx-path <path>          JADX executable or .bat path.
  --packages <ids>            Comma- or space-separated package IDs.
  --all                       Process all discovered packages without asking.
  --fast                      Use the base APK and optimized JADX settings while preserving resources and deobfuscation.
  --force                     Redownload APKs and refresh Play Store discovery.
  --retries <n>               Retry failed downloads n additional times (default: 2).
  --apkeep-parallel <n>       APKeep internal parallel fetches (default: 1).
  --decompile-parallel <n>    Fast-mode package workers (default: 2).

Pull options:
  --emulator <serial>         ADB device/emulator serial.
  --package-search <text>     Filter installed packages when --packages is absent.

Download options:
  --source <download|pull>    Acquisition source for --mode full (default: pull).
  --apkeep-path <path>        APKeep executable or .bat path.
  --play-store-email <email>  Google Play account email.
  --aas-token <token>         Google Play AAS token.
  --developer-url <url>       Play Store developer page used for discovery.
  --split-apk                 Ask APKeep for split APK output (default).
  --no-split-apk              Disable split APK output.

Other:
  -h, --help                  Show this help.

Examples:
  node apk-pull-decompile.js --download --apk-base-dir "D:\\APKs" \\
    --apkeep-path "C:\\Tools\\apkeep.exe" --play-store-email user@example.com \\
    --aas-token "<token>" --packages com.example.app

  node apk-pull-decompile.js --pull --emulator emulator-5554 \\
    --apk-base-dir "D:\\APKs" --packages com.example.app

  node apk-pull-decompile.js --decompile --apk-base-dir "D:\\APKs" \\
    --decompiled-base-dir "D:\\Decompiled" --jadx-path "C:\\Tools\\jadx.bat" --all
`);
}

const rl = readline.createInterface({
  input: process.stdin,
  output: process.stdout
});

function ask(question) {
  return new Promise(resolve => {
    rl.question(question, answer => resolve(answer.trim()));
  });
}

const activeChildProcesses = new Set();
let shuttingDown = false;

function stopActiveChildProcesses() {
  for (const child of activeChildProcesses) {
    if (child.exitCode !== null) {
      continue;
    }

    if (process.platform === "win32") {
      spawnSync(
        "taskkill",
        ["/pid", String(child.pid), "/t", "/f"],
        {
          stdio: "ignore",
          windowsHide: true
        }
      );
    } else {
      child.kill("SIGINT");
    }
  }
}

function handleTermination(signal) {
  if (shuttingDown) {
    return;
  }

  shuttingDown = true;
  console.error(
    `\nReceived ${signal}. Stopping the active process...`
  );

  stopActiveChildProcesses();

  if (!rl.closed) {
    rl.close();
  }

  process.exitCode = 130;

  setTimeout(() => {
    process.exit(130);
  }, 250);
}

process.on("SIGINT", () => handleTermination("SIGINT"));
process.on("SIGTERM", () => handleTermination("SIGTERM"));
rl.on("SIGINT", () => handleTermination("SIGINT"));

async function getInput(value, question) {
  if (Array.isArray(value) && value.length > 0) {
    return value;
  }

  if (typeof value === "string" && value.trim() !== "") {
    return value.trim();
  }

  if (
    value !== undefined &&
    value !== null &&
    value !== ""
  ) {
    return value;
  }

  return ask(question);
}

function runChildProcess(executable, args, captureStdout = false) {
  return new Promise((resolve, reject) => {
    const child = spawn(
      executable,
      args,
      {
        stdio: captureStdout
          ? ["pipe", "pipe", "inherit"]
          : "inherit",
        windowsHide: true,
        windowsVerbatimArguments: false
      }
    );

    activeChildProcesses.add(child);

    let stdout = "";
    let settled = false;

    if (child.stdout) {
      child.stdout.on("data", chunk => {
        stdout += chunk.toString();
      });
    }

    child.once("error", error => {
      if (settled) {
        return;
      }

      settled = true;

      activeChildProcesses.delete(child);

      reject(error);
    });

    child.once("close", (code, signal) => {
      if (settled) {
        return;
      }

      settled = true;

      activeChildProcesses.delete(child);

      resolve({
        code,
        signal,
        stdout
      });
    });
  });
}

async function runAdb(emulator, args) {
  console.log(`> adb -s "${emulator}" ${args.join(" ")}`);

  if (shuttingDown) {
    throw new Error("Interrupted.");
  }

  const result = await runChildProcess(
    "adb",
    ["-s", emulator, ...args],
    true
  );

  if (result.code !== 0) {
    throw new Error(
      `adb failed with exit code: ${result.code}`
    );
  }

  return result.stdout.trim();
}

function safeName(name) {
  return name.replace(/[<>:"/\\|?*]/g, "_");
}

function parseSelection(input, max) {
  input = input.trim().toLowerCase();

  if (input === "all") {
    return Array.from({ length: max }, (_, i) => i);
  }

  const selected = new Set();

  for (const part of input.split(",")) {
    const value = part.trim();

    if (!value) {
      return null;
    }

    if (value.includes("-")) {
      const range = value.split("-");

      if (range.length !== 2) {
        return null;
      }

      const start = Number(range[0]);
      const end = Number(range[1]);

      if (
        !Number.isInteger(start) ||
        !Number.isInteger(end) ||
        start < 1 ||
        end > max ||
        start > end
      ) {
        return null;
      }

      for (let i = start; i <= end; i++) {
        selected.add(i - 1);
      }
    } else {
      const number = Number(value);

      if (
        !Number.isInteger(number) ||
        number < 1 ||
        number > max
      ) {
        return null;
      }

      selected.add(number - 1);
    }
  }

  return [...selected].sort((a, b) => a - b);
}

function parsePackageIds(value) {
  const values = Array.isArray(value)
    ? value
    : String(value || "").split(/[\s,]+/);

  const packages = [];
  const seen = new Set();

  for (const rawValue of values) {
    const packageName = String(rawValue || "").trim();

    if (!packageName) {
      continue;
    }

    if (!/^[A-Za-z0-9][A-Za-z0-9._]+$/.test(packageName)) {
      return null;
    }

    if (!seen.has(packageName)) {
      seen.add(packageName);
      packages.push(packageName);
    }
  }

  return packages;
}

function quoteForDisplay(value) {
  const stringValue = String(value);

  if (/^[A-Za-z0-9_./:=+-]+$/.test(stringValue)) {
    return stringValue;
  }

  return `"${stringValue.replace(/"/g, '\\"')}"`;
}

function redactApkeepArgs(args) {
  const redacted = [];
  let redactNext = false;

  for (const arg of args) {
    if (redactNext) {
      redacted.push("<redacted>");
      redactNext = false;
      continue;
    }

    redacted.push(arg);

    if (arg === "-t" || arg === "--aas-token") {
      redactNext = true;
    }
  }

  return redacted;
}

async function runApkeep(apkeepPath, args) {
  const resolvedApkeep = path.resolve(apkeepPath);
  const displayArgs = redactApkeepArgs(args)
    .map(quoteForDisplay)
    .join(" ");

  console.log(`> ${quoteForDisplay(resolvedApkeep)} ${displayArgs}`);

  const isWindowsScript = /\.(bat|cmd)$/i.test(resolvedApkeep);
  const executable = isWindowsScript
    ? process.env.ComSpec || "cmd.exe"
    : resolvedApkeep;
  const executableArgs = isWindowsScript
    ? ["/d", "/s", "/c", "call", resolvedApkeep, ...args]
    : args;

  if (shuttingDown) {
    return false;
  }

  let result;

  try {
    result = await runChildProcess(
      executable,
      executableArgs
    );
  } catch (error) {
    console.error(`APKeep error: ${error.message}`);
    return false;
  }

  if (shuttingDown) {
    return false;
  }

  if (result.code !== 0) {
    console.error(`APKeep failed with exit code: ${result.code}`);
    return false;
  }

  return true;
}

async function decompileWithJadx(
  jadxPath,
  outputDir,
  apkFiles,
  fast
) {
  fs.mkdirSync(outputDir, { recursive: true });

  const resolvedJadx = path.resolve(jadxPath);
  const resolvedOutput = path.resolve(outputDir);
  const resolvedApks = apkFiles.map(file => path.resolve(file));

  console.log("\nStarting JADX...");
  console.log(`JADX: ${resolvedJadx}`);
  console.log(`Output: ${resolvedOutput}`);
  console.log(`APKs: ${resolvedApks.length}`);

  // Fast mode still decodes resources and deobfuscates so the output includes
  // AndroidManifest.xml and usable source. It only uses cheaper source
  // conversion/logging settings.
  const jadxModeArgs = fast
    ? [
      "--deobf",
      "--no-debug-info",
      "--decompilation-mode",
      "simple",
      "--log-level",
      "error"
    ]
    : [
      "--show-bad-code",
      "--deobf"
    ];

  const args = [
    "/c",
    "call",
    resolvedJadx,
    "-d",
    resolvedOutput,
    ...jadxModeArgs,
    ...resolvedApks
  ];

  if (shuttingDown) {
    return false;
  }

  let result;

  try {
    result = await runChildProcess(
      process.env.ComSpec || "cmd.exe",
      args
    );
  } catch (error) {
    console.error(`\nJADX error: ${error.message}`);
    return false;
  }

  if (shuttingDown) {
    return false;
  }

  if (result.code !== 0) {
    console.error(`\nJADX failed with exit code: ${result.code}`);
    return false;
  }

  return true;
}

function findApkFiles(rootDir) {
  if (!fs.existsSync(rootDir)) {
    return [];
  }

  const files = [];

  for (const entry of fs.readdirSync(rootDir, {
    withFileTypes: true
  })) {
    const fullPath = path.join(rootDir, entry.name);

    if (entry.isDirectory()) {
      files.push(...findApkFiles(fullPath));
    } else if (entry.isFile() && /\.apk$/i.test(entry.name)) {
      files.push(fullPath);
    }
  }

  return files.sort();
}

function removeApkFiles(rootDir) {
  const apkFiles = findApkFiles(rootDir);

  for (const apkFile of apkFiles) {
    try {
      fs.unlinkSync(apkFile);
    } catch (error) {
      console.error(
        `Unable to remove APK before retrying ${apkFile}: ${error.message}`
      );
    }
  }
}

async function pullPackageApks(emulator, selectedPackage, apkDir) {
  let apkPathsOutput;

  try {
    apkPathsOutput = await runAdb(
      emulator,
      ["shell", "pm", "path", selectedPackage]
    );
  } catch {
    console.error(
      `\nUnable to get APK paths for ${selectedPackage}`
    );
    return [];
  }

  const apkPaths = apkPathsOutput
    .split(/\r?\n/)
    .map(line => line.replace(/^package:/, "").trim())
    .filter(Boolean);

  if (!apkPaths.length) {
    console.error(`\nNo APKs found for ${selectedPackage}`);
    return [];
  }

  console.log(`\nFound ${apkPaths.length} APK(s).`);

  const pulledApks = [];

  for (let i = 0; i < apkPaths.length; i++) {
    const remotePath = apkPaths[i];
    const apkName = path.basename(remotePath);
    const localPath = path.join(apkDir, apkName);

    console.log(
      `\n[${i + 1}/${apkPaths.length}] Pulling ${apkName}`
    );

    try {
      await runAdb(
        emulator,
        ["pull", remotePath, localPath]
      );

      if (fs.existsSync(localPath)) {
        pulledApks.push(localPath);
        console.log(`Saved: ${localPath}`);
      }
    } catch {
      console.error(`Failed to pull ${apkName}`);
    }
  }

  return pulledApks;
}

async function downloadPackageApks(
  apkeepPath,
  playStoreEmail,
  asstoken,
  selectedPackage,
  apkDir,
  splitApk,
  retries,
  force,
  apkeepParallel
) {
  fs.mkdirSync(apkDir, { recursive: true });

  if (force) {
    console.log(
      `\n--force enabled: removing existing APKs for ${selectedPackage}`
    );
    removeApkFiles(apkDir);
  }

  const attempts = retries + 1;
  const splitModes = splitApk
    ? [true, false]
    : [false];

  for (let splitModeIndex = 0; splitModeIndex < splitModes.length; splitModeIndex++) {
    const useSplitApk = splitModes[splitModeIndex];

    if (
      splitModeIndex > 0 &&
      !useSplitApk
    ) {
      console.log(
        `\nRetrying ${selectedPackage} with split APK mode disabled.`
      );
      removeApkFiles(apkDir);
    }

    const args = [
      "-a",
      selectedPackage,
      "-d",
      "google-play",
      "-e",
      playStoreEmail,
      "-t",
      asstoken,
      "-r",
      String(apkeepParallel)
    ];

    if (useSplitApk) {
      args.push("-o", "split_apk=true");
    } else if (splitApk) {
      args.push("-o", "split_apk=false");
    }

    // APKeep expects the output directory as its final positional argument.
    args.push(apkDir);

    for (let attempt = 1; attempt <= attempts; attempt++) {
      if (attempt > 1) {
        console.log(
          `\nRetrying ${selectedPackage} ` +
          `(attempt ${attempt}/${attempts})`
        );
      }

      const success = await runApkeep(apkeepPath, args);
      const downloadedApks = findApkFiles(apkDir);

      if (success && downloadedApks.length > 0) {
        console.log(
          `Downloaded ${downloadedApks.length} APK(s) for ${selectedPackage}`
        );
        return downloadedApks;
      }

      if (downloadedApks.length > 0) {
        console.error(
          `APKeep returned an incomplete download for ${selectedPackage}`
        );
      } else {
        console.error(
          `No APK files were downloaded for ${selectedPackage}`
        );
      }

      removeApkFiles(apkDir);
    }
  }

  console.error(
    `\nDownload failed for ${selectedPackage} after ` +
    `${attempts} attempt(s).`
  );

  return [];
}

async function selectEmulatorPackages(
  emulator,
  packageSearch,
  selectAll
) {
  let packageOutput;

  try {
      packageOutput = await runAdb(
      emulator,
      ["shell", "pm", "list", "packages"]
    );
  } catch {
    throw new Error("Unable to list packages.");
  }

  const packages = packageOutput
    .split(/\r?\n/)
    .map(line => line.replace(/^package:/, "").trim())
    .filter(pkg => {
      const search = String(packageSearch || "")
        .trim()
        .toLowerCase();

      return !search || pkg.toLowerCase().includes(search);
    });

  if (!packages.length) {
    throw new Error(
      `No packages found matching: ${packageSearch || "(all packages)"}`
    );
  }

  console.log("\nMatching packages:");

  packages.forEach((pkg, index) => {
    console.log(`${index + 1}. ${pkg}`);
  });

  console.log("\nPackage selection:");
  console.log("  1       = One package");
  console.log("  1-5     = Package range");
  console.log("  1,3,7   = Specific packages");
  console.log("  1-3,7   = Range + specific packages");
  console.log("  all     = All matching packages");

  if (selectAll) {
    return packages;
  }

  let selectedIndexes = null;

  while (!selectedIndexes) {
    const selection = await ask("\nSelect package(s): ");

    selectedIndexes = parseSelection(
      selection,
      packages.length
    );

    if (!selectedIndexes || selectedIndexes.length === 0) {
      console.log(
        "\nInvalid selection. Example: 1,3,5 or 1-5 or all"
      );
    }
  }

  return selectedIndexes.map(index => packages[index]);
}

async function selectDownloadPackages(
  apkBaseDir,
  {
    packages: explicitPackages,
    developerUrl: configuredDeveloperUrl,
    selectAll,
    force
  }
) {
  if (explicitPackages && explicitPackages.length > 0) {
    return explicitPackages;
  }

  const discoveryOutputDir = path.join(
    path.resolve(apkBaseDir),
    "_playstore-discovery"
  );
  const discoveryOutput = path.join(
    discoveryOutputDir,
    "playstore_app_list.json"
  );

  let apps;

  if (
    !force &&
    fs.existsSync(discoveryOutput)
  ) {
    console.log(
      `\nUsing cached Play Store app list: ${discoveryOutput}`
    );

    let cachedApps;

    try {
      cachedApps = JSON.parse(
        fs.readFileSync(discoveryOutput, "utf8")
      );
    } catch (error) {
      throw new Error(
        `Unable to read cached Play Store app list: ${error.message}. ` +
        "Use --force to refresh it."
      );
    }

    if (!Array.isArray(cachedApps)) {
      throw new Error(
        `Cached Play Store app list is not an array: ${discoveryOutput}. ` +
        "Use --force to refresh it."
      );
    }

    apps = cachedApps;
  } else {
    if (force && fs.existsSync(discoveryOutput)) {
      console.log(
        "\n--force enabled: refreshing the Play Store app list."
      );
    }

    const developerUrl = await getInput(
      configuredDeveloperUrl,
      "Enter Google Play developer URL: "
    );

    if (!developerUrl) {
      throw new Error("A Google Play developer URL is required.");
    }

    const discovery = await discoverDeveloperApps(
      developerUrl,
      {
        outputDir: discoveryOutputDir
      }
    );

    apps = discovery.apps;
  }

  const packages = apps
    .map(app => app && app.package)
    .filter(Boolean);

  if (!packages.length) {
    throw new Error(
      "No package IDs were found on the developer page."
    );
  }

  console.log("\nDiscovered package selection:");
  packages.forEach((pkg, index) => {
    console.log(`${index + 1}. ${pkg}`);
  });

  console.log("\nPackage selection:");
  console.log("  1       = One package");
  console.log("  1-5     = Package range");
  console.log("  1,3,7   = Specific packages");
  console.log("  1-3,7   = Range + specific packages");
  console.log("  all     = All discovered packages");

  if (selectAll) {
    return packages;
  }

  let selectedIndexes = null;

  while (!selectedIndexes) {
    const selection = await ask("\nSelect package(s): ");

    selectedIndexes = parseSelection(
      selection,
      packages.length
    );

    if (!selectedIndexes || selectedIndexes.length === 0) {
      console.log(
        "\nInvalid selection. Example: 1,3,5 or 1-5 or all"
      );
    }
  }

  return selectedIndexes.map(index => packages[index]);
}

function findExistingPackageGroups(apkBaseDir) {
  const resolvedBaseDir = path.resolve(apkBaseDir);
  const groups = new Map();

  for (const apkFile of findApkFiles(resolvedBaseDir)) {
    const relativePath = path.relative(
      resolvedBaseDir,
      path.resolve(apkFile)
    );
    const pathParts = relativePath.split(path.sep);
    const packageName = pathParts.length > 1
      ? pathParts[0]
      : path.basename(apkFile, path.extname(apkFile));

    if (!groups.has(packageName)) {
      groups.set(packageName, []);
    }

    groups.get(packageName).push(apkFile);
  }

  return [...groups.entries()]
    .map(([packageName, apkFiles]) => ({
      packageName,
      apkFiles: apkFiles.sort()
    }))
    .sort((left, right) =>
      left.packageName.localeCompare(right.packageName)
    );
}

async function selectExistingPackages(
  apkBaseDir,
  explicitPackages,
  selectAll
) {
  const groups = findExistingPackageGroups(apkBaseDir);

  if (!groups.length) {
    throw new Error(
      `No APK files found under: ${path.resolve(apkBaseDir)}`
    );
  }

  if (explicitPackages && explicitPackages.length > 0) {
    const available = new Set(
      groups.map(group => group.packageName)
    );
    const missing = explicitPackages.filter(pkg =>
      !available.has(pkg) &&
      !available.has(safeName(pkg))
    );

    if (missing.length > 0) {
      throw new Error(
        `No APK files found for: ${missing.join(", ")}`
      );
    }

    return explicitPackages;
  }

  console.log("\nExisting APK groups:");

  groups.forEach((group, index) => {
    console.log(
      `${index + 1}. ${group.packageName} (${group.apkFiles.length} APK(s))`
    );
  });

  if (selectAll) {
    return groups.map(group => group.packageName);
  }

  console.log("\nPackage selection:");
  console.log("  1       = One package");
  console.log("  1-5     = Package range");
  console.log("  1,3,7   = Specific packages");
  console.log("  1-3,7   = Range + specific packages");
  console.log("  all     = All existing APK groups");

  let selectedIndexes = null;

  while (!selectedIndexes) {
    const selection = await ask("\nSelect package(s): ");

    selectedIndexes = parseSelection(
      selection,
      groups.length
    );

    if (!selectedIndexes || selectedIndexes.length === 0) {
      console.log(
        "\nInvalid selection. Example: 1,3,5 or 1-5 or all"
      );
    }
  }

  return selectedIndexes.map(index => groups[index].packageName);
}

function findPackageApks(apkBaseDir, selectedPackage) {
  const packageDir = path.resolve(
    apkBaseDir,
    safeName(selectedPackage)
  );
  const packageFiles = findApkFiles(packageDir);

  if (packageFiles.length > 0) {
    return packageFiles;
  }

  const matchingGroup = findExistingPackageGroups(apkBaseDir)
    .find(group =>
      group.packageName === selectedPackage ||
      group.packageName === safeName(selectedPackage)
    );

  return matchingGroup ? matchingGroup.apkFiles : [];
}

function selectBaseApk(apkFiles, selectedPackage) {
  if (apkFiles.length <= 1) {
    return apkFiles;
  }

  const packageBaseName = safeName(selectedPackage)
    .toLowerCase();
  const exactBaseApk = apkFiles.find(file =>
    path.basename(file).toLowerCase() === "base.apk"
  );

  const packageApk = apkFiles.find(file =>
    path.basename(file).toLowerCase() ===
    `${packageBaseName}.apk`
  );

  const namedBaseApk = apkFiles.find(file =>
    /^base(?:[-_.].*)?\.apk$/i.test(
      path.basename(file)
    )
  );

  const baseApk = exactBaseApk || packageApk || namedBaseApk;

  if (!baseApk) {
    throw new Error(
      `--fast could not identify the base APK for ${selectedPackage}. ` +
      `Expected base.apk or ${safeName(selectedPackage)}.apk. ` +
      `Found: ${apkFiles.map(file => path.basename(file)).join(", ")}`
    );
  }

  console.log(
    `\n--fast enabled: using base APK ${path.basename(baseApk)}`
  );

  return [baseApk];
}

async function processPackage({
  selectedPackage,
  mode,
  source,
  emulator,
  apkeepPath,
  playStoreEmail,
  asstoken,
  jadxPath,
  apkBaseDir,
  decompiledBaseDir,
  splitApk,
  fast,
  retries,
  force,
  apkeepParallel
}) {
  if (shuttingDown) {
    return;
  }

  console.log("\n================================");
  console.log(`Processing: ${selectedPackage}`);
  console.log("================================");

  const acquisitionMode = mode === "full"
    ? source
    : mode;
  const shouldDecompile = [
    "full",
    "decompile"
  ].includes(mode);

  const apkDir = path.resolve(
    apkBaseDir,
    safeName(selectedPackage)
  );

  const decompiledDir = shouldDecompile
    ? path.resolve(
      decompiledBaseDir,
      safeName(selectedPackage)
    )
    : null;

  let apkFiles;
  const isDownloadMode = acquisitionMode === "download";

  if (
    isDownloadMode &&
    !force
  ) {
    const existingApks = findApkFiles(apkDir);

    if (existingApks.length > 0) {
      console.log(
        `\nFound ${existingApks.length} existing APK(s) for ` +
        `${selectedPackage}; skipping download.`
      );
      console.log("Use --force to download it again.");
      apkFiles = existingApks;

      if (mode === "download") {
        return;
      }
    }
  }

  if (apkFiles) {
    // Full mode reuses existing APKs and continues to decompilation.
  } else if (mode === "decompile") {
    apkFiles = findPackageApks(
      apkBaseDir,
      selectedPackage
    );
  } else if (acquisitionMode === "download") {
    fs.mkdirSync(apkDir, { recursive: true });
    apkFiles = await downloadPackageApks(
      apkeepPath,
      playStoreEmail,
      asstoken,
      selectedPackage,
      apkDir,
      splitApk,
      retries,
      force,
      apkeepParallel
    );
  } else {
    fs.mkdirSync(apkDir, { recursive: true });
    apkFiles = await pullPackageApks(
      emulator,
      selectedPackage,
      apkDir
    );
  }

  if (!apkFiles.length) {
    console.error(
      `\nNo APKs available for ${selectedPackage}`
    );
    return;
  }

  if (shouldDecompile) {
    const decompileApks = fast
      ? selectBaseApk(apkFiles, selectedPackage)
      : apkFiles;

    const success = await decompileWithJadx(
      jadxPath,
      decompiledDir,
      decompileApks,
      fast
    );

    if (success) {
      console.log(
        `\nJADX completed for ${selectedPackage}`
      );
    } else {
      console.error(
        `\nJADX failed for ${selectedPackage}`
      );
    }
  }

  const apkLocation = mode === "decompile"
    ? path.dirname(apkFiles[0])
    : apkDir;

  console.log(`\nAPKs: ${apkLocation}`);

  if (shouldDecompile) {
    console.log(`Decompiled: ${decompiledDir}`);
  }
}

async function processPackages({
  selectedPackages,
  mode,
  source,
  emulator,
  apkeepPath,
  playStoreEmail,
  asstoken,
  jadxPath,
  apkBaseDir,
  decompiledBaseDir,
  splitApk,
  fast,
  retries,
  force,
  apkeepParallel,
  decompileParallel
}) {
  console.log("\nSelected packages:");

  selectedPackages.forEach(pkg => {
    console.log(`- ${pkg}`);
  });

  const workerCount = mode === "decompile" && fast
    ? Math.min(decompileParallel, selectedPackages.length)
    : 1;
  let nextPackageIndex = 0;

  async function worker() {
    while (!shuttingDown) {
      const packageIndex = nextPackageIndex++;

      if (packageIndex >= selectedPackages.length) {
        return;
      }

      await processPackage({
        selectedPackage: selectedPackages[packageIndex],
        mode,
        source,
        emulator,
        apkeepPath,
        playStoreEmail,
        asstoken,
        jadxPath,
        apkBaseDir,
        decompiledBaseDir,
        splitApk,
        fast,
        retries,
        force,
        apkeepParallel
      });
    }
  }

  await Promise.all(
    Array.from(
      { length: workerCount },
      () => worker()
    )
  );
}

async function main() {
  const options = parseCliArgs(process.argv.slice(2));

  if (options.help) {
    printUsage();
    return;
  }

  const {
    mode,
    source,
    all: selectAll,
    splitApk,
    fast,
    retries,
    force,
    apkeepParallel,
    decompileParallel
  } = options;

  console.log("================================");
  console.log("APK Pull/Download + JADX Decompiler");
  console.log("================================");
  console.log(
    `Mode: ${mode}${mode === "full" ? ` (${source} + decompile)` : ""}`
  );

  const apkBaseDir = await getInput(
    options.apkBaseDir,
    "Enter APK storage path: "
  );

  if (!apkBaseDir) {
    throw new Error("An APK storage path is required.");
  }

  let decompiledBaseDir;
  let resolvedJadx;

  if (["full", "decompile"].includes(mode)) {
    decompiledBaseDir = await getInput(
      options.decompiledBaseDir,
      "Enter decompiled APK path: "
    );

    const jadxPath = await getInput(
      options.jadxPath,
      "\nEnter JADX executable path: "
    );

    if (!decompiledBaseDir || !jadxPath) {
      throw new Error(
        "JADX and decompiled APK paths are required."
      );
    }

    resolvedJadx = path.resolve(jadxPath);

    if (!fs.existsSync(resolvedJadx)) {
      throw new Error(`JADX not found: ${resolvedJadx}`);
    }
  }

  const explicitPackages = parsePackageIds(options.packages);

  if (
    options.packages !== undefined &&
    !explicitPackages
  ) {
    throw new Error(
      "Invalid package list. Use IDs such as com.example.app separated by commas."
    );
  }

  let selectedPackages;
  let apkeepPath;
  let playStoreEmail;
  let asstoken;
  let emulator;

  if (
    mode === "download" ||
    (mode === "full" && source === "download")
  ) {
    apkeepPath = await getInput(
      options.apkeepPath,
      "\nEnter APKeep executable path: "
    );

    playStoreEmail = await getInput(
      options.playStoreEmail,
      "Enter Google Play email: "
    );

    asstoken = await getInput(
      options.asstoken,
      "Enter Google Play AAS token: "
    );

    if (!apkeepPath || !playStoreEmail || !asstoken) {
      throw new Error(
        "APKeep path, Google Play email, and AAS token are required."
      );
    }

    const resolvedApkeep = path.resolve(apkeepPath);

    if (!fs.existsSync(resolvedApkeep)) {
      throw new Error(`APKeep not found: ${resolvedApkeep}`);
    }

    selectedPackages = await selectDownloadPackages(
      apkBaseDir,
      {
        packages: explicitPackages,
        developerUrl: options.developerUrl,
        selectAll,
        force
      }
    );
    apkeepPath = resolvedApkeep;
  } else if (
    mode === "pull" ||
    (mode === "full" && source === "pull")
  ) {
    emulator = await getInput(
      options.emulator,
      "\nEnter emulator/device name: "
    );

    if (!emulator) {
      throw new Error("An emulator/device name is required.");
    }

    try {
      await runAdb(emulator, ["get-state"]);
    } catch {
      throw new Error(`Device not available: ${emulator}`);
    }

    if (explicitPackages && explicitPackages.length > 0) {
      selectedPackages = explicitPackages;
    } else {
      const packageSearch = selectAll
        ? options.packageSearch || ""
        : await getInput(
          options.packageSearch,
          "\nEnter package search text (blank = all packages): "
        );

      selectedPackages = await selectEmulatorPackages(
        emulator,
        packageSearch,
        selectAll
      );
    }
  } else {
    selectedPackages = await selectExistingPackages(
      apkBaseDir,
      explicitPackages,
      selectAll
    );
  }

  await processPackages({
    selectedPackages,
    mode,
    source,
    emulator,
    apkeepPath,
    playStoreEmail,
    asstoken,
    jadxPath: resolvedJadx,
    apkBaseDir,
    decompiledBaseDir,
    splitApk,
    fast,
    retries,
    force,
    apkeepParallel,
    decompileParallel
  });

  console.log("\n================================");
  console.log("Completed");
  console.log("================================");
}

main()
  .catch(error => {
    console.error("\nError:");
    console.error(error.message || error);
    process.exitCode = 1;
  })
  .finally(() => {
    if (!rl.closed) {
      rl.close();
    }
  });
