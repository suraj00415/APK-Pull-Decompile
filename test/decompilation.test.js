const test = require("node:test");
const assert = require("node:assert/strict");
const path = require("node:path");
const { selectBaseApk } = require("../src/decompilation");

test("fast JADX mode selects the base APK and rejects ambiguous split sets", () => {
  const files = [
    path.join("apks", "com.example.app", "split_config.apk"),
    path.join("apks", "com.example.app", "base.apk")
  ];

  assert.deepEqual(
    selectBaseApk(files, "com.example.app"),
    [files[1]]
  );
  assert.throws(
    () => selectBaseApk([
      files[0],
      path.join("apks", "com.example.app", "split_config.en.apk")
    ], "com.example.app"),
    /Expected base\.apk/
  );
  assert.deepEqual(
    selectBaseApk(["apks/com.example.app/single.apk"], "com.example.app"),
    ["apks/com.example.app/single.apk"]
  );
});
