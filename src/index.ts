import "dotenv/config";
import { App } from "@slack/bolt";
import Groq from "groq-sdk";

// ── Config ────────────────────────────────────────────────────────
const SLACK_BOT_TOKEN  = process.env.SLACK_BOT_TOKEN!;
const SLACK_APP_TOKEN  = process.env.SLACK_APP_TOKEN!;
const GROQ_API_KEY     = process.env.GROQ_API_KEY!;
const GITHUB_TOKEN     = process.env.GITHUB_TOKEN!;
const GITHUB_OWNER     = process.env.GITHUB_OWNER!;
const GITHUB_VAULT     = process.env.GITHUB_VAULT_REPO || "angadha-vault";
const MODEL            = process.env.GROQ_MODEL || "openai/gpt-oss-120b";

// Daily todo check-ins (optional). OWNER_SLACK_ID = your Slack member ID (Profile → ⋮ → Copy member ID)
const OWNER_SLACK_ID   = process.env.OWNER_SLACK_ID;           // enables the scheduled DMs
const EVENING_TIME     = process.env.EVENING_TIME || "21:00";   // IST, "how many tasks did you finish?"
const MORNING_TIME     = process.env.MORNING_TIME;              // IST, optional morning push (e.g. "07:30")

if (!SLACK_BOT_TOKEN || !SLACK_APP_TOKEN || !GROQ_API_KEY) {
  console.error("❌ Missing required env vars. Check .env file.");
  process.exit(1);
}

const groq = new Groq({ apiKey: GROQ_API_KEY });

// ── Slack App (Socket Mode — no public URL needed) ────────────────
const app = new App({
  token: SLACK_BOT_TOKEN,
  appToken: SLACK_APP_TOKEN,
  socketMode: true,
});

// ── IST date/time helpers ─────────────────────────────────────────
function istDate(offsetDays = 0): string {
  return new Date(Date.now() + 5.5 * 3600000 + offsetDays * 86400000).toISOString().split("T")[0];
}
function istTime(): string {
  return new Date(Date.now() + 5.5 * 3600000).toISOString().split("T")[1].substring(0, 5);
}

// ── GitHub Vault ──────────────────────────────────────────────────
// Vault structure:
//   Gym/YYYY-MM-DD.md   — daily workout log
//   Gym/progress.md     — PRs & body weight history
//   Ideas/content-ideas.md
//   Ideas/project-ideas.md
//   HackerNews/YYYY-MM-DD.md
//   Notes/YYYY-MM-DD.md
//   Todos/YYYY-MM-DD.md — daily task checklist + result line

const SAVE_FAILED = "⚠️ Couldn't write to your vault (GitHub rejected it — check GITHUB_TOKEN / repo name / rate limit). Nothing was saved.";

async function vaultRead(path: string): Promise<{ content: string; sha: string } | null> {
  if (!GITHUB_TOKEN) return null;
  const url = `https://api.github.com/repos/${GITHUB_OWNER}/${GITHUB_VAULT}/contents/${path}`;
  const res = await fetch(url, {
    headers: { Authorization: `token ${GITHUB_TOKEN}`, Accept: "application/vnd.github.v3+json" },
  });
  if (!res.ok) return null;
  const data: any = await res.json();
  return {
    content: Buffer.from(data.content, "base64").toString("utf-8"),
    sha: data.sha,
  };
}

async function vaultWrite(path: string, newLines: string, append = true): Promise<boolean> {
  if (!GITHUB_TOKEN) return false;
  const url = `https://api.github.com/repos/${GITHUB_OWNER}/${GITHUB_VAULT}/contents/${path}`;
  const existing = await vaultRead(path);
  const body = append && existing
    ? existing.content.trimEnd() + "\n" + newLines + "\n"
    : newLines + "\n";

  const res = await fetch(url, {
    method: "PUT",
    headers: {
      Authorization: `token ${GITHUB_TOKEN}`,
      Accept: "application/vnd.github.v3+json",
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      message: `Mastiska: update ${path}`,
      content: Buffer.from(body).toString("base64"),
      sha: existing?.sha,
    }),
  });
  return res.ok;
}

