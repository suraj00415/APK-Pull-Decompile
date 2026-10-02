const path = require("node:path");
const { discoverDeveloperApps } = require("../playstore-monitor/developer-scraper");
const {
  readJson,
  writeJsonAtomic,
  ensureDirectory
} = require("./storage");
const { packageIsIncluded } = require("./targets");
const { sleep } = require("./util");

function normalizeVersion(version) {
  if (version === undefined || version === null) {
    return null;
  }

  const result = String(version).trim();

  if (
    !result ||
    /^(?:vary|varies with device|unknown|not available|n\/a|null)$/i.test(result)
  ) {
    return null;
  }

  return result;
}

function appKey(developerId, packageName) {
  return `${developerId}|${packageName}`;
}

function statePaths(dataDirectory) {
  return {
    inventory: path.join(dataDirectory, "apps.json"),
    state: path.join(dataDirectory, "monitor-state.json"),
    diff: path.join(dataDirectory, "latest-diff.json")
  };
}

function readState(filePath) {
  const state = readJson(filePath, null);

  if (state === null) {
    return null;
  }

  if (
    typeof state !== "object" ||
    Array.isArray(state) ||
    typeof state.apps !== "object" ||
    !state.apps ||
    typeof state.developers !== "object" ||
    !state.developers
  ) {
    throw new Error(
      `The monitor snapshot is invalid: ${filePath}. Preserve a copy before replacing it.`
    );
  }

  return state;
}

async function loadGooglePlayScraper() {
  try {
    const imported = await import("google-play-scraper");
    return imported.default || imported;
  } catch (error) {
    if (error.code === "ERR_MODULE_NOT_FOUND") {
      throw new Error(
        "Monitoring requires google-play-scraper. Run npm install."
      );
    }

    throw error;
  }
}

async function mapWithConcurrency(items, concurrency, worker) {
  const results = new Array(items.length);
  let nextIndex = 0;

  async function runWorker() {
    while (true) {
      const index = nextIndex++;
      if (index >= items.length) {
        return;
      }
      results[index] = await worker(items[index], index);
    }
  }

  await Promise.all(
    Array.from(
      { length: Math.min(concurrency, items.length) },
      () => runWorker()
    )
  );
  return results;
}

async function fetchDeveloperApps(developer, settings, adapters) {
  const url = new URL("https://play.google.com/store/apps/dev");
  url.searchParams.set("id", developer.id);
  url.searchParams.set("hl", settings.monitor.language);
  url.searchParams.set("gl", settings.monitor.country);

  const result = await adapters.discoverDeveloperApps(url.toString(), {
    saveArtifacts: false,
    quiet: false,
    signal: settings.signal
  });

  if (!Array.isArray(result.apps) || result.apps.length === 0) {
    throw new Error(
      `No Play Store apps were returned for ${developer.name} (${developer.id}).`
    );
  }

  const selectedApps = result.apps
    .filter(app =>
      app.package &&
      packageIsIncluded(app.package, developer, settings)
    )
    .map(app => ({
      ...app,
      developerId: developer.id,
      developerName: developer.name,
      url: app.url ||
        `https://play.google.com/store/apps/details?id=${app.package}`
    }));

  return [...new Map(selectedApps.map(app => [app.package, app])).values()];
}

async function fetchVersions(gplay, apps, settings, previousState) {
  let completed = 0;
  let failed = 0;
  const versionedApps = await mapWithConcurrency(
    apps,
    settings.monitor.detailsConcurrency,
    async app => {
      let version = null;
      let versionError = null;

      try {
        const details = await gplay.app({
          appId: app.package,
          lang: settings.monitor.language,
          country: settings.monitor.country
        });
        version = normalizeVersion(details.version);
      } catch (error) {
        failed++;
        versionError = error.message;
        console.warn(`Could not fetch version for ${app.package}: ${error.message}`);
      }

      const previous = previousState?.apps?.[appKey(app.developerId, app.package)];
      if (!version && previous?.version) {
        version = previous.version;
      }

      if (settings.monitor.requestDelayMs > 0) {
        await sleep(settings.monitor.requestDelayMs, settings.signal);
      }

      completed++;
      if (completed % 10 === 0 || completed === apps.length) {
        console.log(`Fetched versions for ${completed}/${apps.length} apps.`);
      }

      return {
        ...app,
        version,
        ...(versionError ? { versionError } : {})
      };
    }
  );

  if (failed === apps.length && apps.length > 0) {
    throw new Error(
      `Version lookup failed for every one of the ${apps.length} selected apps.`
    );
  }

  return { apps: versionedApps, failedRequests: failed };
}

function compareApps(apps, previousState, developers, checkedAt) {
  const state = previousState || { apps: {}, developers: {} };
  const nextApps = { ...state.apps };
  const nextDevelopers = { ...state.developers };
  const changes = [];

  for (const developer of developers) {
    const initialized = Object.prototype.hasOwnProperty.call(
      nextDevelopers,
      developer.id
    );
    const selected = apps.filter(app => app.developerId === developer.id);

    for (const app of selected) {
      const key = appKey(developer.id, app.package);
      const previous = nextApps[key];

      if (initialized && !previous) {
        changes.push({ type: "added", ...app });
      } else if (
        previous?.version &&
        app.version &&
        previous.version !== app.version
      ) {
        changes.push({
          type: "version",
          ...app,
          previousVersion: previous.version
        });
      }

      nextApps[key] = {
        ...app,
        version: app.version || previous?.version || null,
        checkedAt
      };
    }

    nextDevelopers[developer.id] = {
      name: developer.name,
      checkedAt
    };
  }

  return {
    changes,
    nextState: {
      updatedAt: checkedAt,
      apps: nextApps,
      developers: nextDevelopers
    }
  };
}

