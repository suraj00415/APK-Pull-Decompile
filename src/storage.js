const crypto = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");
const { hostname } = require("node:os");

const PACKAGE_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;

function ensureDirectory(directory) {
  fs.mkdirSync(directory, { recursive: true });
  const info = fs.lstatSync(directory);

  if (!info.isDirectory() || info.isSymbolicLink()) {
    throw new Error(`Expected a real directory: ${directory}`);
  }
}

function readJson(filePath, fallback) {
  try {
    return JSON.parse(fs.readFileSync(filePath, "utf8"));
  } catch (error) {
    if (error.code === "ENOENT") {
      return fallback;
    }

    throw new Error(`Could not read ${filePath}: ${error.message}`);
  }
}

function writeJsonAtomic(filePath, value) {
  ensureDirectory(path.dirname(filePath));
  assertOwnedPath(path.dirname(filePath), filePath);
  const tempPath = `${filePath}.${process.pid}.${crypto.randomUUID()}.tmp`;
  let descriptor;

  try {
    descriptor = fs.openSync(tempPath, "wx", 0o600);
    fs.writeFileSync(descriptor, `${JSON.stringify(value, null, 2)}\n`, "utf8");
    fs.fsyncSync(descriptor);
    fs.closeSync(descriptor);
    descriptor = undefined;
    fs.renameSync(tempPath, filePath);
  } catch (error) {
    if (descriptor !== undefined) {
      fs.closeSync(descriptor);
    }
    try {
      fs.unlinkSync(tempPath);
    } catch {
      // Preserve the original write error.
    }
    throw new Error(`Could not save ${filePath}: ${error.message}`);
  }
}

function packageDirectoryName(packageName) {
  const safe = String(packageName);

  if (!PACKAGE_PATTERN.test(safe) || safe === "." || safe === "..") {
    throw new Error(`Unsafe package name: ${safe}`);
  }

  return safe;
}

function pathIsWithin(rootDirectory, target) {
  const root = path.resolve(rootDirectory);
  const destination = path.resolve(target);
  return destination === root || destination.startsWith(`${root}${path.sep}`);
}

function assertOwnedPath(rootDirectory, target) {
  const root = path.resolve(rootDirectory);
  const destination = path.resolve(target);

  if (!pathIsWithin(root, destination) || destination === root) {
    throw new Error(`Refusing to modify a path outside its configured directory: ${destination}`);
  }

  const relative = path.relative(root, destination);
  let cursor = root;

  for (const part of relative.split(path.sep)) {
    cursor = path.join(cursor, part);
    try {
      const info = fs.lstatSync(cursor);

      if (info.isSymbolicLink()) {
        throw new Error(`Refusing to follow a symbolic link: ${cursor}`);
      }
    } catch (error) {
      if (error.code === "ENOENT") {
        continue;
      }
      throw error;
    }
  }

  return destination;
}

function removeOwnedPath(rootDirectory, target) {
  const destination = assertOwnedPath(rootDirectory, target);

  if (fs.existsSync(destination)) {
    fs.rmSync(destination, { recursive: true, force: true });
  }
}

function findApks(rootDirectory) {
  if (!fs.existsSync(rootDirectory)) {
    return [];
  }

  const files = [];

  function walk(directory) {
    for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
      if (entry.isSymbolicLink() || entry.name.startsWith(".staging-") ||
          entry.name.startsWith(".backup-")) {
        continue;
      }

      const fullPath = path.join(directory, entry.name);

      if (entry.isDirectory()) {
        walk(fullPath);
      } else if (entry.isFile() && /\.apk$/i.test(entry.name)) {
        files.push(fullPath);
      }
    }
  }

  walk(rootDirectory);
  return files.sort();
}

function groupApks(rootDirectory) {
  const groups = new Map();

  for (const apkPath of findApks(rootDirectory)) {
    const relative = path.relative(rootDirectory, apkPath);
    const components = relative.split(path.sep);
    const packageName = components.length > 1
      ? components[0]
      : path.basename(apkPath, path.extname(apkPath));

    if (!groups.has(packageName)) {
      groups.set(packageName, []);
    }

    groups.get(packageName).push(apkPath);
  }

  return [...groups].map(([packageName, apkFiles]) => ({
    packageName,
    apkFiles: apkFiles.sort()
  })).sort((left, right) => left.packageName.localeCompare(right.packageName));
}

async function fileSignature(filePaths) {
  const files = [];

  for (const filePath of [...new Set(filePaths)].sort()) {
    const digest = crypto.createHash("sha256");
    const stream = fs.createReadStream(filePath);

    for await (const chunk of stream) {
      digest.update(chunk);
    }

    const info = fs.statSync(filePath);
    files.push({
      path: path.resolve(filePath),
      size: info.size,
      sha256: digest.digest("hex")
    });
  }

  return files;
}

function loadProcessing(dataDirectory) {
  const value = readJson(path.join(dataDirectory, "processing-state.json"), null);

  if (!value) {
    return {
      initialized: true,
      pipelineInitialized: false,
      packages: Object.create(null)
    };
  }

  if (typeof value !== "object" || Array.isArray(value) ||
      typeof value.packages !== "object" || !value.packages) {
    throw new Error("The processing state is invalid; move processing-state.json aside and try again.");
  }

  return {
    initialized: true,
    pipelineInitialized: Boolean(value.pipelineInitialized),
    packages: Object.assign(Object.create(null), value.packages)
  };
}

