/**
 * Bird League — AI Judging Module
 *
 * Reads prompt templates from /prompts/*.txt
 * Calls: OpenAI (ChatGPT) → Google (Gemini) → Anthropic (Claude)
 * Parses each response for a winner pick
 * Stores the full judgment in the database
 */

const fs = require("fs");
const path = require("path");
const https = require("https");
const db = require("./db");

const PROMPTS_DIR = path.join(__dirname, "prompts");

// ─── Load & fill prompt templates ──────────────────────────

function loadPrompt(filename) {
  return fs.readFileSync(path.join(PROMPTS_DIR, filename), "utf8");
}

function fillTemplate(template, vars) {
  let result = template;
  for (const [key, value] of Object.entries(vars)) {
    result = result.replace(new RegExp(`\\{\\{${key}\\}\\}`, "g"), value || "(none provided)");
  }
  return result;
}

// ─── HTTP helper (no dependencies) ─────────────────────────

function httpsPost(url, headers, body) {
  return new Promise((resolve, reject) => {
    const parsed = new URL(url);
    const options = {
      hostname: parsed.hostname,
      port: 443,
      path: parsed.pathname + parsed.search,
      method: "POST",
      headers: { "Content-Type": "application/json", ...headers },
    };
    const req = https.request(options, (res) => {
      let data = "";
      res.on("data", (chunk) => (data += chunk));
      res.on("end", () => {
        try {
          resolve({ status: res.statusCode, body: JSON.parse(data) });
        } catch {
          resolve({ status: res.statusCode, body: data });
        }
      });
    });
    req.on("error", reject);
    req.write(JSON.stringify(body));
    req.end();
  });
}

// ─── Parse which bird the judge picked ─────────────────────

function parsePick(responseText) {
  const lower = responseText.toLowerCase();
  // Look for explicit "BIRD 1" or "BIRD 2" near the start
  const first200 = lower.slice(0, 200);
  if (first200.includes("bird 1")) return "m1";
  if (first200.includes("bird 2")) return "m2";
  // Fallback: check anywhere
  const bird1Count = (lower.match(/bird 1/g) || []).length;
  const bird2Count = (lower.match(/bird 2/g) || []).length;
  if (bird1Count > bird2Count) return "m1";
  if (bird2Count > bird1Count) return "m2";
  return null; // Could not determine
}

function parseClaudePick(responseText, m1Species, m2Species) {
  const lower = responseText.toLowerCase();
  // Claude's ruling usually says "rules in favor of" or "finds in favor of"
  const favorMatch = lower.match(/(?:rules?|finds?|rules?)\s+in\s+favor\s+of\s+(?:the\s+)?(.+?)[\.\,\n]/);
  if (favorMatch) {
    const favored = favorMatch[1].toLowerCase();
    if (favored.includes(m1Species.toLowerCase())) return "m1";
    if (favored.includes(m2Species.toLowerCase())) return "m2";
  }
  // Check for "BIRD 1" / "BIRD 2"
  const first500 = lower.slice(0, 500);
  if (first500.includes("bird 1")) return "m1";
  if (first500.includes("bird 2")) return "m2";
  // Check which species is mentioned more in the final paragraph
  const paragraphs = responseText.split("\n\n");
  const lastPara = paragraphs[paragraphs.length - 1].toLowerCase();
  if (lastPara.includes(m1Species.toLowerCase()) && !lastPara.includes(m2Species.toLowerCase())) return "m1";
  if (lastPara.includes(m2Species.toLowerCase()) && !lastPara.includes(m1Species.toLowerCase())) return "m2";
  // Check for "the [species] wins" or "declared the cooler bird"
  if (lower.includes(m1Species.toLowerCase() + " wins") || lower.includes(m1Species.toLowerCase() + " is the cooler") || lower.includes(m1Species.toLowerCase() + " is hereby")) return "m1";
  if (lower.includes(m2Species.toLowerCase() + " wins") || lower.includes(m2Species.toLowerCase() + " is the cooler") || lower.includes(m2Species.toLowerCase() + " is hereby")) return "m2";
  return null;
}

// ─── API Callers ───────────────────────────────────────────

async function callChatGPT(prompt) {
  const apiKey = process.env.OPENAI_API_KEY;
  if (!apiKey) throw new Error("OPENAI_API_KEY not set");
  const res = await httpsPost("https://api.openai.com/v1/chat/completions", {
    Authorization: `Bearer ${apiKey}`,
  }, {
    model: "gpt-4o",
    messages: [{ role: "user", content: prompt }],
    max_tokens: 1000,
    temperature: 0.8,
  });
  if (res.status !== 200) throw new Error(`OpenAI error ${res.status}: ${JSON.stringify(res.body)}`);
  return res.body.choices[0].message.content;
}

async function callGemini(prompt) {
  const apiKey = process.env.GOOGLE_AI_API_KEY;
  if (!apiKey) throw new Error("GOOGLE_AI_API_KEY not set");
  const url = `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.0-flash:generateContent?key=${apiKey}`;
  const res = await httpsPost(url, {}, {
    contents: [{ parts: [{ text: prompt }] }],
    generationConfig: { temperature: 0.9, maxOutputTokens: 1000 },
  });
  if (res.status !== 200) throw new Error(`Gemini error ${res.status}: ${JSON.stringify(res.body)}`);
  return res.body.candidates[0].content.parts[0].text;
}

