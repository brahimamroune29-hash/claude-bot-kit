# Launch checklist

The launch is done when every box is ticked, with the evidence written beside it.

## The bot
- [ ] Real card in `data/card.json`; `"test"` gone; the bot boots (no `card.json needs fixing` in the log); the owner read his own card.
- [ ] Product photos in `data/media/`, each listed name opens at `https://<domain>/media/<name>`.
- [ ] Keys in `/opt/shop-bot/.env`: Wasender, OpenRouter (balance topped up), OpenAI; Meta if Instagram or Messenger; `AGENT_PHONE` = the owner's number.
- [ ] `DAILY_COST_CAP_USD` set; `LOW_BALANCE_USD` set.
- [ ] Wasender: a number used by the shop only (the bot answers every chat on it); webhook `https://<domain>/wa` with the secret; event `messages.upsert` only.
- [ ] Meta (if used): app in the owner's account, Page token, webhook `/meta` with `messages` and `message_echoes`; App Review status known.

## Tested on `TEST_NUMBERS`
- [ ] A full order or booking end to end, with the total or slot checked by hand.
- [ ] A voice note understood; a bare photo gets the «write what you need» line.
- [ ] A handoff reaches the owner, and the reply from the dashboard arrives.
- [ ] «نخمم» brings a follow-up; «ما تبعتليش» stops everything.
- [ ] 20 real past questions replayed: count the correct replies, and the owner agrees on the bar.

## Around it
- [ ] Dashboard password handed to the owner; he logged in on his phone.
- [ ] Uptime monitor on `/health`.
- [ ] Daily backup file exists in `data/backups`.
- [ ] Any old bot on the same number switched off (two live bots reply twice); `TEST_NUMBERS` emptied; bot restarted.
- [ ] Day 1: read every real chat; day 3: read the first 50 and fix by count.