function slackEscape(value) {
  return String(value || "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}

function formatSlackMessage(summary) {
  const additions = summary.changes.filter(change => change.type === "added").length;
  const versions = summary.changes.length - additions;
  const lines = [
    summary.baseline
      ? "Google Play baseline established."
      : "Google Play scan completed.",
    `Developers: ${summary.developers.join(", ")}`,
    `Apps checked: ${summary.appsChecked}`,
    `New apps: ${additions}; version changes: ${versions}`,
    `Duration: ${Math.ceil(summary.durationMs / 1000)} seconds`,
    `Completed at: ${summary.completedAt}`
  ];

  if (summary.failures?.length) {
    lines.push(`Warnings: ${summary.failures.length} version lookup(s) failed.`);
  }
  if (summary.changes.length === 0) {
    lines.push("No app additions or version changes.");
  }

  for (const change of summary.changes.slice(0, 100)) {
    const name = slackEscape(change.title || change.package);
    const link = `<${change.url}|${name}>`;

    if (change.type === "added") {
      lines.push(
        `- New app for ${slackEscape(change.developerName)}: ${link} ` +
        `(\`${slackEscape(change.package)}\`)` +
        (change.version ? ` version \`${slackEscape(change.version)}\`` : "")
      );
    } else {
      lines.push(
        `- ${slackEscape(change.developerName)}: ${link} ` +
        `(\`${slackEscape(change.package)}\`) ` +
        `\`${slackEscape(change.previousVersion)}\` -> \`${slackEscape(change.version)}\``
      );
    }
  }

  if (summary.changes.length > 100) {
    lines.push(`...and ${summary.changes.length - 100} more.`);
  }

  return lines.join("\n");
}

async function sendSlackNotification(webhookUrl, summary, options = {}) {
  const response = await (options.fetch || fetch)(webhookUrl, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ text: formatSlackMessage(summary) }),
    signal: options.signal || AbortSignal.timeout(15000)
  });

  if (!response.ok) {
    throw new Error(`Slack returned HTTP ${response.status}.`);
  }
}

async function notify(settings, summary, adapters, notifications) {
  const text = formatSlackMessage(summary);

  if (!settings.monitor.slackWebhookUrl) {
    console.log(text);
    notifications.status = "console";
    return;
  }

  try {
    await adapters.sendSlackNotification(
      settings.monitor.slackWebhookUrl,
      summary,
      { signal: settings.signal }
    );
    console.log("Sent scan summary to Slack.");
    notifications.status = "slack";
  } catch (error) {
    notifications.status = "failed";
    notifications.error = error.message;
    console.error(`Slack delivery failed: ${error.message}`);
  }
}

async function runScan(settings, options = {}) {
  const startedAt = Date.now();
  const adapters = {
    discoverDeveloperApps: options.discoverDeveloperApps || discoverDeveloperApps,
    loadGooglePlayScraper: options.loadGooglePlayScraper || loadGooglePlayScraper,
    sendSlackNotification: options.sendSlackNotification || sendSlackNotification
  };
  const locations = statePaths(settings.dataDir);
  ensureDirectory(settings.dataDir);

  try {
    const gplay = await adapters.loadGooglePlayScraper();
    const previousState = readState(locations.state);
    const discoveredApps = [];

    for (const developer of settings.developers) {
      console.log(`Discovering apps for ${developer.name} (${developer.id})...`);
      discoveredApps.push(
        ...await fetchDeveloperApps(developer, settings, adapters)
      );
    }
    if (discoveredApps.length === 0) {
      throw new Error("No apps match the configured include/exclude filters.");
    }

    const allApps = [];
    const failures = [];

    for (const developer of settings.developers) {
      const developerApps = discoveredApps.filter(
        app => app.developerId === developer.id
      );
      const result = await fetchVersions(
        gplay,
        developerApps,
        settings,
        previousState
      );
      allApps.push(...result.apps);

      for (const app of result.apps) {
        if (app.versionError) {
          failures.push({
            package: app.package,
            error: app.versionError
          });
        }
      }
    }

    const checkedAt = new Date().toISOString();
    const comparison = compareApps(
      allApps,
      previousState,
      settings.developers,
      checkedAt
    );
    const inventory = allApps.map(app => ({
      package: app.package,
      developerId: app.developerId,
      developerName: app.developerName,
      title: app.title || "",
      url: app.url,
      version: app.version || null,
      checkedAt
    }));
    const summary = {
      baseline: previousState === null,
      appsChecked: inventory.length,
      changes: comparison.changes,
      completedAt: checkedAt,
      developers: settings.developers.map(item => item.name),
      durationMs: Date.now() - startedAt,
      failures
    };

    writeJsonAtomic(locations.inventory, inventory);
    writeJsonAtomic(locations.diff, summary);
    writeJsonAtomic(locations.state, comparison.nextState);

    const notifications = {};
    await notify(settings, summary, adapters, notifications);

    return {
      ...summary,
      apps: inventory,
      state: comparison.nextState,
      notification: notifications,
      locations
    };
  } catch (error) {
    const failureSummary = {
      baseline: false,
      appsChecked: 0,
      changes: [],
      completedAt: new Date().toISOString(),
      developers: settings.developers.map(item => item.name),
      durationMs: Date.now() - startedAt,
      failures: [{ error: error.message }],
      failed: true
    };
    const notifications = {};

    if (!options.suppressFailureSummary) {
      await notify(settings, failureSummary, adapters, notifications);
    }

    error.scanSummary = failureSummary;
    error.notification = notifications;
    throw error;
  }
}

module.exports = {
  compareApps,
  formatSlackMessage,
  normalizeVersion,
  runScan,
  sendSlackNotification,
  statePaths
};
