# Architecture of the reference bot (`code/`)

Node 22 built-ins only: `node:http`, `node:sqlite` (one SQLite file per bot), global `fetch`, `node:crypto`, `node --test`. No framework and no npm dependencies. Text replies come from Claude Haiku through OpenRouter (`MODEL`); voice notes go to OpenAI (`OPENAI_API_KEY`). The bot does not look at customer photos. Every setting is in `code/.env.example`. Style: ESM; no semicolons except in `server.js`, `try.js`; one-line comments that give the reason.

## Message flow
1. **Inbound.** `POST /wa` (Wasender, secret header checked with `sameSecret`) → `parseWasender`; `POST /meta` (signed with `X-Hub-Signature-256`, checked by `metaSigned`) → `parseMeta`. Both return the same row shape: `{waId, phone, fromMe, text, kind, at, name, media?/url?}`. Meta chat ids are `fb:<PSID>` / `ig:<IGSID>`; `isMeta(id)` tells them apart everywhere.
2. **`onMessage`** (server.js):
   - Our own echo → `claimEcho` marks the bot row sent and stops.
   - A human typing on the shop's phone → stored as `role='human'`; the bot stays quiet for `HUMAN_QUIET` (20 min).
   - A customer message → `addMessage` (the `wa_id UNIQUE` index drops duplicates) → `TEST_NUMBERS` filter → `silent()` (production waiting for its keys stays quiet).
   - Voice → `hear()`: transcribe (`media.js`), then rewrite the row's text to «🎤 …».
   - Image → its caption under our note «📷 [صورة من الزبون]» (the model is told it cannot see the photo); a bare image gets the code's fixed line asking the customer to write.
3. **`schedule`** waits for the customer to finish typing: 6 s after a question or a long message, 12 s otherwise; a new message resets the timer. **`enqueue`** keeps one reply at a time per chat.
4. **`reply` → `think` → `answer`** (brain.js):
   - The system prompt = RULES + `renderCard(card)` (cached) + `nowBlock` (date, weekday, pending draft, pending recheck).
   - Tool loop (`TOOLS`): `prepare_order`, `confirm_order`, `show_photos`, `handoff`, `recheck_order`, `remind_later`, run by `orderTools` (shop.js).
   - **Violations** are checked before sending: unknown numbers, foreign contact or time, wrong letters for the customer, false "order confirmed", a summary differing from the code's. One regeneration; after that, the code's own fallback text.
   - Costs go to `costs` and `ai_calls`; guard hits go to `guard_log`.
5. **`sendBubbles`** splits the reply into at most 3 bubbles and shows "typing…" at about 4 characters per second (2–15 s per bubble). It aborts if a human took over or the customer wrote again. Wasender's 5 s gap between sends is kept (the `send` wrapper). Meta caps a message at 1000 bytes (`fitBytes`) and sends the photo caption as its own row.
6. **Jobs** (`jobs.js`, `startJobs`, one tick a minute):
   - Follow-ups (`dueFollowUps`).
   - The question before shipping (`dueRechecks`, at 10:00 the next day).
   - Retention: chats deleted after 60 days, orders kept.
   - A daily SQLite backup (7 kept).
   - The sweep: unanswered chats are retried, and 3 failures in 30 min block a retry.
7. **Health.** `GET /health` returns 200, or `waiting for keys` while the bot is silent, or 503 after 5 failed WhatsApp sends in a row.
8. **Boot.** `card.json` is parsed and checked (`checkCard`, shop.js); any problem stops the boot with one Arabic line per problem.

## Modules
| File | Owns |
|---|---|
| `server.js` | boot checks (card, env), the flow above, routes, the sweep, the balance check every 6 h (warns `AGENT_PHONE`) |
| `wa.js` | Wasender: parse webhook, `send` (text or image), presence, `typingMs` |
| `meta.js` | Messenger and Instagram via the Page: parse, signature, send, typing, 24 h window (`META_WINDOW_MS` = 23 h), privacy page |
| `brain.js` | prompt, card rendering, tools schema, guards (`checkReply`, `wrongSummary`, `foreignTime`, `foreignContact`, `falseOrder`, `wrongScript`), reply cleanup, `answer`, `orBalance` |
| `shop.js` | **niche layer**: `checkCard`, wilaya lookup, phone normalising, `priceOrder` (money), summary text, `orderTools`, recheck text |
| `db.js` | schema + additive migrations, messages, drafts and orders, `claimEcho`, costs, `firstTime` (send-once alerts), guard log |
| `jobs.js` | follow-up rules (`optedOut`, `promiseAt`, `remindAt`, quiet hours), rechecks, retention, backup, `startJobs` |
| `media.js` | voice → text; `mediaRoutes` serves product photos at `/media/<name>` (plain names only) |
| `dashboard.js` + `public/index.html` | the owner's board: login cookie, waiting chats and reply, orders and status moves, CSV export, stock switches (written back to `card.json`), 7-day chart |
| `try.js` + `public/try.html` | the local chat simulator (dry run only) |
| `report.js` | daily numbers in the terminal |

## Data (SQLite, `db.js`)
| Table | Holds |
|---|---|
| `chats` | per customer: stage, `human_until`, `handed_off` and reason, follow-up state (`follow_at`, `follow_round`, `follow_kind`) |
| `messages` | every message: `role` is `student` (the customer), `bot` or `human`; `status` is null, `sent` or `failed`; `media` |
| `orders` | draft → confirmed → shipped → delivered / returned / cancelled; items JSON; fee and total from code; recheck state |
| `costs`, `ai_calls` | money spent per day, tokens per call |
| `guard_log` | every guard firing |
| `alerts` | keys of alerts already sent today (send once, survives restarts) |

Migrations are additive (`ALTER TABLE … ADD COLUMN` behind a `PRAGMA table_info` check), and are wrapped in BEGIN/COMMIT when there are several.

## Tests
`node --test` runs `test/*.test.js`: a pure function or an in-memory DB per case, HTTP routes on port 0, and fake `fetchImpl` for every outside call. Each test name says the behaviour, and many carry the story of the bug they lock.
