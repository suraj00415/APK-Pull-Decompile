# APK Pull & Decompile

Discover Android apps from Google Play, track app and version changes, acquire APKs, and decompile them with JADX. The `monitor`, `pull`, `decompile`, and `pipeline` commands share one optional config file. Each command runs once and exits. Discovery and version monitoring are combined in `monitor`.

## Setup

Use Node.js 20 or newer. Install the project dependencies with:

```sh
npm install
```

In PowerShell, use `npm.cmd` and `npx.cmd` if execution policy blocks the `.ps1` shims.

Install Chromium for Play Store publisher-page discovery:

```sh
npx playwright install chromium
```

Install APKeep, Android platform tools (ADB), and JADX separately if you intend to use them. Add the tools to `PATH` or configure their executable paths.

Copy `config.example.json` to `config.json` and set your publisher ID. Keep the local config private; it is excluded from Git.

On Windows PowerShell, copy the example with `Copy-Item config.example.json config.json`.

For credentials, copy `.env.example` to `.env` in the project root and fill in the values you need. The root `.env` is ignored by Git. A credential supplied in the command line takes priority over config and environment values; an environment variable already set by your shell takes priority over the same key in `.env`.

```sh
cp .env.example .env
```

In PowerShell:

```powershell
Copy-Item .env.example .env
```

## One-command workflow

```sh
npm run pipeline -- --config ./config.json
```

The first pipeline run processes every selected app. Later runs process new or version-changed apps and retry unfinished work. The pipeline scans Google Play, sends one Slack summary, downloads the required APKs with APKeep, then decompiles successful downloads with JADX. Without a Slack webhook, the scan summary goes to the terminal.

The root `.env` can define `SLACK_WEBHOOK_URL`, `PLAY_STORE_EMAIL`, and `PLAY_STORE_AAS_TOKEN`. The config example references these names. You can also set them in the shell or pass credentials with `--slack-webhook`, `--email`, and `--aas-token`. In cron, use the cron environment or provide a protected `.env` file. Credentials are redacted from logged APKeep commands.

Use `--all` to consider every current target, and `--force` to refresh selected APKs and JADX output. Use both to rebuild all current targets:

```sh
npm run pipeline -- --config ./config.json --all --force
```

APK files and decompiled output are organized in directories named after each package. The shared `data/` directory holds the current app inventory, monitor snapshot, latest diff, and processing state. Keep this directory between runs: processing state lets the pipeline detect changes, avoid repeating completed work, and resume failed work.

## Standalone commands

| Command | Purpose |
|---|---|
| `npm run monitor` | Discover publisher apps, fetch versions, save inventory and diff, and send a Slack or terminal summary. |
| `npm run pull` | Acquire APKs using Play Store/APKeep or ADB. |
| `npm run decompile` | Decompile collected APKs with JADX. |

Examples:

```sh
npm run monitor -- --config ./config.json
npm run pull -- --config ./config.json --packages com.example.app
npm run pull -- --config ./config.json --source device --device emulator-5554 --all
npm run decompile -- --config ./config.json --all
```

`monitor` performs discovery and version checks in one run. It prints the publisher, browser startup, page title, and app count for each scrolling round, then fetches versions for the selected apps. It saves the versioned inventory to `data/apps.json`, the snapshot to `data/monitor-state.json`, and the summary and diff to `data/latest-diff.json`, then sends one Slack or terminal summary. The command prints the saved file paths when it finishes.

The former `npm run scrape` command has been merged into `npm run monitor`. Update any scripts or scheduled jobs that used `scrape` to use `monitor`.

For standalone acquisition and decompilation, `targets.packages` in the shared config selects package IDs directly. For example:

```json
{
  "targets": {
    "developers": [],
    "packages": ["com.example.app"],
    "excludePackages": []
  }
}
```

With that saved as the root `config.json`, `npm run pull -- --config ./config.json` pulls that app, and `npm run decompile -- --config ./config.json` decompiles its local APK group. An empty `targets.packages` list means there is no global package allowlist. `targets.excludePackages` always blocks a package, including one listed in `targets.packages` or a developer's `includePackages`. Passing `--packages` or `--exclude-packages` replaces that corresponding config list for the command.

