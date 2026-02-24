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

function parsePick(responseText, m1Species, m2Species) {
  // Primary: check for "WINNER: SUBMISSION 1" or "WINNER: SUBMISSION 2"
  const winnerMatch = responseText.match(/WINNER:\s*SUBMISSION\s*(\d)/i);
  if (winnerMatch) {
    if (winnerMatch[1] === "1") return "m1";
    if (winnerMatch[1] === "2") return "m2";
  }

  // Fallback: species name matching
  const lower = responseText.toLowerCase();
  const m1Base = m1Species.toLowerCase().replace(/\s*\(.*?\)\s*/g, "").trim();
  const m2Base = m2Species.toLowerCase().replace(/\s*\(.*?\)\s*/g, "").trim();

  const first200 = lower.slice(0, 200);
  if (first200.includes(m1Base + " is the cooler")) return "m1";
  if (first200.includes(m2Base + " is the cooler")) return "m2";

  console.log("  [WARNING] Could not parse pick from response");
  return null;
}

function parseClaudePick(responseText, m1Species, m2Species) {
  // Primary: check for "WINNER: SUBMISSION 1" or "WINNER: SUBMISSION 2"
  const winnerMatch = responseText.match(/WINNER:\s*SUBMISSION\s*(\d)/i);
  if (winnerMatch) {
    if (winnerMatch[1] === "1") return "m1";
    if (winnerMatch[1] === "2") return "m2";
  }

  // Fallback: species name matching
  const lower = responseText.toLowerCase();
  const m1Base = m1Species.toLowerCase().replace(/\s*\(.*?\)\s*/g, "").trim();
  const m2Base = m2Species.toLowerCase().replace(/\s*\(.*?\)\s*/g, "").trim();

  // Check "rules/finds in favor of"
  const favorMatch = lower.match(/(?:rules?|finds?)\s+in\s+favor\s+of\s+(?:the\s+)?(.+?)[\.\\,\n]/);
  if (favorMatch) {
    const favored = favorMatch[1].toLowerCase();
    if (favored.includes(m1Base) || m1Base.includes(favored)) return "m1";
    if (favored.includes(m2Base) || m2Base.includes(favored)) return "m2";
  }

  console.log("  [WARNING] Could not parse Claude's pick from response");
  return null;
}

// ─── API Callers ───────────────────────────────────────────

async function callChatGPT(prompt, images) {
  const apiKey = process.env.OPENAI_API_KEY;
  if (!apiKey) throw new Error("OPENAI_API_KEY not set");

  // Build content array: labeled images + text
  const content = [];
  if (images && images.length > 0) {
    for (const img of images) {
      content.push({ type: "text", text: `[Photo from ${img.label}'s submission:]` });
      content.push({ type: "image_url", image_url: { url: `data:${img.mime};base64,${img.base64}` } });
    }
  }
  content.push({ type: "text", text: prompt });

  const res = await httpsPost("https://api.openai.com/v1/chat/completions", {
    Authorization: `Bearer ${apiKey}`,
  }, {
    model: "o4-mini",
    messages: [{ role: "user", content }],
  });
  if (res.status !== 200) throw new Error(`OpenAI error ${res.status}: ${JSON.stringify(res.body)}`);
  return res.body.choices[0].message.content;
}

async function callGemini(prompt, images) {
  const apiKey = process.env.GOOGLE_AI_API_KEY;
  if (!apiKey) throw new Error("GOOGLE_AI_API_KEY not set");
  const url = `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.0-flash:generateContent?key=${apiKey}`;

  const parts = [];
  if (images && images.length > 0) {
    for (const img of images) {
      parts.push({ text: `[Photo from ${img.label}'s submission:]` });
      parts.push({ inline_data: { mime_type: img.mime, data: img.base64 } });
    }
  }
  parts.push({ text: prompt });

  const res = await httpsPost(url, {}, {
    contents: [{ parts }],
    generationConfig: { temperature: 0.9, maxOutputTokens: 1000 },
  });
  if (res.status !== 200) throw new Error(`Gemini error ${res.status}: ${JSON.stringify(res.body)}`);
  return res.body.candidates[0].content.parts[0].text;
}