function saveProcessing(dataDirectory, state) {
  writeJsonAtomic(path.join(dataDirectory, "processing-state.json"), state);
}

function processIsAlive(pid) {
  if (!Number.isInteger(pid) || pid < 1) {
    return false;
  }

  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error.code === "EPERM";
  }
}

function lockOwner(lockDirectory) {
  try {
    return readJson(path.join(lockDirectory, "owner.json"), null);
  } catch {
    return null;
  }
}

function ownerIsDead(lockDirectory, owner) {
  if (owner) {
    if (owner.host !== hostname()) {
      return false;
    }
    return !processIsAlive(owner.pid);
  }

  try {
    return Date.now() - fs.statSync(lockDirectory).mtimeMs > 120000;
  } catch {
    return true;
  }
}

function acquireLock(dataDirectory) {
  ensureDirectory(dataDirectory);
  const lockDirectory = path.join(dataDirectory, ".apk-workflow.lock");
  const recoveryDirectory = `${lockDirectory}.recovery`;
  const token = crypto.randomUUID();
  const owner = {
    pid: process.pid,
    host: hostname(),
    token,
    startedAt: new Date().toISOString()
  };

  function createLock() {
    try {
      fs.mkdirSync(lockDirectory);
    } catch (error) {
      if (error.code === "EEXIST") {
        return false;
      }
      throw error;
    }

    try {
      writeJsonAtomic(path.join(lockDirectory, "owner.json"), owner);
      return true;
    } catch (error) {
      removeOwnedPath(dataDirectory, lockDirectory);
      throw error;
    }
  }

  if (!createLock()) {
    const existingOwner = lockOwner(lockDirectory);

    if (!ownerIsDead(lockDirectory, existingOwner)) {
      return { acquired: false, owner: existingOwner };
    }

    try {
      fs.mkdirSync(recoveryDirectory);
    } catch (error) {
      if (error.code === "EEXIST") {
        return { acquired: false, owner: existingOwner };
      }
      throw error;
    }

    try {
      const latestOwner = lockOwner(lockDirectory);

      if (!ownerIsDead(lockDirectory, latestOwner)) {
        return { acquired: false, owner: latestOwner };
      }

      removeOwnedPath(dataDirectory, lockDirectory);

      if (!createLock()) {
        return { acquired: false, owner: lockOwner(lockDirectory) };
      }
    } finally {
      removeOwnedPath(dataDirectory, recoveryDirectory);
    }
  }

  let released = false;

  return {
    acquired: true,
    release() {
      if (released) {
        return;
      }

      const current = lockOwner(lockDirectory);

      if (current?.token === token) {
        removeOwnedPath(dataDirectory, lockDirectory);
      }

      released = true;
    }
  };
}

function publishDirectory(rootDirectory, stagingDirectory, destinationDirectory) {
  const root = path.resolve(rootDirectory);
  const staging = assertOwnedPath(root, stagingDirectory);
  const destination = assertOwnedPath(root, destinationDirectory);
  const encodedName = Buffer.from(path.basename(destination)).toString("base64url");
  const backup = path.join(
    root,
    `.backup-${encodedName}-${process.pid}-${crypto.randomUUID()}`
  );
  let movedOldDirectory = false;

  try {
    if (fs.existsSync(destination)) {
      fs.renameSync(destination, backup);
      movedOldDirectory = true;
    }

    fs.renameSync(staging, destination);
  } catch (error) {
    if (movedOldDirectory && !fs.existsSync(destination)) {
      fs.renameSync(backup, destination);
    }
    throw error;
  }

  if (movedOldDirectory) {
    removeOwnedPath(root, backup);
  }
}

function recoverDirectorySwaps(rootDirectory) {
  if (!fs.existsSync(rootDirectory)) {
    return;
  }

  for (const entry of fs.readdirSync(rootDirectory, { withFileTypes: true })) {
    if (!entry.isDirectory() || entry.isSymbolicLink() ||
        !entry.name.startsWith(".backup-")) {
      continue;
    }

    const match = entry.name.match(/^\.backup-(.+)-\d+-[0-9a-f-]{36}$/);
    if (!match) {
      continue;
    }

    let destinationName;
    try {
      destinationName = Buffer.from(match[1], "base64url").toString("utf8");
      packageDirectoryName(destinationName);
    } catch {
      continue;
    }

    const backupPath = path.join(rootDirectory, entry.name);
    const destinationPath = path.join(rootDirectory, destinationName);
    if (!fs.existsSync(destinationPath)) {
      fs.renameSync(backupPath, destinationPath);
    } else {
      removeOwnedPath(rootDirectory, backupPath);
    }
  }
}

module.exports = {
  acquireLock,
  assertOwnedPath,
  ensureDirectory,
  fileSignature,
  findApks,
  groupApks,
  loadProcessing,
  packageDirectoryName,
  publishDirectory,
  recoverDirectorySwaps,
  readJson,
  removeOwnedPath,
  saveProcessing,
  writeJsonAtomic
};