Package filters accept exact IDs or wildcard patterns. `*` matches any sequence of characters, while dots are literal. For example, `com.abc.*` matches package IDs beginning with `com.abc.`:

```json
{
  "targets": {
    "developers": [{
      "id": "DEVELOPER_ID",
      "includePackages": ["com.abc.*"],
      "excludePackages": ["com.abc.internal.*"]
    }],
    "packages": [],
    "excludePackages": ["com.abc.retired.*"]
  }
}
```

The same patterns work with `--packages` and `--exclude-packages`; quote them to keep shell handling predictable:

```sh
npm run pull -- --packages 'com.abc.*' --exclude-packages 'com.abc.internal.*'
```

Exclusions take priority over inclusions, including when the same package matches both patterns.

`--from-app-list <file>` points to a JSON array of app records, usually an inventory created by `monitor` such as `data/apps.json`. Each record must have a `package` ID and may also include `title`, `developerId`, `developerName`, `url`, and `version`. It supplies app targets and metadata; it is not a path to an APK. Without this option, standalone commands use the saved inventory under `data-dir`. APK files for decompilation still come from `apk-dir`. Use `--all` to include all available targets: the saved Play Store inventory for Play Store pulls, matching installed apps for device pulls, or all local APK package groups for decompilation. These commands do not scrape implicitly.

To use CLI settings without loading `config.json`, pass `--no-config`. For example:

```sh
npm run pull -- --no-config --source playstore --apkeep /tools/apkeep \
  --email researcher@example.com --aas-token "$PLAY_STORE_AAS_TOKEN" \
  --packages com.example.app --apk-dir ./apks
```

In PowerShell, use `$env:PLAY_STORE_AAS_TOKEN` for the environment variable reference.

Run `npm start -- --help` for the command list, or `npm run pipeline -- --help` for options. Shared options include `--config`, `--developer`, `--packages`, `--exclude-packages`, and `--data-dir`. Acquisition options include `--source`, `--apkeep`, `--adb`, `--device`, `--email`, `--aas-token`, `--no-split-apk`, `--retries`, and `--download-parallel`. JADX options include `--jadx`, `--decompiled-dir`, `--fast`, and `--decompile-jobs`.

CLI settings override config values. Developer and package lists accept repeated flags or comma-separated values; a CLI list replaces that list in config. Exclusions always apply. Config paths are relative to the config file; CLI paths are relative to the current working directory.

## Monitor settings and diffs

Each developer entry uses the ID from the publisher page's `?id=` parameter. `name` is a display label. An empty `includePackages` list includes all that publisher's apps; `excludePackages` always takes priority. You may pass one or more IDs or publisher page URLs with `--developer`.

Every `monitor` run discovers the current publisher apps before fetching versions and comparing them with the saved snapshot. The first scan establishes a baseline and saves an empty diff. Later scans report new apps and version changes. A failed version lookup retains the previous known version. The current inventory is `data/apps.json`; the authoritative scan state is `data/monitor-state.json`; the latest summary and diff is `data/latest-diff.json`. The pipeline uses this same combined scan before downloading and decompiling APKs.

Slack is optional. Set `monitor.slackWebhook` to `{ "env": "SLACK_WEBHOOK_URL" }` or a local webhook value. Without a webhook, summaries print to the terminal. A webhook error leaves the successful scan data in place, reports the delivery error, and exits with a failure status.

## Cron scheduling

Commands run once and exit. Use system cron for recurring runs; the example runs daily at 09:00 in the cron host's configured timezone. Adjust paths, npm's executable path, time, and environment variables for the host:

```cron
0 9 * * * cd /opt/apk-pull-decompile && /usr/bin/npm run pipeline -- --config /opt/apk-pull-decompile/config.json >> /opt/apk-pull-decompile/data/pipeline.log 2>&1
```

Create the log directory before enabling the cron entry:

```sh
mkdir -p /opt/apk-pull-decompile/data
```

To run only monitoring, replace `pipeline` with `monitor`. Set executable paths in the shared config when cron's `PATH` does not include APKeep, ADB, or JADX. Set credential environment variables in the cron environment when using env references.

If you previously installed the systemd monitor, disable it before adding cron to prevent duplicate scans:

```sh
sudo systemctl disable --now playstore-monitor
```

## Development

Run the automated suite with:

```sh
npm test
```
