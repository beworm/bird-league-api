/**
 * Bird League — JSON-file database layer
 *
 * PERSISTENCE:
 * - Uses RAILWAY_VOLUME_MOUNT_PATH or /data for persistent storage
 * - Falls back to local ./data for dev
 * - Auto-backs up on every write (keeps last 30 backups)
 */

const fs = require("fs");
const path = require("path");

// ─── Persistent Storage Path ─────────────────────────────
const DATA_DIR = process.env.RAILWAY_VOLUME_MOUNT_PATH || path.join(__dirname, "data");
const DB_PATH = path.join(DATA_DIR, "db.json");
const BACKUP_DIR = path.join(DATA_DIR, "backups");
const MAX_BACKUPS = 30;

fs.mkdirSync(DATA_DIR, { recursive: true });
fs.mkdirSync(BACKUP_DIR, { recursive: true });

console.log(`[DB] Data directory: ${DATA_DIR}`);
console.log(`[DB] Database path: ${DB_PATH}`);
console.log(`[DB] Backup directory: ${BACKUP_DIR}`);

// ─── Members ──────────────────────────────────────────────

const MEMBERS = [
  { id: 1, name: "Matthew" },
  { id: 2, name: "Trevor & Katie" },
  { id: 3, name: "Marshall" },
  { id: 4, name: "Dara" },
  { id: 5, name: "Anna" },
  { id: 6, name: "Leo & Taylor" },
  { id: 7, name: "Jack" },
  { id: 8, name: "Emily" },
  { id: 9, name: "Grace" },
  { id: 10, name: "Ben" },
];

// ─── Real Schedule ────────────────────────────────────────

const SCHEDULE = [
  { week: 1, status: "completed", matchups: [
    { m1: 2, m2: 1 },
    { m1: 3, m2: 6 },
    { m1: 4, m2: 7 },
    { m1: 5, m2: 8 },
    { m1: 10, m2: 9 },
  ]},
  { week: 2, status: "completed", matchups: [
    { m1: 1, m2: 6 },
    { m1: 2, m2: 7 },
    { m1: 3, m2: 8 },
    { m1: 4, m2: 9 },
    { m1: 5, m2: 10 },
  ]},
  { week: 3, status: "active", matchups: [
    { m1: 6, m2: 7 },
    { m1: 1, m2: 8 },
    { m1: 2, m2: 9 },
    { m1: 3, m2: 10 },
    { m1: 4, m2: 5 },
  ]},
  { week: 4, status: "upcoming", matchups: [
    { m1: 1, m2: 3 },
    { m1: 2, m2: 4 },
    { m1: 5, m2: 6 },
    { m1: 7, m2: 9 },
    { m1: 8, m2: 10 },
  ]},
  { week: 5, status: "upcoming", matchups: [
    { m1: 1, m2: 4 },
    { m1: 2, m2: 3 },
    { m1: 5, m2: 7 },
    { m1: 6, m2: 10 },
    { m1: 8, m2: 9 },
  ]},
  { week: 6, status: "upcoming", matchups: [
    { m1: 1, m2: 5 },
    { m1: 2, m2: 6 },
    { m1: 3, m2: 9 },
    { m1: 4, m2: 8 },
    { m1: 7, m2: 10 },
  ]},
];

function defaultDb() {
  return {
    members: MEMBERS,
    schedule: SCHEDULE,
    submissions: [],
    judgments: [],
  };
}

// ─── Backup System ───────────────────────────────────────

function createBackup() {
  try {
    if (!fs.existsSync(DB_PATH)) return;
    const timestamp = new Date().toISOString().replace(/[:.]/g, "-");
    const backupPath = path.join(BACKUP_DIR, `db-${timestamp}.json`);
    fs.copyFileSync(DB_PATH, backupPath);

    // Prune old backups
    const backups = fs.readdirSync(BACKUP_DIR)
      .filter(f => f.startsWith("db-") && f.endsWith(".json"))
      .sort()
      .reverse();

    if (backups.length > MAX_BACKUPS) {
      backups.slice(MAX_BACKUPS).forEach(f => {
        fs.unlinkSync(path.join(BACKUP_DIR, f));
      });
    }
  } catch (err) {
    console.error("[DB] Backup failed:", err.message);
  }
}

function listBackups() {
  try {
    return fs.readdirSync(BACKUP_DIR)
      .filter(f => f.startsWith("db-") && f.endsWith(".json"))
      .sort()
      .reverse()
      .map(f => ({
        name: f,
        size: fs.statSync(path.join(BACKUP_DIR, f)).size,
      }));
  } catch {
    return [];
  }
}

function restoreBackup(backupName) {
  const backupPath = path.join(BACKUP_DIR, backupName);
  if (!fs.existsSync(backupPath)) return null;
  createBackup(); // backup current before restoring
  const data = fs.readFileSync(backupPath, "utf8");
  const db = JSON.parse(data);
  fs.writeFileSync(DB_PATH, JSON.stringify(db, null, 2), "utf8");
  console.log(`[DB] Restored from backup: ${backupName}`);
  return db;
}

