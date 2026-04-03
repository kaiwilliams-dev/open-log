/**
 * OpenLog — Local Claude Code Analytics Dashboard
 * Bun server that reads ~/.claude/projects/**\/*.jsonl files and serves
 * a real-time analytics dashboard over HTTP.
 *
 * Usage:
 *   bun run server.ts [--port 7777]
 *   PORT=8080 bun run server.ts
 */

import { readdir, stat } from "node:fs/promises";
import { join, basename } from "node:path";

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------

const PORT = (() => {
  const portArg = process.argv.find((a, i) => process.argv[i - 1] === "--port");
  if (portArg) return parseInt(portArg, 10);
  if (process.env.PORT) return parseInt(process.env.PORT, 10);
  return 7777;
})();

const HOME = process.env.HOME ?? "/Users/apple";
const CLAUDE_DIR = join(HOME, ".claude");
const PROJECTS_DIR = join(CLAUDE_DIR, "projects");
const SESSIONS_DIR = join(CLAUDE_DIR, "sessions");
const PUBLIC_DIR = join(import.meta.dir, "public");

// Cost-per-million-token rates (used for usage % calculation)
const RATE = {
  input: 15,
  output: 75,
  cacheCreation: 18.75,
  cacheRead: 1.5,
} as const;

// Budget is dynamic — Anthropic adjusts based on demand (2x on weekends, etc.)
// We show raw cost as the ground truth and let users calibrate the % via the UI.
// Default $210 is a weekday estimate. The real value shifts.
const BUDGET_DOLLARS = parseFloat(process.env.OPENLOG_BUDGET ?? "227");
const DENOMINATOR = BUDGET_DOLLARS * 1_000_000;

// Cache TTLs
const TTL_USAGE_MS = 30_000;   // 30s — usage endpoint
const TTL_DEFAULT_MS = 60_000; // 60s — all other endpoints

// ---------------------------------------------------------------------------
// Type definitions
// ---------------------------------------------------------------------------

interface AssistantRecord {
  type: "assistant";
  timestamp: string;
  sessionId: string;
  cwd?: string;
  version?: string;
  message: {
    model?: string;
    role: "assistant";
    stop_reason?: string;
    content?: Array<
      | { type: "text"; text: string }
      | { type: "thinking"; thinking: string }
      | { type: "tool_use"; name: string; input?: Record<string, unknown> }
    >;
    usage?: {
      input_tokens?: number;
      output_tokens?: number;
      cache_creation_input_tokens?: number;
      cache_read_input_tokens?: number;
    };
  };
}

interface UserRecord {
  type: "user";
  timestamp: string;
  sessionId: string;
  toolUseResult?: {
    success?: boolean;
    commandName?: string;
  };
  message?: {
    role: "user";
    content?: Array<{ type: string; name?: string; content?: unknown }>;
  };
}

interface ProgressRecord {
  type: "progress";
  timestamp: string;
  sessionId: string;
  data?: {
    type?: string;
    hookEvent?: string;
    hookName?: string;
    command?: string;
  };
}

interface SystemRecord {
  type: "system";
  subtype?: string;
  timestamp: string;
  durationMs?: number;
  level?: string;
  cause?: Record<string, unknown>;
  hookCount?: number;
  hookInfos?: Array<{ command?: string; durationMs?: number }>;
}

type JsonlRecord = AssistantRecord | UserRecord | ProgressRecord | SystemRecord | Record<string, unknown>;

// Parsed "event" for the activity feed
interface ActivityEvent {
  type: "skill" | "hook" | "error";
  name: string;
  detail: string;
  timestamp: string;
  sessionId: string;
}

// ---------------------------------------------------------------------------
// In-memory cache layer
// ---------------------------------------------------------------------------

interface CacheEntry<T> {
  data: T;
  expiresAt: number;
}

const cache = new Map<string, CacheEntry<unknown>>();

function getCached<T>(key: string): T | null {
  const entry = cache.get(key) as CacheEntry<T> | undefined;
  if (!entry) return null;
  if (Date.now() > entry.expiresAt) {
    cache.delete(key);
    return null;
  }
  return entry.data;
}

function setCached<T>(key: string, data: T, ttlMs: number): void {
  cache.set(key, { data, expiresAt: Date.now() + ttlMs });
}

// ---------------------------------------------------------------------------
// File helpers
// ---------------------------------------------------------------------------

/**
 * Enumerate all .jsonl session files under ~/.claude/projects/.
 * Returns an array of absolute file paths.
 * Also picks up subagent files at <session-uuid>/subagents/agent-<id>.jsonl
 */
async function getAllJsonlFiles(): Promise<string[]> {
  const results: string[] = [];

  let projectDirs: string[];
  try {
    projectDirs = await readdir(PROJECTS_DIR);
  } catch {
    return results;
  }

  await Promise.all(
    projectDirs.map(async (projectDir) => {
      const projectPath = join(PROJECTS_DIR, projectDir);

      let entries: string[];
      try {
        entries = await readdir(projectPath);
      } catch {
        return;
      }

      for (const entry of entries) {
        if (entry.endsWith(".jsonl")) {
          results.push(join(projectPath, entry));
        } else {
          // Possible subagent directory: <session-uuid>/subagents/
          const subagentPath = join(projectPath, entry, "subagents");
          try {
            const subEntries = await readdir(subagentPath);
            for (const sub of subEntries) {
              if (sub.endsWith(".jsonl")) {
                results.push(join(subagentPath, sub));
              }
            }
          } catch {
            // Not a directory or no subagents — skip
          }
        }
      }
    })
  );

  return results;
}