// Append an entry to a file, creating it with a header if it doesn't exist yet.
async function appendEntry(path: string, header: string, entry: string): Promise<boolean> {
  const existing = await vaultRead(path);
  return vaultWrite(path, existing ? entry : header + entry, !!existing);
}

// ── Groq ──────────────────────────────────────────────────────────
async function askGroq(system: string, user: string): Promise<string> {
  const c = await groq.chat.completions.create({
    model: MODEL,
    messages: [{ role: "system", content: system }, { role: "user", content: user }],
    max_tokens: 1500,
    temperature: 0.75,
  });
  return c.choices[0]?.message?.content ?? "No response.";
}

// ── Hacker News (Algolia free API) ───────────────────────────────
interface HNStory { objectID: string; title: string; url?: string; points: number; num_comments: number; author: string; created_at: string; }

const TOPIC_TO_HN: Record<string, string> = {
  ipo: "IPO stock listing offering", earnings: "earnings revenue quarterly results",
  rbi: "RBI india central bank interest rate", crypto: "crypto bitcoin ethereum blockchain",
  nifty: "india stock market nifty sensex", budget: "india budget fiscal policy",
  startup: "startup funding venture capital", forex: "forex currency exchange rupee",
  gold: "gold commodities price", fii: "foreign investment india FII",
  sector: "sector analysis industry", economy: "economy GDP inflation india",
};

async function fetchHN(query: string, limit = 5, minPoints = 30, days = 0): Promise<HNStory[]> {
  const filters = [`points>${minPoints}`];
  if (days) filters.push(`created_at_i>${Math.floor(Date.now() / 1000) - days * 86400}`);
  const url = `https://hn.algolia.com/api/v1/search?query=${encodeURIComponent(query)}&tags=story&hitsPerPage=${limit}&numericFilters=${filters.join(",")}`;
  const res = await fetch(url);
  if (!res.ok) throw new Error(`HN API ${res.status}`);
  return ((await res.json()) as any).hits ?? [];
}

// HN-only topics: `#hn #seed`. Add more here later (e.g. launch, layoffs, acquisition).
const HN_EXTRA: Record<string, { label: string; queries: string[]; minPoints: number; days: number }> = {
  seed: { label: "startups raising seed rounds (last 90 days)", queries: ["raises seed", "seed round"], minPoints: 5, days: 90 },
};

async function fetchHNExtra(cfg: { queries: string[]; minPoints: number; days: number }, limit = 6): Promise<HNStory[]> {
  const results = await Promise.all(cfg.queries.map(q => fetchHN(q, 10, cfg.minPoints, cfg.days)));
  const seen = new Map<string, HNStory>();
  results.flat().forEach(s => seen.set(s.objectID, s));
  return [...seen.values()].sort((a, b) => b.points - a.points).slice(0, limit);
}

function timeAgo(d: string): string {
  const h = Math.floor((Date.now() - new Date(d).getTime()) / 3_600_000);
  return h < 1 ? "just now" : h < 24 ? `${h}h ago` : `${Math.floor(h / 24)}d ago`;
}

function formatHN(stories: HNStory[], label: string): string {
  if (!stories.length) return `No HN stories found for *${label}* right now.`;
  const lines = [`🔥 *Top HN Stories — ${label}*\n`];
  stories.forEach((s, i) => {
    const hn = `https://news.ycombinator.com/item?id=${s.objectID}`;
    lines.push(`*${i + 1}. ${s.title}*`);
    lines.push(`⬆️ ${s.points} pts · 💬 ${s.num_comments} comments · ${timeAgo(s.created_at)}`);
    lines.push(s.url ? `📎 <${s.url}|Article>  |  🗣 <${hn}|HN Discussion>` : `🗣 <${hn}|HN Discussion>`);
    lines.push("");
  });
  lines.push("_Tip: add a format tag to generate content from the top story — e.g. `#hn #crypto #thread`_");
  return lines.join("\n");
}

