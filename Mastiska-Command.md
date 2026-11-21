# Mastiska Commands (Slack second brain)

Where to type: DM the bot (no mention needed). In a channel, mention it first: `@Mastiska #note ...`
Every entry is saved to your GitHub vault (angadha-vault) and shows up in Obsidian.
Times are IST. Separate several tasks with `;` or new lines.

## Todos  ->  Todos/YYYY-MM-DD.md
| Command | What it does |
|---|---|
| `#todo gym; study; read` | Plan TOMORROW's tasks |
| `#todo #today call mom` | Add to TODAY's list |
| `#tasks` | Show today's tasks (also: "today's tasks") |
| `#tasks #tomorrow` | Show tomorrow's tasks |
| `#done 1 3` | Mark tasks 1 and 3 done (use the numbers shown) |
| `#done all` | Mark every task done |
| `#done none` | Reset all to not done |
| `#undone 2` | Mark task 2 not done again |

Evening check-in: the bot DMs you at 21:00 IST (change with EVENING_TIME) with today's list.
Reply `#done 1 3`. It stores `**Result:** 2/3 done` in the day's file.
Optional morning push: set MORNING_TIME=07:30 on Render.

## Notes  ->  Notes/YYYY-MM-DD.md
| Command | What it does |
|---|---|
| (just type anything, no tag) | Quick note, timestamped in today's file |
| `#note any text` | Same thing, explicit |
| `#save` | Saves the bot's last generated answer to Notes |

## Gym  ->  Gym/
| Command | What it does |
|---|---|
| `#gym chest day, bench 5x5 60kg` | Today's workout log (Gym/DATE.md) |
| `#gym #pr bench 70kg` | Personal record (Gym/progress.md) |
| `#gym #weight 72` | Body weight (Gym/progress.md) |
| `#gym show` | View today's workout log |
| `#gym yesterday` | View yesterday's log |
| `#gym week` | View the last 7 days |
| `#gym 2026-11-12` | View a specific date |
| `#gym summary` | AI summary of PRs and weight |

## Ideas  ->  Ideas/
| Command | What it does |
|---|---|
| `#idea text` | Content idea (Ideas/content-ideas.md) |
| `#project text` | Project idea (Ideas/project-ideas.md) |

## Hacker News  ->  HackerNews/YYYY-MM-DD.md (with #save)
| Command | What it does |
|---|---|
| `#hn` | Top fintech stories |
| `#hn #seed` | Startups raising seed rounds, last 90 days |
| `#hn #crypto` | Top stories on a topic (any topic tag below) |
| `#hn #seed #save` | Show and save to your vault |
| `#hn #startup #thread` | Generate a post from the top story |

## Content generation (fintech)
Combine a topic tag + optional trade tag + a format tag + your text.
Example: `#nifty #breakout #thread Nifty crossed 25,000 today`

Topic tags: #ipo #earnings #rbi #crypto #nifty #budget #startup #forex #gold #fii #sector #economy
Trade tags: #bull #bear #breakout #support #resistance #trend #volume #momentum #reversal #swing #intraday #longterm #dca #fundamentals #technical #risk
Format tags: #thread #li #linkedin #ig #instagram #yt #youtube #all #repurpose #score #hook #ideas #explain #story

Then `#save` stores the result in Notes.

## Help
Send an empty message or mention the bot with no text to see the in-Slack help.

## Env variables (Render -> Environment)
SLACK_BOT_TOKEN, SLACK_APP_TOKEN, GROQ_API_KEY, GROQ_MODEL, GITHUB_TOKEN, GITHUB_OWNER,
GITHUB_VAULT_REPO=angadha-vault, OWNER_SLACK_ID (your member ID, starts with U),
EVENING_TIME (default 21:00), MORNING_TIME (optional)

## Second-brain extras
| Command | What it does |
|---|---|
| `#find pricing idea` | Search the whole vault (all words must match), newest first |
| `#spend 250 food lunch` | Log an expense (amount, category, optional note) |
| `#spend month` / `#spend month 2026-10` | Totals by category |
| `#spend week` | Last 7 days |
| `#spend undo` | Remove the last expense this month |
| `#remind 5pm call mom` | DM at that time (IST). If the time passed today, it means tomorrow |
| `#remind tomorrow 9am gym` | Tomorrow |
| `#remind in 30m tea` | In 30 minutes (also `in 2h`) |
| `#remind 2026-12-01 18:00 pay rent` | Specific date |
| `#remind list` / `#remind cancel 2` | See or cancel pending reminders |
| `#habit water 3L` | Log a habit (name, optional value) |
| `#habit week` | 7-day view with streaks |
| (paste a link) or `#link url` | Reading list with AI summary (Links/reading-list.md) |
| `#clean rambling text` | Tidy bullets, saved to Notes with the original |
| `#review` | Weekly review now |
| `#carry` | Move today's unfinished tasks to tomorrow (or `#carry 2 3`) |

Weekly review: automatic every Sunday 19:00 IST (WEEKLY_REVIEW_TIME). Saved to Reviews/.
Daily HN digest: 10:00 IST (HN_DIGEST_TIME). Evening check-in: 21:00 IST (EVENING_TIME).

## Short prefixes (type less)
i: idea · p: project · g: gym · n: note · t: todo (tomorrow) · d: done · s: spend · r: remind · f: find · l: link · c: clean · h: habit
Example: `s: 250 food lunch`, `r: 5pm call mom`, `t: gym; study`

## Notes
- A message with a link and no tag is saved as a link. Use `#note` to save it as a plain note.
- Env vars to add on Render if you want to change times: WEEKLY_REVIEW_TIME, HN_DIGEST_TIME, EVENING_TIME.