/**
 * Get the mtime of a file in milliseconds. Returns 0 on error.
 */
async function getMtimeMs(filePath: string): Promise<number> {
  try {
    const s = await stat(filePath);
    return s.mtimeMs;
  } catch {
    return 0;
  }
}

/**
 * Parse a .jsonl file line-by-line. Skips blank lines and invalid JSON.
 * Calls `onRecord` for each successfully parsed record.
 * Uses Bun.file() for fast reads.
 */
async function parseJsonlFile(
  filePath: string,
  onRecord: (record: JsonlRecord) => void
): Promise<void> {
  try {
    const file = Bun.file(filePath);
    const text = await file.text();
    const lines = text.split("\n");
    for (const line of lines) {
      const trimmed = line.trim();
      if (!trimmed) continue;
      try {
        onRecord(JSON.parse(trimmed) as JsonlRecord);
      } catch {
        // Skip malformed JSON lines
      }
    }
  } catch {
    // File unreadable — skip
  }
}

/**
 * Return only files modified within the last `withinMs` milliseconds.
 */
async function recentFiles(files: string[], withinMs: number): Promise<string[]> {
  const cutoff = Date.now() - withinMs;
  const results = await Promise.all(
    files.map(async (f) => {
      const mtime = await getMtimeMs(f);
      return mtime >= cutoff ? f : null;
    })
  );
  return results.filter((f): f is string => f !== null);
}

// ---------------------------------------------------------------------------
// /api/usage — 5-hour rolling window token cost
// ---------------------------------------------------------------------------

async function computeUsage() {
  const cached = getCached<ReturnType<typeof buildUsageResponse>>("usage");
  if (cached) return cached;

  const now = Date.now();
  const windowMs = 5 * 60 * 60 * 1000; // 5 hours
  const windowStart = new Date(now - windowMs);

  const allFiles = await getAllJsonlFiles();
  // Only read files modified in the last 5 hours
  const candidates = await recentFiles(allFiles, windowMs);

  let inputTokens = 0;
  let outputTokens = 0;
  let cacheCreationTokens = 0;
  let cacheReadTokens = 0;

  await Promise.all(
    candidates.map((filePath) =>
      parseJsonlFile(filePath, (record) => {
        if (record.type !== "assistant") return;
        const rec = record as AssistantRecord;
        const ts = new Date(rec.timestamp);
        if (ts < windowStart) return;

        const usage = rec.message?.usage;
        if (!usage) return;
        inputTokens += usage.input_tokens ?? 0;
        outputTokens += usage.output_tokens ?? 0;
        cacheCreationTokens += usage.cache_creation_input_tokens ?? 0;
        cacheReadTokens += usage.cache_read_input_tokens ?? 0;
      })
    )
  );

  const result = buildUsageResponse(
    inputTokens,
    outputTokens,
    cacheCreationTokens,
    cacheReadTokens,
    windowStart,
    new Date(now)
  );
  setCached("usage", result, TTL_USAGE_MS);
  return result;
}

function buildUsageResponse(
  inputTokens: number,
  outputTokens: number,
  cacheCreationTokens: number,
  cacheReadTokens: number,
  windowStart: Date,
  windowEnd: Date
) {
  const inputCost = (inputTokens * RATE.input) / 1_000_000;
  const outputCost = (outputTokens * RATE.output) / 1_000_000;
  const cacheCreationCost = (cacheCreationTokens * RATE.cacheCreation) / 1_000_000;
  const cacheReadCost = (cacheReadTokens * RATE.cacheRead) / 1_000_000;
  const totalCost = inputCost + outputCost + cacheCreationCost + cacheReadCost;

  // Weighted token sum = cost × 1,000,000
  const weightedSum =
    inputTokens * RATE.input +
    outputTokens * RATE.output +
    cacheCreationTokens * RATE.cacheCreation +
    cacheReadTokens * RATE.cacheRead;

  const percentage = (weightedSum / DENOMINATOR) * 100;

  return {
    percentage: Math.round(percentage * 10) / 10,
    costBreakdown: {
      input: { tokens: inputTokens, cost: Math.round(inputCost * 1000) / 1000 },
      output: { tokens: outputTokens, cost: Math.round(outputCost * 1000) / 1000 },
      cacheCreation: { tokens: cacheCreationTokens, cost: Math.round(cacheCreationCost * 1000) / 1000 },
      cacheRead: { tokens: cacheReadTokens, cost: Math.round(cacheReadCost * 1000) / 1000 },
    },
    totalCost: Math.round(totalCost * 1000) / 1000,
    windowStart: windowStart.toISOString(),
    windowEnd: windowEnd.toISOString(),
    budget: BUDGET_DOLLARS,
  };
}

// ---------------------------------------------------------------------------
// /api/stats — Overview metrics for the last N days
// ---------------------------------------------------------------------------

