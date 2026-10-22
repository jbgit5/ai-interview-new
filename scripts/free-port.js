/**
 * Stops whatever is listening on the given TCP port (default 3000).
 * Windows: PowerShell Get-NetTCPConnection + Stop-Process.
 * macOS/Linux: lsof + kill -9.
 * Used before `next dev` so the app always binds to the intended port.
 */

const { execSync } = require("child_process");

const raw = process.argv[2] || process.env.DEV_PORT || "3000";
const port = /^\d+$/.test(String(raw)) ? String(raw) : "3000";

function killWindows() {
  const block = [
    "Get-NetTCPConnection",
    `-LocalPort ${port}`,
    "-State Listen",
    "-ErrorAction SilentlyContinue",
    "| Select-Object -ExpandProperty OwningProcess -Unique",
    "| Where-Object { $_ -gt 0 }",
    "| ForEach-Object { Stop-Process -Id $_ -Force -ErrorAction SilentlyContinue }",
  ].join(" ");
  try {
    execSync(
      `powershell -NoProfile -NonInteractive -Command "& { ${block} }"`,
      { stdio: "ignore", windowsHide: true }
    );
  } catch {
    // Nothing listening, or cannot stop (ignore and let next dev report bind errors)
  }
}

function killUnix() {
  try {
    const out = execSync(`lsof -ti :${port}`, {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    }).trim();
    if (!out) return;
    for (const pid of out.split(/\n/).filter(Boolean)) {
      try {
        execSync(`kill -9 ${pid}`, { stdio: "ignore" });
      } catch {
        // ignore
      }
    }
  } catch {
    // lsof exits 1 when no process uses the port
  }
}

if (process.platform === "win32") killWindows();
else killUnix();
