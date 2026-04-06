#!/usr/bin/env bun
/**
 * OpenLog CLI
 *
 * Usage:
 *   openlog              — Start the dashboard
 *   openlog start        — Start the dashboard
 *   openlog update       — Pull latest, reinstall, restart
 *   openlog restart      — Kill existing + start fresh
 *   openlog stop         — Stop the running dashboard
 *   openlog status       — Check if running, show version
 *   openlog ports        — Show active localhost services
 */

import { execSync, spawn } from "node:child_process";
import { join } from "node:path";

const VERSION = "0.1.1";
const PORT = parseInt(process.env.PORT ?? "7777", 10);
const DIR = import.meta.dir;

const SALMON = "\x1b[38;2;212;119;92m";
const BOLD = "\x1b[1m";
const DIM = "\x1b[2m";
const RESET = "\x1b[0m";

function log(msg: string) { console.log(`  ${msg}`); }
function header() {
  console.log();
  log(`${BOLD}OpenLog${RESET} ${DIM}v${VERSION}${RESET}`);
  log(`${"─".repeat(40)}`);
}

function isRunning(): number | null {
  try {
    const pids = execSync(`lsof -ti:${PORT} 2>/dev/null`, { encoding: "utf-8" }).trim();
    if (pids) return parseInt(pids.split("\n")[0], 10);
  } catch {}
  return null;
}

function killExisting(): boolean {
  const pid = isRunning();
  if (pid) {
    try {
      execSync(`kill -9 ${pid} 2>/dev/null`);
      log(`Stopped existing process (PID ${pid})`);
      // Wait for port to free up
      let attempts = 0;
      while (isRunning() && attempts < 10) {
        execSync("sleep 0.2");
        attempts++;
      }
      return true;
    } catch {}
  }
  return false;
}

function startServer(foreground = true) {
  if (foreground) {
    log(`Starting on ${SALMON}http://localhost:${PORT}${RESET}`);
    console.log();
    const server = spawn("bun", ["run", "server.ts"], {
      cwd: DIR,
      stdio: "inherit",
      env: { ...process.env, PORT: String(PORT) },
    });
    server.on("exit", (code) => process.exit(code ?? 0));
    process.on("SIGINT", () => { server.kill("SIGINT"); process.exit(0); });
    process.on("SIGTERM", () => { server.kill("SIGTERM"); process.exit(0); });
  } else {
    // Background: detach from terminal
    const server = spawn("bun", ["run", "server.ts"], {
      cwd: DIR,
      stdio: "ignore",
      env: { ...process.env, PORT: String(PORT) },
      detached: true,
    });
    server.unref();
    // Wait a moment and verify it started
    execSync("sleep 0.5");
    const pid = isRunning();
    if (pid) {
      log(`Dashboard running at ${SALMON}http://localhost:${PORT}${RESET} (PID ${pid})`);
    } else {
      log(`${SALMON}Failed to start${RESET} — run ${BOLD}openlog start${RESET} to debug`);
    }
    console.log();
  }
}

async function checkRemoteVersion(): Promise<{ latest: string; updateAvailable: boolean } | null> {
  try {
    const res = await fetch("https://api.github.com/repos/kaiwilliams-dev/open-log/releases/latest", {
      headers: { "User-Agent": "OpenLog/" + VERSION },
    });
    if (!res.ok) return null;
    const data = await res.json() as { tag_name: string };
    const latest = data.tag_name.replace(/^v/, "");
    return { latest, updateAvailable: latest !== VERSION };
  } catch {
    return null;
  }
}

// ── Commands ──

const cmd = process.argv[2] ?? "start";

switch (cmd) {
  case "start": {
    header();
    const pid = isRunning();
    if (pid) {
      log(`Already running on port ${PORT} (PID ${pid})`);
      log(`Use ${SALMON}openlog restart${RESET} to restart`);
      console.log();
      process.exit(0);
    }
    startServer();
    break;
  }

  case "restart": {
    header();
    killExisting();
    startServer();
    break;
  }

  case "stop": {
    header();
    const pid = isRunning();
    if (pid) {
      killExisting();
      log("Stopped.");
    } else {
      log("Not running.");
    }
    console.log();
    break;
  }

  case "update": {
    header();
    log("Checking for updates...");

    const remote = await checkRemoteVersion();
    if (remote?.updateAvailable) {
      log(`${SALMON}Update available:${RESET} v${VERSION} → v${remote.latest}`);
    } else if (remote) {
      log(`Already on latest (v${VERSION})`);
    }

    log("");
    log("Pulling latest...");
    try {
      const pullOutput = execSync("git pull", { cwd: DIR, encoding: "utf-8" }).trim();
      log(DIM + pullOutput + RESET);
    } catch (e: any) {
      log(`${SALMON}Git pull failed:${RESET} ${e.message}`);
      process.exit(1);
    }

    log("");
    log("Installing dependencies...");
    try {
      execSync("bun install", { cwd: DIR, stdio: "inherit" });
    } catch {
      log(`${SALMON}Install failed${RESET}`);
      process.exit(1);
    }

    log("");
    killExisting();
    log("Starting in background...");
    startServer(false);
    log(`${SALMON}Done!${RESET} Open http://localhost:${PORT}`);
    console.log();
    process.exit(0);
  }

  case "status": {
    header();
    const pid = isRunning();
    if (pid) {
      log(`${SALMON}●${RESET} Running on port ${PORT} (PID ${pid})`);
      try {
        const rss = execSync(`ps -p ${pid} -o rss= 2>/dev/null`, { encoding: "utf-8" }).trim();
        const mb = parseInt(rss, 10) / 1024;
        log(`  Memory: ${mb.toFixed(0)}MB`);
      } catch {}
    } else {
      log(`○ Not running`);
    }
    log(`  Version: v${VERSION}`);
    log(`  Port: ${PORT}`);
    log(`  Dashboard: http://localhost:${PORT}`);

    const remote = await checkRemoteVersion();
    if (remote?.updateAvailable) {
      log(`  ${SALMON}Update available: v${remote.latest}${RESET}`);
      log(`  Run ${BOLD}openlog update${RESET} to update`);
    }
    console.log();
    break;
  }

  case "ports": {
    // Delegate to ports.ts
    const ports = spawn("bun", ["run", "ports.ts", ...process.argv.slice(3)], {
      cwd: DIR,
      stdio: "inherit",
    });
    ports.on("exit", (code) => process.exit(code ?? 0));
    break;
  }

  case "help":
  case "--help":
  case "-h": {
    header();
    log(`${BOLD}Commands:${RESET}`);
    log(`  ${SALMON}openlog${RESET}            Start the dashboard`);
    log(`  ${SALMON}openlog start${RESET}      Start the dashboard`);
    log(`  ${SALMON}openlog update${RESET}     Pull latest, reinstall, restart`);
    log(`  ${SALMON}openlog restart${RESET}    Kill existing + start fresh`);
    log(`  ${SALMON}openlog stop${RESET}       Stop the running dashboard`);
    log(`  ${SALMON}openlog status${RESET}     Check if running, show version`);
    log(`  ${SALMON}openlog ports${RESET}      Show active localhost services`);
    console.log();
    break;
  }

  default: {
    console.error(`  Unknown command: ${cmd}`);
    console.error(`  Run ${SALMON}openlog help${RESET} for usage`);
    process.exit(1);
  }
}