async function computeStats(days: number) {
  const cacheKey = `stats:${days}`;
  const cached = getCached<object>(cacheKey);
  if (cached) return cached;

  const now = Date.now();
  const windowMs = days * 24 * 60 * 60 * 1000;
  const cutoff = new Date(now - windowMs);

  const allFiles = await getAllJsonlFiles();
  const candidates = await recentFiles(allFiles, windowMs);

  const skillNames = new Set<string>();
  let totalTriggers = 0;
  const turnDurations: number[] = [];
  let errors = 0;

  await Promise.all(
    candidates.map((filePath) =>
      parseJsonlFile(filePath, (record) => {
        const ts = new Date((record as { timestamp?: string }).timestamp ?? 0);
        if (ts < cutoff) return;

        // Count assistant records as triggers; extract skill names from tool_use
        if (record.type === "assistant") {
          const rec = record as AssistantRecord;
          totalTriggers++;
          if (rec.message?.content) {
            for (const block of rec.message.content) {
              if (block.type === "tool_use" && block.name === "Skill") {
                const input = (block as { type: "tool_use"; name: string; input?: Record<string, unknown> }).input;
                const skillName = input?.skill as string | undefined;
                if (skillName) skillNames.add(skillName);
              }
            }
          }
        }

        // Turn durations
        if (
          record.type === "system" &&
          (record as SystemRecord).subtype === "turn_duration"
        ) {
          const ms = (record as SystemRecord).durationMs;
          if (ms != null) turnDurations.push(ms);
        }

        // API errors
        if (
          record.type === "system" &&
          (record as SystemRecord).subtype === "api_error"
        ) {
          errors++;
        }
      })
    )
  );

  const avgResponseMs =
    turnDurations.length > 0
      ? Math.round(turnDurations.reduce((a, b) => a + b, 0) / turnDurations.length)
      : 0;

  const result = {
    totalSkills: skillNames.size,
    totalTriggers,
    avgResponseMs,
    errors,
    // Change fields: placeholders — would need historical baseline to compute properly
    skillsChange: "+0",
    triggersChange: "+0%",
    responseChange: "0s",
  };

  setCached(cacheKey, result, TTL_DEFAULT_MS);
  return result;
}

// ---------------------------------------------------------------------------
// /api/activity — Last 50 events
// ---------------------------------------------------------------------------

async function computeActivity() {
  const cached = getCached<ActivityEvent[]>("activity");
  if (cached) return cached;

  const allFiles = await getAllJsonlFiles();
  // Scan files modified in last 7 days for activity
  const windowMs = 7 * 24 * 60 * 60 * 1000;
  const candidates = await recentFiles(allFiles, windowMs);

  const events: ActivityEvent[] = [];

  await Promise.all(
    candidates.map((filePath) =>
      parseJsonlFile(filePath, (record) => {
        const base = record as { type?: string; timestamp?: string; sessionId?: string };
        if (!base.timestamp || !base.sessionId) return;

        if (record.type === "assistant") {
          const rec = record as AssistantRecord;
          if (rec.message?.content) {
            for (const block of rec.message.content) {
              if (block.type === "tool_use" && block.name === "Skill") {
                const input = (block as { type: "tool_use"; name: string; input?: Record<string, unknown> }).input;
                const skillName = (input?.skill as string) ?? "unknown";
                events.push({
                  type: "skill",
                  name: skillName,
                  detail: `Triggered by tool_use: Skill`,
                  timestamp: rec.timestamp,
                  sessionId: rec.sessionId,
                });
              }
            }
          }
        }

        if (record.type === "progress") {
          const rec = record as ProgressRecord;
          if (rec.data?.type !== "hook_progress") return; // Skip bash_progress, agent_progress, etc.
          const hookName = rec.data?.hookName ?? rec.data?.hookEvent ?? "unknown";
          events.push({
            type: "hook",
            name: hookName,
            detail: `Hook fired: ${rec.data?.command ?? ""}`,
            timestamp: rec.timestamp,
            sessionId: rec.sessionId,
          });
        }

        if (
          record.type === "system" &&
          (record as SystemRecord).subtype === "api_error"
        ) {
          const rec = record as SystemRecord;
          events.push({
            type: "error",
            name: "api_error",
            detail: `Error: ${JSON.stringify(rec.cause ?? {})}`,
            timestamp: rec.timestamp,
            sessionId: "",
          });
        }
      })
    )
  );

  // Sort descending by timestamp, take top 50
  events.sort((a, b) => b.timestamp.localeCompare(a.timestamp));
  const result = events.slice(0, 50);

  setCached("activity", result, TTL_DEFAULT_MS);
  return result;
}

// ---------------------------------------------------------------------------
// /api/skills — Skill analytics
// ---------------------------------------------------------------------------

interface SkillStats {
  name: string;
  triggers: number;
  trend: number[]; // last 7 days, index 0 = oldest
  avgTimeMs: number;
  lastUsed: string;
  status: "active" | "idle" | "dormant" | "error";
  description: string;
}

