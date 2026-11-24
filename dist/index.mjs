// @bun
// src/index.mjs
import fs2 from "fs";
import path2 from "path";
import os from "os";
import http from "http";
import crypto2 from "crypto";
import { spawn } from "child_process";
import { fileURLToPath } from "url";

// src/files.mjs
import fs from "fs";
import path from "path";
import crypto from "crypto";
function privateDir(dir) {
  fs.mkdirSync(dir, { recursive: true, mode: 448 });
}
function credential(file) {
  try {
    return fs.readFileSync(file, "utf8").trim();
  } catch (e) {
    if (e.code !== "ENOENT")
      throw e;
    privateDir(path.dirname(file));
    const key = crypto.randomBytes(32).toString("hex");
    try {
      fs.writeFileSync(file, key, { flag: "wx", mode: 384 });
      return key;
    } catch (e2) {
      if (e2.code !== "EEXIST")
        throw e2;
      return fs.readFileSync(file, "utf8").trim();
    }
  }
}

// src/index.mjs
async function ClaudeFirstParty() {
  if (process.platform !== "darwin")
    throw new Error("Claude Desktop 1P alpha currently supports macOS only.");
  const home = process.env.MAGPIE_1P_HOME || os.homedir();
  const dir = path2.join(home, ".claude/magpie-1p");
  const key = credential(path2.join(dir, "control-token"));
  const controlPort = process.env.MAGPIE_1P_HOME ? Number(process.env.MAGPIE_1P_CONTROL_PORT || 3436) : 3436;
  const id = crypto2.randomUUID();
  let starting = false, closed = false, lastLaunch = 0;
  function lease() {
    return new Promise((resolve, reject) => {
      const body = JSON.stringify({ id });
      const req = http.request({ hostname: "127.0.0.1", port: controlPort, path: "/lease", method: "POST", headers: { authorization: "Bearer " + key, "content-type": "application/json", "content-length": Buffer.byteLength(body) }, timeout: 1500 }, (res) => {
        res.resume();
        res.once("end", () => res.statusCode === 200 ? resolve() : reject(new Error("The 1P service port belongs to another process.")));
      });
      req.once("error", reject);
      req.once("timeout", () => req.destroy(new Error("1P lease timeout")));
      req.end(body);
    });
  }
  async function heartbeat() {
    if (starting || closed)
      return;
    starting = true;
    try {
      await lease();
    } catch (e) {
      if (e.code !== "ECONNREFUSED" || Date.now() - lastLaunch < 15000) {
        console.error("[Claude 1P]", e.message);
        return;
      }
      lastLaunch = Date.now();
      const runtime = process.execPath;
      const worker = fileURLToPath(new URL("./worker.mjs", import.meta.url));
      const log = fs2.openSync(path2.join(dir, "runtime.log"), "a", 384);
      const child = spawn(runtime, [worker], { detached: true, stdio: ["ignore", log, log], env: { ...process.env, MAGPIE_1P_HOME: home } });
      child.on("error", (e2) => console.error("[Claude 1P] Could not start runtime:", e2.message));
      child.unref();
      fs2.closeSync(log);
    } finally {
      starting = false;
    }
  }
  heartbeat();
  const timer = setInterval(heartbeat, 5000);
  timer.unref();
  process.once("exit", () => {
    closed = true;
    clearInterval(timer);
  });
  return {};
}
export {
  ClaudeFirstParty as default
};
