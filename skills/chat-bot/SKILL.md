---
name: chat-bot
description: Build and host a customer-chat bot (WhatsApp through Wasender, Instagram and Messenger through a Facebook Page) as plain Node.js with zero dependencies, starting from a tested reference shop bot. Use when the user wants a chat bot, a WhatsApp/Instagram/Messenger bot, an AI sales or booking assistant for a shop, academy, clinic or any service, follow-ups for leads, an owner dashboard, or to put such a bot on a server.
---

# Chat bot

`code/` is a working reference: a cash-on-delivery shop bot with its full test suite (`npm test`). It answers from a card of facts, takes orders, follows up without pressure, hands off to a human, and gives the owner a dashboard. Read [reference/architecture.md](reference/architecture.md) before editing any module.

## Working with the user
- Speak the user's language, simply. Code, commits and file names stay in English.
- Ask at most 2–3 questions per round, each with a recommended default. Never ask what the code or the card can answer.
- Every claim about how the bot performs carries its count ("X of Y, period"); without one, say it is an assumption.
- A mistake goes in the first line, with the correct fact, then the fix.

## Steps
Each step ends when its written output exists.

1. **Understand the business.** Shop (orders) or bookings (academy, clinic, service)? Country, currency, channels (WhatsApp, Instagram, Messenger), who answers when the bot hands off. Write the answers at the top of the project's `CLAUDE.md`.
2. **Copy.** Copy `code/` into the user's project folder (never edit the skill's own copy). Run `npm test` there: it must be green before you change anything.
3. **Fill the card.** `card.json` is the single source of truth: offers, prices, delivery or dates, policy, FAQ, phone. Each empty field becomes a question to the owner. Keep `"test": true` until launch.
4. **Adapt the niche and the country.** Per [reference/niches.md](reference/niches.md): card schema, tools, prompt rules and jobs. The reference is an Algerian cash-on-delivery shop; outside Algeria change all of these, tests first:
   - time zone: UTC+1 is hard-coded in `src/brain.js`, `src/jobs.js`, `src/dashboard.js`, `src/report.js`;
   - phone formats (shop and customer) in `src/shop.js`;
   - the 58-wilaya delivery-fee table and the currency (دج) in `src/shop.js` and the card;
   - the dialect: the prompt RULES in `src/brain.js` are written in Algerian darja, with a guard against Moroccan words; rewrite them in the customer's dialect.
   Bookings (academy, clinic, service) are a new niche layer you build from the shop one; there is no booking code yet.
5. **Red, then green.** Every changed behaviour gets a failing `node --test` first; the whole suite ends green. Tests read the fixed `test/card.sample.json`, never the project's `card.json`; update the sample only when the card schema changes.
6. **Try it.** Put an `OPENROUTER_API_KEY` in `.env` (without it no reply is written, even in a dry run), then `DRY_RUN=1` and the `/try` page locally. Write 20 real questions customers ask this business, run them, and count correct replies. The user sets the bar.
7. **Review.** Before every commit, a fresh-context reviewer tries to prove the diff wrong. Show the user the result, fix, then commit.
8. **Host.** Follow [reference/hosting.md](reference/hosting.md): one bot on one small server.
9. **Go live.** Live with `TEST_NUMBERS` only, then empty it and read the first 50 real chats; fix by count. Every box in [reference/launch-checklist.md](reference/launch-checklist.md) is ticked.

## Hard rules
- **Money and dates are computed in code from the card.** A reply may contain only numbers from the card or from this turn's tool result. A reply that breaks this is regenerated once, then replaced by the code's own text.
- **"Confirmed / registered" only after the confirm tool succeeds.** A "yes" confirms only a summary the bot actually showed in its last turn.
- **Guards live in code, not in the prompt.** Each guard writes a `guard_log` row every time it fires, so it can be counted.
- **Follow-ups without pressure.** At most 2 nudges. "Let me think" brings the bot back in 6 h; a time the customer gives becomes that time. Opt-out words stop everything. Respect quiet hours in the business's time zone. Instagram and Messenger allow messages only within 24 h of the customer's last one.
- **Our own sends are never a human reply.** Every echo of a bot send is claimed before handoff logic sees it.
- **One live bot per number.** Two bots on one webhook reply twice; switch the old one off in the same minute.
- **Secrets live in `.env` only.** Customer numbers, names and addresses stay out of logs and commits.
- **Production refuses to boot on a misconfiguration:** a test card, a short password, `DRY_RUN`, or half-filled Meta keys.
- **Screens:** for visual changes, show the user one screen first and change the rest only after their yes.