async function computeSkills() {
  const cached = getCached<SkillStats[]>("skills");
  if (cached) return cached;

  const now = Date.now();
  const windowMs = 30 * 24 * 60 * 60 * 1000; // scan 30 days
  const allFiles = await getAllJsonlFiles();
  const candidates = await recentFiles(allFiles, windowMs);

  // Map: skillName -> { triggers, timestamps, turnDurations }
  const skillMap = new Map<
    string,
    { triggers: number; timestamps: number[]; turnDurations: number[] }
  >();

  await Promise.all(
    candidates.map((filePath) =>
      parseJsonlFile(filePath, (record) => {
        if (record.type !== "assistant") return;
        const rec = record as AssistantRecord;
        const ts = new Date(rec.timestamp).getTime();

        if (rec.message?.content) {
          for (const block of rec.message.content) {
            if (block.type === "tool_use" && block.name === "Skill") {
              const input = (block as { type: "tool_use"; name: string; input?: Record<string, unknown> }).input;
              const skillName = (input?.skill as string) ?? "unknown";

              if (!skillMap.has(skillName)) {
                skillMap.set(skillName, { triggers: 0, timestamps: [], turnDurations: [] });
              }
              const entry = skillMap.get(skillName)!;
              entry.triggers++;
              entry.timestamps.push(ts);
            }
          }
        }
      })
    )
  );

  const oneHour = 60 * 60 * 1000;
  const oneDay = 24 * oneHour;

  const result: SkillStats[] = [];

  for (const [name, entry] of skillMap.entries()) {
    const lastTs = Math.max(...entry.timestamps);
    const age = now - lastTs;

    let status: SkillStats["status"] = "dormant";
    if (age < oneHour) status = "active";
    else if (age < oneDay) status = "idle";

    // 7-day trend: count per day, index 0 = 6 days ago, index 6 = today
    const trend = new Array(7).fill(0) as number[];
    for (const ts of entry.timestamps) {
      const daysAgo = Math.floor((now - ts) / oneDay);
      if (daysAgo < 7) {
        trend[6 - daysAgo]++;
      }
    }

    result.push({
      name,
      triggers: entry.triggers,
      trend,
      avgTimeMs: entry.turnDurations.length
        ? Math.round(entry.turnDurations.reduce((a, b) => a + b, 0) / entry.turnDurations.length)
        : 0,
      lastUsed: new Date(lastTs).toISOString(),
      status,
      description: "",
    });
  }

  // Sort by trigger count desc
  result.sort((a, b) => b.triggers - a.triggers);

  setCached("skills", result, TTL_DEFAULT_MS);
  return result;
}

// ---------------------------------------------------------------------------
// /api/hooks — Hook analytics
// ---------------------------------------------------------------------------

interface HookStats {
  event: string;
  name: string;
  command: string;
  fires: number;
  lastFired: string;
  daily: number[]; // 7-day breakdown, index 0=6 days ago, 6=today
}

async function computeHooks() {
  const cached = getCached<HookStats[]>("hooks");
  if (cached) return cached;

  const windowMs = 30 * 24 * 60 * 60 * 1000;
  const allFiles = await getAllJsonlFiles();
  const candidates = await recentFiles(allFiles, windowMs);

  // Map: hookName -> { event, command, fires, lastFired }
  const hookMap = new Map<
    string,
    { event: string; command: string; fires: number; lastFired: number }
  >();

  await Promise.all(
    candidates.map((filePath) =>
      parseJsonlFile(filePath, (record) => {
        if (record.type !== "progress") return;
        const rec = record as ProgressRecord;
        // Only count actual hook events, not bash_progress, agent_progress, etc.
        if (rec.data?.type !== "hook_progress") return;
        const hookName = rec.data?.hookName ?? rec.data?.hookEvent ?? "unknown";
        const hookEvent = rec.data?.hookEvent ?? "unknown";
        const command = rec.data?.command ?? "";
        const ts = new Date(rec.timestamp).getTime();

        if (!hookMap.has(hookName)) {
          hookMap.set(hookName, { event: hookEvent, command, fires: 0, lastFired: 0, daily: new Array(7).fill(0) });
        }
        const entry = hookMap.get(hookName)!;
        entry.fires++;
        if (ts > entry.lastFired) entry.lastFired = ts;
        const daysAgo = Math.floor((Date.now() - ts) / (24 * 3600000));
        if (daysAgo >= 0 && daysAgo < 7) entry.daily[6 - daysAgo]++;
      })
    )
  );

  const result: HookStats[] = [];
  for (const [name, entry] of hookMap.entries()) {
    result.push({
      event: entry.event,
      name,
      command: entry.command,
      fires: entry.fires,
      lastFired: new Date(entry.lastFired).toISOString(),
      daily: entry.daily,
    });
  }

  result.sort((a, b) => b.fires - a.fires);

  setCached("hooks", result, TTL_DEFAULT_MS);
  return result;
}

// ---------------------------------------------------------------------------
// /api/heatmap — 7-day × 24-hour trigger grid
// ---------------------------------------------------------------------------

interface HeatmapData {
  days: string[];
  data: number[][];
}

