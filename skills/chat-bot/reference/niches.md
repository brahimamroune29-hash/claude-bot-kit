# Niches: what changes per client type

The core is shared and stays as it is: channels, the server flow, the guard framework, follow-ups, the dashboard skeleton, hosting. The niche layer is the part you rewrite: the card schema, `shop.js` (tools and money), the tool list and RULES in `brain.js`, the order or booking table, the niche jobs, and the dashboard sections.

## Shop: cash-on-delivery orders (the reference, `code/`)
- **Card:** products (price in دج, variants, photos, stock), fee per wilaya for home and office, delivery delay, policy, FAQ.
- **Flow:** product + variant + quantity → name and phone → wilaya and address → home or office. `prepare_order` prices it in code and returns the summary. The customer says «نعم» to a summary the bot showed; `confirm_order` runs; only then «طلبيتك تأكدت».
- **Jobs:** follow-ups; the next morning at 10:00, «نبعثوها؟» (yes = ready to ship, no = cancelled + owner alert).
- **Five numbers:** conversations → confirmed orders → shipped → delivered → amount delivered.

## Bookings: academy, clinic, any service
- **Card:** offers (course or treatment, for whom, duration, price), upcoming sessions or open slots, place or online link, how to register and pay, phone, FAQ.
- **Flow:** greet → understand the goal → the matching offer → price → booking. One question per reply. Price after the need is clear, or at once if asked twice. Dates only when the person asks or says they want to book (unasked dates, some right after «غالي», push people away). The phone number always sits in the card: people ask for it.
- **Tools:** `prepare_booking` (the code picks only a real slot from the card) → `confirm_booking` (writes the row; «سجّلتك» only after it succeeds) → `handoff`, `remind_later`.
- **Jobs:** confirmation the evening before, asking for «نعم»; a reminder on the morning itself; no-show tracking (people who book and do not come are the usual biggest loss).
- **Five numbers:** conversations → registrations → attended the first session → paid → amount.

## Adding a niche
1. Write the card schema, its `checkCard` (boot refuses a broken card), and fill a test card.
2. Copy `shop.js` to `<niche>.js` and keep its shape: pure pricing or slot functions, plus one tool runner.
3. Change `TOOLS`, the RULES flow lines, and the "done" guard (`falseOrder` → false booking).
4. Rename the order table only if the dashboard and CSV change with it. Tests first for each step.
