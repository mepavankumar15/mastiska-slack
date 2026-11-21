import "dotenv/config";
import { App } from "@slack/bolt";
import Groq from "groq-sdk";
import { gunzipSync } from "zlib";

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
const HN_DIGEST_TIME   = process.env.HN_DIGEST_TIME || "10:00"; // IST, daily HN tech + markets digest ("off" to disable)
const WEEKLY_REVIEW_TIME = process.env.WEEKLY_REVIEW_TIME || "19:00"; // IST, every Sunday ("off" to disable)

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
//   Expenses/YYYY-MM.md — one line per expense
//   Habits/YYYY-MM.md   — one line per habit log
//   Links/reading-list.md — saved links with AI summary
//   Reminders/reminders.md — pending (- [ ]) and fired (- [x]) reminders
//   Reviews/YYYY-MM-DD.md — weekly reviews

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
  if (res.ok) snapCache = null; // vault changed → drop the cached snapshot
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

// Current HN front page (what's trending right now)
async function fetchHNFront(limit = 5): Promise<HNStory[]> {
  const res = await fetch(`https://hn.algolia.com/api/v1/search?tags=front_page&hitsPerPage=${limit}`);
  if (!res.ok) throw new Error(`HN API ${res.status}`);
  return ((await res.json()) as any).hits ?? [];
}

// Markets stories from the last 2 days
const HN_MARKET_CFG = { queries: ["stock market", "inflation fed rates", "earnings", "IPO", "bitcoin", "economy"], minPoints: 10, days: 2 };

function formatHN(stories: HNStory[], label: string, showTip = true): string {
  if (!stories.length) return `No HN stories found for *${label}* right now.`;
  const lines = [`🔥 *Top HN Stories — ${label}*\n`];
  stories.forEach((s, i) => {
    const hn = `https://news.ycombinator.com/item?id=${s.objectID}`;
    lines.push(`*${i + 1}. ${s.title}*`);
    lines.push(`⬆️ ${s.points} pts · 💬 ${s.num_comments} comments · ${timeAgo(s.created_at)}`);
    lines.push(s.url ? `📎 <${s.url}|Article>  |  🗣 <${hn}|HN Discussion>` : `🗣 <${hn}|HN Discussion>`);
    lines.push("");
  });
  if (showTip) lines.push("_Tip: add a format tag to generate content from the top story — e.g. `#hn #crypto #thread`_");
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
// Muscle group tags for gym categorization
const MUSCLE_GROUPS: Record<string, string> = {
  chest: "Chest & Triceps", "chest&tricep": "Chest & Triceps", "chest&triceps": "Chest & Triceps",
  back: "Back & Biceps", "back&bicep": "Back & Biceps", "back&biceps": "Back & Biceps",
  legs: "Legs", leg: "Legs",
  fullbody: "Full Body", full: "Full Body",
  shoulders: "Shoulders", shoulder: "Shoulders",
  arms: "Arms", arm: "Arms",
  core: "Core", cardio: "Cardio",
};

const HELP = `👋 *Mastiska — Your AI Second Brain*

Type \`#?\` or \`#help\` anytime to see this menu.

*📝 Quick Note*
Just type anything (no tag) → saved to today's Notes file
\`#note [text]\` → same thing, explicit
\`#idea [text]\` → saves to Ideas/content-ideas
\`#project [text]\` → saves to Ideas/project-ideas

*🏋️ Gym*
\`#gym [workout details]\` → today's workout log
\`#gym #chest bench 80kg 4x8\` → log workout by muscle group
_Muscle groups: \`#chest\` · \`#back\` · \`#legs\` · \`#fullbody\` · \`#shoulders\` · \`#arms\` · \`#core\` · \`#cardio\`_
\`#gym show chest\` → view only chest workouts this week
\`#gym #pr [lift] [weight]\` → logs a personal record
\`#gym #weight [kg]\` → logs body weight
\`#gym show\` / \`#gym yesterday\` / \`#gym week\` → view logs
\`#gym 2026-11-12\` → view a specific date
\`#gym summary\` → AI summary of PRs & weight

*✅ Todos*
\`#todo task one; task two\` → plan tomorrow's tasks
\`#todo #today task\` → add to today's list
\`#tasks\` → today's tasks (\`#tasks #tomorrow\` for tomorrow)
\`#done 1 3\` → mark tasks 1 and 3 done (\`#done all\` / \`#done none\`)
\`#undone 2\` → mark task 2 not done again
\`#carry\` → move today's unfinished tasks to tomorrow
_Evening check-in DM asks how many you finished._

*🧠 Second brain*
\`#find pricing idea\` → search your whole vault
\`#spend 250 food lunch\` → log expense (\`#spend month\` · \`week\` · \`undo\`)
\`#remind 5pm call mom\` → DM reminder (\`tomorrow 9am …\`, \`in 30m …\`, \`#remind list\`)
\`#habit water 3L\` → log habit (\`#habit week\` for streaks)
Paste a link (or \`#link url\`) → reading list with AI summary
\`#clean [rambling text]\` → tidy bullets, saved to Notes
\`#review\` → weekly review now (auto every Sunday evening)

*⚡ Prefixes:* \`i:\` idea · \`p:\` project · \`g:\` gym · \`n:\` note · \`t:\` todo · \`d:\` done · \`s:\` spend · \`r:\` remind · \`f:\` find · \`l:\` link · \`c:\` clean · \`h:\` habit

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

// ═══════════════════════════════════════════════════════════════════
//  Second-brain extras: vault snapshot + search, expenses, habits,
//  reminders, link saver, weekly review
// ═══════════════════════════════════════════════════════════════════
const errMsg = (e: unknown) => (e instanceof Error ? e.message : "unknown");

// AI answers are markdown; Slack wants *bold* and "•" bullets
function toSlack(md: string): string {
  return md
    .replace(/\*\*(.+?)\*\*/g, "*$1*")
    .replace(/^#{1,6}\s+(.+)$/gm, "*$1*")
    .replace(/^\s*[-*]\s+/gm, "• ");
}

// ── Vault snapshot: the whole repo in ONE request (tarball) ───────
let snapCache: { at: number; files: Map<string, string> } | null = null;

function parseTar(buf: Buffer): Map<string, string> {
  const files = new Map<string, string>();
  let off = 0;
  let nextName: string | null = null;
  while (off + 512 <= buf.length) {
    const header = buf.subarray(off, off + 512);
    if (header.every(b => b === 0)) break;
    const str = (s: number, e: number) => header.toString("utf8", s, e).replace(/\0[\s\S]*$/, "");
    let name = str(0, 100);
    const prefix = str(345, 500);
    if (prefix) name = `${prefix}/${name}`;
    const size = parseInt(str(124, 136).trim() || "0", 8);
    const type = String.fromCharCode(header[156]);
    off += 512;
    const data = buf.subarray(off, off + size);
    off += Math.ceil(size / 512) * 512;
    if (type === "x") { // pax header: carries the real name of the next entry
      const m = data.toString("utf8").match(/\d+ path=([^\n]+)\n/);
      if (m) nextName = m[1];
      continue;
    }
    if (type === "g") continue; // global pax header (commit id)
    const full = nextName ?? name;
    nextName = null;
    if ((type === "0" || type === "\0") && full.endsWith(".md")) {
      const path = full.split("/").slice(1).join("/"); // drop "owner-repo-sha/" folder
      if (path && !path.split("/").some(seg => seg.startsWith("."))) files.set(path, data.toString("utf8"));
    }
  }
  return files;
}

async function loadVault(maxAgeMs = 30_000): Promise<Map<string, string>> {
  if (snapCache && Date.now() - snapCache.at < maxAgeMs) return snapCache.files;
  if (!GITHUB_TOKEN) return new Map();
  const res = await fetch(`https://api.github.com/repos/${GITHUB_OWNER}/${GITHUB_VAULT}/tarball`, {
    headers: { Authorization: `token ${GITHUB_TOKEN}`, Accept: "application/vnd.github+json" },
  });
  if (!res.ok) throw new Error(`GitHub tarball ${res.status}`);
  const files = parseTar(gunzipSync(Buffer.from(await res.arrayBuffer())));
  snapCache = { at: Date.now(), files };
  return files;
}

