const fs = require("node:fs");
const path = require("node:path");
const {
  ensureDirectory,
  fileSignature,
  findApks,
  groupApks,
  loadProcessing,
  packageDirectoryName,
  publishDirectory,
  readJson,
  recoverDirectorySwaps,
  removeOwnedPath,
  saveProcessing
} = require("./storage");
const { filterAvailableApps } = require("./acquisition");
const { packageIsIncluded } = require("./targets");

function selectBaseApk(apkFiles, packageName) {
  if (apkFiles.length <= 1) {
    return apkFiles;
  }

  const packageApkName = `${packageDirectoryName(packageName)}.apk`.toLowerCase();
  const exactBase = apkFiles.find(file =>
    path.basename(file).toLowerCase() === "base.apk"
  );
  const packageApk = apkFiles.find(file =>
    path.basename(file).toLowerCase() === packageApkName
  );
  const namedBase = apkFiles.find(file =>
    /^base(?:[-_.].*)?\.apk$/i.test(path.basename(file))
  );
  const base = exactBase || packageApk || namedBase;

  if (!base) {
    throw new Error(
      `Fast mode could not identify the base APK for ${packageName}. ` +
      `Expected base.apk or ${packageApkName}; found: ` +
      apkFiles.map(file => path.basename(file)).join(", ")
    );
  }

  return [base];
}

function listOutputFiles(directory) {
  const files = [];

  function walk(current) {
    if (!fs.existsSync(current)) {
      return;
    }

    for (const entry of fs.readdirSync(current, { withFileTypes: true })) {
      if (entry.isSymbolicLink()) {
        throw new Error(`JADX output contains an unsupported symbolic link: ${path.join(current, entry.name)}`);
      }
      const fullPath = path.join(current, entry.name);
      if (entry.isDirectory()) {
        walk(fullPath);
      } else if (entry.isFile()) {
        files.push(fullPath);
      }
    }
  }

  walk(directory);
  return files.sort();
}

async function decompilationIsValid(settings, record, sourceFiles) {
  const previous = record?.decompilation;
  if (
    !previous ||
    previous.jadx !== settings.decompile.jadx ||
    previous.fast !== settings.decompile.fast ||
    !Array.isArray(previous.sourceFiles) ||
    !Array.isArray(previous.outputFiles) ||
    !previous.outputFiles.length
  ) {
    return false;
  }

  try {
    const [currentSource, currentOutput] = await Promise.all([
      fileSignature(sourceFiles),
      fileSignature(previous.outputFiles.map(file => file.path))
    ]);
    return JSON.stringify(currentSource) === JSON.stringify(previous.sourceFiles) &&
      JSON.stringify(currentOutput) === JSON.stringify(previous.outputFiles);
  } catch {
    return false;
  }
}

function inventoryTargets(settings, options = {}) {
  if (Array.isArray(options.apps)) {
    return filterAvailableApps(options.apps, settings);
  }

  const inventoryPath = settings.standalone.fromAppList ||
    path.join(settings.dataDir, "apps.json");
  let inventory;

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
  for (const packageName of settings.packages.filter(item => !item.includes("*"))) {
    if (!byPackage.has(packageName) &&
        !inventoryPackages.has(packageName) &&
        packageIsIncluded(packageName, null, settings)) {
      byPackage.set(packageName, {
        package: packageName,
        title: "",
        developerId: "",
        developerName: "",
        version: null
      });
    }
  }

  if (options.all) {
    for (const group of groupApks(settings.apkDir)) {
      if (!packageIsIncluded(group.packageName, null, settings) ||
          (inventoryPackages.has(group.packageName) &&
            !byPackage.has(group.packageName))) {
        continue;
      }
      if (!byPackage.has(group.packageName)) {
        byPackage.set(group.packageName, {
          package: group.packageName,
          title: "",
          version: null
        });
      }
    }
  }

  return [...byPackage.values()];
}

function sourceApksForPackage(settings, app, processing) {
  const record = processing.packages[app.package];
  const staged = record?.acquisition?.files;

  if (Array.isArray(staged) && staged.length > 0) {
    const files = staged.map(file => file.path);
    if (files.every(file => fs.existsSync(file))) {
      return files;
    }
  }

  const folder = path.join(settings.apkDir, packageDirectoryName(app.package));
  return findApks(folder);
}

