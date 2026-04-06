/**
 * OpenLog Ports — See every localhost service running on your machine
 *
 * Usage:
 *   bun run ports.ts              # One-shot table
 *   bun run ports.ts --watch      # Live updating (every 3s)
 *   bun run ports.ts --json       # JSON output
 *   bun run ports.ts --serve 9999 # Serve a web UI on port 9999
 */

import { execSync } from "node:child_process";
import { readdir } from "node:fs/promises";
import { join } from "node:path";

const HOME = process.env.HOME ?? "/Users/apple";
const SESSIONS_DIR = join(HOME, ".claude", "sessions");

interface PortInfo {
  port: number;
  pid: number;
  process: string;
  command: string;
  cwd: string;
  memory: string;
  user: string;
  state: string;
  icon: string;
  label: string;
  color: string;
}

// Logo/icon mapping based on process name or command keywords
function detectService(process: string, command: string, port: number): { icon: string; label: string; color: string } {
  const cmd = command.toLowerCase();
  const proc = process.toLowerCase();

  if (cmd.includes("next-server") || cmd.includes("next dev")) return { icon: "▲", label: "Next.js", color: "#000" };
  if (cmd.includes("vite") || port === 5173 || port === 5174) return { icon: "⚡", label: "Vite", color: "#646CFF" };
  if (cmd.includes("openlog") || cmd.includes("server.ts") && port === 7777) return { icon: "◉", label: "OpenLog", color: "#D4775C" };
  if (proc === "redis-ser" || cmd.includes("redis")) return { icon: "◆", label: "Redis", color: "#DC382D" };
  if (cmd.includes("python") || proc.startsWith("python")) return { icon: "🐍", label: "Python", color: "#3776AB" };
  if (cmd.includes("nginx")) return { icon: "◈", label: "Nginx", color: "#009639" };
  if (cmd.includes("postgres") || proc.includes("postgres")) return { icon: "🐘", label: "PostgreSQL", color: "#336791" };
  if (cmd.includes("mongo")) return { icon: "🍃", label: "MongoDB", color: "#47A248" };
  if (cmd.includes("docker")) return { icon: "🐳", label: "Docker", color: "#2496ED" };
  if (proc === "node" || cmd.includes("node ")) return { icon: "⬢", label: "Node.js", color: "#339933" };
  if (proc === "bun" || cmd.includes("bun ")) return { icon: "🥟", label: "Bun", color: "#FBF0DF" };
  if (cmd.includes("raycast")) return { icon: "🔍", label: "Raycast", color: "#FF6363" };
  if (cmd.includes("figma")) return { icon: "🎨", label: "Figma", color: "#F24E1E" };
  if (cmd.includes("t3 code") || cmd.includes("code")) return { icon: "⌨️", label: "Editor", color: "#007ACC" };
  if (cmd.includes("webpack")) return { icon: "📦", label: "Webpack", color: "#8DD6F9" };
  if (cmd.includes("esbuild")) return { icon: "⚡", label: "esbuild", color: "#FFCF00" };
  if (cmd.includes("flask")) return { icon: "🧪", label: "Flask", color: "#000" };
  if (cmd.includes("fastapi") || cmd.includes("uvicorn")) return { icon: "⚡", label: "FastAPI", color: "#009688" };
  if (cmd.includes("rapportd")) return { icon: "📡", label: "System", color: "#999" };

  return { icon: "●", label: proc || "Unknown", color: "#999" };
}

interface ClaudeSession {
  pid: number;
  sessionId: string;
  cwd: string;
  startedAt: number;
  kind?: string;
  entrypoint?: string;
}

async function getClaudeSessions(): Promise<ClaudeSession[]> {
  try {
    const files = (await readdir(SESSIONS_DIR)).filter(f => f.endsWith(".json"));
    const sessions: ClaudeSession[] = [];

    await Promise.all(files.map(async (f) => {
      try {
        const file = Bun.file(join(SESSIONS_DIR, f));
        const data = await file.json() as ClaudeSession;
        // Check if the PID is still alive
        try {
          execSync(`kill -0 ${data.pid} 2>/dev/null`, { timeout: 1000 });
          sessions.push(data);
        } catch {
          // PID not running — skip
        }
      } catch {}
    }));

    sessions.sort((a, b) => b.startedAt - a.startedAt);
    return sessions;
  } catch {
    return [];
  }
}

