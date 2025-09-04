// app.js — Async REST bridge for meet-teams-bot
// Run: API_KEY=replace-me PORT=3300 LOG_ECHO=1 node app.js

import express from "express";
import { spawn, execSync, spawnSync } from "child_process";
import path from "path";
import fs from "fs";
import "dotenv/config";
import { fileURLToPath } from "url";
import crypto from "crypto";
import axios from "axios";
import http from "http";
import https from "https";
import { S3Client, PutObjectCommand, GetObjectCommand } from "@aws-sdk/client-s3";
import { getSignedUrl } from "@aws-sdk/s3-request-presigner"; 


const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// ===== ENV =====
const PORT = Number(process.env.PORT || 3000);
const API_KEY = process.env.API_KEY || "";
if (!API_KEY) { console.error("❌ Missing API_KEY"); process.exit(1); }

const DEFAULT_RECORDINGS_DIR = process.env.RECORDINGS_DIR || path.join(__dirname, "recordings");
const ECHO_LOG = (process.env.LOG_ECHO || "1") === "1";
const BOT_IDLE_TIMEOUT_MS = Number(process.env.BOT_IDLE_TIMEOUT_MS || 15 * 60_000);
const BOT_MAX_TIMEOUT_MS  = Number(process.env.BOT_MAX_TIMEOUT_MS  || 2 * 60 * 60_000);

// ===== S3 config =====
const AWS_REGION = process.env.AWS_REGION || process.env.AWS_DEFAULT_REGION || "ap-southeast-1";
const AWS_S3_ENDPOINT = process.env.AWS_S3_ENDPOINT || undefined; // สำหรับ MinIO / S3-compatible
const AWS_S3_FORCE_PATH_STYLE = (process.env.AWS_S3_FORCE_PATH_STYLE || "0") === "1";

// --- รองรับชื่อ ENV แบบที่คุณใช้ในสคริปต์ .ts เดิมด้วย ---
const S3_REGION = process.env.S3_REGION || AWS_REGION;
const S3_ENDPOINT_RAW = process.env.S3_ENDPOINT || AWS_S3_ENDPOINT || "";
const S3_FORCE_PATHSTYLE =
  (process.env.S3_FORCE_PATHSTYLE || "").toLowerCase() === "true" || AWS_S3_FORCE_PATH_STYLE;

function asEndpointUrl(v) {
  if (!v) return undefined;
  // อนุญาตทั้ง “r2.cloudflarestorage.com” และ “https://r2.cloudflarestorage.com”
  return /^https?:\/\//i.test(v) ? v : `https://${v}`;
}

// สร้าง S3 client สำหรับ presign โดยเฉพาะ (credentials อ่านจาก ENV ของโปรเซส)
const s3Presign = new S3Client({
  region: S3_REGION,
  endpoint: S3_ENDPOINT_RAW ? asEndpointUrl(S3_ENDPOINT_RAW) : undefined,
  // R2 มักต้องใช้ path-style (virtual-host บางทีจะผิดโดเมน/ใบเซิร์ต)
  forcePathStyle: S3_FORCE_PATHSTYLE || (/r2\.cloudflarestorage\.com$/i.test(S3_ENDPOINT_RAW || "")),
});

// internal stop target (ส่วนใหญ่ไม่เปิดพอร์ต 8080 ไว้ — เราจะมี fallback เป็น docker exec)
const MEET_BOT_BASE = process.env.MEET_BOT_BASE || "";
const ALLOW_DOCKER_STOP = (process.env.ALLOW_DOCKER_STOP || "1") === "1"; // เปิดไว้เป็นดีฟอลต์

// axios no keep-alive
const axiosBot = axios.create({
  baseURL: MEET_BOT_BASE || undefined,
  timeout: 7000,
  httpAgent: new http.Agent({ keepAlive: false }),
  httpsAgent: new https.Agent({ keepAlive: false })
});