async function computeHeatmap() {
  const cached = getCached<HeatmapData>("heatmap");
  if (cached) return cached;

  const now = new Date();
  const windowMs = 7 * 24 * 60 * 60 * 1000;
  const allFiles = await getAllJsonlFiles();
  const candidates = await recentFiles(allFiles, windowMs);

  // Grid: [dayIndex (0=oldest)][hour]
  const grid: number[][] = Array.from({ length: 7 }, () => new Array(24).fill(0));
  const DAY_NAMES = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];

  await Promise.all(
    candidates.map((filePath) =>
      parseJsonlFile(filePath, (record) => {
        if (record.type !== "assistant") return;
        const rec = record as AssistantRecord;
        const ts = new Date(rec.timestamp);
        const daysAgo = Math.floor((now.getTime() - ts.getTime()) / (24 * 60 * 60 * 1000));
        if (daysAgo < 0 || daysAgo >= 7) return;
        const dayIndex = 6 - daysAgo; // 0 = 6 days ago, 6 = today
        const hour = ts.getHours();
        grid[dayIndex][hour]++;
      })
    )
  );

  // Build the ordered day labels: starting from 6 days ago to today
  const days: string[] = [];
  for (let i = 6; i >= 0; i--) {
    const d = new Date(now.getTime() - i * 24 * 60 * 60 * 1000);
    days.push(DAY_NAMES[d.getDay()]);
  }

  // Also build dates array for detail lookups
  const dates: string[] = [];
  for (let i = 6; i >= 0; i--) {
    const d = new Date(now.getTime() - i * 24 * 60 * 60 * 1000);
    dates.push(d.toISOString().slice(0, 10));
  }

  const result: HeatmapData & { dates: string[] } = { days, dates, data: grid };
  setCached("heatmap", result, TTL_DEFAULT_MS);
  return result;
}

// ---------------------------------------------------------------------------
// /api/heatmap-detail — Breakdown for a specific day+hour
// ---------------------------------------------------------------------------

async function computeHeatmapDetail(date: string, hour: number) {
  const cacheKey = `heatmap-detail:${date}:${hour}`;
  const cached = getCached<Record<string, unknown>>(cacheKey);
  if (cached) return cached;

  const dayStart = new Date(date + "T00:00:00");
  const hourStart = new Date(dayStart.getTime() + hour * 3600000);
  const hourEnd = new Date(hourStart.getTime() + 3600000);

  const allFiles = await getAllJsonlFiles();
  const candidates = await recentFiles(allFiles, 8 * 24 * 3600000); // 8 days

  const skills: Record<string, number> = {};
  const hooks: Record<string, number> = {};
  let triggers = 0;
  let errors = 0;
  let tokens = { input: 0, output: 0, cacheCreate: 0, cacheRead: 0 };

  await Promise.all(
    candidates.map((filePath) =>
      parseJsonlFile(filePath, (record) => {
        const ts = new Date((record as { timestamp?: string }).timestamp ?? 0);
        if (ts < hourStart || ts >= hourEnd) return;

        if (record.type === "assistant") {
          const rec = record as AssistantRecord;
          triggers++;
          const u = rec.message?.usage;
          if (u) {
            tokens.input += u.input_tokens ?? 0;
            tokens.output += u.output_tokens ?? 0;
            tokens.cacheCreate += u.cache_creation_input_tokens ?? 0;
            tokens.cacheRead += u.cache_read_input_tokens ?? 0;
          }
          if (rec.message?.content) {
            for (const block of rec.message.content) {
              if (block.type === "tool_use" && block.name === "Skill") {
                const name = ((block as any).input?.skill as string) ?? "unknown";
                skills[name] = (skills[name] ?? 0) + 1;
              }
            }
          }
        }

        if (record.type === "progress") {
          const rec = record as ProgressRecord;
          if (rec.data?.type === "hook_progress") {
            const name = rec.data.hookName ?? rec.data.hookEvent ?? "unknown";
            hooks[name] = (hooks[name] ?? 0) + 1;
          }
        }

        if (record.type === "system" && (record as SystemRecord).subtype === "api_error") {
          errors++;
        }
      })
    )
  );

  const cost = (tokens.input * RATE.input + tokens.output * RATE.output +
    tokens.cacheCreate * RATE.cacheCreation + tokens.cacheRead * RATE.cacheRead) / 1_000_000;

  const result = {
    date, hour, triggers, errors, cost: Math.round(cost * 100) / 100,
    tokens, skills, hooks,
    skillCount: Object.keys(skills).length,
    hookCount: Object.keys(hooks).length,
  };

  setCached(cacheKey, result, TTL_DEFAULT_MS);
  return result;
}

// ---------------------------------------------------------------------------
// /api/history — Daily usage going back to first session
// ---------------------------------------------------------------------------

interface DayData {
  date: string;
  cost: number;
  percentage: number;
  tokens: {
    input: number;
    output: number;
    cacheCreation: number;
    cacheRead: number;
  };
  triggers: number;
}

interface HistoryData {
  days: DayData[];
  totalCost: number;
  firstDate: string;
  lastDate: string;
}

const TTL_HISTORY_MS = 3_600_000; // 1 hour — historical data rarely changes, saves memory

