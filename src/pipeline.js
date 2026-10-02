const {
  acquireApps,
  acquisitionIsValid
} = require("./acquisition");
const {
  decompileApps,
  decompilationIsValid
} = require("./decompilation");
const { runScan } = require("./monitor");
const {
  loadProcessing,
  saveProcessing
} = require("./storage");
const { deduplicateApps } = require("./targets");

function completedPipeline(record, app, source, device) {
  const state = record?.pipeline;

  return Boolean(
    state &&
    state.status === "complete" &&
    state.completedVersion === (app.version || null) &&
    record.acquisition?.source === source &&
    record.acquisition?.device === (source === "device" ? device : null)
  );
}

async function needsWork(settings, app, processing) {
  if (settings.pipeline.all) {
    return true;
  }

  const record = processing.packages[app.package];
  if (!processing.pipelineInitialized || !record) {
    return true;
  }

  if (record.pipeline?.status === "pending") {
    return true;
  }

  if (!completedPipeline(record, app, settings.pull.source, settings.pull.device)) {
    return true;
  }

  if (!await acquisitionIsValid(record)) {
    return true;
  }

  const sourceFiles = record.acquisition.files.map(file => file.path);
  return !await decompilationIsValid(settings, record, sourceFiles);
}

async function runPipeline(settings, options = {}) {
  const logger = options.logger || console;
  const runTool = options.runTool;
  const processing = loadProcessing(settings.dataDir);
  const scan = await (options.runScan || runScan)(
    settings,
    options.monitorOptions
  );
  const uniqueApps = deduplicateApps(scan.apps);
  const selected = [];

  for (const app of uniqueApps) {
    if (await needsWork(settings, app, processing)) {
      selected.push(app);
    }
  }

  processing.pipelineInitialized = true;
  for (const app of selected) {
    const previous = processing.packages[app.package] || {};
    processing.packages[app.package] = {
      ...previous,
      pipeline: {
        status: "pending",
        targetVersion: app.version || null,
        startedAt: new Date().toISOString()
      }
    };
  }
  saveProcessing(settings.dataDir, processing);

  if (selected.length === 0) {
    logger.log("No new or changed apps need APK processing.");
    return {
      scan,
      selected: [],
      acquisition: { results: [], failed: false },
      decompilation: { results: [], failed: false },
      failed: Boolean(scan.notification?.status === "failed" || scan.failures.length)
    };
  }

  logger.log(`Processing ${selected.length} new, changed, or unfinished app(s).`);
  const acquisition = await acquireApps(settings, selected, {
    runTool,
    signal: options.signal,
    logger,
    processing
  });
  const acquiredPackages = new Set(
    acquisition.results
      .filter(result => result.status === "acquired" || result.status === "reused")
      .map(result => result.package)
  );
  const readyToDecompile = selected.filter(app =>
    acquiredPackages.has(app.package)
  );

  for (const result of acquisition.results) {
    if (result.status === "failed") {
      const previous = processing.packages[result.package] || {};
      processing.packages[result.package] = {
        ...previous,
        pipeline: {
          status: "pending",
          targetVersion:
            selected.find(app => app.package === result.package)?.version || null,
          lastError: result.error,
          lastAttemptAt: new Date().toISOString()
        }
      };
    }
  }
  saveProcessing(settings.dataDir, processing);

  const decompilation = readyToDecompile.length > 0
    ? await decompileApps(settings, readyToDecompile, {
      runTool,
      signal: options.signal,
      logger,
      processing
    })
    : { results: [], failed: false, processing };
  const decompiledByPackage = new Map(
    decompilation.results.map(result => [result.package, result])
  );

  for (const app of readyToDecompile) {
    const previous = processing.packages[app.package] || {};
    const result = decompiledByPackage.get(app.package);

    if (result && result.status !== "failed") {
      processing.packages[app.package] = {
        ...previous,
        pipeline: {
          status: "complete",
          completedVersion: app.version || null,
          source: settings.pull.source,
          completedAt: new Date().toISOString(),
          developerNames: app.developerNames || []
        }
      };
    } else {
      processing.packages[app.package] = {
        ...previous,
        pipeline: {
          status: "pending",
          targetVersion: app.version || null,
          lastError: result?.error || "Decompilation did not complete.",
          lastAttemptAt: new Date().toISOString()
        }
      };
    }
  }

  saveProcessing(settings.dataDir, processing);
  const failed = Boolean(
    acquisition.failed ||
    decompilation.failed ||
    scan.notification?.status === "failed" ||
    scan.failures.length
  );
  logger.log(
    `Pipeline ${failed ? "finished with errors" : "completed"}: ` +
    `${selected.length} app(s), ${acquisition.results.filter(
      result => result.status === "acquired"
    ).length} acquisition(s), ${decompilation.results.filter(
      result => result.status === "decompiled"
    ).length} decompilation(s).`
  );

  return {
    scan,
    selected,
    acquisition,
    decompilation,
    processing,
    failed
  };
}

module.exports = {
  completedPipeline,
  needsWork,
  runPipeline
};