async function decompileOne(settings, app, sourceFiles, processing, options) {
  const packageName = packageDirectoryName(app.package);
  const previous = processing.packages[packageName] || {};
  const outputDirectory = path.join(settings.decompiledDir, packageName);

  if (!settings.pipeline.force &&
      await decompilationIsValid(settings, previous, sourceFiles)) {
    options.logger.log(`Reusing verified JADX output for ${packageName}.`);
    return {
      package: packageName,
      status: "reused",
      outputDirectory,
      decompilation: previous.decompilation
    };
  }

  const stageDirectory = fs.mkdtempSync(
    path.join(settings.decompiledDir, `.staging-${packageName}-`)
  );

  try {
    const jadxInputFiles = settings.decompile.fast
      ? selectBaseApk(sourceFiles, packageName)
      : sourceFiles;
    const modeArguments = settings.decompile.fast
      ? [
        "--deobf",
        "--no-debug-info",
        "--decompilation-mode",
        "simple",
        "--log-level",
        "error"
      ]
      : ["--show-bad-code", "--deobf"];

    const result = await options.runTool(
      settings.decompile.jadx,
      ["-d", stageDirectory, ...modeArguments, ...jadxInputFiles],
      {
        signal: options.signal,
        showOutput: true,
        captureStdout: false
      }
    );

    if (result.code !== 0) {
      throw new Error(`JADX exited with code ${result.code}.`);
    }

    const generatedFiles = listOutputFiles(stageDirectory);
    if (generatedFiles.length === 0) {
      throw new Error("JADX exited successfully without producing any files.");
    }

    const [sourceSignatures, outputSignatures] = await Promise.all([
      fileSignature(sourceFiles),
      fileSignature(generatedFiles)
    ]);
    publishDirectory(settings.decompiledDir, stageDirectory, outputDirectory);
    const publishedSignatures = await fileSignature(
      outputSignatures.map(file =>
        path.join(outputDirectory, path.relative(stageDirectory, file.path))
      )
    );
    const decompilation = {
      jadx: settings.decompile.jadx,
      fast: settings.decompile.fast,
      sourceFiles: sourceSignatures,
      outputFiles: publishedSignatures,
      completedAt: new Date().toISOString()
    };

    processing.packages[packageName] = {
      ...processing.packages[packageName],
      decompilation,
      decompileAttemptError: null
    };
    saveProcessing(settings.dataDir, processing);
    options.logger.log(`JADX completed for ${packageName}.`);
    return {
      package: packageName,
      status: "decompiled",
      outputDirectory,
      decompilation
    };
  } catch (error) {
    if (options.signal?.aborted) {
      throw options.signal.reason || error;
    }

    try {
      removeOwnedPath(settings.decompiledDir, stageDirectory);
    } catch {
      // Keep JADX's diagnostic as the primary error.
    }
    processing.packages[packageName] = {
      ...processing.packages[packageName],
      decompileAttemptError: error.message,
      lastDecompileAttemptAt: new Date().toISOString()
    };
    saveProcessing(settings.dataDir, processing);
    options.logger.error(`JADX failed for ${packageName}: ${error.message}`);
    return {
      package: packageName,
      status: "failed",
      error: error.message
    };
  }
}

async function decompileApps(settings, apps, options = {}) {
  const logger = options.logger || console;
  const processing = options.processing || loadProcessing(settings.dataDir);
  const runTool = options.runTool;

  if (typeof runTool !== "function") {
    throw new Error("Decompilation requires a process runner.");
  }
  ensureDirectory(settings.decompiledDir);
  recoverDirectorySwaps(settings.decompiledDir);

  const work = [];
  for (const app of apps) {
    const sourceFiles = sourceApksForPackage(settings, app, processing);
    if (sourceFiles.length === 0) {
      processing.packages[app.package] = {
        ...processing.packages[app.package],
        decompileAttemptError: `No APK files were found for ${app.package}.`,
        lastDecompileAttemptAt: new Date().toISOString()
      };
      saveProcessing(settings.dataDir, processing);
      work.push({
        package: app.package,
        run: async () => ({
          package: app.package,
          status: "failed",
          error: `No APK files were found for ${app.package}.`
        })
      });
    } else {
      work.push({
        package: app.package,
        run: () => decompileOne(
          settings,
          app,
          sourceFiles,
          processing,
          { ...options, runTool, logger }
        )
      });
    }
  }

  let next = 0;
  const results = new Array(work.length);
  async function worker() {
    while (true) {
      const index = next++;
      if (index >= work.length) {
        return;
      }
      if (options.signal?.aborted) {
        throw options.signal.reason || new Error("Operation interrupted.");
      }
      results[index] = await work[index].run();
    }
  }

  await Promise.all(
    Array.from(
      { length: Math.min(settings.decompile.jobs, work.length) },
      () => worker()
    )
  );

  return {
    results,
    processing,
    failed: results.some(result => result.status === "failed")
  };
}

module.exports = {
  decompileApps,
  decompilationIsValid,
  inventoryTargets,
  selectBaseApk,
  sourceApksForPackage
};