function getListeningPorts(): PortInfo[] {
  try {
    const raw = execSync(
      `lsof -iTCP -sTCP:LISTEN -nP 2>/dev/null`,
      { encoding: "utf-8", timeout: 5000 }
    );

    const lines = raw.trim().split("\n").slice(1);
    const seen = new Map<number, PortInfo>();

    for (const line of lines) {
      const parts = line.split(/\s+/);
      if (parts.length < 9) continue;

      const process = parts[0];
      const pid = parseInt(parts[1], 10);
      const user = parts[2];
      const name = parts[8];

      const portMatch = name.match(/:(\d+)$/);
      if (!portMatch) continue;
      const port = parseInt(portMatch[1], 10);

      if (seen.has(port)) continue;

      let command = process;
      let cwd = "";
      let memory = "";

      try {
        command = execSync(`ps -p ${pid} -o command= 2>/dev/null`, {
          encoding: "utf-8", timeout: 2000,
        }).trim();
        if (command.length > 120) command = command.slice(0, 117) + "...";
      } catch {}

      try {
        cwd = execSync(`lsof -p ${pid} -Fn 2>/dev/null | grep "^n/" | head -1`, {
          encoding: "utf-8", timeout: 2000,
        }).trim().replace(/^n/, "");
      } catch {}

      try {
        const rss = execSync(`ps -p ${pid} -o rss= 2>/dev/null`, {
          encoding: "utf-8", timeout: 2000,
        }).trim();
        const mb = parseInt(rss, 10) / 1024;
        memory = mb >= 1024 ? `${(mb / 1024).toFixed(1)}GB` : `${mb.toFixed(0)}MB`;
      } catch {}

      const service = detectService(process, command, port);

      seen.set(port, {
        port, pid, process, command,
        cwd: cwd || "—", memory: memory || "—",
        user, state: "LISTEN",
        ...service,
      });
    }

    return [...seen.values()].sort((a, b) => a.port - b.port);
  } catch {
    return [];
  }
}

// ---------------------------------------------------------------------------
// CLI Output
// ---------------------------------------------------------------------------

function printTable(ports: PortInfo[]) {
  console.clear();
  console.log(`\n  \x1b[1mLocalhost Services\x1b[0m — ${ports.length} port${ports.length !== 1 ? "s" : ""} active`);
  console.log(`  ${"─".repeat(70)}`);

  if (ports.length === 0) {
    console.log("  No listening ports found.\n");
    return;
  }

  console.log(
    `  \x1b[2m${"PORT".padEnd(8)}${"SERVICE".padEnd(16)}${"PID".padEnd(10)}${"MEMORY".padEnd(10)}${"COMMAND"}\x1b[0m`
  );

  for (const p of ports) {
    const portStr = `:${p.port}`.padEnd(8);
    const svcStr = p.label.padEnd(16);
    const pidStr = String(p.pid).padEnd(10);
    const memStr = p.memory.padEnd(10);
    let cmd = p.command;
    if (cmd.length > 60) cmd = cmd.slice(0, 57) + "...";
    console.log(`  \x1b[33m${portStr}\x1b[0m${svcStr}${pidStr}${memStr}\x1b[2m${cmd}\x1b[0m`);
  }
  console.log();
}

// ---------------------------------------------------------------------------
// Web UI
// ---------------------------------------------------------------------------

