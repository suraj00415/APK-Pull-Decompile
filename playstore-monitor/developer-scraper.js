const fs = require("fs");
const path = require("path");

function getPackageFromHref(href) {
  if (!href) {
    return null;
  }

  const normalizedHref = href.replace(/\\\//g, "/");
  const match = normalizedHref.match(
    /\/store\/apps\/details\?id=([A-Za-z0-9._]+)/
  );

  return match ? match[1] : null;
}

function getDeveloperIdFromUrl(developerUrl) {
  try {
    return new URL(developerUrl).searchParams.get("id");
  } catch {
    return null;
  }
}

function cleanTitle(title) {
  return String(title || "")
    .replace(/\s+/g, " ")
    .trim();
}

async function clickShowMore(page, quiet = false) {
  const buttons = page.locator('button, [role="button"]');

  for (let i = 0; i < await buttons.count(); i++) {
    const button = buttons.nth(i);

    try {
      const text = cleanTitle(await button.innerText({ timeout: 500 }));
      const ariaLabel = cleanTitle(
        await button.getAttribute("aria-label")
      );

      if (!/\b(?:show|see)\s+more\b/i.test(`${text} ${ariaLabel}`)) {
        continue;
      }

      if (!(await button.isVisible())) {
        continue;
      }

      await button.scrollIntoViewIfNeeded({ timeout: 2000 });
      await button.click({ timeout: 3000 });
      if (!quiet) {
        console.log("Clicked Show more.");
      }
      return true;
    } catch {
      // Keep checking in case this control disappeared during a page update.
    }
  }

  return false;
}

async function discoverDeveloperApps(developerUrl, options = {}) {
  let chromium;

  try {
    ({ chromium } = require("playwright"));
  } catch {
    throw new Error(
      "Developer-page discovery requires Playwright. " +
      "Run: npm install playwright && npx playwright install chromium"
    );
  }

  const outputDir = path.resolve(
    options.outputDir || path.join(__dirname, "data")
  );

  const saveArtifacts = options.saveArtifacts !== false;

  if (saveArtifacts) {
    fs.mkdirSync(outputDir, { recursive: true });
  }

  let browser;
  let closeBrowser;

  try {
    if (!options.quiet) {
      console.log("Launching Chromium...");
    }

    browser = await chromium.launch({
      headless: options.headless !== false
    });
    closeBrowser = () => {
      browser?.close().catch(() => {});
    };
    options.signal?.addEventListener("abort", closeBrowser, { once: true });

    const page = await browser.newPage({
      viewport: {
        width: 1440,
        height: 1000
      },
      locale: "en-IN"
    });

    if (!options.quiet) {
      console.log("Opening Google Play developer page...");
    }

    await page.goto(developerUrl, {
      waitUntil: "domcontentloaded",
      timeout: 60000
    });

    await page.waitForTimeout(7000);
    if (!options.quiet) {
      console.log("Title:", await page.title());
    }

    const apps = new Map();
    let lastCount = 0;
    let stableRounds = 0;

    for (let roundNo = 0; roundNo < 40; roundNo++) {
      const links = page.locator(
        'a[href*="/store/apps/details?id="]'
      );

      const count = await links.count();

      for (let i = 0; i < count; i++) {
        try {
          const link = links.nth(i);
          const href = await link.getAttribute("href");
          const packageName = getPackageFromHref(href);

          if (!packageName) {
            continue;
          }

          let title = "";

          try {
            title = cleanTitle(await link.innerText({ timeout: 1000 }));
          } catch {
            // Some virtualized links disappear while the page is scrolling.
          }

          if (!apps.has(packageName)) {
            apps.set(packageName, {
              package: packageName,
              title,
              url:
                "https://play.google.com/store/apps/details?id=" +
                packageName
            });
          }
        } catch {
          // Ignore links that are detached during page updates.
        }
      }

      if (!options.quiet) {
        console.log(
          `Round ${String(roundNo + 1).padStart(2, "0")}: ${apps.size} apps`
        );
      }

      const clicked = await clickShowMore(page, options.quiet);

      if (clicked) {
        await page.waitForTimeout(2000);
      }

      for (let i = 0; i < 5; i++) {
        await page.mouse.wheel(0, 1200);
        await page.waitForTimeout(1000);
      }

      const currentCount = apps.size;

      if (currentCount === lastCount && !clicked) {
        stableRounds++;
      } else {
        stableRounds = 0;
      }

      lastCount = currentCount;

      if (stableRounds >= 4) {
        if (!options.quiet) {
          console.log("No new apps detected.");
        }
        break;
      }
    }

    // One final scan catches links loaded during the last scroll.
    const links = page.locator(
      'a[href*="/store/apps/details?id="]'
    );

    for (let i = 0; i < await links.count(); i++) {
      try {
        const packageName = getPackageFromHref(
          await links.nth(i).getAttribute("href")
        );

        if (
          packageName &&
          !apps.has(packageName)
        ) {
          apps.set(packageName, {
            package: packageName,
            title: "",
            url:
              "https://play.google.com/store/apps/details?id=" +
              packageName
          });
        }
      } catch {
        // Ignore links detached during the final scan.
      }
    }

    const result = [...apps.values()];
    let screenshot = null;
    let output = null;

    if (saveArtifacts) {
      screenshot = path.join(outputDir, "playstore_developer.png");
      output = path.join(outputDir, "playstore_app_list.json");
      const developerId = getDeveloperIdFromUrl(developerUrl);
      let previousApps = [];

      try {
        previousApps = JSON.parse(fs.readFileSync(output, "utf8"));
      } catch {
        // The discovery output may not exist yet or may not be valid JSON.
      }

      const previousVersions = new Map(
        Array.isArray(previousApps)
          ? previousApps.map(app => [app.package, app.version || null])
          : []
      );

      for (const app of result) {
        app.developerId = developerId;
        app.version = previousVersions.get(app.package) || null;
      }

      await page.screenshot({
        path: screenshot,
        fullPage: true
      });

      fs.writeFileSync(
        output,
        JSON.stringify(result, null, 2),
        "utf8"
      );
    }

    if (!options.quiet) {
      console.log();
      console.log("=".repeat(70));
      console.log(`TOTAL UNIQUE APPS: ${result.length}`);
      console.log("=".repeat(70));

      result.forEach((app, index) => {
        console.log(
          `${String(index + 1).padStart(3)}. ` +
          `${app.package.padEnd(50)} ${app.title}`
        );
      });

      if (saveArtifacts) {
        console.log();
        console.log("JSON:", output);
        console.log("Screenshot:", screenshot);
      }
    }

    return {
      apps: result,
      output,
      screenshot
    };
  } finally {
    options.signal?.removeEventListener("abort", closeBrowser);
    if (browser) {
      await browser.close();
    }
  }
}

module.exports = {
  discoverDeveloperApps,
  getPackageFromHref,
  getDeveloperIdFromUrl
};
