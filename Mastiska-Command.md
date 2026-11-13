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

Evening check-in: the bot DMs you at 21:00 IST (change with EVENING_TIME) with today's list.
Reply `#done 1 3`. It stores `**Result:** 2/3 done` in the day's file.
Optional morning push: set MORNING_TIME=07:30 on Render.

## Notes  ->  Notes/YYYY-MM-DD.md
| Command | What it does |
|---|---|
| `#note any text` | Timestamped note in today's file |
| `#save` | Saves the bot's last generated answer to Notes |

## Gym  ->  Gym/
| Command | What it does |
|---|---|
| `#gym chest day, bench 5x5 60kg` | Today's workout log (Gym/DATE.md) |
| `#gym #pr bench 70kg` | Personal record (Gym/progress.md) |
| `#gym #weight 72` | Body weight (Gym/progress.md) |
| `#gym summary` | AI summary of your progress |

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
