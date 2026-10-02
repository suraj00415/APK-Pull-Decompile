const fs = require("node:fs");
const path = require("node:path");
const {
  ensureDirectory,
  fileSignature,
  findApks,
  loadProcessing,
  packageDirectoryName,
  publishDirectory,
  readJson,
  recoverDirectorySwaps,
  removeOwnedPath,
  saveProcessing
} = require("./storage");
const { packageIsIncluded, packageMatchesAny } = require("./targets");

function currentProcessing(settings) {
  return loadProcessing(settings.dataDir);
}

function saveRecord(settings, state) {
  saveProcessing(settings.dataDir, state);
}

function recordFor(state, packageName) {
  return Object.prototype.hasOwnProperty.call(state.packages, packageName)
    ? state.packages[packageName]
    : {};
}

async function acquisitionIsValid(record) {
  const acquisition = record?.acquisition;

  if (!acquisition || !Array.isArray(acquisition.files) || !acquisition.files.length) {
    return false;
  }

  try {
    const current = await fileSignature(acquisition.files.map(file => file.path));
    return JSON.stringify(current) === JSON.stringify(acquisition.files);
  } catch {
    return false;
  }
}

function selectedApp(pack, developer) {
  return {
    package: pack,
    developerId: developer?.developerId || "",
    developerName: developer?.developerName || "",
    title: developer?.title || "",
    url: developer?.url ||
      `https://play.google.com/store/apps/details?id=${pack}`,
    version: developer?.version || null
  };
}

function filterAvailableApps(apps, settings) {
  return apps.filter(app => {
    if (!app || typeof app.package !== "string") {
      return false;
    }
    const developer = settings.developers.find(
      item => item.id === String(app.developerId || "")
    );
    return packageIsIncluded(app.package, developer, settings);
  });
}

async function devicePackages(settings, runTool, signal) {
  const args = [];
  if (settings.pull.device) {
    args.push("-s", settings.pull.device);
  }
  args.push("shell", "pm", "list", "packages");
  const result = await runTool(settings.pull.adb, args, {
    signal,
    captureStdout: true
  });

  if (result.code !== 0) {
    throw new Error(
      `Could not list installed apps with ADB (exit code ${result.code}).`
    );
  }

  const installed = result.stdout
    .split(/\r?\n/)
    .map(line => line.replace(/^package:/, "").trim())
    .filter(Boolean);

  const allowed = settings.packages;
  let inventory = [];
  const inventoryPath = settings.standalone?.fromAppList ||
    path.join(settings.dataDir, "apps.json");
  try {
    inventory = readJson(inventoryPath, []);
  } catch (error) {
    throw new Error(`Could not read the saved app inventory: ${error.message}`);
  }
  const listedPackages = new Set(
    inventory
      .filter(app => app && typeof app.package === "string")
      .map(app => app.package)
  );
  const restrictToInventory = Boolean(settings.standalone?.fromAppList);
  const ownersByPackage = new Map();
  for (const app of inventory) {
    if (!app || typeof app.package !== "string" || !app.developerId) {
      continue;
    }
    if (!ownersByPackage.has(app.package)) {
      ownersByPackage.set(app.package, []);
    }
    ownersByPackage.get(app.package).push(app);
  }
  const hasPublisherFilters = settings.developers.some(
    developer => developer.includePackages.length > 0
  );
  return installed
    .filter(packageName => {
      if ((allowed.length > 0 &&
            !packageMatchesAny(packageName, allowed)) ||
          packageMatchesAny(packageName, settings.excludePackages) ||
          (restrictToInventory && !listedPackages.has(packageName))) {
        return false;
      }

      const rows = ownersByPackage.get(packageName) || [];
      if (rows.length > 0) {
        return rows.some(row => {
          const developer = settings.developers.find(
            item => item.id === String(row.developerId)
          );
          return packageIsIncluded(packageName, developer, settings);
        });
      }

      if (!hasPublisherFilters || packageMatchesAny(packageName, settings.packages)) {
        return true;
      }

      return settings.developers.some(developer =>
        packageMatchesAny(packageName, developer.includePackages) &&
        !packageMatchesAny(packageName, developer.excludePackages)
      );
    })
    .map(packageName => {
      const firstOwner = ownersByPackage.get(packageName)?.[0];
      return selectedApp(packageName, firstOwner);
    });
}

