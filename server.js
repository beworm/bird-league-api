/**
 * Bird League API Server
 * 
 * Zero-dependency Node.js server.
 * Endpoints:
 *   GET  /api/members
 *   GET  /api/schedule
 *   GET  /api/standings
 *   GET  /api/data              (full dump for frontend)
 *   GET  /api/week/:week
 *   GET  /api/matchup/:week/:m1/:m2
 *   POST /api/submit/:week/:memberId
 *   GET  /api/media/:week/:memberId/:filename
 *   POST /api/admin/judge/:week  (requires ADMIN_SECRET)
 *   POST /api/admin/seed         (requires ADMIN_SECRET)
 *   POST /api/admin/reset        (requires ADMIN_SECRET)
 */

const http = require("http");
const fs = require("fs");
const path = require("path");
const db = require("./db");
const { parseMultipart, parseJson } = require("./multipart");

const PORT = process.env.PORT || 3001;

// CORS — allow your Vercel frontend
const ALLOWED_ORIGINS = (process.env.ALLOWED_ORIGINS || "http://localhost:5173,http://localhost:3000")
  .split(",").map(s => s.trim());

function setCors(req, res) {
  const origin = req.headers.origin;
  if (ALLOWED_ORIGINS.includes(origin) || ALLOWED_ORIGINS.includes("*")) {
    res.setHeader("Access-Control-Allow-Origin", origin);
  } else if (ALLOWED_ORIGINS.length > 0) {
    res.setHeader("Access-Control-Allow-Origin", ALLOWED_ORIGINS[0]);
  }
  res.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS, DELETE");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type, Authorization");
}

function json(res, data, status = 200) {
  res.writeHead(status, { "Content-Type": "application/json" });
  res.end(JSON.stringify(data));
}

function error(res, msg, status = 400) {
  json(res, { error: msg }, status);
}

function readBody(req) {
  return new Promise((resolve) => {
    const chunks = [];
    req.on("data", (c) => chunks.push(c));
    req.on("end", () => resolve(Buffer.concat(chunks)));
  });
}

function checkAdmin(req) {
  const secret = process.env.ADMIN_SECRET;
  if (!secret) return false;
  const auth = req.headers.authorization;
  return auth === `Bearer ${secret}`;
}

const MIME = {
  ".jpg": "image/jpeg", ".jpeg": "image/jpeg", ".png": "image/png",
  ".gif": "image/gif", ".webp": "image/webp",
  ".mp4": "video/mp4", ".mov": "video/quicktime", ".webm": "video/webm",
  ".mp3": "audio/mpeg", ".wav": "audio/wav",
};

// ─── Route handler ────────────────────────────────────────

