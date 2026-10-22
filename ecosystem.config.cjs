/** PM2 config — loads .env.production so auth URLs match https://screeno-ai.duckdns.org */
const path = require("path");
const fs = require("fs");

const appDir = __dirname;
const envPath = path.join(appDir, ".env.production");
const env = { NODE_ENV: "production" };

if (fs.existsSync(envPath)) {
  for (const line of fs.readFileSync(envPath, "utf8").split("\n")) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const eq = trimmed.indexOf("=");
    if (eq === -1) continue;
    const key = trimmed.slice(0, eq).trim();
    let val = trimmed.slice(eq + 1).trim();
    if (
      (val.startsWith('"') && val.endsWith('"')) ||
      (val.startsWith("'") && val.endsWith("'"))
    ) {
      val = val.slice(1, -1);
    }
    env[key] = val;
  }
}

module.exports = {
  apps: [
    {
      name: "screeno",
      cwd: appDir,
      script: "node_modules/.bin/next",
      args: "start",
      env,
    },
  ],
};