// ── #find ─────────────────────────────────────────────────────────
async function findInVault(query: string): Promise<string> {
  const files = await loadVault(0);
  const words = query.toLowerCase().split(/\s+/).filter(Boolean);
  const dateOf = (p: string) => p.match(/\d{4}-\d{2}(-\d{2})?/)?.[0] ?? "";
  const paths = [...files.keys()].sort((a, b) => dateOf(b).localeCompare(dateOf(a)) || a.localeCompare(b));
  const hits: { path: string; line: string }[] = [];
  for (const p of paths) {
    for (const line of files.get(p)!.split("\n")) {
      const t = line.trim();
      if (t && words.every(w => t.toLowerCase().includes(w))) hits.push({ path: p, line: t });
    }
  }
  if (!hits.length) return `🔎 Nothing found for *${query}*. Try fewer or different words.`;
  const shown = hits.slice(0, 15).map(h => `*${h.path}* — ${h.line.length > 180 ? h.line.slice(0, 180) + "…" : h.line}`);
  return `🔎 *${hits.length} match${hits.length > 1 ? "es" : ""} for "${query}"*${hits.length > 15 ? " (showing newest 15)" : ""}\n\n${shown.join("\n")}`;
}

// ── Expenses (Expenses/YYYY-MM.md) ────────────────────────────────
type Expense = { date: string; amount: number; cat: string; note: string };
const EXP_LINE = /^- (\d{4}-\d{2}-\d{2}) \| ([\d.]+) \| ([^|]*) \| ?(.*)$/;
const inr = (n: number) => "₹" + n.toLocaleString("en-IN", { maximumFractionDigits: 2 });

function parseExpenses(content: string): Expense[] {
  const out: Expense[] = [];
  for (const line of content.split("\n")) {
    const m = line.match(EXP_LINE);
    if (m) out.push({ date: m[1], amount: parseFloat(m[2]), cat: m[3].trim() || "misc", note: m[4] });
  }
  return out;
}

function byCategory(exps: Expense[]): string {
  const totals = new Map<string, number>();
  exps.forEach(e => totals.set(e.cat, (totals.get(e.cat) ?? 0) + e.amount));
  const total = exps.reduce((s, e) => s + e.amount, 0);
  const rows = [...totals.entries()].sort((a, b) => b[1] - a[1])
    .map(([c, v]) => `• ${c}: ${inr(v)} (${Math.round((v / total) * 100)}%)`);
  return `${rows.join("\n")}\n*Total: ${inr(total)}* · ${exps.length} entr${exps.length === 1 ? "y" : "ies"}`;
}

async function loadExpenses(months: string[]): Promise<Expense[]> {
  const all: Expense[] = [];
  for (const m of months) {
    const f = await vaultRead(`Expenses/${m}.md`);
    if (f) all.push(...parseExpenses(f.content));
  }
  return all;
}