async function selectApps(settings, options = {}) {
  if (Array.isArray(options.apps)) {
    return filterAvailableApps(options.apps, settings);
  }

  const explicitPackages = settings.packages;
  if (settings.pull.source === "device" && options.all) {
    const apps = await devicePackages(
      settings,
      options.runTool,
      options.signal
    );
    if (apps.length === 0) {
      throw new Error("No installed apps match the configured package filters.");
    }
    return apps;
  }

  let inventoryPath = settings.standalone.fromAppList;
  if (!inventoryPath) {
    inventoryPath = path.join(settings.dataDir, "apps.json");
  }

  let inventory = [];
  try {
    inventory = readJson(inventoryPath, []);
  } catch (error) {
    throw new Error(`Could not read app inventory ${inventoryPath}: ${error.message}`);
  }
  if (!Array.isArray(inventory)) {
    throw new Error(`App inventory must be a JSON array: ${inventoryPath}`);
  }

  const inventoryPackages = new Set(
    inventory
      .filter(app => app && typeof app.package === "string")
      .map(app => app.package)
  );
  inventory = filterAvailableApps(inventory, settings);
  const byPackage = new Map(inventory.map(app => [app.package, app]));
  for (const packageName of explicitPackages.filter(item => !item.includes("*"))) {
    if (!byPackage.has(packageName) &&
        !inventoryPackages.has(packageName) &&
        packageIsIncluded(packageName, null, settings)) {
      byPackage.set(packageName, selectedApp(packageName));
    }
  }

  const apps = [...byPackage.values()];
  if (apps.length === 0) {
    throw new Error(
      `No app targets found. Set targets.packages, run "npm run monitor", or pass --from-app-list <file> or --all.`
    );
  }

  if (settings.pull.source === "device" && options.all && explicitPackages.length > 0) {
    return apps;
  }

  return apps;
}

function adbPrefix(settings) {
  const prefix = [];
  if (settings.pull.device) {
    prefix.push("-s", settings.pull.device);
  }
  return prefix;
}

function assertNotAborted(signal) {
  if (signal?.aborted) {
    throw signal.reason || new Error("Operation interrupted.");
  }
}

function makeStage(settings, packageName) {
  packageDirectoryName(packageName);
  const stage = fs.mkdtempSync(
    path.join(settings.apkDir, `.staging-${packageName}-`)
  );
  return { stage };
}

function clearStage(settings, stage) {
  removeOwnedPath(settings.apkDir, stage);
  fs.mkdirSync(stage, { recursive: true });
}

async function runApkeep(settings, packageName, stage, options) {
  const splitModes = settings.pull.splitApk
    ? [true, false]
    : [false];

  for (const useSplits of splitModes) {
    if (!useSplits && settings.pull.splitApk) {
      options.logger.log(`Retrying ${packageName} with split APKs disabled.`);
      clearStage(settings, stage);
    }

    const args = [
      "-a", packageName,
      "-d", "google-play",
      "-e", settings.pull.email,
      "-t", settings.pull.aasToken,
      "-r", String(settings.pull.downloadParallel)
    ];

    if (useSplits) {
      args.push("-o", "split_apk=true");
    } else if (settings.pull.splitApk) {
      args.push("-o", "split_apk=false");
    }
    args.push(stage);

    for (let attempt = 0; attempt <= settings.pull.retries; attempt++) {
      assertNotAborted(options.signal);

      if (attempt > 0) {
        options.logger.log(
          `Retrying ${packageName} (attempt ${attempt + 1}/${settings.pull.retries + 1}).`
        );
        clearStage(settings, stage);
      }

      const result = await options.runTool(settings.pull.apkeep, args, {
        signal: options.signal,
        showOutput: true,
        captureStdout: false
      });
      const apkFiles = findApks(stage);

      if (result.code === 0 && apkFiles.length > 0) {
        return apkFiles;
      }

      if (result.code === 0) {
        options.logger.error(`APKeep produced no APK files for ${packageName}.`);
      } else {
        options.logger.error(
          `APKeep failed for ${packageName} with exit code ${result.code}.`
        );
      }
    }
  }

  return [];
}

