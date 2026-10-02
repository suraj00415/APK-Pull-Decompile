const {
  loadSettings,
  parseCommandLine,
  parseHelp
} = require("./src/config");
const {
  acquireLock
} = require("./src/storage");
const {
  createRunner
} = require("./src/process");
const {
  acquireApps,
  selectApps
} = require("./src/acquisition");
const {
  decompileApps,
  inventoryTargets
} = require("./src/decompilation");
const { runScan } = require("./src/monitor");
const {
  runPipeline
} = require("./src/pipeline");

function printUsage(command = null) {
  if (!command) {
    console.log(`APK Pull & Decompile

Usage:
  npm run <command> -- [options]

Commands:
  monitor     Discover Play Store apps, check versions, save the diff, and notify Slack.
  pull        Acquire APKs from Google Play or a connected Android device.
  decompile   Decompile existing APKs with JADX.
  pipeline    Monitor, acquire new or changed APKs, and decompile them.

Run "npm run <command> -- --help" to see command options.

Configuration:
  Copy config.example.json to config.json and edit it, or pass settings with
  command-line options. Put credentials in the optional root .env file.
  --no-config ignores config.json but still reads .env and CLI options.`);
    return;
  }

  const shared =
    "  --config <path>       Use one shared config file.\n" +
    "  --no-config           Ignore config.json and use CLI settings.\n" +
    "  --packages <patterns>  Select IDs or wildcard patterns (repeat or comma-separated).\n" +
    "  --exclude-packages <patterns>  Exclude IDs or wildcard patterns.\n" +
    "  --data-dir <path>     Store inventory, snapshots, and state.\n" +
    "  -h, --help            Show this help.";
  const usages = {
    monitor:
      "npm run monitor -- [--developer <id-or-url>] [monitor options]\n" +
      "Discover publisher apps, fetch versions, save inventory, snapshot, and diff,\n" +
      "then send one Slack or terminal summary.",
    pull:
      "npm run pull -- [--source playstore|device] [pull options]\n" +
      "Use --from-app-list <file> for a custom JSON app inventory (default: data/apps.json).\n" +
      "Use --all to select all available targets.\n" +
      "Device source: --device <serial>. Play Store source: --email and --aas-token.",
    decompile:
      "npm run decompile -- [--packages <ids-or-patterns>] [decompile options]\n" +
      "Use --from-app-list <file> for a custom JSON app inventory (default: data/apps.json).\n" +
      "APK files are read from --apk-dir; --all includes every local APK package.",
    pipeline:
      "npm run pipeline -- [pipeline options]\n" +
      "Changed apps run by default. Use --all to consider every target and --force to refresh."
  };
  const acquisition =
    "  --source <value>      Select playstore or device (default: playstore).\n" +
    "  --apkeep <path>       APKeep executable.\n" +
    "  --adb <path>          ADB executable.\n" +
    "  --device <serial>     ADB device serial.\n" +
    "  --email <email>       Play Store email; overrides config and .env.\n" +
    "  --aas-token <token>   Play Store token; overrides config and .env.\n" +
    "  --no-split-apk        Disable split APK downloads.\n" +
    "  --retries <number>    Additional download attempts.\n" +
    "  --download-parallel <number>  APKeep internal parallelism.\n" +
    "  --all                 Select all available packages.\n" +
    "  --from-app-list <file>  Read app records from a JSON inventory, not an APK file.\n" +
    "  --force               Refresh the selected APKs.";
  const decompiler =
    "  --apk-dir <path>      APK storage directory.\n" +
    "  --decompiled-dir <path>  JADX output directory.\n" +
    "  --jadx <path>         JADX executable.\n" +
    "  --fast                Use optimized source conversion while preserving resources.\n" +
    "  --decompile-jobs <number>  Concurrent package decompilations.";
  const monitor =
    "  --language <code>     Google Play language.\n" +
    "  --country <code>      Google Play country.\n" +
    "  --details-concurrency <number>  Concurrent version lookups.\n" +
    "  --request-delay-ms <number>  Delay between lookups.\n" +
    "  --slack-webhook <url>  Set the webhook for this invocation; overrides config and .env.\n" +
    "  --developer <id-or-url>  Select a publisher (repeat to add publishers).\n";
  let options = shared;

  if (command === "monitor") {
    options = `${monitor}${shared}`;
  } else if (command === "pull") {
    options = `${acquisition}\n${shared}`;
  } else if (command === "decompile") {
    options = `${decompiler}\n${shared}\n  --all                 Decompile every discovered APK package.\n  --from-app-list <file>  Read package records from a JSON inventory.\n  --force               Re-run JADX for selected packages.`;
  } else {
    options =
      `${monitor}${acquisition.replace(/  --all[\s\S]*?--force[^\n]*/, "")}\n` +
      `${decompiler.replace(/  --force[^\n]*/, "")}\n${shared}\n` +
      "  --all                 Consider every current app target.\n" +
      "  --force               Refresh selected APKs and JADX output.";
  }

  console.log(`${usages[command]}\n\nOptions:\n${options}`);
}