async function callClaude(prompt, images) {
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) throw new Error("ANTHROPIC_API_KEY not set");

  // Build content array: labeled images, then text
  const content = [];
  if (images && images.length > 0) {
    for (const img of images) {
      content.push({ type: "text", text: `[Photo from ${img.label}'s submission:]` });
      content.push({ type: "image", source: { type: "base64", media_type: img.mime, data: img.base64 } });
    }
  }
  content.push({ type: "text", text: prompt });

  const res = await httpsPost("https://api.anthropic.com/v1/messages", {
    "x-api-key": apiKey,
    "anthropic-version": "2023-06-01",
  }, {
    model: "claude-sonnet-4-20250514",
    max_tokens: 2000,
    messages: [{ role: "user", content }],
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

  // Load submission images from disk
  const DATA_DIR = process.env.RAILWAY_VOLUME_MOUNT_PATH || path.join(__dirname, "data");
  const MEDIA_DIR = path.join(DATA_DIR, "submissions");
  const images = [];

  function loadImages(sub, label) {
    if (!sub.mediaFiles || sub.mediaFiles.length === 0) return;
    for (const mediaUrl of sub.mediaFiles) {
      // mediaUrl looks like "/api/media/3/1/filename.jpeg"
      const parts = mediaUrl.split("/");
      const weekDir = `week-${parts[3]}`;
      const memberDir = parts[4];
      const filename = parts[5];
      const filePath = path.join(MEDIA_DIR, weekDir, memberDir, filename);
      const ext = path.extname(filename).toLowerCase();

      // Only include images, skip videos (too large for API)
      if (![".jpg", ".jpeg", ".png", ".gif", ".webp"].includes(ext)) continue;

      try {
        if (fs.existsSync(filePath)) {
          const data = fs.readFileSync(filePath);
          const mimeTypes = { ".jpg": "image/jpeg", ".jpeg": "image/jpeg", ".png": "image/png", ".gif": "image/gif", ".webp": "image/webp" };
          images.push({
            base64: data.toString("base64"),
            mime: mimeTypes[ext] || "image/jpeg",
            label,
          });
          console.log(`  Loaded image for ${label}: ${filename} (${(data.length / 1024).toFixed(0)}KB)`);
        }
      } catch (err) {
        console.log(`  Warning: Could not load image ${filePath}: ${err.message}`);
      }
    }
  }

  loadImages(m1Sub, m1Member.name);
  loadImages(m2Sub, m2Member.name);
  console.log(`  Total images loaded: ${images.length}`);

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
  console.log("  [ChatGPT PROMPT]:", chatgptPrompt.substring(0, 2000));
  const chatgptResponse = await callChatGPT(chatgptPrompt, images);
  console.log("  [ChatGPT RESPONSE]:", chatgptResponse.substring(0, 1000));
  const chatgptPick = parsePick(chatgptResponse, m1Sub.species, m2Sub.species);
  console.log(`  [ChatGPT] Picked: ${chatgptPick === "m1" ? m1Member.name : m2Member.name}`);

  // Step 2: Gemini (capricious) — falls back to ChatGPT if no Gemini key
  console.log(`  [Gemini] Judging ${m1Member.name} vs ${m2Member.name}...`);
  const geminiPrompt = fillTemplate(loadPrompt("gemini.txt"), vars);
  console.log("  [Gemini PROMPT]:", geminiPrompt.substring(0, 2000));
  let geminiResponse;
  if (process.env.GOOGLE_AI_API_KEY) {
    try {
      geminiResponse = await callGemini(geminiPrompt, images);
    } catch (err) {
      console.log(`  [Gemini] Failed (${err.message}), falling back to ChatGPT...`);
      geminiResponse = await callChatGPT(geminiPrompt, images);
    }
  } else {
    console.log(`  [Gemini] No API key, using ChatGPT as fallback...`);
    geminiResponse = await callChatGPT(geminiPrompt, images);
  }
  const geminiPick = parsePick(geminiResponse, m1Sub.species, m2Sub.species);
  console.log(`  [Gemini] Picked: ${geminiPick === "m1" ? m1Member.name : m2Member.name}`);

  // Strip WINNER lines from display text
  const chatgptArgument = chatgptResponse.replace(/\n*WINNER:.*$/i, "").trim();
  const geminiArgument = geminiResponse.replace(/\n*WINNER:.*$/i, "").trim();

  // Step 3: Claude (synthesis) — sees both prior arguments (without WINNER lines)
  console.log(`  [Claude] Delivering final ruling...`);
  const claudeVars = {
    ...vars,
    CHATGPT_ARGUMENT: chatgptArgument,
    GEMINI_ARGUMENT: geminiArgument,
  };
  const claudePrompt = fillTemplate(loadPrompt("claude.txt"), claudeVars);
  console.log("  [Claude PROMPT]:", claudePrompt.substring(0, 3000));
  const claudeResponse = await callClaude(claudePrompt, images);
  const claudePick = parseClaudePick(claudeResponse, m1Sub.species, m2Sub.species);
  // Strip the WINNER: line from the display text
  const claudeRuling = claudeResponse.replace(/\n*WINNER:.*$/i, "").trim();
  console.log(`  [Claude] Ruled: ${claudePick === "m1" ? m1Member.name : claudePick === "m2" ? m2Member.name : "UNKNOWN"} (${claudePick})`);
  if (!claudePick) console.log(`  [WARNING] Could not parse Claude's pick! Response ends with: ${claudeResponse.slice(-100)}`);

  // Step 4: Generate summary
  let summary = "";
  try {
    const winnerSpecies = claudePick === "m1" ? m1Sub.species : m2Sub.species;
    const winnerName = claudePick === "m1" ? m1Member.name : m2Member.name;
    const summaryVars = {
      WINNER_SPECIES: winnerSpecies,
      WINNER_NAME: winnerName,
      CLAUDE_RULING: claudeRuling,
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
    chatgpt: { pick: chatgptPick, argument: chatgptArgument },
    gemini: { pick: geminiPick, argument: geminiArgument },
    claude: { ruling: claudeRuling },
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