async function computeHistory(): Promise<HistoryData> {
  const cached = getCached<HistoryData>("history");
  if (cached) return cached;

  const allFiles = await getAllJsonlFiles();

  // date string (YYYY-MM-DD) -> accumulator
  const dayMap = new Map<
    string,
    { input: number; output: number; cacheCreation: number; cacheRead: number; triggers: number }
  >();

  await Promise.all(
    allFiles.map((filePath) =>
      parseJsonlFile(filePath, (record) => {
        if (record.type !== "assistant") return;
        const rec = record as AssistantRecord;
        const usage = rec.message?.usage;
        if (!usage) return;

        const dateKey = rec.timestamp.slice(0, 10); // "YYYY-MM-DD"
        if (!dayMap.has(dateKey)) {
          dayMap.set(dateKey, { input: 0, output: 0, cacheCreation: 0, cacheRead: 0, triggers: 0 });
        }
        const day = dayMap.get(dateKey)!;
        day.input += usage.input_tokens ?? 0;
        day.output += usage.output_tokens ?? 0;
        day.cacheCreation += usage.cache_creation_input_tokens ?? 0;
        day.cacheRead += usage.cache_read_input_tokens ?? 0;
        day.triggers++;
      })
    )
  );

  if (dayMap.size === 0) {
    const empty: HistoryData = { days: [], totalCost: 0, firstDate: "", lastDate: "" };
    // Don't cache — too much memory
    // setCached("history", empty, TTL_HISTORY_MS);
    return empty;
  }

  const sortedKeys = [...dayMap.keys()].sort();
  const firstDate = sortedKeys[0];
  const today = new Date().toISOString().slice(0, 10);

  // Fill every calendar day between firstDate and today
  const days: DayData[] = [];
  let totalCost = 0;

  const cursor = new Date(firstDate + "T00:00:00Z");
  const endDate = new Date(today + "T00:00:00Z");

  while (cursor <= endDate) {
    const dateKey = cursor.toISOString().slice(0, 10);
    const acc = dayMap.get(dateKey) ?? { input: 0, output: 0, cacheCreation: 0, cacheRead: 0, triggers: 0 };

    const cost =
      (acc.input * RATE.input +
        acc.output * RATE.output +
        acc.cacheCreation * RATE.cacheCreation +
        acc.cacheRead * RATE.cacheRead) /
      1_000_000;

    const percentage = (cost / BUDGET_DOLLARS) * 100;

    days.push({
      date: dateKey,
      cost: Math.round(cost * 10000) / 10000,
      percentage: Math.round(percentage * 100) / 100,
      tokens: {
        input: acc.input,
        output: acc.output,
        cacheCreation: acc.cacheCreation,
        cacheRead: acc.cacheRead,
      },
      triggers: acc.triggers,
    });

    totalCost += cost;

    cursor.setUTCDate(cursor.getUTCDate() + 1);
  }

  const result: HistoryData = {
    days,
    totalCost: Math.round(totalCost * 10000) / 10000,
    firstDate,
    lastDate: today,
  };

  // Don't cache history — it holds 800MB+ in memory. Let GC free it.
  // setCached("history", result, TTL_HISTORY_MS);
  return result;
}

// ---------------------------------------------------------------------------
// /api/sessions — Active Claude processes
// ---------------------------------------------------------------------------

interface SessionInfo {
  pid: number;
  sessionId: string;
  cwd: string;
  startedAt: number;
  kind?: string;
  entrypoint?: string;
}

async function computeSessions() {
  const cached = getCached<SessionInfo[]>("sessions");
  if (cached) return cached;

  let sessionFiles: string[];
  try {
    sessionFiles = (await readdir(SESSIONS_DIR)).filter((f) => f.endsWith(".json"));
  } catch {
    return [];
  }

  const results: SessionInfo[] = [];

  await Promise.all(
    sessionFiles.map(async (filename) => {
      try {
        const file = Bun.file(join(SESSIONS_DIR, filename));
        const data = await file.json() as SessionInfo;
        results.push(data);
      } catch {
        // Skip unreadable or malformed session files
      }
    })
  );

  results.sort((a, b) => b.startedAt - a.startedAt);
  setCached("sessions", results, TTL_DEFAULT_MS);
  return results;
}

// ---------------------------------------------------------------------------
// /api/limits — Read real-time limits from statusline hook capture
// ---------------------------------------------------------------------------

const OPENLOG_DIR = join(HOME, ".openlog");
const LIMITS_FILE = join(OPENLOG_DIR, "limits.json");

async function readLimits() {
  try {
    const file = Bun.file(LIMITS_FILE);
    if (!(await file.exists())) return { available: false, message: "No limits data yet. Use Claude Code to generate data." };
    const data = await file.json() as Record<string, unknown>;
    const age = Math.floor(Date.now() / 1000) - ((data.ts as number) ?? 0);
    return { available: true, stale: age > 300, age_seconds: age, rate_limited: !!(data as any).rate_limited, ...data };
  } catch {
    return { available: false, message: "Could not read limits file" };
  }
}

// ---------------------------------------------------------------------------
// /api/sync-limits — Spawn headless Claude TUI via expect to capture statusline
// ---------------------------------------------------------------------------

const SYNC_SCRIPT = join(OPENLOG_DIR, "sync.exp");
const SYNC_LOG = join(OPENLOG_DIR, "sync-history.jsonl");
const SYNC_COST_FILE = join(OPENLOG_DIR, "sync-costs.json");

