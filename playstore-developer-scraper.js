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

function cleanTitle(title) {
  return String(title || "")
    .replace(/\s+/g, " ")
    .trim();
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
    options.outputDir || path.join("playstore-audit", "reports")
  );

  fs.mkdirSync(outputDir, { recursive: true });

  let browser;

  try {
    console.log("Launching Chromium...");

    browser = await chromium.launch({
      headless: options.headless !== false
    });

    const page = await browser.newPage({
      viewport: {
        width: 1440,
        height: 1000
      },
      locale: "en-IN"
    });

    console.log("Opening Google Play developer page...");

    await page.goto(developerUrl, {
      waitUntil: "domcontentloaded",
      timeout: 60000
    });

    await page.waitForTimeout(7000);
    console.log("Title:", await page.title());

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

      console.log(
        `Round ${String(roundNo + 1).padStart(2, "0")}: ${apps.size} apps`
      );

      let clicked = false;

      try {
        const buttons = page.locator("button");

        for (let i = 0; i < await buttons.count(); i++) {
          try {
            const button = buttons.nth(i);
            const text = cleanTitle(
              await button.innerText({ timeout: 500 })
            ).toLowerCase();

            if (["see more", "show more", "more"].includes(text)) {
              console.log("Clicking:", text);
              await button.click({ timeout: 3000 });
              await page.waitForTimeout(3000);
              clicked = true;
              break;
            }
          } catch {
            // Continue checking other buttons.
          }
        }
      } catch {
        // The page may not expose buttons while it is re-rendering.
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
        console.log("No new apps detected.");
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
    const screenshot = path.join(outputDir, "playstore_developer.png");
    const output = path.join(outputDir, "playstore_app_list.json");

    await page.screenshot({
      path: screenshot,
      fullPage: true
    });

    fs.writeFileSync(
      output,
      JSON.stringify(result, null, 2),
      "utf8"
    );

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

    console.log();
    console.log("JSON:", output);
    console.log("Screenshot:", screenshot);

    return {
      apps: result,
      output,
      screenshot
    };
  } finally {
    if (browser) {
      await browser.close();
    }
  }
}

module.exports = {
  discoverDeveloperApps,
  getPackageFromHref
};

if (require.main === module) {
  const developerUrl = process.argv[2];

  if (!developerUrl) {
    console.error(
      "Usage: node playstore-developer-scraper.js <developer-url> [output-dir]"
    );
    process.exitCode = 1;
  } else {
    discoverDeveloperApps(developerUrl, {
      outputDir: process.argv[3]
    }).catch(error => {
      console.error("\nDeveloper-page discovery failed:");
      console.error(error.message);
      process.exitCode = 1;
    });
  }
}
