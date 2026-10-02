function packagePatternMatches(pattern, packageName) {
  const expression = pattern
    .split("*")
    .map(part => part.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"))
    .join(".*");
  return new RegExp(`^${expression}$`).test(packageName);
}

function packageMatchesAny(packageName, patterns) {
  return patterns.some(pattern => packagePatternMatches(pattern, packageName));
}

function packageIsIncluded(packageName, developer, settings) {
  if (packageMatchesAny(packageName, settings.excludePackages)) {
    return false;
  }

  if (settings.packages.length > 0 &&
      !packageMatchesAny(packageName, settings.packages)) {
    return false;
  }

  if (!developer) {
    return true;
  }

  if (packageMatchesAny(packageName, developer.excludePackages)) {
    return false;
  }

  return developer.includePackages.length === 0 ||
    packageMatchesAny(packageName, developer.includePackages);
}

function filterApps(apps, settings) {
  return apps.filter(app => {
    const developer = settings.developers.find(
      item => item.id === String(app.developerId || "")
    );
    return packageIsIncluded(app.package, developer, settings);
  });
}

function deduplicateApps(apps) {
  const byPackage = new Map();

  for (const app of apps) {
    const current = byPackage.get(app.package);

    if (!current) {
      byPackage.set(app.package, {
        ...app,
        developerNames: app.developerName ? [app.developerName] : []
      });
      continue;
    }

    if (current.version && app.version && current.version !== app.version) {
      throw new Error(
        `Conflicting monitored versions for ${app.package}: ${current.version} and ${app.version}.`
      );
    }

    current.version = current.version || app.version || null;
    current.title = current.title || app.title || "";
    current.url = current.url || app.url || "";
    if (app.developerName && !current.developerNames.includes(app.developerName)) {
      current.developerNames.push(app.developerName);
    }
  }

  return [...byPackage.values()].sort((left, right) =>
    left.package.localeCompare(right.package)
  );
}

module.exports = {
  deduplicateApps,
  filterApps,
  packageIsIncluded,
  packageMatchesAny
};
