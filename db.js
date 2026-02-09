/**
 * Bird League — JSON-file database layer
 *
 * All structured data in a single JSON file.
 * Media files stored on disk in /submissions.
 *
 * Judgment format (new):
 * {
 *   id, week, m1Id, m2Id,
 *   m1sub: { species, desc },
 *   m2sub: { species, desc },
 *   winner: "m1" | "m2",
 *   summary: "one-line summary",
 *   chatgpt: { pick: "m1"|"m2", argument: "..." },
 *   gemini:  { pick: "m1"|"m2", argument: "..." },
 *   claude:  { ruling: "..." },
 *   judgedAt: ISO string
 * }
 */

const fs = require("fs");
const path = require("path");

const DB_PATH = path.join(__dirname, "data", "db.json");

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
    { m1: 2, m2: 1 },   // Trevor & Katie vs Matthew
    { m1: 3, m2: 6 },   // Marshall vs Leo & Taylor
    { m1: 4, m2: 7 },   // Dara vs Jack
    { m1: 5, m2: 8 },   // Anna vs Emily
    { m1: 10, m2: 9 },  // Ben vs Grace
  ]},
  { week: 2, status: "completed", matchups: [
    { m1: 1, m2: 6 },   // Matthew vs Leo & Taylor
    { m1: 2, m2: 7 },   // Trevor & Katie vs Jack
    { m1: 3, m2: 8 },   // Marshall vs Emily
    { m1: 4, m2: 9 },   // Dara vs Grace
    { m1: 5, m2: 10 },  // Anna vs Ben
  ]},
  { week: 3, status: "active", matchups: [
    { m1: 6, m2: 7 },   // Leo & Taylor vs Jack
    { m1: 1, m2: 8 },   // Matthew vs Emily
    { m1: 2, m2: 9 },   // Trevor & Katie vs Grace
    { m1: 3, m2: 10 },  // Marshall vs Ben
    { m1: 4, m2: 5 },   // Dara vs Anna
  ]},
  { week: 4, status: "upcoming", matchups: [
    { m1: 1, m2: 3 },   // Matthew vs Marshall
    { m1: 2, m2: 4 },   // Trevor & Katie vs Dara
    { m1: 5, m2: 6 },   // Anna vs Leo & Taylor
    { m1: 7, m2: 9 },   // Jack vs Grace
    { m1: 8, m2: 10 },  // Emily vs Ben
  ]},
  { week: 5, status: "upcoming", matchups: [
    { m1: 1, m2: 4 },   // Matthew vs Dara
    { m1: 2, m2: 3 },   // Trevor & Katie vs Marshall
    { m1: 5, m2: 7 },   // Anna vs Jack
    { m1: 6, m2: 10 },  // Leo & Taylor vs Ben
    { m1: 8, m2: 9 },   // Emily vs Grace
  ]},
  { week: 6, status: "upcoming", matchups: [
    { m1: 1, m2: 5 },   // Matthew vs Anna
    { m1: 2, m2: 6 },   // Trevor & Katie vs Leo & Taylor
    { m1: 3, m2: 9 },   // Marshall vs Grace
    { m1: 4, m2: 8 },   // Dara vs Emily
    { m1: 7, m2: 10 },  // Jack vs Ben
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

// ─── Read / Write ─────────────────────────────────────────

function read() {
  try {
    return JSON.parse(fs.readFileSync(DB_PATH, "utf8"));
  } catch {
    const db = defaultDb();
    write(db);
    return db;
  }
}

function write(db) {
  fs.mkdirSync(path.dirname(DB_PATH), { recursive: true });
  fs.writeFileSync(DB_PATH, JSON.stringify(db, null, 2), "utf8");
}

// ─── Public API ───────────────────────────────────────────

module.exports = {
  getMembers: () => read().members,
  getMember: (id) => read().members.find((m) => m.id === id) || null,
  getSchedule: () => read().schedule,
  getWeek: (weekNum) => read().schedule.find((w) => w.week === weekNum) || null,

  // ── Submissions ──────────────────────────────────────

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

  // ── Judgments ────────────────────────────────────────

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

  // ── Standings (computed from judgments) ──────────────

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

  // ── Schedule Management ─────────────────────────────

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

  // ── Reset ──────────────────────────────────────────

  reset() {
    const db = defaultDb();
    write(db);
    return db;
  },
};