// ── Content generation (Mastiska core) ───────────────────────────
const TOPIC_TAGS: Record<string, string> = {
  ipo:         "This is about an IPO. Cover: company background, IPO price, GMP if known, bull case, bear case.",
  earnings:    "This is about company earnings/results. Cover: revenue, profit, vs estimates, stock reaction.",
  rbi:         "This is about RBI or monetary policy. Cover: decision, market impact, what it means for investors.",
  crypto:      "This is about cryptocurrency. Be balanced. Include Indian regulatory angle where relevant.",
  nifty:       "This is about Nifty50/Sensex/Indian indices. Include sector performance and key movers.",
  budget:      "This is about the Union Budget. Cover: market impact, sectors that win/lose, investor takeaways.",
  startup:     "This is about the Indian startup ecosystem — funding, valuation, launches.",
  forex:       "This is about forex. Cover: INR movement, global factors, impact on exporters/importers.",
  gold:        "This is about gold/commodities. Cover: price move, why it matters, how to play it.",
  fii:         "This is about FII/DII activity. Cover: net flows, impact on market direction.",
  sector:      "This is a sector analysis. Cover: key players, tailwinds, headwinds, outlook.",
  economy:     "This is about macro — GDP, inflation, jobs. Cover: data meaning, market impact.",
};

const TRADE_TAGS: Record<string, string> = {
  bull: "Take a bullish angle. Focus on upside potential, catalysts, buy case.",
  bear: "Take a bearish angle. Focus on downside risks, red flags, caution.",
  breakout: "Analyze as a breakout. Key levels, volume, what success looks like.",
  support: "Focus on support levels — where buyers step in, what if it breaks.",
  resistance: "Focus on resistance levels — where sellers appear, breakout implications.",
  trend: "Analyze the trend — up/down/sideways, simple language.",
  volume: "Focus on volume — unusual volume, accumulation vs distribution.",
  momentum: "Focus on momentum — accelerating or slowing, near-term implications.",
  reversal: "Analyze as potential trend reversal — signals and confirmation.",
  swing: "Frame for swing traders — multi-day hold, entry/target/stoploss.",
  intraday: "Frame for intraday traders — key levels for the session.",
  longterm: "Frame for long-term investors — fundamentals, compounding.",
  dca: "Frame through DCA lens — is this a good asset to DCA into?",
  fundamentals: "Focus on fundamentals — revenue, margins, PE, debt, moat.",
  technical: "Focus on technicals — price action, key levels, chart patterns.",
  risk: "Focus on risk — what can go wrong, position sizing, stop loss.",
};

const FORMAT_PROMPTS: Record<string, string> = {
  thread:   "Write a Twitter/X thread (5-7 tweets, numbered 1/ 2/ 3/). Each under 280 chars. Punchy. End with CTA.",
  li:       "Write a LinkedIn post (150-300 words). Short paragraphs. First line is scroll-stopper. End with question.",
  linkedin: "Write a LinkedIn post (150-300 words). Short paragraphs. First line is scroll-stopper. End with question.",
  ig:       "Write an Instagram caption (100-150 words) + 15 hashtags. Conversational, story-driven.",
  instagram:"Write an Instagram caption (100-150 words) + 15 hashtags. Conversational, story-driven.",
  yt:       "Write a YouTube package:\nTitle: [under 60 chars]\nDescription: [150-word SEO]\nTags: [10 tags]",
  youtube:  "Write a YouTube package:\nTitle: [under 60 chars]\nDescription: [150-word SEO]\nTags: [10 tags]",
  all:      "Repurpose for all 4 platforms. Label each:\n🐦 TWITTER THREAD:\n💼 LINKEDIN:\n📸 INSTAGRAM:\n🎬 YOUTUBE:",
  repurpose:"Repurpose for all 4 platforms. Label each:\n🐦 TWITTER THREAD:\n💼 LINKEDIN:\n📸 INSTAGRAM:\n🎬 YOUTUBE:",
  score:    "Score this post out of 10.\nScore: X/10\nWhy: [2-3 specific reasons]\nImproved version: [full rewrite]\nBe brutally honest.",
  hook:     "Write 10 scroll-stopping opening lines. Different styles: stat, question, hot take, story, contrast, prediction. Number 1-10.",
  ideas:    "Give 5 content ideas. For each:\n[n]. Title\nPlatform: [best platform]\nAngle: [one line]\nHook: [opening line]",
  explain:  "Explain as a Twitter thread (5-6 tweets, 1/ 2/ 3/). One real-world analogy. No jargon. End with 'Save this 🔖'",
  story:    "Write a LinkedIn story post (150-250 words). Structure: Hook → What happened → Expected vs actual → Lesson. End with question.",
};