async function handleRequest(req, res) {
  try {
  setCors(req, res);

  if (req.method === "OPTIONS") {
    res.writeHead(204);
    return res.end();
  }

  const url = new URL(req.url, `http://${req.headers.host}`);
  const seg = url.pathname.split("/").filter(Boolean);

  // ── Health check ──
  if (req.method === "GET" && url.pathname === "/") {
    return json(res, { status: "ok", name: "Bird League API", version: "1.0.0" });
  }

  // ── GET /api/members ──
  if (req.method === "GET" && url.pathname === "/api/members") {
    return json(res, db.getMembers());
  }

  // ── GET /api/schedule ──
  if (req.method === "GET" && url.pathname === "/api/schedule") {
    return json(res, db.getSchedule());
  }

  // ── GET /api/standings ──
  if (req.method === "GET" && url.pathname === "/api/standings") {
    return json(res, db.getStandings());
  }

  // ── GET /api/data — full dump for frontend ──
  if (req.method === "GET" && url.pathname === "/api/data") {
    const members = db.getMembers();
    const schedule = db.getSchedule();
    const standings = db.getStandings();
    const getName = (id) => members.find(m => m.id === id)?.name || "Unknown";

    const weeks = schedule.map(w => {
      const matchups = w.matchups.map(mu => {
        const result = { m1: mu.m1, m2: mu.m2 };
        const sub1 = db.getSubmission(w.week, mu.m1);
        const sub2 = db.getSubmission(w.week, mu.m2);
        if (sub1) result.sub1 = { species: sub1.species, desc: sub1.description, media: sub1.mediaFiles || [] };
        if (sub2) result.sub2 = { species: sub2.species, desc: sub2.description, media: sub2.mediaFiles || [] };

        const judgment = db.getJudgment(w.week, mu.m1, mu.m2);
        if (judgment) {
          result.judgment = {
            winner: judgment.winner, summary: judgment.summary,
            m1sub: judgment.m1sub, m2sub: judgment.m2sub,
            chatgpt: judgment.chatgpt, gemini: judgment.gemini,
            claude: judgment.claude,
          };
        }
        return result;
      });
      return { week: w.week, status: w.status, matchups };
    });

    return json(res, { members, schedule: weeks, standings });
  }

  // ── GET /api/week/:week ──
  if (req.method === "GET" && seg[0] === "api" && seg[1] === "week" && seg[2]) {
    const weekNum = parseInt(seg[2]);
    const week = db.getWeek(weekNum);
    if (!week) return error(res, "Week not found", 404);

    const members = db.getMembers();
    const getName = (id) => members.find(m => m.id === id)?.name || "Unknown";

    const matchups = week.matchups.map(mu => {
      const result = { m1: mu.m1, m2: mu.m2, m1Name: getName(mu.m1), m2Name: getName(mu.m2) };
      const sub1 = db.getSubmission(weekNum, mu.m1);
      const sub2 = db.getSubmission(weekNum, mu.m2);
      if (sub1) result.sub1 = { species: sub1.species, desc: sub1.description, media: sub1.mediaFiles || [] };
      if (sub2) result.sub2 = { species: sub2.species, desc: sub2.description, media: sub2.mediaFiles || [] };
      const judgment = db.getJudgment(weekNum, mu.m1, mu.m2);
      if (judgment) {
        result.judgment = {
          winner: judgment.winner, summary: judgment.summary,
          m1sub: judgment.m1sub, m2sub: judgment.m2sub,
          chatgpt: judgment.chatgpt, gemini: judgment.gemini, claude: judgment.claude,
        };
      }
      return result;
    });

    return json(res, { week: weekNum, status: week.status, matchups });
  }

  // ── POST /api/submit/:week/:memberId ──
  if (req.method === "POST" && seg[0] === "api" && seg[1] === "submit" && seg.length === 4) {
    const weekNum = parseInt(seg[2]);
    const memberId = parseInt(seg[3]);

    const week = db.getWeek(weekNum);
    if (!week) return error(res, "Week not found", 404);
    if (week.status === "completed") return error(res, "Submissions closed for this week", 403);

    const member = db.getMember(memberId);
    if (!member) return error(res, "Member not found", 404);

    const inMatchup = week.matchups.some(mu => mu.m1 === memberId || mu.m2 === memberId);
    if (!inMatchup) return error(res, "Member not in a matchup this week", 400);

    const contentType = req.headers["content-type"] || "";
    let species = "", description = "", mediaFiles = [];

    try {
      if (contentType.includes("multipart/form-data")) {
        const safeName = member.name.replace(/[^a-zA-Z0-9]/g, "_");
        const uploadDir = path.join(__dirname, "submissions", `week-${weekNum}`, safeName);
        const { fields, files } = await parseMultipart(req, uploadDir);
        species = fields.species || "";
        description = fields.description || "";
        mediaFiles = files.map(f => `/api/media/${weekNum}/${memberId}/${f.savedName}`);
      } else if (contentType.includes("application/json")) {
        const data = await parseJson(req);
        species = data.species || "";
        description = data.description || "";
      } else {
        // Try reading as JSON anyway
        const body = await readBody(req);
        try {
          const data = JSON.parse(body.toString("utf8"));
          species = data.species || "";
          description = data.description || "";
        } catch {}
      }
    } catch (err) {
      console.error("Submit parse error:", err);
      return error(res, "Failed to parse submission: " + err.message, 400);
    }

    if (!species) return error(res, "Species is required", 400);

    const submission = db.upsertSubmission({ week: weekNum, memberId, species, description, mediaFiles });
    return json(res, submission, 201);
  }

  // ── GET /api/media/:week/:memberId/:filename ──
  if (req.method === "GET" && seg[0] === "api" && seg[1] === "media" && seg.length === 5) {
    const weekNum = seg[2];
    const memberId = parseInt(seg[3]);
    const filename = seg[4];

    const member = db.getMember(memberId);
    if (!member) return error(res, "Not found", 404);

    const safeName = member.name.replace(/[^a-zA-Z0-9]/g, "_");
    const filePath = path.join(__dirname, "submissions", `week-${weekNum}`, safeName, filename);
    if (!fs.existsSync(filePath)) return error(res, "File not found", 404);

    const ext = path.extname(filename).toLowerCase();
    const mime = MIME[ext] || "application/octet-stream";
    const stat = fs.statSync(filePath);

    res.writeHead(200, {
      "Content-Type": mime,
      "Content-Length": stat.size,
      "Cache-Control": "public, max-age=86400",
    });
    fs.createReadStream(filePath).pipe(res);
    return;
  }

  // ── GET /api/admin/backup — download current db.json ──
  if (req.method === "GET" && seg[0] === "api" && seg[1] === "admin" && seg[2] === "backup" && !seg[3]) {
    if (!checkAdmin(req)) return error(res, "Unauthorized", 401);
    try {
      const data = JSON.stringify(db.getFullDb(), null, 2);
      res.writeHead(200, {
        "Content-Type": "application/json",
        "Content-Disposition": `attachment; filename="db-backup-${new Date().toISOString().slice(0,10)}.json"`,
      });
      return res.end(data);
    } catch (err) {
      return error(res, "Backup failed: " + err.message, 500);
    }
  }

  // ── GET /api/admin/backups — list all auto-backups ──
  if (req.method === "GET" && seg[0] === "api" && seg[1] === "admin" && seg[2] === "backups") {
    if (!checkAdmin(req)) return error(res, "Unauthorized", 401);
    return json(res, { backups: db.listBackups() });
  }

  // ── POST /api/admin/restore — upload a db.json to replace current ──
  if (req.method === "POST" && seg[0] === "api" && seg[1] === "admin" && seg[2] === "restore" && !seg[3]) {
    if (!checkAdmin(req)) return error(res, "Unauthorized", 401);
    try {
      const body = await readBody(req);
      const data = JSON.parse(body.toString("utf8"));
      if (!data.members || !data.schedule) return error(res, "Invalid db.json — missing members or schedule", 400);
      db.replaceDb(data);
      return json(res, { status: "restored", members: data.members.length, submissions: (data.submissions || []).length, judgments: (data.judgments || []).length });
    } catch (err) {
      return error(res, "Restore failed: " + err.message, 400);
    }
  }

  // ── POST /api/admin/restore/:backupName — restore from auto-backup ──
  if (req.method === "POST" && seg[0] === "api" && seg[1] === "admin" && seg[2] === "restore" && seg[3]) {
    if (!checkAdmin(req)) return error(res, "Unauthorized", 401);
    const result = db.restoreBackup(seg[3]);
    if (!result) return error(res, "Backup not found", 404);
    return json(res, { status: "restored", backup: seg[3], submissions: (result.submissions || []).length, judgments: (result.judgments || []).length });
  }

  // ── POST /api/admin/week/:week/status ──
  if (req.method === "POST" && seg[0] === "api" && seg[1] === "admin" && seg[2] === "week" && seg[3] && seg[4] === "status") {
    if (!checkAdmin(req)) return error(res, "Unauthorized", 401);
    try {
      const body = JSON.parse((await readBody(req)).toString("utf8"));
      const validStatuses = ["upcoming", "active", "completed"];
      if (!body.status || !validStatuses.includes(body.status)) {
        return error(res, "Invalid status. Must be: " + validStatuses.join(", "), 400);
      }
      const week = db.setWeekStatus(parseInt(seg[3]), body.status);
      if (!week) return error(res, "Week not found", 404);
      return json(res, { status: "ok", week: week.week, newStatus: week.status });
    } catch (err) {
      return error(res, err.message, 400);
    }
  }

  // ── POST /api/admin/judge/:week ──
  if (req.method === "POST" && seg[0] === "api" && seg[1] === "admin" && seg[2] === "judge" && seg[3]) {
    if (!checkAdmin(req)) return error(res, "Unauthorized", 401);
    try {
      const judge = require("./judge");
      const results = await judge.judgeWeek(parseInt(seg[3]));
      return json(res, { judged: results.length, results });
    } catch (err) {
      return error(res, err.message, 500);
    }
  }

  // ── POST /api/admin/seed ──
  if (req.method === "POST" && seg[0] === "api" && seg[1] === "admin" && seg[2] === "seed") {
    if (!checkAdmin(req)) return error(res, "Unauthorized", 401);
    try {
      delete require.cache[require.resolve("./seed")];
      require("./seed");
      return json(res, { status: "seeded" });
    } catch (err) {
      return error(res, err.message, 500);
    }
  }

  // ── POST /api/admin/reset ──
  if (req.method === "POST" && seg[0] === "api" && seg[1] === "admin" && seg[2] === "reset") {
    if (!checkAdmin(req)) return error(res, "Unauthorized", 401);
    db.reset();
    return json(res, { status: "reset complete" });
  }

  error(res, "Not found", 404);
  } catch (err) { console.error("Request error:", err); if (!res.headersSent) error(res, "Server error", 500); }
}

// ─── Start ────────────────────────────────────────────────

const server = http.createServer(handleRequest);
server.listen(PORT, () => {
  console.log(`\n  Bird League API running on port ${PORT}`);
  console.log(`  Health: http://localhost:${PORT}/`);
  console.log(`  Data:   http://localhost:${PORT}/api/data\n`);
});