let syncInProgress = false;

const SYNC_SHELL = join(OPENLOG_DIR, "sync.sh");

async function runTmuxSync(): Promise<{ exitCode: number | null; elapsed: number }> {
  const t0 = Date.now();
  const proc = Bun.spawn(["/bin/bash", SYNC_SHELL], {
    stdout: "pipe", stderr: "pipe",
    env: { ...process.env, HOME },
  });
  await proc.exited;
  return { exitCode: proc.exitCode, elapsed: Date.now() - t0 };
}

async function syncLimits(): Promise<Record<string, unknown>> {
  // If sync is already running, wait for it (max 15s) rather than rejecting
  if (syncInProgress) {
    for (let i = 0; i < 15; i++) {
      await Bun.sleep(1000);
      if (!syncInProgress) break;
    }
    if (syncInProgress) { syncInProgress = false; } // Force unlock after 15s
  }
  syncInProgress = true;
  const beforeTs = Date.now();

  try {
    // First check: did the statusline hook already write fresh data?
    const existingLimits = await (async () => {
      try {
        const f = Bun.file(LIMITS_FILE);
        if (await f.exists()) return await f.json() as Record<string, unknown>;
      } catch {}
      return null;
    })();
    const existingAge = existingLimits ? Math.floor(Date.now() / 1000) - ((existingLimits.ts as number) ?? 0) : Infinity;

    // If we have fresh data from statusline (<60s old), just use it
    if (existingAge < 60) {
      return { success: true, limits_captured: true, limits: existingLimits, elapsed_ms: Date.now() - beforeTs, source: "statusline" };
    }

    // Run tmux-based sync — spawns real Claude TUI, statusline writes limits.json
    await runTmuxSync();

    // Check if limits file was updated
    let captured = false;
    let limits: Record<string, unknown> | null = null;
    try {
      const f = Bun.file(LIMITS_FILE);
      if (await f.exists()) {
        const data = await f.json() as Record<string, unknown>;
        const age = Math.floor(Date.now() / 1000) - ((data.ts as number) ?? 0);
        if (age < 30) { limits = data; captured = true; }
      }
    } catch {}

    const elapsed = Date.now() - beforeTs;

    // Log to sync history
    const logEntry = {
      ts: Math.floor(Date.now() / 1000),
      success: captured,
      elapsed_ms: elapsed,
      limits: captured ? limits : null,
    };
    const { appendFile } = await import("node:fs/promises");
    await appendFile(SYNC_LOG, JSON.stringify(logEntry) + "\n");

    // Track cumulative sync cost
    await trackSyncCost();

    return { success: true, limits_captured: captured, limits, elapsed_ms: elapsed };
  } catch (err) {
    return { success: false, error: err instanceof Error ? err.message : String(err), elapsed_ms: Date.now() - beforeTs };
  } finally {
    syncInProgress = false;
  }
}

// Track sync costs — each sync uses ~$0.01 of Claude budget
async function trackSyncCost() {
  const file = Bun.file(SYNC_COST_FILE);
  let data: { totalSyncs: number; estimatedCost: number; history: Array<{ date: string; syncs: number }> } = {
    totalSyncs: 0, estimatedCost: 0, history: []
  };
  try { if (await file.exists()) data = await file.json() as typeof data; } catch {}

  const today = new Date().toISOString().slice(0, 10);
  data.totalSyncs++;
  data.estimatedCost = Math.round(data.totalSyncs * 0.009 * 1000) / 1000; // ~$0.009 per sync

  const todayEntry = data.history.find(h => h.date === today);
  if (todayEntry) todayEntry.syncs++;
  else data.history.push({ date: today, syncs: 1 });

  // Keep last 90 days
  if (data.history.length > 90) data.history = data.history.slice(-90);

  await Bun.write(SYNC_COST_FILE, JSON.stringify(data, null, 2));
}

// ---------------------------------------------------------------------------
// /api/limits-history — Read sync history for charting
// ---------------------------------------------------------------------------

async function readLimitsHistory() {
  try {
    const file = Bun.file(SYNC_LOG);
    if (!(await file.exists())) return { entries: [] };
    const text = await file.text();
    const entries: Array<Record<string, unknown>> = [];
    for (const line of text.split("\n")) {
      if (!line.trim()) continue;
      try { entries.push(JSON.parse(line)); } catch {}
    }
    return { entries: entries.slice(-500) }; // Last 500 syncs
  } catch {
    return { entries: [] };
  }
}

async function readSyncCosts() {
  try {
    const file = Bun.file(SYNC_COST_FILE);
    if (!(await file.exists())) return { totalSyncs: 0, estimatedCost: 0, history: [] };
    return await file.json();
  } catch {
    return { totalSyncs: 0, estimatedCost: 0, history: [] };
  }
}

// ---------------------------------------------------------------------------
// Auto-sync: run every 5 minutes if limits are stale
// ---------------------------------------------------------------------------

const AUTO_SYNC_INTERVAL_MS = 5 * 60 * 1000; // 5 minutes