function startWebUI(uiPort: number) {
  const html = `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>Localhost Services</title>
<link href="https://fonts.googleapis.com/css2?family=DM+Mono:wght@300;400;500&family=Poppins:wght@300;400;500;600&display=swap" rel="stylesheet">
<style>
  :root{--s:#D4775C;--ink:#1A1A1A;--i2:#555;--i3:#999;--i4:#bbb;--bg:#FAFAFA;--w:#FFF;--r:#E5E5E5}
  *{box-sizing:border-box;margin:0;padding:0}
  body{font-family:'Poppins',sans-serif;background:var(--bg);color:var(--ink);padding:48px;-webkit-font-smoothing:antialiased}
  h1{font-size:28px;font-weight:400;margin-bottom:4px;letter-spacing:-.5px}
  .sub{font-size:13px;color:var(--i3);font-weight:300;margin-bottom:24px}
  .sub span{color:var(--s);font-family:'DM Mono',monospace}

  .tabs{display:flex;gap:0;margin-bottom:24px;border-bottom:1px solid var(--r)}
  .tab{padding:10px 24px;font-size:13px;font-weight:400;color:var(--i3);cursor:pointer;border-bottom:2px solid transparent;transition:all .15s}
  .tab:hover{color:var(--ink)}
  .tab.on{color:var(--ink);border-bottom-color:var(--s);font-weight:500}
  .tab .count{font-family:'DM Mono',monospace;font-size:11px;background:var(--r);color:var(--i3);padding:1px 7px;border-radius:10px;margin-left:6px}
  .tab.on .count{background:rgba(212,119,92,0.12);color:var(--s)}

  .panel{display:none}
  .panel.on{display:block}

  .cards{display:grid;grid-template-columns:repeat(auto-fill,minmax(340px,1fr));gap:16px}
  .card{background:var(--w);border:1px solid var(--r);border-radius:10px;padding:20px;transition:all .2s;position:relative;overflow:hidden}
  .card:hover{border-color:#ccc;box-shadow:0 4px 20px rgba(0,0,0,0.04);transform:translateY(-1px)}
  .card-top{display:flex;align-items:center;gap:12px;margin-bottom:14px}
  .card-icon{width:38px;height:38px;border-radius:8px;display:flex;align-items:center;justify-content:center;font-size:18px;flex-shrink:0}
  .card-title{font-size:15px;font-weight:500}
  .card-port{font-family:'DM Mono',monospace;font-size:12px;color:var(--s)}
  .card-port a{color:var(--s);text-decoration:none}
  .card-port a:hover{text-decoration:underline}
  .card-meta{display:grid;grid-template-columns:1fr 1fr;gap:8px}
  .card-field{font-size:11px}
  .card-field-label{font-family:'DM Mono',monospace;font-size:9px;letter-spacing:.1em;text-transform:uppercase;color:var(--i4);margin-bottom:2px}
  .card-field-value{color:var(--i2);font-family:'DM Mono',monospace;font-size:11px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
  .card-cmd{margin-top:12px;font-family:'DM Mono',monospace;font-size:10px;color:var(--i3);background:var(--bg);padding:8px 10px;border-radius:5px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
  .live-dot{width:7px;height:7px;border-radius:50%;background:#2E7D32;display:inline-block;animation:pulse 2s ease-in-out infinite}
  @keyframes pulse{0%,100%{opacity:1}50%{opacity:.4}}

  /* Sessions */
  .session-card{background:var(--w);border:1px solid var(--r);border-radius:10px;padding:20px;transition:all .2s}
  .session-card:hover{border-color:#ccc;box-shadow:0 4px 20px rgba(0,0,0,0.04)}
  .session-top{display:flex;align-items:center;gap:12px;margin-bottom:12px}
  .claude-icon{width:38px;height:38px;border-radius:8px;background:#1A1A1A;display:flex;align-items:center;justify-content:center;color:var(--s);font-size:16px;font-family:'DM Mono',monospace;font-weight:600}
  .session-id{font-family:'DM Mono',monospace;font-size:11px;color:var(--i3)}
  .session-cwd{font-family:'DM Mono',monospace;font-size:11px;color:var(--i2);background:var(--bg);padding:8px 10px;border-radius:5px;margin-top:8px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
  .session-meta{display:flex;gap:20px;margin-top:10px}
  .session-meta-item{font-size:11px;color:var(--i3)}
  .session-meta-item strong{color:var(--i2);font-weight:500}

  .refresh{font-size:11px;color:var(--i3);margin-top:20px;font-family:'DM Mono',monospace}
  .empty{text-align:center;padding:48px;color:var(--i3);font-size:14px;font-weight:300}
</style>
</head>
<body>
<h1>Localhost Services</h1>
<div class="sub">Refreshes every 3 seconds</div>

<div class="tabs">
  <div class="tab on" onclick="switchTab('ports')">Services <span class="count" id="port-count">—</span></div>
  <div class="tab" onclick="switchTab('sessions')">Claude Sessions <span class="count" id="session-count">—</span></div>
</div>

<div class="panel on" id="panel-ports">
  <div class="cards" id="port-cards"></div>
</div>

<div class="panel" id="panel-sessions">
  <div class="cards" id="session-cards"></div>
</div>

<div class="refresh" id="ts"></div>

<script>
function switchTab(name){
  document.querySelectorAll('.tab').forEach(t=>t.classList.remove('on'));
  document.querySelectorAll('.panel').forEach(p=>p.classList.remove('on'));
  event.target.closest('.tab').classList.add('on');
  document.getElementById('panel-'+name).classList.add('on');
}

function timeAgo(ts){
  const s=Math.floor((Date.now()-ts)/1000);
  if(s<60)return s+'s ago';
  if(s<3600)return Math.floor(s/60)+'m ago';
  if(s<86400)return Math.floor(s/3600)+'h ago';
  return Math.floor(s/86400)+'d ago';
}

async function load(){
  // Ports
  const pRes=await fetch('/api/ports');
  const ports=await pRes.json();
  document.getElementById('port-count').textContent=ports.length;
  const pc=document.getElementById('port-cards');
  pc.innerHTML=ports.length===0?'<div class="empty">No listening ports found</div>':ports.map(p=>{
    const bgColor=p.color+'18';
    return \`<div class="card">
      <div class="card-top">
        <div class="card-icon" style="background:\${bgColor};color:\${p.color}">\${p.icon}</div>
        <div>
          <div class="card-title">\${p.label} <span class="live-dot"></span></div>
          <div class="card-port"><a href="http://localhost:\${p.port}" target="_blank">localhost:\${p.port}</a></div>
        </div>
      </div>
      <div class="card-meta">
        <div class="card-field"><div class="card-field-label">PID</div><div class="card-field-value">\${p.pid}</div></div>
        <div class="card-field"><div class="card-field-label">Memory</div><div class="card-field-value">\${p.memory}</div></div>
      </div>
      <div class="card-cmd" title="\${p.command.replace(/"/g,'&quot;')}">\${p.command}</div>
    </div>\`;
  }).join('');

  // Sessions
  const sRes=await fetch('/api/sessions');
  const sessions=await sRes.json();
  document.getElementById('session-count').textContent=sessions.length;
  const sc=document.getElementById('session-cards');
  sc.innerHTML=sessions.length===0?'<div class="empty">No active Claude sessions</div>':sessions.map(s=>{
    return \`<div class="session-card">
      <div class="session-top">
        <div class="claude-icon">CC</div>
        <div>
          <div class="card-title">Claude Code</div>
          <div class="session-id">\${s.sessionId?.slice(0,12)||'—'}...</div>
        </div>
      </div>
      <div class="session-cwd">\${s.cwd||'—'}</div>
      <div class="session-meta">
        <div class="session-meta-item">PID <strong>\${s.pid}</strong></div>
        <div class="session-meta-item">Started <strong>\${s.startedAt?timeAgo(s.startedAt):'—'}</strong></div>
        \${s.kind?\`<div class="session-meta-item">Type <strong>\${s.kind}</strong></div>\`:''}
      </div>
    </div>\`;
  }).join('');

  document.getElementById('ts').textContent='last updated: '+new Date().toLocaleTimeString();
}
load();
setInterval(load,3000);
</script>
</body>
</html>`;

  const server = Bun.serve({
    port: uiPort,
    async fetch(req) {
      const url = new URL(req.url);
      if (url.pathname === "/api/ports") {
        const ports = getListeningPorts();
        return new Response(JSON.stringify(ports), {
          headers: { "Content-Type": "application/json" },
        });
      }
      if (url.pathname === "/api/sessions") {
        const sessions = await getClaudeSessions();
        return new Response(JSON.stringify(sessions), {
          headers: { "Content-Type": "application/json" },
        });
      }
      return new Response(html, {
        headers: { "Content-Type": "text/html" },
      });
    },
  });

  console.log(`\n  Localhost Services — Web UI`);
  console.log(`  ──────────────────────────`);
  console.log(`  Open:  http://localhost:${uiPort}`);
  console.log(`  API:   http://localhost:${uiPort}/api/ports`);
  console.log(`         http://localhost:${uiPort}/api/sessions\n`);
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

const args = process.argv.slice(2);

if (args.includes("--json")) {
  console.log(JSON.stringify(getListeningPorts(), null, 2));
} else if (args.includes("--serve")) {
  const portIdx = args.indexOf("--serve");
  const uiPort = parseInt(args[portIdx + 1] || "9999", 10);
  startWebUI(uiPort);
} else if (args.includes("--watch")) {
  setInterval(() => printTable(getListeningPorts()), 3000);
  printTable(getListeningPorts());
} else {
  printTable(getListeningPorts());
}
