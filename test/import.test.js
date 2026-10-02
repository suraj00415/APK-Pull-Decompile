const test = require("node:test");
const assert = require("node:assert/strict");

test("importing the CLI and feature modules does not register handlers or start work", () => {
  const events = ["SIGINT", "SIGTERM"];
  const before = new Map(
    events.map(event => [event, process.listeners(event)])
  );
  const stdinListeners = {
    data: process.stdin.listenerCount("data"),
    end: process.stdin.listenerCount("end")
  };

  require("../cli");
  require("../src/monitor");
  require("../src/acquisition");
  require("../src/decompilation");
  require("../src/pipeline");

  for (const event of events) {
    assert.deepEqual(process.listeners(event), before.get(event));
  }
  assert.equal(process.stdin.listenerCount("data"), stdinListeners.data);
  assert.equal(process.stdin.listenerCount("end"), stdinListeners.end);
});