function splitAdbApkPaths(output) {
  return output
    .split(/\r?\n/)
    .map(line => line.replace(/^package:/, "").trim())
    .filter(Boolean);
}

async function readDeviceVersion(settings, packageName, runTool, signal) {
  const result = await runTool(
    settings.pull.adb,
    [
      ...adbPrefix(settings),
      "shell",
      "dumpsys",
      "package",
      packageName
    ],
    { signal, captureStdout: true }
  );

  if (result.code !== 0) {
    throw new Error(`Could not read installed version for ${packageName}.`);
  }

  const match = result.stdout.match(/^\s*versionName=(.+?)\s*$/m);
  return match ? match[1].trim() : null;
}

async function pullFromDevice(settings, packageName, stage, options) {
  const listing = await options.runTool(
    settings.pull.adb,
    [
      ...adbPrefix(settings),
      "shell",
      "pm",
      "path",
      packageName
    ],
    { signal: options.signal, captureStdout: true }
  );

  if (listing.code !== 0) {
    throw new Error(
      `ADB could not locate ${packageName} on ${settings.pull.device || "the connected device"}.`
    );
  }

  const remotePaths = splitAdbApkPaths(listing.stdout);
  if (remotePaths.length === 0) {
    throw new Error(`ADB returned no APK paths for ${packageName}.`);
  }

  const names = new Set();
  const files = [];
  for (const remotePath of remotePaths) {
    assertNotAborted(options.signal);
    const fileName = path.posix.basename(remotePath);
    if (!fileName || names.has(fileName)) {
      throw new Error(`ADB returned duplicate or invalid APK file names for ${packageName}.`);
    }
    names.add(fileName);
    const localPath = path.join(stage, fileName);
    const result = await options.runTool(
      settings.pull.adb,
      [...adbPrefix(settings), "pull", remotePath, localPath],
      { signal: options.signal, captureStdout: false, showOutput: true }
    );

    if (result.code !== 0 || !fs.existsSync(localPath)) {
      throw new Error(`ADB failed to pull ${remotePath} for ${packageName}.`);
    }
    files.push(localPath);
  }

  return files;
}

function failureRecord(existing, app, error) {
  return {
    ...existing,
    lastAttemptAt: new Date().toISOString(),
    pendingVersion: app.version || null,
    lastError: error.message
  };
}

async function verifyDeviceVersion(settings, packageName, app, runTool, signal) {
  if (settings.pull.source !== "device" || !app.version) {
    return null;
  }

  const installedVersion = await readDeviceVersion(
    settings,
    packageName,
    runTool,
    signal
  );
  if (installedVersion !== app.version) {
    throw new Error(
      `${packageName} is ${installedVersion || "an unknown version"} on the device, ` +
      `but Google Play reports ${app.version}. Update the app on the device and retry.`
    );
  }
  return installedVersion;
}

