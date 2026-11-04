# Hosting: one bot on one server

The step-by-step guide, in Arabic for the person running the bot, is `code/deploy/SETUP.md`; follow it as written. The design behind it:
- **Server:** Ubuntu 24.04, Node 22, Caddy (HTTPS on its own), ufw. One small machine (1 CPU, 1 GB) is enough for one bot; that is an assumption, not measured, so watch memory.
- **Layout:** the code in `/opt/shop-bot`, the keys in `/opt/shop-bot/.env` (chmod 600), everything the bot writes in `/opt/shop-bot/data/` (database, card, photos, backups). Production refuses to boot when `DB_PATH`, `CARD_PATH`, `MEDIA_DIR` or `BACKUP_DIR` point outside `data/`, because a deploy replaces everything else.
- **Service:** `code/deploy/shop-bot.service` runs as the `bot` user, restarts on a crash, and can write only `data/`.
- **Deploy:** `deploy/deploy.sh bot@SERVER` runs the tests, ships the code (inside a git repo: only a clean, committed tree), keeps `.env` and `data/`, restarts the bot and checks `/health`.
- **Keys:** the shop pays its own Wasender, OpenRouter, OpenAI and (if used) Meta. A low OpenRouter balance warns `AGENT_PHONE` on WhatsApp.
- **Outside watch:** an uptime monitor on `/health` every 5 minutes, because the bot's own WhatsApp alerts go quiet if the whole server dies.

## Not a host
- Serverless platforms (Vercel, Netlify functions…) cannot run it: no disk for SQLite and no long-running timers for follow-ups and backups.
- A laptop behind a quick tunnel works for a demo only: the tunnel and the machine drop, and the bot goes dark without anyone noticing.