// ── Habits (Habits/YYYY-MM.md) ────────────────────────────────────
const HABIT_LINE = /^- (\d{4}-\d{2}-\d{2}) \| ([^|]+) \| (.*)$/;
type HabitLog = { date: string; name: string; value: string };

function parseHabits(content: string): HabitLog[] {
  const out: HabitLog[] = [];
  for (const line of content.split("\n")) {
    const m = line.match(HABIT_LINE);
    if (m) out.push({ date: m[1], name: m[2].trim(), value: m[3].trim() });
  }
  return out;
}

async function loadHabits(months: string[]): Promise<HabitLog[]> {
  const all: HabitLog[] = [];
  for (const m of months) {
    const f = await vaultRead(`Habits/${m}.md`);
    if (f) all.push(...parseHabits(f.content));
  }
  return all;
}

const dayRange = (n: number) => [...Array(n)].map((_, i) => istDate(-(n - 1 - i))); // oldest → today
const monthsOf = (days: string[]) => [...new Set(days.map(d => d.slice(0, 7)))];

async function habitWeek(): Promise<string> {
  const days = dayRange(7);
  const logs = (await loadHabits(monthsOf(days))).filter(l => days.includes(l.date));
  if (!logs.length) return "No habits logged in the last 7 days. Try `#habit water 3L` or `#habit sleep 7h`.";
  const names = [...new Set(logs.map(l => l.name))].sort();
  const rows = names.map(n => {
    const byDay = new Map<string, string>();
    logs.filter(l => l.name === n).forEach(l => byDay.set(l.date, l.value));
    const marks = days.map(d => (byDay.has(d) ? "✅" : "⬜")).join("");
    let streak = 0;
    for (let i = days.length - 1; i >= 0; i--) {
      if (byDay.has(days[i])) streak++;
      else if (i === days.length - 1) continue; // today not logged yet — don't break the streak
      else break;
    }
    const last = byDay.get(days[days.length - 1]) ?? byDay.get(days[days.length - 2]) ?? "";
    return `*${n}*  ${marks}  ${byDay.size}/7 · streak ${streak}${last && last !== "✓" ? ` · latest ${last}` : ""}`;
  });
  return `📈 *Habits — last 7 days* (oldest → today)\n\n${rows.join("\n")}`;
}

// ── Reminders (Reminders/reminders.md) ────────────────────────────
type Reminder = { whenMs: number; text: string; line: string };
const REMINDER_FILE = "Reminders/reminders.md";
const REMINDER_LINE = /^- \[ \] (\d{4}-\d{2}-\d{2}) (\d{2}:\d{2}) \| (.+)$/;
let reminders: Reminder[] = [];

const istParts = (ms: number) => {
  const d = new Date(ms + 5.5 * 3600000);
  return { y: d.getUTCFullYear(), mo: d.getUTCMonth(), d: d.getUTCDate() };
};
const istToMs = (y: number, mo: number, d: number, h: number, mi: number) => Date.UTC(y, mo, d, h, mi) - 5.5 * 3600000;
const fmtIST = (ms: number) => new Date(ms + 5.5 * 3600000).toISOString().replace("T", " ").slice(0, 16);

// "5pm …", "17:30 …", "tomorrow 9am …", "2026-12-01 18:00 …", "in 30m …"
function parseWhen(input: string): { whenMs: number; rest: string } | null {
  let s = input.trim();
  const now = Date.now();
  let m = s.match(/^in\s+(\d+)\s*(m|min|mins|minutes?|h|hr|hrs|hours?)\b\s*/i);
  if (m) {
    const hours = /^h/i.test(m[2]);
    return { whenMs: now + Number(m[1]) * (hours ? 3600000 : 60000), rest: s.slice(m[0].length) };
  }
  let dateParts: [number, number, number] | null = null;
  let dayOffset: number | null = null;
  if ((m = s.match(/^(\d{4})-(\d{2})-(\d{2})\s+/))) { dateParts = [+m[1], +m[2] - 1, +m[3]]; s = s.slice(m[0].length); }
  else if ((m = s.match(/^tomorrow\s+/i))) { dayOffset = 1; s = s.slice(m[0].length); }
  else if ((m = s.match(/^today\s+/i))) { dayOffset = 0; s = s.slice(m[0].length); }
  const t = s.match(/^(\d{1,2})(?::(\d{2}))?\s*(am|pm)?(?!\w)\s*/i);
  if (!t || (!t[2] && !t[3])) return null; // "5" alone is ambiguous — need am/pm or HH:MM
  let h = +t[1];
  const mi = t[2] ? +t[2] : 0;
  if (t[3]) { if (h < 1 || h > 12) return null; h = (h % 12) + (t[3].toLowerCase() === "pm" ? 12 : 0); }
  if (h > 23 || mi > 59) return null;
  const p = istParts(now);
  let when = dateParts
    ? istToMs(dateParts[0], dateParts[1], dateParts[2], h, mi)
    : istToMs(p.y, p.mo, p.d + (dayOffset ?? 0), h, mi);
  if (!dateParts && dayOffset === null && when <= now) when += 86400000; // time already passed today → tomorrow
  return { whenMs: when, rest: s.slice(t[0].length) };
}

async function loadReminders(): Promise<void> {
  const f = await vaultRead(REMINDER_FILE);
  reminders = [];
  if (!f) return;
  for (const line of f.content.split("\n")) {
    const m = line.match(REMINDER_LINE);
    if (m) reminders.push({ whenMs: Date.parse(`${m[1]}T${m[2]}:00+05:30`), text: m[3], line });
  }
}