async function acquireApps(settings, apps, options = {}) {
  const logger = options.logger || console;
  const state = options.processing || currentProcessing(settings);
  const results = [];
  const runTool = options.runTool;

  if (typeof runTool !== "function") {
    throw new Error("APK acquisition requires a process runner.");
  }

  ensureDirectory(settings.apkDir);
  ensureDirectory(settings.dataDir);
  recoverDirectorySwaps(settings.apkDir);

  for (const app of apps) {
    assertNotAborted(options.signal);
    const packageName = packageDirectoryName(app.package);
    const existing = recordFor(state, packageName);
    const targetDirectory = path.join(settings.apkDir, packageName);
    let reused = false;
    let installedVersion = null;

    if (!settings.pipeline.force && await acquisitionIsValid(existing) &&
        existing.acquisition.source === settings.pull.source &&
        existing.acquisition.device === settings.pull.device &&
        (app.version == null ||
          app.version === existing.acquisition.observedVersion)) {
      try {
        installedVersion = await verifyDeviceVersion(
          settings,
          packageName,
          app,
          runTool,
          options.signal
        );
      } catch (error) {
        if (options.signal?.aborted) {
          throw options.signal.reason || error;
        }
        state.packages[packageName] = failureRecord(existing, app, error);
        saveRecord(settings, state);
        logger.error(`APK acquisition failed for ${packageName}: ${error.message}`);
        results.push({ package: packageName, status: "failed", error: error.message });
        continue;
      }

      logger.log(`Reusing verified APKs for ${packageName}.`);
      results.push({
        package: packageName,
        status: "reused",
        apkFiles: existing.acquisition.files.map(file => file.path),
        acquisition: existing.acquisition
      });
      reused = true;
    }

    if (reused) {
      continue;
    }

    let stage;

    try {
      installedVersion = await verifyDeviceVersion(
        settings,
        packageName,
        app,
        runTool,
        options.signal
      );
      stage = makeStage(settings, packageName).stage;

      const apkFiles = settings.pull.source === "device"
        ? await pullFromDevice(settings, packageName, stage, {
          runTool,
          signal: options.signal
        })
        : await runApkeep(settings, packageName, stage, {
          runTool,
          logger,
          signal: options.signal
        });

      if (!apkFiles.length) {
        throw new Error(
          `Could not acquire APKs for ${packageName} after the configured retries.`
        );
      }

      const files = await fileSignature(apkFiles);
      const acquisition = {
        source: settings.pull.source,
        device: settings.pull.source === "device" ? settings.pull.device : null,
        observedVersion: app.version || null,
        installedVersion,
        files,
        completedAt: new Date().toISOString()
      };

      publishDirectory(settings.apkDir, stage, targetDirectory);
      const publishedFiles = await fileSignature(
        files.map(file =>
          path.join(targetDirectory, path.relative(stage, file.path))
        )
      );
      state.packages[packageName] = {
        ...recordFor(state, packageName),
        acquisition: { ...acquisition, files: publishedFiles },
        lastAttemptAt: new Date().toISOString(),
        pendingVersion: null,
        lastError: null
      };
      saveRecord(settings, state);
      results.push({
        package: packageName,
        status: "acquired",
        apkFiles: publishedFiles.map(file => file.path),
        acquisition: state.packages[packageName].acquisition
      });
      logger.log(`Saved ${publishedFiles.length} APK(s) for ${packageName}.`);
    } catch (error) {
      if (options.signal?.aborted) {
        throw options.signal.reason || error;
      }

      try {
        if (stage) {
          removeOwnedPath(settings.apkDir, stage);
        }
      } catch {
        // Keep the acquisition failure as the main diagnostic.
      }
      state.packages[packageName] = failureRecord(
        recordFor(state, packageName),
        app,
        error
      );
      saveRecord(settings, state);
      logger.error(`APK acquisition failed for ${packageName}: ${error.message}`);
      results.push({ package: packageName, status: "failed", error: error.message });
    }
  }

  return {
    results,
    processing: state,
    failed: results.some(result => result.status === "failed")
  };
}

module.exports = {
  acquireApps,
  acquisitionIsValid,
  devicePackages,
  filterAvailableApps,
  readDeviceVersion,
  selectApps,
  verifyDeviceVersion
};