async function callClaude(prompt) {
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) throw new Error("ANTHROPIC_API_KEY not set");
  const res = await httpsPost("https://api.anthropic.com/v1/messages", {
    "x-api-key": apiKey,
    "anthropic-version": "2023-06-01",
  }, {
    model: "claude-sonnet-4-20250514",
    max_tokens: 2000,
    messages: [{ role: "user", content: prompt }],
  });
  if (res.status !== 200) throw new Error(`Anthropic error ${res.status}: ${JSON.stringify(res.body)}`);
  return res.body.content[0].text;
}

// ─── Main Judging Function ─────────────────────────────────

/**
 * Judge a single matchup.
 *
 * @param {number} week - Week number
 * @param {object} m1Sub - { memberId, species, description }
 * @param {object} m2Sub - { memberId, species, description }
 * @returns {object} Full judgment result
 */
async function judgeMatchup(week, m1Sub, m2Sub) {
  const m1Member = db.getMember(m1Sub.memberId);
  const m2Member = db.getMember(m2Sub.memberId);

  const vars = {
    M1_NAME: m1Member.name,
    M1_SPECIES: m1Sub.species,
    M1_DESCRIPTION: m1Sub.description,
    M2_NAME: m2Member.name,
    M2_SPECIES: m2Sub.species,
    M2_DESCRIPTION: m2Sub.description,
  };

  // Step 1: ChatGPT (rational)
  console.log(`  [ChatGPT] Judging ${m1Member.name} vs ${m2Member.name}...`);
  const chatgptPrompt = fillTemplate(loadPrompt("chatgpt.txt"), vars);
  const chatgptResponse = await callChatGPT(chatgptPrompt);
  const chatgptPick = parsePick(chatgptResponse);
  console.log(`  [ChatGPT] Picked: ${chatgptPick === "m1" ? m1Member.name : m2Member.name}`);

  // Step 2: Gemini (capricious)
  console.log(`  [Gemini] Judging ${m1Member.name} vs ${m2Member.name}...`);
  const geminiPrompt = fillTemplate(loadPrompt("gemini.txt"), vars);
  const geminiResponse = await callGemini(geminiPrompt);
  const geminiPick = parsePick(geminiResponse);
  console.log(`  [Gemini] Picked: ${geminiPick === "m1" ? m1Member.name : m2Member.name}`);

  // Step 3: Claude (synthesis) — sees both prior arguments
  console.log(`  [Claude] Delivering final ruling...`);
  const claudeVars = {
    ...vars,
    CHATGPT_ARGUMENT: chatgptResponse,
    GEMINI_ARGUMENT: geminiResponse,
  };
  const claudePrompt = fillTemplate(loadPrompt("claude.txt"), claudeVars);
  const claudeResponse = await callClaude(claudePrompt);
  const claudePick = parseClaudePick(claudeResponse, m1Sub.species, m2Sub.species);
  console.log(`  [Claude] Ruled: ${claudePick === "m1" ? m1Member.name : m2Member.name}`);

  // Step 4: Generate summary
  let summary = "";
  try {
    const winnerSpecies = claudePick === "m1" ? m1Sub.species : m2Sub.species;
    const winnerName = claudePick === "m1" ? m1Member.name : m2Member.name;
    const summaryVars = {
      WINNER_SPECIES: winnerSpecies,
      WINNER_NAME: winnerName,
      CLAUDE_RULING: claudeResponse,
    };
    const summaryPrompt = fillTemplate(loadPrompt("summary.txt"), summaryVars);
    summary = await callClaude(summaryPrompt);
  } catch (err) {
    console.warn("  [Summary] Failed to generate, using fallback:", err.message);
    const winnerSpecies = claudePick === "m1" ? m1Sub.species : m2Sub.species;
    summary = `The ${winnerSpecies} prevailed in this week's matchup.`;
  }

  // Build result
  const result = {
    id: `judgment-w${week}-${m1Sub.memberId}v${m2Sub.memberId}`,
    week,
    m1Id: m1Sub.memberId,
    m2Id: m2Sub.memberId,
    m1sub: { species: m1Sub.species, desc: m1Sub.description },
    m2sub: { species: m2Sub.species, desc: m2Sub.description },
    winner: claudePick,
    summary: summary.trim(),
    chatgpt: { pick: chatgptPick, argument: chatgptResponse },
    gemini: { pick: geminiPick, argument: geminiResponse },
    claude: { ruling: claudeResponse },
    judgedAt: new Date().toISOString(),
  };

  // Store in database
  db.saveJudgment(result);

  return result;
}

/**
 * Judge all matchups for a given week.
 * Only judges matchups where both players have submitted.
 */
async function judgeWeek(week) {
  const weekData = db.getWeek(week);
  if (!weekData) throw new Error(`Week ${week} not found`);

  const results = [];
  for (const matchup of weekData.matchups) {
    const m1Sub = db.getSubmission(week, matchup.m1);
    const m2Sub = db.getSubmission(week, matchup.m2);

    if (!m1Sub || !m2Sub) {
      console.log(`  Skipping ${matchup.m1} vs ${matchup.m2} — missing submission(s)`);
      continue;
    }

    // Check if already judged
    const existing = db.getJudgment(week, matchup.m1, matchup.m2);
    if (existing) {
      console.log(`  Already judged ${matchup.m1} vs ${matchup.m2}, skipping`);
      results.push(existing);
      continue;
    }

    const result = await judgeMatchup(week, m1Sub, m2Sub);
    results.push(result);
  }

  return results;
}

module.exports = { judgeMatchup, judgeWeek };