async function autoSync() {
  try {
    const limits = await readLimits();
    // Only sync if data is stale (>5 min old) or missing
    if (!limits.available || (limits as any).stale) {
      console.log(`[OpenLog] Auto-syncing limits...`);
      const result = await syncLimits();
      if ((result as any).limits_captured) {
        const lim = (result as any).limits as Record<string, any>;
        console.log(`[OpenLog] Synced: 5h=${lim?.five_hour?.pct}% 7d=${lim?.seven_day?.pct}% (${(result as any).elapsed_ms}ms)`);
      } else {
        console.log(`[OpenLog] Sync completed but no limits captured (${(result as any).elapsed_ms}ms)`);
      }
    }
  } catch (err) {
    console.error(`[OpenLog] Auto-sync error:`, err);
  }
}

// Auto-sync disabled — manual sync only to save usage budget
// setInterval(autoSync, AUTO_SYNC_INTERVAL_MS);

// ---------------------------------------------------------------------------
// CORS helper
// ---------------------------------------------------------------------------

const CORS_HEADERS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type",
};

function jsonResponse(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data, null, 2), {
    status,
    headers: {
      "Content-Type": "application/json",
      ...CORS_HEADERS,
    },
  });
}

function errorResponse(message: string, status = 500): Response {
  return jsonResponse({ error: message }, status);
}

// ---------------------------------------------------------------------------
// Static file server
// ---------------------------------------------------------------------------

async function serveStatic(filePath: string): Promise<Response> {
  const file = Bun.file(filePath);
  const exists = await file.exists();
  if (!exists) {
    return new Response("Not Found", { status: 404, headers: CORS_HEADERS });
  }
  return new Response(file, { headers: CORS_HEADERS });
}

// ---------------------------------------------------------------------------
// Request router
// ---------------------------------------------------------------------------

async function handleRequest(req: Request): Promise<Response> {
  const url = new URL(req.url);
  const { pathname, searchParams } = url;

  // Handle CORS preflight
  if (req.method === "OPTIONS") {
    return new Response(null, { status: 204, headers: CORS_HEADERS });
  }

  // Static dashboard
  if (pathname === "/" || pathname === "/index.html") {
    return serveStatic(join(PUBLIC_DIR, "index.html"));
  }

  // Static assets (css, js, etc.)
  if (!pathname.startsWith("/api/")) {
    return serveStatic(join(PUBLIC_DIR, pathname));
  }

  // API routes
  try {
    switch (pathname) {
      case "/api/usage": {
        const data = await computeUsage();
        return jsonResponse(data);
      }

      case "/api/stats": {
        const days = Math.max(1, parseInt(searchParams.get("days") ?? "7", 10));
        const data = await computeStats(days);
        return jsonResponse(data);
      }

      case "/api/activity": {
        const data = await computeActivity();
        return jsonResponse(data);
      }

      case "/api/skills": {
        const data = await computeSkills();
        return jsonResponse(data);
      }

      case "/api/hooks": {
        const data = await computeHooks();
        return jsonResponse(data);
      }

      case "/api/heatmap": {
        const data = await computeHeatmap();
        return jsonResponse(data);
      }

      case "/api/heatmap-detail": {
        const date = searchParams.get("date") ?? "";
        const hour = parseInt(searchParams.get("hour") ?? "0", 10);
        if (!date) return errorResponse("Missing date param", 400);
        const data = await computeHeatmapDetail(date, hour);
        return jsonResponse(data);
      }

      case "/api/sessions": {
        const data = await computeSessions();
        return jsonResponse(data);
      }

      case "/api/history": {
        const data = await computeHistory();
        return jsonResponse(data);
      }

      case "/api/limits": {
        const data = await readLimits();
        return jsonResponse(data);
      }

      case "/api/sync-limits": {
        const data = await syncLimits();
        return jsonResponse(data);
      }

      case "/api/limits-history": {
        const data = await readLimitsHistory();
        return jsonResponse(data);
      }

      case "/api/sync-costs": {
        const data = await readSyncCosts();
        return jsonResponse(data);
      }

      default:
        return errorResponse("Not Found", 404);
    }
  } catch (err) {
    console.error(`[OpenLog] Error handling ${pathname}:`, err);
    return errorResponse("Internal Server Error", 500);
  }
}

// ---------------------------------------------------------------------------
// Server startup
// ---------------------------------------------------------------------------

const server = Bun.serve({
  port: PORT,
  fetch: handleRequest,
});

console.log(`\n  OpenLog — Claude Code Analytics Dashboard`);
console.log(`  ─────────────────────────────────────────`);
console.log(`  Local:   http://localhost:${PORT}`);
console.log(`  Data:    ${PROJECTS_DIR}`);
console.log(`\n  API endpoints:`);
console.log(`    GET /api/usage    — 5-hour rolling usage %`);
console.log(`    GET /api/stats    — overview stats (?days=7)`);
console.log(`    GET /api/activity — live event feed`);
console.log(`    GET /api/skills   — skill analytics`);
console.log(`    GET /api/hooks    — hook analytics`);
console.log(`    GET /api/heatmap  — trigger heatmap`);
console.log(`    GET /api/sessions — active sessions`);
console.log(`    GET /api/history  — daily usage from first session`);
console.log(`\n  Cache TTL: 30s (usage: 10s, history: 5m)\n`);
