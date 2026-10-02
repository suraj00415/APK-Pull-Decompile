const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const {
  acquireLock,
  publishDirectory,
  recoverDirectorySwaps
} = require("../src/storage");
const { createInvocation, createRunner } = require("../src/process");

test("the shared lock skips concurrent owners and releases cleanly", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "apk-lock-test-"));
  try {
    const first = acquireLock(root);
    const second = acquireLock(root);
    assert.equal(first.acquired, true);
    assert.equal(second.acquired, false);
    first.release();
    const third = acquireLock(root);
    assert.equal(third.acquired, true);
    third.release();
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("directory publishing keeps the old output when a replacement cannot be renamed", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "apk-publish-test-"));
  const oldOutput = path.join(root, "com.example.app");
  const missingStage = path.join(root, ".staging-missing");
  fs.mkdirSync(oldOutput);
  fs.writeFileSync(path.join(oldOutput, "old.txt"), "previous");

  try {
    assert.throws(() =>
      publishDirectory(root, missingStage, oldOutput)
    );
    assert.equal(
      fs.readFileSync(path.join(oldOutput, "old.txt"), "utf8"),
      "previous"
    );
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("a directory swap interrupted before publishing restores the previous output", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "apk-recovery-test-"));
  const backup = path.join(
    root,
    `.backup-${Buffer.from("com.example.app").toString("base64url")}-99999999-12345678-1234-1234-1234-123456789abc`
  );
  fs.mkdirSync(backup);
  fs.writeFileSync(path.join(backup, "old.txt"), "preserved");

  try {
    recoverDirectorySwaps(root);
    assert.equal(
      fs.readFileSync(path.join(root, "com.example.app", "old.txt"), "utf8"),
      "preserved"
    );
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("Windows batch invocations quote executable and paths containing spaces", () => {
  const invocation = createInvocation(
    "C:\\Tools\\jadx.bat",
    ["-d", "C:\\APK Output\\com.example.app"],
    "win32",
    "C:\\Windows\\System32\\cmd.exe"
  );

  assert.equal(invocation.command, "C:\\Windows\\System32\\cmd.exe");
  assert.equal(invocation.windowsVerbatimArguments, true);
  assert.match(invocation.args.at(-1), /"C:\\Tools\\jadx\.bat"/);
  assert.match(invocation.args.at(-1), /"C:\\APK Output\\com\.example\.app"/);
});

test("native Linux tools keep their direct executable and credential logs are redacted", async () => {
  const invocation = createInvocation(
    "/opt/jadx with spaces/bin/jadx",
    ["-d", "/tmp/output with spaces"],
    "linux"
  );
  assert.equal(invocation.command, "/opt/jadx with spaces/bin/jadx");
  assert.deepEqual(invocation.args, ["-d", "/tmp/output with spaces"]);

  const logged = [];
  const runner = createRunner({
    logger: { log: line => logged.push(line), error: line => logged.push(line) },
    secrets: ["private-token"]
  });
  const result = await runner(
    process.execPath,
    ["-e", "process.stdout.write(process.argv[1])", "private-token"],
    { captureStdout: true }
  );
  assert.equal(result.code, 0);
  assert.equal(result.stdout, "private-token");
  assert.equal(logged.some(line => line.includes("private-token")), false);
});