// ===== Utils =====
const stripAnsi = (s) => s.replace(/\x1b\[[0-9;]*m/g, "");
const UUID_PATTERNS = [
  /\/recordings\/([A-F0-9-]{36})\//i,
  /bot UUID[^A-F0-9]*([A-F0-9-]{36})/i,
  /session ID[: ]+([A-F0-9-]{36})/i,
  /"bot_uuid"\s*:\s*"([A-F0-9-]{36})"/i,
  /"id"\s*:\s*"([A-F0-9-]{36})"/i,
];
function extractUuidFrom(line) {
  const s = stripAnsi(line);
  for (const r of UUID_PATTERNS) { const m = s.match(r); if (m) return m[1]; }
}
function isUuidDirName(name) { return /^[A-F0-9-]{36}$/i.test(name); }
function findLatestUuidFromRecordingsSince(baseDir, sinceMs) {
  try {
    const names = fs.readdirSync(baseDir).filter(isUuidDirName);
    const fresh = names
      .map((name) => {
        const p = path.join(baseDir, name);
        return { name, t: fs.statSync(p).mtimeMs };
      })
      .filter(it => !sinceMs || it.t >= (sinceMs - 5_000))
      .sort((a,b)=>b.t-a.t);
    return fresh[0]?.name;
  } catch {}
}
const sleep = (ms) => new Promise(r => setTimeout(r, ms));

// parse extra ["k=v","x=true"] → {k:"v",x:true}
function parseExtraToObject(extra) {
  const out = {};
  if (!Array.isArray(extra)) return out;
  for (const kv of extra) {
    if (typeof kv !== "string" || !kv.includes("=")) continue;
    const [k, ...rest] = kv.split("=");
    const vRaw = rest.join("=");
    if (/^(true|false)$/i.test(vRaw)) out[k] = vRaw.toLowerCase() === "true";
    else if (/^-?\d+(\.\d+)?$/.test(vRaw)) out[k] = Number(vRaw);
    else {
      try { out[k] = JSON.parse(vRaw); }
      catch { out[k] = vRaw; }
    }
  }
  return out;
}

// ===== In-memory stores =====
// job = { id, pid, status, createdAt, updatedAt, startedAt, meeting_url, bot_name, extra,
//         uuid?, containerName?, recordings?, recordingsDir?, exitCode?, signal?, error?, clients:Set }
const JOBS = new Map();
const CHILDREN = new Map();

function newJobId() { return crypto.randomUUID(); }
function setJob(id, patch) {
  const j = JOBS.get(id) || {};
  const now = Date.now();
  const merged = { updatedAt: now, ...j, ...patch };
  JOBS.set(id, merged);
  return merged;
}
function pushLog(id, line) {
  const j = setJob(id, {});
  (j.logs ||= []).push(line);
  if (j.logs.length > 5000) j.logs.splice(0, j.logs.length - 5000);
  for (const res of j.clients || []) res.write(`data: ${line}\n\n`);
}

// หา run_bot.sh อัตโนมัติ
function resolveRunScript() {
  const tried = [
    path.resolve(__dirname, "run_bot.sh"),
    path.resolve(__dirname, "..", "run_bot.sh"),
    path.resolve(__dirname, "..", "meet-teams-bot", "run_bot.sh"),
    "/meet-teams-bot/run_bot.sh",
  ];
  for (const p of tried) {
    try { if (fs.existsSync(p)) return { runPath: p, tried }; } catch {}
  }
  return { runPath: tried[0], tried };
}

// ===== docker helpers (GRACEFUL stop) =====
function findContainerNameByUuid(uuid) {
  try {
    const out = execSync(`docker ps --filter "label=meetbot.uuid=${uuid}" --format "{{.Names}}"`).toString().trim();
    return out.split("\n").filter(Boolean)[0] || null;
  } catch { return null; }
}
function findContainerIdByUuid(uuid) {
  try {
    const out = execSync(`docker ps --filter "label=meetbot.uuid=${uuid}" --format "{{.ID}}"`).toString().trim();
    return out.split("\n").filter(Boolean)[0] || null;
  } catch { return null; }
}

// ----- Docker helpers: host-port & IP of container:8080 -----
function dockerGetHostPort8080(container) {
  try {
    const out = execSync(`docker port ${container} 8080/tcp`).toString().trim();
    if (!out) return;
    // ตัวอย่าง out: "0.0.0.0:49155" หรือ ":::49155" หรือ "127.0.0.1:49155"
    const first = out.split(/\s+/)[0];
    const portStr = first.split(":").pop();
    const port = Number(portStr);
    if (Number.isFinite(port) && port > 0) return port;
  } catch {}
}

function dockerGetIP(container) {
  try {
    const out = execSync(
      `docker inspect -f "{{range .NetworkSettings.Networks}}{{.IPAddress}}{{end}}" ${container}`
    ).toString().trim();
    return out || undefined;
  } catch {}
}

async function httpPostNoKeepAlive(url, payload) {
  const ax = axios.create({
    timeout: 7000,
    httpAgent: new http.Agent({ keepAlive: false }),
    httpsAgent: new https.Agent({ keepAlive: false }),
  });
  const r = await ax.post(url, payload);
  return r.data;
}

// ยิง /stop_record ที่ container ผ่าน host-port หรือ container IP
async function tryHttpStopByContainer(container, payload) {
  // A) host published port (ถ้ารู้ชื่อ container)
  const p = dockerGetHostPort8080(container);
  const ip = dockerGetIP(container);
  let lastErr;
  if (p) {
    try { return await httpPostNoKeepAlive(`http://127.0.0.1:${p}/stop_record`, payload); }
    catch (e) { lastErr = e; }
  }
  if (ip) {
    try { return await httpPostNoKeepAlive(`http://${ip}:8080/stop_record`, payload); }
    catch (e) { lastErr = e; }
  }
  throw lastErr || new Error("no_http_route_to_container");
}

// docker exec (fallback สุดท้ายจริง ๆ) — ลองหลายวิธี: node, python, curl, wget, busybox
function dockerExecStopRecord(containerRef, payload) {
  const data = JSON.stringify(payload);
  const payloadB64 = Buffer.from(data, "utf8").toString("base64");
  const tryExec = (args) => spawnSync("docker", args, { encoding: "utf8" });

  // A) Node (ถ้ามี)
  {
    const nodeCmd =
      'node -e "const http=require(\'http\');' +
      'const d=Buffer.from(process.env.PAYLOAD_B64,\'base64\').toString(\'utf8\');' +
      'const req=http.request({host:\'127.0.0.1\',port:8080,path:\'/stop_record\',method:\'POST\',headers:{\'Content-Type\':\'application/json\',\'Content-Length\':Buffer.byteLength(d)}},res=>{let b=\'\';res.on(\'data\',c=>b+=c);res.on(\'end\',()=>{console.log(b||String(res.statusCode))});});' +
      'req.on(\'error\',e=>{console.error(e.message);process.exit(2)});req.write(d);req.end();"';
    const r = tryExec(["exec", "-e", `PAYLOAD_B64=${payloadB64}`, containerRef, "sh", "-lc", nodeCmd]);
    if (r.status === 0) return (r.stdout || "").trim();
  }

  // B) Python (ถ้ามี)
  {
    const pyCmd =
      'python3 - <<PY\n' +
      'import sys, json, urllib.request, os\n' +
      'd = json.loads(os.environ["PAYLOAD"])\n' +
      'req = urllib.request.Request("http://127.0.0.1:8080/stop_record", data=json.dumps(d).encode("utf-8"), headers={"Content-Type":"application/json"})\n' +
      'print(urllib.request.urlopen(req, timeout=6).read().decode("utf-8"))\n' +
      'PY';
    const r = tryExec(["exec", "-e", `PAYLOAD=${data}`, containerRef, "sh", "-lc", pyCmd]);
    if (r.status === 0) return (r.stdout || "").trim();
  }

  // C) curl
  {
    const cmd = 'command -v curl >/dev/null 2>&1 && curl -fsS -X POST http://127.0.0.1:8080/stop_record -H "Content-Type: application/json" -d "$PAYLOAD"';
    const r = tryExec(["exec", "-e", `PAYLOAD=${data}`, containerRef, "sh", "-lc", cmd]);
    if (r.status === 0) return (r.stdout || "").trim();
  }

  // D) wget
  {
    const cmd = 'command -v wget >/dev/null 2>&1 && wget -qO- --method=POST --header="Content-Type: application/json" --body-data="$PAYLOAD" http://127.0.0.1:8080/stop_record';
    const r = tryExec(["exec", "-e", `PAYLOAD=${data}`, containerRef, "sh", "-lc", cmd]);
    if (r.status === 0) return (r.stdout || "").trim();
  }

  // E) busybox wget
  {
    const cmd = 'command -v busybox >/dev/null 2>&1 && busybox wget -qO- http://127.0.0.1:8080/stop_record --post-data="$PAYLOAD" --header \'Content-Type: application/json\'';
    const r = tryExec(["exec", "-e", `PAYLOAD=${data}`, containerRef, "sh", "-lc", cmd]);
    if (r.status === 0) return (r.stdout || "").trim();
  }

  throw new Error("docker_exec_stop_failed_all");
}

function ensureHostPort8080(jobId, cname, attempt = 0) {
  if (!cname) return;
  const hp = dockerGetHostPort8080(cname);
  if (hp) {
    setJob(jobId, { hostPort8080: hp });
    pushLog(jobId, `[api] mapped container ${cname} -> host :${hp}`);
  } else if (attempt < 3) {
    setTimeout(() => ensureHostPort8080(jobId, cname, attempt + 1), 1200);
  }
}

// ========= Utils & Guards สำหรับ Presign =========
function parseS3Uri(uri) {
  if (!uri || typeof uri !== "string") throw new Error("ต้องระบุพารามิเตอร์ s3 เป็น s3://<bucket>/<key>");
  const m = uri.match(/^s3:\/\/([^/]+)\/(.+)$/i);
  if (!m) throw new Error(`รูปแบบลิงก์ไม่ถูกต้อง: ${uri} (เช่น s3://bucket/path/to/file.ext)`);
  return { bucket: m[1], key: m[2] };
}

function mask(s) { if (!s) return undefined; return s.length <= 8 ? s[0] + "****" : s.slice(0,4) + "****" + s.slice(-2); }
async function createPresignedGetUrl(bucketName, s3Key, expiresIn = 3600, opts = {}) {
  const cmd = new GetObjectCommand({
    Bucket: bucketName,
    Key: s3Key,
    ...(opts.downloadName ? { ResponseContentDisposition: `attachment; filename="${opts.downloadName}"` } : {}),
    ...(opts.contentType ? { ResponseContentType: opts.contentType } : {}),
  });
  return getSignedUrl(s3Presign, cmd, { expiresIn });
}

// bucket ที่ใช้สำหรับ presign (ล็อกจาก ENV)
const PRESIGN_BUCKET =
  process.env.PRESIGN_BUCKET ||
  process.env.AWS_S3_VIDEO_BUCKET ||
  process.env.AWS_S3_BUCKET ||
  process.env.S3_BUCKET ||
  "";

// ตรวจ filename แบบง่าย: ไม่ให้มี / หรือ \ และห้าม ".."
function validateFilename(name) {
  if (!name || typeof name !== "string") throw new Error("ต้องระบุ filename");
  if (/[\/\\]/.test(name)) throw new Error("filename ต้องไม่มีเครื่องหมาย / หรือ \\");
  if (name.includes("..")) throw new Error("filename ไม่ควรมี '..'");
}

// ตรวจ uuid แบบง่าย (รูปแบบ xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx)
function validateUuid(u) {
  if (!u || !/^[A-F0-9-]{36}$/i.test(String(u))) throw new Error("uuid รูปแบบไม่ถูกต้อง");
}

// ===== App =====
const app = express();
app.use(express.json({ limit: "1mb" }));

// API key (ยกเว้น health / SSE logs)
app.use((req, res, next) => {
  if (req.path === "/health" || (req.path.startsWith("/jobs/") && req.path.endsWith("/logs"))) return next();
  const key = req.header("X-API-Key");
  if (!key || key !== API_KEY) return res.status(401).json({ success: false, error: "unauthorized" });
  next();
});

app.get("/health", (_req, res) => {
  const { runPath, tried } = resolveRunScript();
  res.json({ ok: true, ts: Date.now(), runPath, tried, meetBotBase: MEET_BOT_BASE });
});

// Create job & start bot (respond immediately)
app.post("/jobs", async (req, res) => {
  const { meeting_url, bot_name, extra } = req.body || {};
  if (!meeting_url) return res.status(400).json({ success: false, error: "meeting_url required" });

  const { runPath, tried } = resolveRunScript();
  if (!fs.existsSync(runPath)) {
    return res.status(500).json({ success: false, error: `run script not found: ${runPath}`, tried });
  }

  const id = newJobId();

  const apiBase =
  process.env.API_SERVER_BASEURL ||
  process.env.WRAPPER_BASEURL ||
  `http://host.docker.internal:${PORT}`;

  const apiToken = process.env.API_SERVER_TOKEN || API_KEY;

  const remoteOverride = {
    api_server_baseurl: apiBase,
    aws_s3_video_bucket: process.env.AWS_S3_VIDEO_BUCKET || "meeting-bot",
    aws_s3_log_bucket: process.env.AWS_S3_LOG_BUCKET || "meeting-bot",
  };

  const args = [
    "run",
    `meeting_url=${meeting_url}`,
    `bot_uuid=${id}`,
    // (ถ้าบอทต้องการคีย์บนสุดด้วย คงไว้ได้ ไม่เสียหาย)
    `api_server_baseurl=${apiBase}`,
    `api_server_token=${apiToken}`,
    // ใส่ remote เป็น JSON ทั้งก้อน (ไม่มีช่องว่าง)
    `remote=${JSON.stringify(remoteOverride)}`,
  ];

  if (bot_name) args.push(`bot_name=${bot_name}`);
  if (Array.isArray(extra)) for (const kv of extra) args.push(String(kv));


  const recordingsDir = process.env.RECORDINGS_DIR || path.join(path.dirname(runPath), "recordings");
  setJob(id, {
    id, status: "pending", meeting_url, bot_name, extra,
    createdAt: Date.now(), updatedAt: Date.now(), startedAt: Date.now(),
    logs: [], clients: new Set(), recordingsDir
  });

  console.log("▶ starting job", id);
  console.log("▶ runPath:", runPath);
  console.log("▶ args:", args.join(" "));
  console.log("▶ recordingsDir:", recordingsDir);

  const child = spawn("/bin/bash", [runPath, ...args], {
    cwd: path.dirname(runPath),
    env: { ...process.env, FORCE_COLOR: "1", TERM: "xterm-256color" },
  });

  CHILDREN.set(id, child);
  setJob(id, { status: "running", pid: child.pid });
  console.log("▶ pid:", child.pid);

  // ---- Idle/Max timeout guards ----
  let lastActivity = Date.now();
  const startedAt = Date.now();
  const guard = setInterval(() => {
    const now = Date.now();
    const idleFor = now - lastActivity;
    const aliveFor = now - startedAt;

    if (aliveFor > BOT_MAX_TIMEOUT_MS) {
      try { child.kill("SIGKILL"); } catch {}
      setJob(id, { status: "timeout", error: "max_time_exceeded" });
      pushLog(id, `timeout -> killed (max ${BOT_MAX_TIMEOUT_MS}ms)`);
      clearInterval(guard);
      return;
    }
    if (idleFor > BOT_IDLE_TIMEOUT_MS) {
      try { child.kill("SIGKILL"); } catch {}
      setJob(id, { status: "timeout", error: "idle_timeout" });
      pushLog(id, `timeout -> killed (idle ${idleFor}ms > ${BOT_IDLE_TIMEOUT_MS}ms)`);
      clearInterval(guard);
    }
  }, 5000);

  // mirror logs + parse uuid + containerName + ต่ออายุ idle timer
  const onData = (src) => (buf) => {
    const raw = buf.toString();
    lastActivity = Date.now();
    if (ECHO_LOG) raw.split("\n").filter(Boolean).forEach(l => console.log(src, l));
    raw.split("\n").filter(Boolean).forEach(l => pushLog(id, `${src} ${l}`));

    for (const line of raw.split("\n")) {
      const jcur = JOBS.get(id) || {};

      // 1) ดึง UUID ครั้งเดียว
      if (!jcur.uuid) {
        const maybe = extractUuidFrom(line);
        if (maybe) setJob(id, { uuid: maybe });
      }

      // 2) จับชื่อคอนเทนเนอร์ (รองรับทั้ง "::container_name::X" และ "CONTAINER_NAME: X")
      const nameMatch = line.match(/(?::\:container_name::|CONTAINER_NAME:\s*)([A-Za-z0-9_.-]+)/i);
      if (nameMatch && !jcur.containerName) {
        const cname = nameMatch[1];
        setJob(id, { containerName: cname });
        // พยายาม map host-port 8080 ทันที + เผื่อดีเลย์ด้วย retry เล็กน้อย
        setJob(id, { containerName: cname });
        // ถ้าชื่อเป็นรูป meetbot-<uuid> ให้ตั้ง uuid ไปเลย
        const maybe = cname.replace(/^meetbot-/, "");
        if (!jcur.uuid && /^[A-F0-9-]{36}$/i.test(maybe)) {
          setJob(id, { uuid: maybe });
        }
        ensureHostPort8080(id, cname);
      }
    }
  };
  child.stdout.on("data", onData("[bot:stdout]"));
  child.stderr.on("data", onData("[bot:stderr]"));

  // record exit/signal
  let exitCodeFinal = null;
  let exitSignalFinal = null;
  const logExit = (tag, code, signal) => console.log(`■ child ${tag} job=${id} pid=${child.pid} code=${code} signal=${signal}`);

  child.once("spawn", () => pushLog(id, "spawned"));
  child.once("error", (err) => {
    console.error("✖ child error:", err);
    setJob(id, { status: "error", error: String(err) });
    pushLog(id, `error ${String(err)}`);
  });
  child.once("exit", (code, signal) => { exitCodeFinal = code; exitSignalFinal = signal; logExit("exit", code, signal); });
  child.once("close", async (code, signal) => {
    logExit("close", code, signal);
    clearInterval(guard);
    CHILDREN.delete(id);

    const codeEff = exitCodeFinal ?? code;
    const sigEff  = exitSignalFinal ?? signal;

    const j0 = JOBS.get(id) || {};
    if (!j0.uuid && codeEff === 0 && !sigEff) {
      await sleep(500);
      const since = j0.startedAt || j0.createdAt;
      const fallback = findLatestUuidFromRecordingsSince(j0.recordingsDir || DEFAULT_RECORDINGS_DIR, since);
      if (fallback) setJob(id, { uuid: fallback });
    }

    const j = JOBS.get(id) || {};
    if (codeEff === 0 && !sigEff && j.uuid) {
      setJob(id, { status: "done", exitCode: 0, signal: null, recordings: path.join(j.recordingsDir || DEFAULT_RECORDINGS_DIR, j.uuid) });
      pushLog(id, `done uuid=${j.uuid}`);
    } else {
      const reason = sigEff ? `killed_by_${sigEff}` : (codeEff === 0 ? "completed_without_uuid" : "bot_failed");
      setJob(id, { status: "error", exitCode: codeEff ?? -1, signal: sigEff, error: reason });
      pushLog(id, `error ${reason}`);
    }
  });

  // respond immediately
  return res.json({ success: true, jobId: id, pid: child.pid, status: "running" });
});

// Job status
app.get("/jobs/:id/status", (req, res) => {
  const j = JOBS.get(req.params.id);
  if (!j) return res.status(404).json({ success: false, error: "job_not_found" });
  const { id, pid, status, createdAt, updatedAt, startedAt, meeting_url, bot_name, uuid, containerName, recordings, exitCode, signal, error } = j;
  res.json({ success: true, id, pid, status, createdAt, updatedAt, startedAt, meeting_url, bot_name, uuid, containerName, recordings, exitCode, signal, error });
});

// ---- helper: stop by container name / label(uuid) (FORCE only) ----
function stopByContainerNameOrUuid(job) {
  // 1) มีชื่อชัดเจน
  if (job.containerName) {
    try {
      execSync(`docker stop ${job.containerName}`, { stdio: "inherit" });
      return { via: "docker_stop_name", target: job.containerName };
    } catch (e) {}
  }
  // 2) หาโดย label meetbot.uuid=<uuid>
  if (job.uuid) {
    try {
      const out = execSync(`docker ps --filter "label=meetbot.uuid=${job.uuid}" --format "{{.ID}}"`).toString().trim();
      const id = out.split("\n").filter(Boolean)[0];
      if (id) {
        execSync(`docker stop ${id}`, { stdio: "inherit" });
        return { via: "docker_stop_label", target: id };
      }
    } catch (e) {}
  }
  throw new Error("no_container_target");
}

app.post("/jobs/:id/stop", async (req, res) => {
  const jobId = req.params.id;
  const job = JOBS.get(jobId);
  if (!job) return res.status(404).json({ success: false, error: "job_not_found" });

  const payload = job.uuid || job.meeting_url
    ? { ...(job.uuid && { bot_id: job.uuid }), ...(job.meeting_url && { meeting_url: job.meeting_url }) }
    : null;

  // 1) ถ้ากำหนด MEET_BOT_BASE ไว้ ก็ลองยิงตามนั้นก่อน
  if (MEET_BOT_BASE && payload) {
    try {
      const data = await httpPostNoKeepAlive(`${MEET_BOT_BASE.replace(/\/+$/, "")}/stop_record`, payload);
      setJob(jobId, { status: "stopping" });
      return res.json({ success: true, via: "stop_record_http_base", data });
    } catch (e) {
      console.warn("stop_record via MEET_BOT_BASE failed:", e?.code || e?.message || String(e));
    }
  }

   // 2) docker exec ยิง HTTP ข้างในคอนเทนเนอร์ก่อน (เสถียรกว่า)
  if (job.containerName && payload) {
    try {
      const out = dockerExecStopRecord(job.containerName, payload);
      setJob(jobId, { status: "stopping" });
      return res.json({ success: true, via: "stop_record_docker_exec", data: out });
    } catch (e) {
        console.warn("stop_record via docker exec failed:", e?.message || String(e));
      }
    }

  // 3) ค่อยลอง HTTP ผ่าน host-port/IP
  if (job.containerName && payload) {
    try {
      const data = await tryHttpStopByContainer(job.containerName, payload);
      setJob(jobId, { status: "stopping" });
      return res.json({ success: true, via: "stop_record_http_container", data });
    } catch (e) {
      console.warn("stop_record via container HTTP failed:", e?.message || String(e));
    }
  }

  // 4) ถ้าทั้งหมดข้างบนพลาด และอนุญาต docker stop → ตัดจบ (อาจไม่ graceful)
  if (ALLOW_DOCKER_STOP && job.containerName) {
    try {
      execSync(`docker stop ${job.containerName}`, { stdio: "inherit" });
      setJob(jobId, { status: "stopping" });
      return res.status(202).json({ success: true, via: "docker_stop_name", target: job.containerName });
    } catch (e) {
      console.warn("docker stop by name failed:", e?.message || String(e));
    }
  }

  // 5) สุดท้ายจริง ๆ: kill child process (ถ้าเหลืออยู่)
  const child = CHILDREN.get(jobId);
  if (child) {
    let termSent = false;
    try { process.kill(child.pid, "SIGTERM"); termSent = true; } catch {}
    setTimeout(() => { try { process.kill(child.pid, "SIGKILL"); } catch {} }, 2000);
    setJob(jobId, { status: "stopping" });
    return res.status(202).json({ success: true, via: "local_kill", message: termSent ? "SIGTERM sent to child" : "failed_to_signal_child" });
  }

  return res.status(502).json({
    success: false,
    error: "stop_unavailable",
    detail: "Could not reach internal /stop_record and no force kill requested.",
    hint: "Make sure the container has an HTTP server on :8080; publish it or use bridge IP; container is named/labelled by uuid already.",
  });
});


// ========= GET /s3/presign-get?s3=s3://bucket/key&expires=1800&downloadName=xx&contentType=yy =========
app.get("/s3/presign-get", async (req, res) => {
  try {
    // guard: credentials ชัดเจน
    const ak = process.env.AWS_ACCESS_KEY_ID;
    const sk = process.env.AWS_SECRET_ACCESS_KEY;
    if (!ak || !sk) {
      return res.status(500).json({
        success: false,
        error: "missing_credentials",
        detail: "ตั้ง AWS_ACCESS_KEY_ID / AWS_SECRET_ACCESS_KEY ให้โปรเซสนี้ก่อน",
        seenEnv: { AWS_ACCESS_KEY_ID: mask(ak), AWS_SECRET_ACCESS_KEY: sk ? "set" : undefined }
      });
    }

   // รูปแบบใหม่: ใช้ uuid + filename และ bucket จาก ENV
    const uuid = req.query.uuid ? String(req.query.uuid) : undefined;
    const filename = req.query.filename ? String(req.query.filename) : undefined;

    console.log(uuid, filename);

    let bucket, key, downloadNameAuto;
    if (uuid && filename) {
      if (!PRESIGN_BUCKET) {
        return res.status(500).json({
          success: false,
          error: "bucket_env_missing",
          detail: "ไม่พบตัวแปรแวดล้อมสำหรับ bucket (ตั้ง PRESIGN_BUCKET หรือ AWS_S3_VIDEO_BUCKET / AWS_S3_BUCKET / S3_BUCKET)"
        });
      }
      validateUuid(uuid);
      validateFilename(filename);
      bucket = PRESIGN_BUCKET;
      key = `${uuid}/${filename}`;
      downloadNameAuto = filename;
    } else {
      // รองรับของเดิม: ?s3=s3://bucket/key
      const s3uri = req.query.s3 || req.query.uri;
      const parsed = parseS3Uri(String(s3uri || ""));
      bucket = parsed.bucket;
      key = parsed.key;
      downloadNameAuto = key.split("/").pop();
    }
    const expiresRaw = Number(req.query.expires);
    const expiresIn = Math.max(60, Number.isFinite(expiresRaw) ? expiresRaw : 1800);
    const downloadName = req.query.downloadName ? String(req.query.downloadName) : undefined;
    const contentType  = req.query.contentType  ? String(req.query.contentType)  : undefined;

    const url = await createPresignedGetUrl(bucket, key, expiresIn, { downloadName, contentType });
    return res.json({ success: true, url, bucket, key, expiresIn });
  } catch (e) {
    console.error("presign-get error:", e);
    return res.status(400).json({
      success: false,
      error: "presign_failed",
      detail: e?.message || String(e),
    });
  }
});

app.listen(PORT, () => {
  console.log(`✅ bot-api listening on :${PORT}`);
  console.log(`▶ default recordings: ${DEFAULT_RECORDINGS_DIR}`);
  console.log(`▶ idle timeout: ${BOT_IDLE_TIMEOUT_MS} ms, max timeout: ${BOT_MAX_TIMEOUT_MS} ms`);
  console.log(`▶ stop_record base: ${MEET_BOT_BASE || "(disabled)"}  ALLOW_DOCKER_STOP=${ALLOW_DOCKER_STOP ? "1" : "0"}`);
});