// ─── Read / Write ─────────────────────────────────────────

function read() {
  try {
    return JSON.parse(fs.readFileSync(DB_PATH, "utf8"));
  } catch {
    console.log("[DB] No existing database found, creating default...");
    const db = defaultDb();
    write(db);
    return db;
  }
}

function write(db) {
  createBackup();
  fs.mkdirSync(path.dirname(DB_PATH), { recursive: true });
  fs.writeFileSync(DB_PATH, JSON.stringify(db, null, 2), "utf8");
}

// ─── Migration: copy from repo if volume is empty ────────

function migrateIfNeeded() {
  const repoDbPath = path.join(__dirname, "data", "db.json");
  if (!fs.existsSync(DB_PATH) && fs.existsSync(repoDbPath) && DATA_DIR !== path.join(__dirname, "data")) {
    console.log("[DB] Migrating data from repo to persistent volume...");
    const data = fs.readFileSync(repoDbPath, "utf8");
    fs.writeFileSync(DB_PATH, data, "utf8");
    console.log("[DB] Migration complete.");
  }
}

migrateIfNeeded();

// ─── Public API ───────────────────────────────────────────

module.exports = {
  getMembers: () => read().members,
  getMember: (id) => read().members.find((m) => m.id === id) || null,
  getSchedule: () => read().schedule,
  getWeek: (weekNum) => read().schedule.find((w) => w.week === weekNum) || null,

  getSubmission(week, memberId) {
    return read().submissions.find(
      (s) => s.week === week && s.memberId === memberId
    ) || null;
  },

  getSubmissionsForWeek(week) {
    return read().submissions.filter((s) => s.week === week);
  },

  upsertSubmission({ week, memberId, species, description, mediaFiles }) {
    const db = read();
    const idx = db.submissions.findIndex(
      (s) => s.week === week && s.memberId === memberId
    );
    const entry = {
      id: `sub-w${week}-m${memberId}`,
      week, memberId, species, description,
      mediaFiles: mediaFiles || [],
      submittedAt: new Date().toISOString(),
    };
    if (idx >= 0) {
      entry.resubmittedAt = new Date().toISOString();
      entry.previousSubmittedAt = db.submissions[idx].submittedAt;
      db.submissions[idx] = entry;
    } else {
      db.submissions.push(entry);
    }
    write(db);
    return entry;
  },

  deleteSubmission(week, memberId) {
    const db = read();
    db.submissions = db.submissions.filter(
      (s) => !(s.week === week && s.memberId === memberId)
    );
    write(db);
  },

  getJudgment(week, m1Id, m2Id) {
    return read().judgments.find(
      (j) => j.week === week && j.m1Id === m1Id && j.m2Id === m2Id
    ) || null;
  },

  getJudgmentsForWeek(week) {
    return read().judgments.filter((j) => j.week === week);
  },

  saveJudgment(judgment) {
    const db = read();
    const idx = db.judgments.findIndex(
      (j) => j.week === judgment.week && j.m1Id === judgment.m1Id && j.m2Id === judgment.m2Id
    );
    if (idx >= 0) {
      db.judgments[idx] = judgment;
    } else {
      db.judgments.push(judgment);
    }
    write(db);
    return judgment;
  },

  getStandings() {
    const db = read();
    const map = {};
    db.members.forEach((m) => {
      map[m.id] = { id: m.id, name: m.name, w: 0, l: 0 };
    });
    db.judgments.forEach((j) => {
      if (j.winner === "m1") {
        if (map[j.m1Id]) map[j.m1Id].w++;
        if (map[j.m2Id]) map[j.m2Id].l++;
      } else if (j.winner === "m2") {
        if (map[j.m2Id]) map[j.m2Id].w++;
        if (map[j.m1Id]) map[j.m1Id].l++;
      }
    });
    return Object.values(map).sort((a, b) => {
      if (b.w !== a.w) return b.w - a.w;
      return a.l - b.l;
    });
  },

  setWeekStatus(weekNum, status) {
    const db = read();
    const week = db.schedule.find((w) => w.week === weekNum);
    if (week) {
      week.status = status;
      write(db);
    }
    return week;
  },

  setWeekMatchups(weekNum, matchups) {
    const db = read();
    const week = db.schedule.find((w) => w.week === weekNum);
    if (week) {
      week.matchups = matchups;
      write(db);
    }
    return week;
  },

  // ── Backup API ─────────────────────────────────────
  listBackups,
  restoreBackup,
  getFullDb() { return read(); },
  replaceDb(newDb) { createBackup(); write(newDb); return newDb; },

  reset() {
    const db = defaultDb();
    write(db);
    return db;
  },
};