const BASE_STYLE = `
Style rules:
- Write like a sharp 22-year-old who understands markets — not a finance textbook
- Short sentences. Punchy. No filler words.
- Personal angle: student learning markets in public, paper trading, no real money yet
- Say "my take" / "I think" — not "experts suggest"
- Never say "as an AI"
- Use specific numbers when possible
- Not financial advice — learner's perspective always
`;

function parseTags(msg: string) {
  const tags = [...msg.matchAll(/#(\w+)/g)].map(m => m[1].toLowerCase());
  return {
    topicTags: tags.filter(t => t in TOPIC_TAGS),
    tradeTags: tags.filter(t => t in TRADE_TAGS),
    formatTag: tags.find(t => t in FORMAT_PROMPTS) ?? "thread",
    hasFormat: tags.some(t => t in FORMAT_PROMPTS),
    content: msg.replace(/#\w+/g, "").trim(),
    raw: tags,
  };
}

function buildContentPrompt(parsed: ReturnType<typeof parseTags>): string {
  const parts = ["You are Mastiska, an AI fintech content assistant for a student content creator.\n"];
  if (parsed.topicTags.length) {
    parts.push("TOPIC CONTEXT:");
    parsed.topicTags.forEach(t => parts.push(`• ${TOPIC_TAGS[t]}`));
    parts.push("");
  }
  if (parsed.tradeTags.length) {
    parts.push("TRADING ANGLE:");
    parsed.tradeTags.forEach(t => parts.push(`• ${TRADE_TAGS[t]}`));
    parts.push("");
  }
  parts.push("OUTPUT FORMAT:");
  parts.push(FORMAT_PROMPTS[parsed.formatTag]);
  parts.push(BASE_STYLE);
  return parts.join("\n");
}

// ── Todos (Todos/YYYY-MM-DD.md, markdown checkboxes) ─────────────
type Task = { done: boolean; text: string };
const TASK_LINE = /^- \[( |x)\] (.+)$/i;

function parseTasks(content: string): Task[] {
  const out: Task[] = [];
  for (const line of content.split("\n")) {
    const m = line.match(TASK_LINE);
    if (m) out.push({ done: m[1].toLowerCase() === "x", text: m[2] });
  }
  return out;
}

function formatTasks(tasks: Task[]): string {
  return tasks.map((t, i) => `${t.done ? "✅" : "⬜"} ${i + 1}. ${t.text}`).join("\n");
}

async function loadTasks(date: string): Promise<Task[]> {
  const f = await vaultRead(`Todos/${date}.md`);
  return f ? parseTasks(f.content) : [];
}

// Marks tasks done (by 1-based number), "all", or "none" (reset). Writes a Result line.
async function markDone(date: string, which: number[] | "all" | "none", undo = false) {
  const f = await vaultRead(`Todos/${date}.md`);
  if (!f) return null;
  let n = 0;
  const lines = f.content
    .split("\n")
    .filter(l => !l.startsWith("**Result:**"))
    .map(l => {
      const m = l.match(TASK_LINE);
      if (!m) return l;
      n++;
      const wasDone = m[1].toLowerCase() === "x";
      const done = which === "all" ? true : which === "none" ? false : undo ? wasDone && !which.includes(n) : wasDone || which.includes(n);
      return `- [${done ? "x" : " "}] ${m[2]}`;
    });
  const tasks = parseTasks(lines.join("\n"));
  if (!tasks.length) return null;
  const done = tasks.filter(t => t.done).length;
  const body = lines.join("\n").trimEnd() + `\n\n**Result:** ${done}/${tasks.length} done (${Math.round((done / tasks.length) * 100)}%)`;
  const ok = await vaultWrite(`Todos/${date}.md`, body, false);
  return { ok, done, total: tasks.length, tasks };
}

// ── Last response store (for #save) ──────────────────────────────
const lastAIResponse = new Map<string, string>(); // channelId → last response

// ── Help message ──────────────────────────────────────────────────
const HELP = `👋 *Mastiska — Your AI Second Brain*

*📝 Quick Log*
\`#note [text]\` → saves to Notes
\`#idea [text]\` → saves to Ideas/content-ideas
\`#project [text]\` → saves to Ideas/project-ideas

*🏋️ Gym*
\`#gym [workout details]\` → today's workout log
\`#gym #pr [lift] [weight]\` → logs a personal record
\`#gym #weight [kg]\` → logs body weight
\`#gym summary\` → shows this week

*✅ Todos*
\`#todo task one; task two\` → plan tomorrow's tasks
\`#todo #today task\` → add to today's list
\`#tasks\` → today's tasks (\`#tasks #tomorrow\` for tomorrow)
\`#done 1 3\` → mark tasks 1 and 3 done (\`#done all\` / \`#done none\`)
\`#undone 2\` → mark task 2 not done again
_Evening check-in DM asks how many you finished._

*📰 Hacker News*
\`#hn\` → top fintech stories right now
\`#hn #seed\` → startups raising seed rounds (last 90 days)
\`#hn #crypto\` → top crypto stories
\`#hn #startup #thread\` → content from top HN story

*✍️ Content Generation*
\`#nifty #breakout #thread [text]\` → Twitter thread
\`#ipo #bear #li [text]\` → LinkedIn post
\`#crypto #bull #hook [text]\` → 10 scroll-stopping hooks
\`#rbi #all [text]\` → all 4 platforms at once
\`#score [paste draft]\` → brutal 1-10 score + rewrite

*💾 Save*
\`#save\` → saves last response to Obsidian

*Topic tags:* \`#ipo\` \`#earnings\` \`#rbi\` \`#crypto\` \`#nifty\` \`#budget\` \`#startup\` \`#forex\` \`#gold\` \`#fii\` \`#sector\` \`#economy\`
*Format tags:* \`#thread\` \`#li\` \`#ig\` \`#yt\` \`#all\` \`#score\` \`#hook\` \`#ideas\` \`#explain\` \`#story\`
*Trade tags:* \`#bull\` \`#bear\` \`#breakout\` \`#swing\` \`#intraday\` \`#longterm\` \`#fundamentals\` \`#technical\` \`#risk\``;

// ── Core message handler ──────────────────────────────────────────
async function handleMessage(text: string, channelId: string, say: Function): Promise<void> {
  // Strip bot mention
  const clean = text.replace(/<@[A-Z0-9]+>/gi, "").trim();

  // Empty → help
  if (!clean) { await say(HELP); return; }

  const tags = clean.toLowerCase().match(/#\w+/g)?.map(t => t.slice(1)) ?? [];

  // ── #save ────────────────────────────────────────────────────────
  if (tags.includes("save")) {
    const last = lastAIResponse.get(channelId);
    if (!last) { await say("Nothing to save yet. Generate some content first."); return; }
    const date = istDate();
    const saved = await vaultWrite(`Notes/${date}.md`, `\n## Saved ${istTime()}\n\n${last}`);
    await say(saved ? `✅ Saved to Notes/${date}.md in your vault.` : "⚠️ Saved locally (GitHub vault not configured).");
    return;
  }

  // ── #todo — plan tasks (default: tomorrow; add #today for today) ──
  if (tags.includes("todo")) {
    const content = clean.replace(/#\w+/g, "").trim();
    const forToday = tags.includes("today");
    const date = istDate(forToday ? 0 : 1);
    const items = content.split(/\n|;/).map(s => s.trim()).filter(Boolean);
    if (!items.length) { await say("What are the tasks? Try `#todo gym; finish report; call mom` (use `#todo #today ...` for today)"); return; }
    const ok = await appendEntry(`Todos/${date}.md`, `# Tasks — ${date}\n\n`, items.map(t => `- [ ] ${t}`).join("\n"));
    if (!ok) { await say(SAVE_FAILED); return; }
    const tasks = await loadTasks(date);
    await say(`📝 Added to *${forToday ? "today" : "tomorrow"}'s* list (${date}):\n\n${formatTasks(tasks)}`);
    return;
  }

  // ── #done — mark today's tasks ───────────────────────────────────
  if (tags.includes("done") || tags.includes("undone")) {
    const undo = tags.includes("undone");
    const arg = clean.replace(/#\w+/g, "").trim().toLowerCase();
    let which: number[] | "all" | "none";
    if (arg === "all") which = undo ? "none" : "all";
    else if (arg === "none" || arg === "0") which = "none";
    else {
      which = (arg.match(/\d+/g) ?? []).map(Number);
      if (!which.length) { await say("Which tasks? Reply with task numbers: `#done 1 3`, or `#done all` / `#done none`"); return; }
    }
    const res = await markDone(istDate(), which, undo);
    if (!res) { await say("No tasks found for today. Add some with `#todo #today task one; task two`"); return; }
    if (!res.ok) { await say(SAVE_FAILED); return; }
    const left = res.total - res.done;
    await say(`📊 *${res.done}/${res.total} done today*\n\n${formatTasks(res.tasks)}\n\n${left ? `${left} left — plan tomorrow with \`#todo ...\`` : "🎉 Clean sweep! Plan tomorrow with `#todo ...`"}`);
    return;
  }

  // ── #tasks / #today / #tomorrow — show list ──────────────────────
  if (tags.some(t => ["tasks", "today", "tomorrow"].includes(t)) || /\b(today'?s|tomorrow'?s)\s+(tasks?|todos?)\b/i.test(clean)) {
    const tomorrow = tags.includes("tomorrow") || /tomorrow'?s/i.test(clean);
    const date = istDate(tomorrow ? 1 : 0);
    const tasks = await loadTasks(date);
    await say(tasks.length
      ? `📋 *${tomorrow ? "Tomorrow" : "Today"}'s tasks* (${date})\n\n${formatTasks(tasks)}`
      : `No tasks for ${tomorrow ? "tomorrow" : "today"} yet. Add some: \`#todo ${tomorrow ? "" : "#today "}task one; task two\``);
    return;
  }

  // ── #note ────────────────────────────────────────────────────────
  if (tags.includes("note")) {
    const content = clean.replace(/#\w+/g, "").trim();
    if (!content) { await say("What do you want to note? Try `#note [your text]`"); return; }
    const date = istDate();
    const ok = await appendEntry(`Notes/${date}.md`, `# Daily Notes — ${date}\n`, `\n### ${istTime()}\n${content}`);
    await say(ok ? `✅ Note saved to *Notes/${date}.md*` : SAVE_FAILED);
    return;
  }

  // ── #gym ─────────────────────────────────────────────────────────
  if (tags.includes("gym")) {
    const content = clean.replace(/#\w+/g, "").trim();
    const date = istDate();

    if (tags.includes("pr")) {
      const ok = await appendEntry("Gym/progress.md", `# Gym Progress\n\n## Personal Records\n`, `- **PR** | ${istTime()} | ${content}`);
      await say(ok ? `🏆 PR logged to *Gym/progress.md* → ${content}` : SAVE_FAILED);
      return;
    }

    if (tags.includes("weight")) {
      const ok = await appendEntry("Gym/progress.md", `# Gym Progress\n\n## Body Weight Log\n`, `- **Weight** | ${date} | ${content}`);
      await say(ok ? `⚖️ Weight logged → ${content}` : SAVE_FAILED);
      return;
    }

    if (content.toLowerCase() === "summary") {
      const existing = await vaultRead("Gym/progress.md");
      if (!existing) { await say("No gym logs yet. Start with `#gym [workout]`"); return; }
      const summary = await askGroq(
        "You are a fitness assistant. Summarize the user's gym progress from their log. Be encouraging and specific. Keep it under 150 words.",
        existing.content
      );
      await say(`📊 *Gym Summary*\n\n${summary}`);
      return;
    }

    // Regular workout log
    const ok = await appendEntry(`Gym/${date}.md`, `# Workout — ${date}\n`, `\n### ${istTime()}\n${content || "Workout logged"}`);
    await say(ok ? `💪 Workout logged to *Gym/${date}.md*` : SAVE_FAILED);
    return;
  }

  // ── #idea ────────────────────────────────────────────────────────
  if (tags.includes("idea")) {
    const content = clean.replace(/#\w+/g, "").trim();
    if (!content) { await say("What's the idea? Try `#idea [your idea]`"); return; }
    const ok = await appendEntry("Ideas/content-ideas.md", `# Content Ideas\n\n`, `- [ ] ${content}  _(${istDate()} ${istTime()})_`);
    await say(ok ? `💡 Idea saved to *Ideas/content-ideas.md*` : SAVE_FAILED);
    return;
  }

  // ── #project ─────────────────────────────────────────────────────
  if (tags.includes("project")) {
    const content = clean.replace(/#\w+/g, "").trim();
    if (!content) { await say("What's the project idea? Try `#project [your idea]`"); return; }
    const ok = await appendEntry("Ideas/project-ideas.md", `# Project Ideas\n\n`, `- [ ] ${content}  _(${istDate()} ${istTime()})_`);
    await say(ok ? `🚀 Project idea saved to *Ideas/project-ideas.md*` : SAVE_FAILED);
    return;
  }

  // ── #hn ──────────────────────────────────────────────────────────
  if (tags.includes("hn")) {
    const parsed = parseTags(clean);
    const topicTag = parsed.topicTags[0];
    const extra = Object.keys(HN_EXTRA).map(k => (tags.includes(k) ? HN_EXTRA[k] : null)).find(Boolean);
    const label = extra ? extra.label : topicTag ? `#${topicTag}` : "fintech";
    const query = topicTag ? TOPIC_TO_HN[topicTag] : "fintech startup technology india";

    await say("🔍 Fetching from Hacker News...");

    try {
      const stories = extra ? await fetchHNExtra(extra) : await fetchHN(query);
      const storiesMsg = formatHN(stories, label);

      // If #save included, write to vault
      if (tags.includes("save") && stories.length) {
        const date = istDate();
        const header = `# HN Stories — ${date}\n\n`;
        const content = stories.map((s, i) => {
          const hn = `https://news.ycombinator.com/item?id=${s.objectID}`;
          return `## ${i + 1}. ${s.title}\n- Score: ${s.points} pts | ${s.num_comments} comments\n- ${s.url ? `[Article](${s.url}) | ` : ""}[HN](${hn})\n`;
        }).join("\n");
        const existing = await vaultRead(`HackerNews/${date}.md`);
        await vaultWrite(`HackerNews/${date}.md`, existing ? content : header + content, !!existing);
      }

      // If format tag present, generate content from top story
      if (stories.length && parsed.hasFormat) {
        const top = stories[0];
        const storyCtx = `Title: "${top.title}"\nURL: ${top.url ?? "N/A"}\nHN Score: ${top.points} pts | ${top.num_comments} comments\nThis is a REAL trending story on Hacker News right now. Use it as your source.`;
        const aiResponse = await askGroq(buildContentPrompt(parsed), storyCtx);
        lastAIResponse.set(channelId, aiResponse);
        await say(storiesMsg);
        await say(`✍️ *Content based on top story:*\n\n${aiResponse}`);
      } else {
        await say(storiesMsg);
      }
    } catch (err) {
      await say(`❌ HN fetch failed: ${err instanceof Error ? err.message : "unknown"}`);
    }
    return;
  }

  // ── Content generation (fintech tags) ────────────────────────────
  const parsed = parseTags(clean);
  const hasFintech = parsed.topicTags.length > 0 || parsed.tradeTags.length > 0 || parsed.hasFormat;

  if (hasFintech || parsed.content) {
    const prompt = buildContentPrompt(parsed);
    await say("✍️ Working on it...");
    try {
      const response = await askGroq(prompt, parsed.content || "Create content based on the context.");
      lastAIResponse.set(channelId, response);
      await say(response);
    } catch (err) {
      await say(`❌ Error: ${err instanceof Error ? err.message : "unknown"}`);
    }
    return;
  }

  await say(HELP);
}

// ── Slack event listeners ─────────────────────────────────────────

// Mentioned in a channel: @HermesOG #nifty #thread ...
app.event("app_mention", async ({ event, say }) => {
  try {
    await handleMessage(event.text, event.channel, say);
  } catch (err) {
    console.error("[Mastiska] Error:", err);
  }
});

// Direct message: just type the command, no mention needed
app.message(async ({ message, say }) => {
  const msg = message as any;
  if (msg.subtype || msg.bot_id) return; // ignore bot messages
  try {
    await handleMessage(msg.text ?? "", msg.channel, say);
  } catch (err) {
    console.error("[Mastiska] DM error:", err);
  }
});

// ── Scheduled DMs (evening check-in, optional morning list) ───────
const firedSlots = new Set<string>();
const toMin = (hhmm: string) => { const [h, m] = hhmm.split(":").map(Number); return h * 60 + m; };

async function dmOwner(text: string) {
  await app.client.chat.postMessage({ channel: OWNER_SLACK_ID!, text });
}

async function runScheduler() {
  const date = istDate();
  const now = toMin(istTime());
  // Due if within 2 hours after the target time and not yet sent today (survives short restarts)
  const due = (slot: string, at?: string) => {
    if (!at) return false;
    const diff = now - toMin(at);
    return diff >= 0 && diff < 120 && !firedSlots.has(`${date}-${slot}`);
  };

  if (due("morning", MORNING_TIME)) {
    firedSlots.add(`${date}-morning`);
    const tasks = await loadTasks(date);
    await dmOwner(tasks.length
      ? `☀️ *Good morning! Today's tasks*\n\n${formatTasks(tasks)}`
      : "☀️ Good morning! No tasks planned for today. Add some: `#todo #today task one; task two`");
  }

  if (due("evening", EVENING_TIME)) {
    firedSlots.add(`${date}-evening`);
    const tasks = await loadTasks(date);
    if (!tasks.length) {
      await dmOwner("🌙 No tasks were planned today. Plan tomorrow: `#todo task one; task two`");
    } else if (tasks.every(t => t.done)) {
      await dmOwner(`🌙 All ${tasks.length} tasks done today — nice. Plan tomorrow with \`#todo ...\``);
    } else {
      await dmOwner(`🌙 *Evening check-in* — ${tasks.length} tasks today:\n\n${formatTasks(tasks)}\n\nHow many did you finish? Reply \`#done 1 3\` (task numbers), \`#done all\` or \`#done none\`.\nThen plan tomorrow: \`#todo task one; task two\``);
    }
  }
}

// ── Health check server (cloud hosts expect an open port + uptime pinger hits it) ──
import { createServer } from "http";
createServer((_req, res) => { res.writeHead(200); res.end("Mastiska is running"); })
  .listen(Number(process.env.PORT) || 8000);

// ── Boot ──────────────────────────────────────────────────────────
(async () => {
  await app.start();

  if (OWNER_SLACK_ID) {
    setInterval(() => runScheduler().catch(e => console.error("[Mastiska] Scheduler error:", e)), 30_000);
    console.log(`⏰ Check-ins on: evening ${EVENING_TIME} IST${MORNING_TIME ? `, morning ${MORNING_TIME} IST` : ""}`);
  } else {
    console.log("ℹ️ OWNER_SLACK_ID not set — scheduled check-ins disabled.");
  }

  console.log(`
╔══════════════════════════════════════════╗
║   Mastiska — AI Second Brain             ║
║   Slack + Groq + Obsidian Vault          ║
╠══════════════════════════════════════════╣
║   Socket Mode: ✅ Connected              ║
║   Vault:       GitHub → Obsidian         ║
╚══════════════════════════════════════════╝
`);
})();