function makeError(message, exitCode = 1) {
  const error = new Error(message);
  error.exitCode = exitCode;
  return error;
}

async function main(argv = process.argv.slice(2)) {
  let parsed;
  try {
    parsed = parseCommandLine(argv);
  } catch (error) {
    console.error(error.message);
    return 2;
  }

  if (!parsed.command) {
    if (parsed.help || argv.length === 0) {
      printUsage();
      return 0;
    }
    return 2;
  }

  if (parseHelp(parsed)) {
    printUsage(parsed.command);
    return 0;
  }

  let settings;
  try {
    settings = loadSettings(parsed.command, parsed.values);
  } catch (error) {
    console.error(error.message);
    return 2;
  }

  const abortController = new AbortController();
  settings.signal = abortController.signal;
  const onSignal = signal => {
    if (!abortController.signal.aborted) {
      abortController.abort(makeError("Interrupted.", signal === "SIGINT" ? 130 : 143));
    }
  };
  const onSigint = () => onSignal("SIGINT");
  const onSigterm = () => onSignal("SIGTERM");
  process.once("SIGINT", onSigint);
  process.once("SIGTERM", onSigterm);

  let lock;
  try {
    lock = acquireLock(settings.dataDir);

    if (!lock.acquired) {
      const owner = lock.owner?.pid ? ` (process ${lock.owner.pid})` : "";
      console.log(`Another command is using this data directory${owner}; skipping this run.`);
      return 0;
    }

    const runner = createRunner({
      secrets: [
        settings.pull.email,
        settings.pull.aasToken,
        settings.monitor.slackWebhookUrl
      ]
    });
    let failed = false;

    if (parsed.command === "monitor") {
      const result = await runScan(settings);
      failed = result.notification.status === "failed" || result.failures.length > 0;
      console.log(
        `Monitor scan: ${result.appsChecked} app(s), ${result.changes.length} change(s).`
      );
      console.log(`Saved app inventory to ${result.locations.inventory}.`);
      console.log(`Saved version snapshot to ${result.locations.state}.`);
      console.log(`Saved diff to ${result.locations.diff}.`);
    } else if (parsed.command === "pull") {
      const apps = await selectApps(settings, {
        all: settings.standalone.all,
        runTool: runner,
        signal: abortController.signal
      });
      const result = await acquireApps(settings, apps, {
        runTool: runner,
        signal: abortController.signal
      });
      failed = result.failed;
      console.log(
        `APK acquisition ${failed ? "finished with errors" : "completed"}: ` +
        `${result.results.length} package(s).`
      );
    } else if (parsed.command === "decompile") {
      const apps = inventoryTargets(settings, {
        all: settings.standalone.all
      });
      if (apps.length === 0) {
        throw makeError(
          "No app targets found. Set targets.packages, run \"npm run monitor\", " +
          "or pass --from-app-list <file> or --all."
        );
      }
      const result = await decompileApps(settings, apps, {
        runTool: runner,
        signal: abortController.signal
      });
      failed = result.failed;
      console.log(
        `Decompilation ${failed ? "finished with errors" : "completed"}: ` +
        `${result.results.length} package(s).`
      );
    } else {
      const result = await runPipeline(settings, {
        runTool: runner,
        signal: abortController.signal
      });
      failed = result.failed;
    }

    return failed ? 1 : 0;
  } catch (error) {
    const exitCode = abortController.signal.aborted
      ? abortController.signal.reason?.exitCode || 130
      : error.exitCode || 1;
    if (exitCode === 130 || exitCode === 143) {
      console.error(`\n${error.message}`);
    } else {
      console.error(`\n${error.message || error}`);
    }
    return exitCode;
  } finally {
    try {
      lock?.release?.();
    } catch (error) {
      console.error(`Could not release the workflow lock: ${error.message}`);
    }
    process.removeListener("SIGINT", onSigint);
    process.removeListener("SIGTERM", onSigterm);
  }
}

if (require.main === module) {
  main().then(
    code => {
      process.exitCode = code;
    },
    error => {
      console.error(error.stack || error.message);
      process.exitCode = 1;
    }
  );
}

module.exports = { main, printUsage };
