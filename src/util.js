function sleep(milliseconds, signal) {
  if (signal?.aborted) {
    return Promise.reject(signal.reason || new Error("Operation interrupted."));
  }

  return new Promise((resolve, reject) => {
    const timer = setTimeout(done, milliseconds);

    function done() {
      signal?.removeEventListener("abort", abort);
      resolve();
    }

    function abort() {
      clearTimeout(timer);
      signal?.removeEventListener("abort", abort);
      reject(signal.reason || new Error("Operation interrupted."));
    }

    signal?.addEventListener("abort", abort, { once: true });
  });
}

function safeName(value) {
  return String(value).replace(/[<>:"/\\|?*\u0000-\u001f]/g, "_");
}

function redact(text, secrets = []) {
  let result = String(text);

  for (const secret of secrets) {
    if (typeof secret === "string" && secret.length >= 3) {
      result = result.split(secret).join("<redacted>");
    }
  }

  return result;
}

module.exports = { redact, safeName, sleep };
