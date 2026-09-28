# APK Pull & Decompile

Node.js utilities for discovering Android apps published by a Google Play developer, downloading APKs with [APKeep](https://github.com/EFForg/apkeep), and decompiling them with [JADX](https://github.com/skylot/jadx).

## Requirements

- Node.js 18+
- APKeep
- JADX
- Chromium for Playwright-based developer-page discovery

Install the Node.js dependency and Playwright browser:

```powershell
npm install
npx playwright install chromium
```

## Usage

Download APKs for a developer:

```powershell
node apk-pull-decompile.js --download `
  --apk-base-dir "D:\path\to\APKS" `
  --apkeep-path "C:\path\to\apkeep.exe" `
  --play-store-email "you@example.com" `
  --aas-token "<your-aas-token>" `
  --developer-url "https://play.google.com/store/apps/dev?id=<developer-id>"
```

Decompile all downloaded APKs:

```powershell
node apk-pull-decompile.js --decompile --fast `
  --apk-base-dir "D:\path\to\APKS" `
  --decompiled-base-dir "D:\path\to\Decompiled-APKs" `
  --jadx-path "C:\path\to\jadx.bat" `
  --all
```

Discover apps directly with the scraper:

```powershell
node playstore-developer-scraper.js `
  "https://play.google.com/store/apps/dev?id=<developer-id>"
```

Run `node apk-pull-decompile.js --help` for all options. Generated APKs, decompiled files, reports, and local credential-bearing command snippets are excluded by `.gitignore`.

Only use these tools against applications and accounts you are authorized to assess. Never commit access tokens or other credentials.