async function markReminder(line: string, mark: string): Promise<void> {
  const f = await vaultRead(REMINDER_FILE);
  if (!f) return;
  const body = f.content.split("\n").map(l => (l === line ? l.replace("- [ ]", `- [${mark}]`) : l)).join("\n");
  await vaultWrite(REMINDER_FILE, body.trimEnd(), false);
}

// ── Link saver (Links/reading-list.md) ────────────────────────────
function extractUrl(text: string): string | null {
  const slack = text.match(/<(https?:[^|>]+)(?:\|[^>]*)?>/);
  if (slack) return slack[1];
  return text.match(/https?:\/\/[^\s<>]+/i)?.[0] ?? null;
}

function isPrivateHost(h: string): boolean {
  h = h.toLowerCase();
  return h === "localhost" || h.endsWith(".local") || h.endsWith(".internal") || h === "[::1]" ||
    /^(127\.|10\.|0\.|169\.254\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.)/.test(h);
}

const decodeEntities = (s: string) =>
  s.replace(/&amp;/g, "&").replace(/&quot;/g, '"').replace(/&#39;|&apos;/g, "'").replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&nbsp;/g, " ");

async function fetchPage(url: string): Promise<{ title: string; text: string } | null> {
  try {
    const u = new URL(url);
    if (!/^https?:$/.test(u.protocol) || isPrivateHost(u.hostname)) return null;
    const res = await fetch(url, {
      redirect: "follow",
      signal: AbortSignal.timeout(8000),
      headers: { "User-Agent": "Mozilla/5.0 (compatible; MastiskaLinkSaver/1.0)" },
    });
    if (!res.ok || !(res.headers.get("content-type") ?? "").includes("text/html")) return null;
    const html = (await res.text()).slice(0, 400_000);
    const title = decodeEntities((html.match(/<title[^>]*>([\s\S]*?)<\/title>/i)?.[1] ?? "").replace(/\s+/g, " ").trim());
    const text = decodeEntities(
      html.replace(/<script[\s\S]*?<\/script>|<style[\s\S]*?<\/style>|<[^>]+>/g, " ").replace(/\s+/g, " ").trim()
    ).slice(0, 6000);
    return { title, text };
  } catch {
    return null;
  }
}

async function saveLink(text: string, say: Function): Promise<void> {
  const url = extractUrl(text);
  if (!url) { await say("Send a link to save, like `#link https://example.com`"); return; }
  const userNote = unslack(text.replace(/<https?:[^>]+>/g, "").replace(/https?:\/\/\S+/g, "").replace(/#\w+/g, "")).trim();
  await say("🔗 Reading the page...");
  const page = await fetchPage(url);
  let summary = "";
  if (page && page.text.length > 200) {
    try {
      summary = (await askGroq(
        "Summarize this web page in 2 short sentences: what it is and why it might be useful. Plain text, no markdown, no preamble.",
        `Title: ${page.title}\n\n${page.text}`
      )).replace(/\s+/g, " ").trim();
    } catch { /* keep the link even if the summary fails */ }
  }
  const title = (page?.title || new URL(url).hostname).replace(/[\[\]]/g, "");
  const line = `- [ ] [${title}](${url})${summary ? ` — ${summary}` : ""}${userNote ? ` — _note: ${userNote}_` : ""}  _(${istDate()})_`;
  const ok = await appendEntry("Links/reading-list.md", "# Reading List\n\n", line);
  await say(ok
    ? `🔗 Saved to *Links/reading-list.md*\n*${title}*${summary ? `\n${summary}` : "\n_(couldn't read the page, saved the link only)_"}`
    : SAVE_FAILED);
}

// ── Weekly review ─────────────────────────────────────────────────
const istDow = () => new Date(Date.now() + 5.5 * 3600000).getUTCDay(); // 0 = Sunday

async function buildWeeklyReview(): Promise<{ text: string; saved: boolean }> {
  const files = await loadVault(0);
  const get = (p: string) => files.get(p) ?? "";
  const days = dayRange(7);
  const inWeek = (line: string) => { const m = line.match(/_\((\d{4}-\d{2}-\d{2})/); return !!m && days.includes(m[1]); };

  let done = 0, total = 0;
  const unfinished: string[] = [];
  for (const d of days) {
    const ts = parseTasks(get(`Todos/${d}.md`));
    total += ts.length;
    done += ts.filter(t => t.done).length;
    ts.filter(t => !t.done).forEach(t => unfinished.push(t.text));
  }
  const gym = days.filter(d => get(`Gym/${d}.md`).trim());
  const notes = days.filter(d => get(`Notes/${d}.md`).trim());
  const noteCount = notes.reduce((n, d) => n + (get(`Notes/${d}.md`).match(/^### /gm)?.length ?? 0), 0);
  const ideas = [...get("Ideas/content-ideas.md").split("\n"), ...get("Ideas/project-ideas.md").split("\n")]
    .filter(l => l.startsWith("- ") && inWeek(l));
  const links = get("Links/reading-list.md").split("\n").filter(l => l.startsWith("- ") && inWeek(l));
  const expenses = monthsOf(days).flatMap(m => parseExpenses(get(`Expenses/${m}.md`))).filter(e => days.includes(e.date));
  const spent = expenses.reduce((s, e) => s + e.amount, 0);
  const habits = monthsOf(days).flatMap(m => parseHabits(get(`Habits/${m}.md`))).filter(h => days.includes(h.date));
  const habitDays = new Map<string, Set<string>>();
  habits.forEach(h => habitDays.set(h.name, (habitDays.get(h.name) ?? new Set()).add(h.date)));

  const pct = total ? Math.round((done / total) * 100) : 0;
  const stats = [
    `✅ Tasks: ${total ? `${done}/${total} done (${pct}%)` : "none planned"}`,
    `🏋️ Gym: ${gym.length} session${gym.length === 1 ? "" : "s"}`,
    `📝 Notes: ${noteCount} · 💡 Ideas: ${ideas.length} · 🔗 Links: ${links.length}`,
    `💸 Spent: ${inr(spent)}`,
    habitDays.size ? `📈 Habits: ${[...habitDays.entries()].map(([n, s]) => `${n} ${s.size}/7`).join(", ")}` : "",
  ].filter(Boolean).join("\n");
  const header = `📅 *Weekly review — ${days[0]} → ${days[6]}*\n\n${stats}`;

  const hasData = total || gym.length || noteCount || ideas.length || links.length || expenses.length || habits.length;
  if (!hasData) return { text: `${header}\n\nNothing logged this week yet — capture a few thoughts and I'll have more to work with next Sunday.`, saved: false };

  const cap = (s: string, n: number) => (s.length > n ? s.slice(0, n) + "…" : s);
  const context = [
    `TASKS: ${done}/${total} done. Unfinished: ${unfinished.join("; ") || "none"}`,
    `GYM SESSIONS (${gym.length}):\n${gym.map(d => `[${d}] ${cap(get(`Gym/${d}.md`).replace(/^# .*\n/, "").trim(), 500)}`).join("\n")}`,
    `NOTES:\n${cap(notes.map(d => `[${d}] ${get(`Notes/${d}.md`).replace(/^# .*\n/, "").trim()}`).join("\n"), 6000)}`,
    `IDEAS:\n${ideas.join("\n")}`,
    `LINKS SAVED:\n${cap(links.join("\n"), 1500)}`,
    `SPENDING:\n${expenses.length ? byCategory(expenses) : "none"}`,
    `HABITS:\n${[...habitDays.entries()].map(([n, s]) => `${n}: ${s.size}/7 days`).join("\n") || "none"}`,
  ].join("\n\n");

  let ai: string;
  try {
    ai = await askGroq(
      "You are a thoughtful second-brain coach reviewing the user's week from their own logs. Write: *What went well* (2-3 bullets), *What slipped* (1-3 bullets), *Themes in my notes and ideas* (1-3 bullets), *Focus for next week* (exactly 3 concrete bullets). Under 220 words. Use ONLY the data given — do not invent events. Address the user as 'you'.",
      context
    );
  } catch (e) {
    ai = `_(AI summary unavailable: ${errMsg(e)})_`;
  }
  const saved = await vaultWrite(`Reviews/${istDate()}.md`, `# Weekly Review — ${days[0]} → ${days[6]}\n\n${stats.replace(/\*/g, "")}\n\n${ai}`, false);
  return { text: `${header}\n\n${toSlack(ai)}${saved ? `\n\n_Saved to Reviews/${istDate()}.md_` : ""}`, saved };
}

// Slack wraps links as <url|label> and escapes & < > — turn that back into clean markdown
function unslack(s: string): string {
  return s
    .replace(/<(https?:[^|>]+)\|([^>]+)>/g, "[$2]($1)")
    .replace(/<(https?:[^>]+)>/g, "$1")
    .replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&amp;/g, "&");
}

// Quick capture: save any text to today's note file
async function saveQuickNote(text: string, say: Function): Promise<void> {
  const date = istDate();
  const ok = await appendEntry(`Notes/${date}.md`, `# Daily Notes — ${date}\n`, `\n### ${istTime()}\n${unslack(text)}`);
  await say(ok ? `📝 Saved to *Notes/${date}.md*` : SAVE_FAILED);
}

// ── Core message handler ──────────────────────────────────────────
async function handleMessage(text: string, channelId: string, say: Function): Promise<void> {
  // Strip bot mention
  let clean = text.replace(/<@[A-Z0-9]+>/gi, "").trim();

  // Empty or help request → help
  if (!clean || clean === "?" || clean === "#?") { await say(HELP); return; }

  // Short prefixes: "i: my idea" → "#idea my idea"
  const PREFIXES: Record<string, string> = {
    i: "idea", p: "project", g: "gym", n: "note", t: "todo", d: "done",
    s: "spend", r: "remind", f: "find", l: "link", c: "clean", h: "habit",
  };
  const pm = clean.match(/^([a-z])\s*:\s*([\s\S]*)$/i);
  if (pm && PREFIXES[pm[1].toLowerCase()]) clean = `#${PREFIXES[pm[1].toLowerCase()]} ${pm[2]}`.trim();

  const tags = clean.toLowerCase().match(/#\w+/g)?.map(t => t.slice(1)) ?? [];
  const cmd = tags[0]; // the new commands only trigger when they are the FIRST tag
  const arg = clean.replace(/#\w+/g, "").trim();

  // ── #help / #? ────────────────────────────────────────────────────
  if (cmd === "help" || cmd === "?" || clean === "#?") { await say(HELP); return; }

  // ── #save ────────────────────────────────────────────────────────
  if (tags.includes("save")) {
    const last = lastAIResponse.get(channelId);
    if (!last) { await say("Nothing to save yet. Generate some content first."); return; }
    const date = istDate();
    const saved = await vaultWrite(`Notes/${date}.md`, `\n## Saved ${istTime()}\n\n${last}`);
    await say(saved ? `✅ Saved to Notes/${date}.md in your vault.` : "⚠️ Saved locally (GitHub vault not configured).");
    return;
  }

  // ── #find — search the whole vault ───────────────────────────────
  if (cmd === "find") {
    if (!arg) { await say("What should I search for? Try `#find pricing idea`"); return; }
    try { await say(await findInVault(arg)); } catch (e) { await say(`❌ Search failed: ${errMsg(e)}`); }
    return;
  }

  // ── #spend — expense log ─────────────────────────────────────────
  if (cmd === "spend") {
    const low = arg.toLowerCase();
    const ym = istDate().slice(0, 7);
    try {
      const mm = low.match(/^month(?:\s+(\d{4}-\d{2}))?$/);
      if (mm) {
        const exps = await loadExpenses([mm[1] ?? ym]);
        await say(exps.length ? `💸 *Spending — ${mm[1] ?? ym}*\n\n${byCategory(exps)}` : `No expenses logged for ${mm[1] ?? ym}.`);
        return;
      }
      if (low === "week") {
        const days = dayRange(7);
        const exps = (await loadExpenses(monthsOf(days))).filter(e => days.includes(e.date));
        await say(exps.length ? `💸 *Spending — last 7 days*\n\n${byCategory(exps)}` : "No expenses in the last 7 days.");
        return;
      }
      if (low === "undo") {
        const f = await vaultRead(`Expenses/${ym}.md`);
        const lines = f ? f.content.split("\n") : [];
        let idx = -1;
        lines.forEach((l, i) => { if (EXP_LINE.test(l)) idx = i; });
        if (!f || idx < 0) { await say("Nothing to undo this month."); return; }
        const removed = lines.splice(idx, 1)[0];
        const ok = await vaultWrite(`Expenses/${ym}.md`, lines.join("\n").trimEnd(), false);
        await say(ok ? `↩️ Removed: ${removed.replace(/^- /, "")}` : SAVE_FAILED);
        return;
      }
      const m = arg.match(/^[₹$]?\s*([\d,]+(?:\.\d+)?)\s*(.*)$/);
      const amount = m ? parseFloat(m[1].replace(/,/g, "")) : NaN;
      if (!m || !(amount > 0)) {
        await say("Log an expense: `#spend 250 food lunch`\nSee totals: `#spend month` · `#spend week` · `#spend undo`");
        return;
      }
      const [first, ...rest] = m[2].trim().split(/\s+/).filter(Boolean);
      const cat = (first ?? "misc").toLowerCase().replace(/\|/g, "");
      const note = rest.join(" ").replace(/\|/g, "/");
      const ok = await appendEntry(`Expenses/${ym}.md`, `# Expenses — ${ym}\n\n`, `- ${istDate()} | ${amount} | ${cat} | ${note}`);
      if (!ok) { await say(SAVE_FAILED); return; }
      const total = (await loadExpenses([ym])).reduce((s, e) => s + e.amount, 0);
      await say(`💸 Saved ${inr(amount)} · ${cat}${note ? ` — ${note}` : ""}\nThis month so far: *${inr(total)}*`);
    } catch (e) {
      await say(`❌ Expense error: ${errMsg(e)}`);
    }
    return;
  }

  // ── #habit — log + weekly streak view ────────────────────────────
  if (cmd === "habit") {
    try {
      if (!arg || ["week", "streak", "list"].includes(arg.toLowerCase())) { await say(await habitWeek()); return; }
      const [name, ...rest] = arg.split(/\s+/);
      const ym = istDate().slice(0, 7);
      const value = rest.join(" ").replace(/\|/g, "/") || "✓";
      const ok = await appendEntry(`Habits/${ym}.md`, `# Habits — ${ym}\n\n`, `- ${istDate()} | ${name.toLowerCase().replace(/\|/g, "")} | ${value}`);
      await say(ok ? `📈 Logged *${name.toLowerCase()}* ${value === "✓" ? "✓" : `→ ${value}`}  (see \`#habit week\`)` : SAVE_FAILED);
    } catch (e) {
      await say(`❌ Habit error: ${errMsg(e)}`);
    }
    return;
  }

  // ── #remind — DM at a time ───────────────────────────────────────
  if (cmd === "remind") {
    if (!OWNER_SLACK_ID) { await say("Reminders need `OWNER_SLACK_ID` set in the bot's environment (that's where I send the DM)."); return; }
    const low = arg.toLowerCase();
    const pending = [...reminders].sort((a, b) => a.whenMs - b.whenMs);
    if (!arg || low === "list") {
      await say(pending.length
        ? `⏰ *Pending reminders*\n\n${pending.map((r, i) => `${i + 1}. ${fmtIST(r.whenMs)} — ${r.text}`).join("\n")}\n\n_Cancel one: \`#remind cancel 2\`_`
        : "No pending reminders. Try `#remind 5pm call mom` · `#remind tomorrow 9am gym` · `#remind in 30m tea`");
      return;
    }
    const cm = low.match(/^cancel\s+(\d+)$/);
    if (cm) {
      const r = pending[Number(cm[1]) - 1];
      if (!r) { await say("No reminder with that number. See `#remind list`."); return; }
      reminders = reminders.filter(x => x !== r);
      await markReminder(r.line, "x");
      await say(`🗑️ Cancelled: ${r.text}`);
      return;
    }
    const parsed = parseWhen(arg);
    if (!parsed) { await say("When? Try `#remind 5pm call mom` · `#remind tomorrow 9am gym` · `#remind in 30m tea` · `#remind 2026-12-01 18:00 pay rent`"); return; }
    if (parsed.whenMs <= Date.now()) { await say("That time has already passed — pick a future time."); return; }
    const text = unslack(parsed.rest.trim()).replace(/\s*\n\s*/g, " ");
    if (!text) { await say("What should I remind you about? `#remind 5pm call mom`"); return; }
    const whenMs = Math.ceil(parsed.whenMs / 60000) * 60000;
    const line = `- [ ] ${fmtIST(whenMs)} | ${text}`;
    const ok = await appendEntry(REMINDER_FILE, "# Reminders\n\n", line);
    if (!ok) { await say(SAVE_FAILED); return; }
    reminders.push({ whenMs, text, line });
    await say(`⏰ Got it — I'll DM you at *${fmtIST(whenMs)} IST*: ${text}`);
    return;
  }

  // ── #link — save a link with an AI summary ───────────────────────
  if (cmd === "link") { await saveLink(clean, say); return; }

  // ── #clean — rambling voice note → tidy bullets (also saved) ─────
  if (cmd === "clean") {
    if (!arg) { await say("Paste or dictate your brain-dump after `#clean` and I'll tidy it into bullets."); return; }
    try {
      const raw = unslack(arg);
      const cleaned = await askGroq(
        "You turn a rambling voice-note transcript into a clean note. Output a short title line, then concise bullet points starting with '- '. Keep EVERY idea, number, name and date. Remove filler words and repetition, fix grammar. Do not add anything new.",
        raw
      );
      const date = istDate();
      const original = raw.split("\n").map(l => `> ${l}`).join("\n");
      const ok = await appendEntry(`Notes/${date}.md`, `# Daily Notes — ${date}\n`, `\n### ${istTime()} (cleaned)\n${cleaned.trim()}\n\n<small>Original:</small>\n${original}`);
      await say(`🧹 *Cleaned*\n\n${toSlack(cleaned)}\n\n${ok ? `_Saved to Notes/${date}.md_` : SAVE_FAILED}`);
    } catch (e) {
      await say(`❌ Clean failed: ${errMsg(e)}`);
    }
    return;
  }

  // ── #review — weekly review on demand ────────────────────────────
  if (cmd === "review") {
    await say("📅 Reading your week...");
    try { await say((await buildWeeklyReview()).text); } catch (e) { await say(`❌ Review failed: ${errMsg(e)}`); }
    return;
  }

  // ── #carry — move unfinished tasks to tomorrow ───────────────────
  if (cmd === "carry") {
    const nums = (arg.match(/\d+/g) ?? []).map(Number);
    const tasks = await loadTasks(istDate());
    if (!tasks.length) { await say("No tasks today to carry over."); return; }
    const pick = tasks.map((t, i) => ({ t, n: i + 1 })).filter(x => !x.t.done && (!nums.length || nums.includes(x.n)));
    if (!pick.length) { await say("Nothing to carry — everything's done 🎉"); return; }
    const tomorrow = istDate(1);
    const have = new Set((await loadTasks(tomorrow)).map(t => t.text.toLowerCase()));
    const items = pick.map(x => x.t.text).filter(t => !have.has(t.toLowerCase()));
    if (items.length) {
      const ok = await appendEntry(`Todos/${tomorrow}.md`, `# Tasks — ${tomorrow}\n\n`, items.map(t => `- [ ] ${t}`).join("\n"));
      if (!ok) { await say(SAVE_FAILED); return; }
    }
    await say(`➡️ Moved ${items.length} task${items.length === 1 ? "" : "s"} to tomorrow${pick.length > items.length ? ` (${pick.length - items.length} already there)` : ""}:\n\n${formatTasks(await loadTasks(tomorrow))}`);
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
    if (!content) { await say("What do you want to note? Just type it — no tag needed."); return; }
    await saveQuickNote(content, say);
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

    // Detect muscle group from tags
    const muscleTag = tags.find(t => MUSCLE_GROUPS[t]);
    const muscleLabel = muscleTag ? MUSCLE_GROUPS[muscleTag] : null;

    // View logs: `#gym show`, `#gym yesterday`, `#gym week`, `#gym 2026-11-12`, `#gym show chest`
    const viewRaw = content.toLowerCase();
    // Check if viewing by muscle group: "show chest" or just "chest"
    const muscleViewMatch = viewRaw.match(/^(?:show\s+)?([a-z&]+)$/) && MUSCLE_GROUPS[viewRaw.replace(/^show\s+/, "")];
    const muscleFilter = muscleViewMatch ? MUSCLE_GROUPS[viewRaw.replace(/^show\s+/, "")] : null;

    if (muscleFilter) {
      // Show only workouts with this muscle group from the last 14 days
      const days = [0, -1, -2, -3, -4, -5, -6, -7, -8, -9, -10, -11, -12, -13].map(o => istDate(o));
      const parts: string[] = [];
      for (const d of days) {
        const f = await vaultRead(`Gym/${d}.md`);
        if (!f) continue;
        // Split by ### sections and find ones matching the muscle group
        const sections = f.content.split(/(?=\n### )/);
        const matching = sections.filter(s => s.includes(`[${muscleFilter}]`));
        if (matching.length) parts.push(`*${d}*\n${matching.join("\n").trim()}`);
      }
      if (!parts.length) {
        await say(`No *${muscleFilter}* workouts in the last 14 days. Log one with \`#gym #${muscleTag ?? muscleFilter.toLowerCase()} [exercises]\``);
        return;
      }
      await say(`🏋️ *${muscleFilter} workouts — last 14 days*\n\n${parts.join("\n\n———\n\n")}`);
      return;
    }

    const view = viewRaw;
    if (/^(show|today|yesterday|week|\d{4}-\d{2}-\d{2})$/.test(view)) {
      const days = view === "week" ? [0, -1, -2, -3, -4, -5, -6].map(o => istDate(o))
        : [view === "yesterday" ? istDate(-1) : /^\d/.test(view) ? view : istDate()];
      const parts: string[] = [];
      for (const d of days) {
        const f = await vaultRead(`Gym/${d}.md`);
        if (f) parts.push(f.content.trim());
      }
      if (!parts.length) {
        await say(view === "week" ? "No workouts logged in the last 7 days." : `No workout logged for *${days[0]}*.`);
        return;
      }
      await say(`🏋️ *Gym log${view === "week" ? " — last 7 days" : ` — ${days[0]}`}*\n\n${parts.join("\n\n———\n\n")}`);
      return;
    }

    // Regular workout log — include muscle group label if provided
    const musclePrefix = muscleLabel ? `[${muscleLabel}] ` : "";
    const workoutContent = content.replace(new RegExp(`#${muscleTag}\\s*`, "i"), "").trim() || "Workout logged";
    const ok = await appendEntry(`Gym/${date}.md`, `# Workout — ${date}\n`, `\n### ${istTime()}\n${musclePrefix}${workoutContent}`);
    await say(ok ? `💪 Workout logged to *Gym/${date}.md*${muscleLabel ? ` · *${muscleLabel}*` : ""}` : SAVE_FAILED);
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

  // No content-generation tags → it's a quick note. Just type a thought and it's saved.
  if (!hasFintech) {
    if (extractUrl(clean)) await saveLink(clean, say); // a shared link → reading list with AI summary
    else await saveQuickNote(clean, say);
    return;
  }

  if (hasFintech) {
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

// Mentioned in a channel: @mastiska #nifty #thread ...
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

let schedulerBusy = false;

async function runScheduler() {
  if (schedulerBusy) return; // don't overlap with a slow previous tick
  schedulerBusy = true;
  try { await runSchedulerTick(); } finally { schedulerBusy = false; }
}

async function runSchedulerTick() {
  const date = istDate();

  // Reminders that have come due (also fires ones missed while the bot was down)
  for (const r of reminders.filter(x => x.whenMs <= Date.now())) {
    reminders = reminders.filter(x => x !== r);
    try {
      const late = Date.now() - r.whenMs > 10 * 60000;
      await dmOwner(`⏰ *Reminder:* ${r.text}${late ? `\n_(was due ${fmtIST(r.whenMs)} IST)_` : ""}`);
    } catch (e) {
      reminders.push(r); // DM failed → try again on the next tick
      throw e;
    }
    await markReminder(r.line, "x");
  }
  const now = toMin(istTime());
  // Due if within 2 hours after the target time and not yet sent today (survives short restarts)
  const due = (slot: string, at?: string) => {
    if (!at || at.toLowerCase() === "off") return false;
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

  if (istDow() === 0 && due("weekly", WEEKLY_REVIEW_TIME)) {
    firedSlots.add(`${date}-weekly`);
    try {
      await dmOwner((await buildWeeklyReview()).text);
    } catch (err) {
      console.error("[Mastiska] Weekly review error:", err);
      await dmOwner("📅 Couldn't build the weekly review. Try `#review` in a bit.");
    }
  }

  if (due("hn", HN_DIGEST_TIME)) {
    firedSlots.add(`${date}-hn`);
    try {
      const [tech, markets] = await Promise.all([fetchHNFront(5), fetchHNExtra(HN_MARKET_CFG, 5)]);
      await dmOwner(`📰 *Your daily Hacker News digest*\n\n${formatHN(tech, "Tech (front page)", false)}\n${formatHN(markets, "Markets (last 2 days)", false)}`);
    } catch (err) {
      console.error("[Mastiska] HN digest error:", err);
      await dmOwner("📰 Couldn't fetch the HN digest this morning. Try `#hn` in a bit.");
    }
  }

  if (due("evening", EVENING_TIME)) {
    firedSlots.add(`${date}-evening`);
    const tasks = await loadTasks(date);
    if (!tasks.length) {
      await dmOwner("🌙 No tasks were planned today. Plan tomorrow: `#todo task one; task two`");
    } else if (tasks.every(t => t.done)) {
      await dmOwner(`🌙 All ${tasks.length} tasks done today — nice. Plan tomorrow with \`#todo ...\``);
    } else {
      await dmOwner(`🌙 *Evening check-in* — ${tasks.length} tasks today:\n\n${formatTasks(tasks)}\n\nHow many did you finish? Reply \`#done 1 3\` (task numbers), \`#done all\` or \`#done none\`.\nUnfinished ones: reply \`#carry\` to move them to tomorrow.\nThen plan tomorrow: \`#todo task one; task two\``);
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
    await loadReminders().catch(e => console.error("[Mastiska] Couldn't load reminders:", e));
    setInterval(() => runScheduler().catch(e => console.error("[Mastiska] Scheduler error:", e)), 30_000);
    console.log(`⏰ Check-ins on: evening ${EVENING_TIME} IST, HN digest ${HN_DIGEST_TIME} IST, weekly review Sun ${WEEKLY_REVIEW_TIME} IST${MORNING_TIME ? `, morning ${MORNING_TIME} IST` : ""}`);
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
