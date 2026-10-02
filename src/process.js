const { spawn } = require("node:child_process");
const { redact } = require("./util");

function quoteWindowsArgument(value) {
  const argument = String(value);

  if (/[\r\n"%]/.test(argument)) {
    throw new Error(
      "Windows batch tool arguments cannot contain quotes, percent signs, or newlines."
    );
  }

  return `"${argument.replace(/(["^&|<>])/g, "^$1")}"`;
}

function createInvocation(executable, args, platform = process.platform, comSpec = "cmd.exe") {
  if (platform !== "win32" || !/\.(?:bat|cmd)$/i.test(executable)) {
    return {
      command: executable,
      args,
      windowsVerbatimArguments: false
    };
  }

  const commandText = [executable, ...args]
    .map(quoteWindowsArgument)
    .join(" ");

  return {
    command: comSpec,
    args: ["/d", "/v:off", "/s", "/c", `"${commandText}"`],
    windowsVerbatimArguments: true
  };
}

function displayArgument(value) {
  const string = String(value);
  return /^[A-Za-z0-9_./:=+@-]+$/.test(string)
    ? string
    : JSON.stringify(string);
}

function createRunner(options = {}) {
  const platform = options.platform || process.platform;
  const comSpec = options.comSpec || process.env.ComSpec || "cmd.exe";
  const secrets = options.secrets || [];
  const logger = options.logger || console;

  return function runTool(executable, args, runOptions = {}) {
    const invocation = createInvocation(
      executable,
      args,
      platform,
      comSpec
    );
    const shownCommand = [
      invocation.command,
      ...invocation.args
    ].map(displayArgument).join(" ");
    logger.log(`> ${redact(shownCommand, secrets)}`);

    return new Promise((resolve, reject) => {
      if (runOptions.signal?.aborted) {
        reject(runOptions.signal.reason || new Error("Operation interrupted."));
        return;
      }

      let child;
      try {
        child = spawn(invocation.command, invocation.args, {
          windowsHide: true,
          windowsVerbatimArguments: invocation.windowsVerbatimArguments,
          stdio: ["ignore", "pipe", "pipe"]
        });
      } catch (error) {
        reject(error);
        return;
      }

      const stdoutChunks = [];
      const stderrChunks = [];
      let stdoutSize = 0;
      let stderrSize = 0;
      let settled = false;
      let outputLine = "";
      const maxCapture = runOptions.maxCaptureBytes || 4 * 1024 * 1024;
      const captureStdout = runOptions.captureStdout !== false;
      const showOutput = runOptions.showOutput === true;

      function collect(chunks, bytes, chunk) {
        const available = Math.max(0, maxCapture - bytes);
        if (available > 0) {
          chunks.push(Buffer.from(chunk).subarray(0, available));
        }
        return bytes + chunk.length;
      }

      function show(chunk) {
        if (!showOutput) {
          return;
        }

        outputLine += chunk.toString("utf8");
        const lines = outputLine.split(/[\r\n]+/);
        outputLine = lines.pop().slice(-65536);

        for (const line of lines) {
          if (line) {
            logger.log(redact(line, secrets));
          }
        }
      }

      child.stdout.on("data", chunk => {
        if (captureStdout) {
          stdoutSize = collect(stdoutChunks, stdoutSize, chunk);
        }
        show(chunk);
      });
      child.stderr.on("data", chunk => {
        stderrSize = collect(stderrChunks, stderrSize, chunk);
        show(chunk);
      });

      function abort() {
        if (!child.pid) {
          return;
        }
        if (platform === "win32") {
          try {
            const killer = spawn(
              comSpec,
              ["/d", "/s", "/c", `taskkill /pid ${child.pid} /t /f`],
              { windowsHide: true, stdio: "ignore" }
            );
            killer.unref();
          } catch {
            child.kill("SIGTERM");
          }
        } else {
          child.kill("SIGTERM");
          const timer = setTimeout(() => {
            if (child.exitCode === null) {
              child.kill("SIGKILL");
            }
          }, 3000);
          timer.unref();
        }
      }

      const signal = runOptions.signal;
      signal?.addEventListener("abort", abort, { once: true });

      child.once("error", error => {
        if (settled) {
          return;
        }
        settled = true;
        signal?.removeEventListener("abort", abort);
        reject(error);
      });

      child.once("close", (code, terminationSignal) => {
        if (settled) {
          return;
        }
        settled = true;
        signal?.removeEventListener("abort", abort);

        if (outputLine) {
          logger.log(redact(outputLine, secrets));
        }

        resolve({
          code,
          signal: terminationSignal,
          stdout: captureStdout ? Buffer.concat(stdoutChunks).toString("utf8") : "",
          stderr: Buffer.concat(stderrChunks).toString("utf8"),
          stdoutTruncated: stdoutSize >= maxCapture,
          stderrTruncated: stderrSize >= maxCapture
        });
      });
    });
  };
}

module.exports = {
  createInvocation,
  createRunner
};
