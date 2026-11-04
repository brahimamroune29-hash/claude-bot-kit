import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import {
  answer, buildSystem, checkReply, costOf, langOf, studentScript, dropEcho, dropMeta, dropRepeats, falseOrder, fieldReject,
  foreignContact, foreignTime, handoffLine, renderCard, wrongSummary, orBalance, isClosing, closingLine, orderDoneLine, moroccan, dropNote, dropGreeting, nearSame, nowBlock, scriptOf, softAi, splitReply, TOOLS, textToolCalls, toMessages, tooShort, wrongScript,
} from '../src/brain.js'

const card = JSON.parse(readFileSync(new URL('./card.sample.json', import.meta.url), 'utf8'))
const S = (text) => ({ role: 'student', text })
const B = (text) => ({ role: 'bot', text })

// ═══ fake LLM ═══
const text = (t, usage = { input_tokens: 100, output_tokens: 20 }) => ({ content: [{ type: 'text', text: t }], usage, stop_reason: 'end_turn' })
const use = (name, input, id = `tu_${name}`) => ({ content: [{ type: 'tool_use', id, name, input }], usage: { input_tokens: 100, output_tokens: 10 }, stop_reason: 'tool_use' })
// script items: a body object => 200, {status} => that status, Error => thrown
function fake(script) {
  const calls = []
  const fetchImpl = async (url, opts) => {
    calls.push({ url, headers: opts.headers, body: JSON.parse(opts.body) })
    const next = script.shift()
    if (next instanceof Error) throw next
    if (next?.status) return { ok: false, status: next.status, json: async () => ({ error: { message: 'boom' } }) }
    return { ok: true, status: 200, json: async () => next }
  }
  return { fetchImpl, calls }
}
const run = (script, history, runTool = async () => ({ ok: true, message: 'تم' })) => {
  const f = fake(script)
  return answer({ card, history, apiKey: 'k', model: 'm', fetchImpl: f.fetchImpl, runTool, now: new Date('2026-11-01T10:00:00Z') }).then((r) => ({ ...r, ...f, tokens: r.calls })) // f.calls = requests sent; tokens = answer().calls
}

// ═══ buildSystem / TOOLS ═══
test('buildSystem: deterministic; every product, price, variant, fee group, policy, phone and FAQ in the card text', () => {
  const a = buildSystem(card)
  assert.equal(a, buildSystem(structuredClone(card)))
  for (const p of card.products) {
    assert.ok(a.includes(p.id) && a.includes(p.name) && a.includes(`${p.price} دج`), p.id)
    for (const [k, vs] of Object.entries(p.variants ?? {})) { assert.ok(a.includes(k)); for (const v of vs) assert.ok(a.includes(v), v) }
  }
  for (const w of card.delivery.wilayas) { assert.ok(a.includes(w.name), w.name); assert.ok(a.includes(`${w.home} دج`) && a.includes(`${w.office} دج`)) }
  for (const x of [card.phone, card.hours, card.delivery.pay, card.delivery.delay, card.policy, card.faq[0].a]) assert.ok(a.includes(x), x)
  assert.match(a, /سؤال واحد/)
  assert.match(a, /prepare_order/)
  assert.match(a, /confirm_order/)
  assert.match(a, /handoff/)
  assert.ok(!/enroll_trial/.test(a))
})
test('renderCard: the wilaya fee table is grouped by identical fees (far fewer lines than 58)', () => {
  const lines = renderCard(card).split('\n').filter((l) => /^- للمنزل \d+ دج/.test(l))
  assert.ok(lines.length >= 3 && lines.length <= 8, String(lines.length))
  assert.ok(lines.some((l) => l.includes('الجزائر (16)') && l.includes('للمنزل 400 دج / للمكتب 300 دج')))
})

test('TOOLS: prepare_order, confirm_order, show_photos and handoff in Anthropic format', () => {
  assert.deepEqual(TOOLS.map((t) => t.name), ['prepare_order', 'confirm_order', 'show_photos', 'handoff', 'recheck_order', 'remind_later'])
  assert.deepEqual(TOOLS[0].input_schema.required, ['items', 'name', 'phone', 'wilaya', 'address', 'delivery'])
  assert.deepEqual(TOOLS[0].input_schema.properties.delivery.enum, ['home', 'office'])
  assert.equal(TOOLS[0].input_schema.properties.items.items.properties.variant.type, 'object')
  assert.deepEqual(TOOLS[1].input_schema.properties, {})
  assert.deepEqual(TOOLS[3].input_schema.required, ['reason'])
})

// ═══ guards: numbers ═══
test('checkReply: an invented price is flagged; card prices pass in any thousand format', () => {
  assert.deepEqual(checkReply('الساعة بـ 4900 دج', card), ['4900'])
  assert.deepEqual(checkReply('الساعة بـ 4800 دج', card), [])
  assert.deepEqual(checkReply('الساعة بـ 4 800 دج و 4.800 دج و ٤٨٠٠ دج', card), [])
  assert.deepEqual(checkReply('La montre coûte 4800 DA', card), [])
  assert.deepEqual(checkReply('La montre coûte 4000 DA', card), ['4000'])
  assert.deepEqual(checkReply('بين 2200 و 7000 دج', card), ['7000'])
  assert.deepEqual(checkReply('التوصيل للجزائر 400 دج وللمكتب 300 دج', card), [])
})
test('checkReply: counts, hours, delay and phone are not prices', () => {
  assert.deepEqual(checkReply('قميصين، 3 ألوان، من 24 إلى 72 ساعة', card), [])
  assert.deepEqual(checkReply('نفتحو من 9:00 إلى 21:00', card), [])
  assert.deepEqual(checkReply('اتصل بـ 0555 123 456', card), []) // phone is the other guard's job
})
test('checkReply: Algerian conventions (million centimes = 10 000 DA, thousands)', () => {
  assert.deepEqual(checkReply('الساعة 4 ألف دج', card), ['4000']) // 4 thousand = 4000, not a card price
  assert.deepEqual(checkReply('العطر 3500 دج', card), [])
  assert.deepEqual(checkReply('الطقم 9 آلاف دج', card), ['9000'])
})
test('checkReply: a total is allowed only if a tool result of this turn carries it', () => {
  assert.deepEqual(checkReply('المجموع 7600 دج', card), ['7600'])
  assert.deepEqual(checkReply('المجموع 7600 دج', card, 'المجموع: 7600 دج، الدفع عند الاستلام.'), [])
  assert.deepEqual(checkReply('المجموع 7700 دج', card, 'المجموع: 7600 دج'), ['7700'])
  assert.deepEqual(checkReply('المجموع 7 600 دج', card, 'المجموع: 7600 دج'), [])
})
test('checkReply: invented «free» is flagged, but the card own «تخفيض» / «تُخصم» are fine', () => {
  assert.deepEqual(checkReply('الحصة التجريبية مجانية', card), ['مجانية'])
  assert.deepEqual(checkReply('La séance est gratuite', card), ['gratuite'])
  assert.deepEqual(checkReply('لا، ما كاين تخفيض، السعر ثابت', card), [])
})

// ═══ guards: foreign contact ═══
test('foreignContact: invented phone, link, domain and handle are flagged', () => {
  assert.equal(foreignContact('كلمنا على 0661 22 33 44', card).length, 1)
  assert.equal(foreignContact('رقمنا +213 770 11 22 33', card).length, 1)
  assert.equal(foreignContact('0770.11.22.33', card).length, 1)
  assert.equal(foreignContact('0555112233', card).length, 1)
  assert.equal(foreignContact('سجّل هنا https://example.com/join', card).length, 1)
  assert.equal(foreignContact('زر academie-xyz.com', card).length, 1)
  assert.equal(foreignContact('تابعنا على @academie_fake', card).length, 1)
})
test('foreignContact: the card phone passes in any spacing; dates, times, prices do not look like phones', () => {
  for (const p of ['0555 98 76 54', '0555987654', '0555.98.76.54', '0555-98-76-54', '+213 555 98 76 54', '00213555987654', '+213555987654'])
    assert.deepEqual(foreignContact(`عيطلنا على ${p}`, card), [], p)
  assert.deepEqual(foreignContact('يوم 2026-11-08 10:00 بـ 6000 دج، 500 دج للتجريبية، من 9:00 إلى 18:00', card), [])
  assert.deepEqual(foreignContact('وين نلقاوكم؟ شارع ديدوش مراد', card), [])
})
test('foreignContact: a link that is in the card passes', () => {
  const withLink = { ...card, site: 'https://www.boutique-demo.dz/commande', ig: '@boutique_demo' }
  assert.deepEqual(foreignContact('زورونا على boutique-demo.dz/commande وتابعنا @boutique_demo', withLink), [])
  assert.equal(foreignContact('زورونا على other.dz', withLink).length, 1)
})

test('falseOrder: a confirmed-order claim without confirm_order is flagged (darja, Latin darja, French)', () => {
  for (const t of ['طلبيتك تأكدت', 'طلبيتك تسجلت', 'مليح، تم تأكيد طلبك', 'تم تسجيل طلبيتك', 'طلبك مؤكد', 'راهي في الطريق', 'سجلت طلبك', 'طلبيتك راهي في الطريق',
    'commande confirmée', 'Votre commande est enregistrée', "Je vous ai bien confirmé votre commande", 'talabitek tsajlet', 'talabtek ta2akdet', 'talabitek rahi f tari9', 'rahi f tari9'])
    assert.ok(falseOrder(t, false).length, t)
})
test('falseOrder: a successful confirm_order, a question, a negation or a conditional is not a false claim', () => {
  assert.deepEqual(falseOrder('طلبيتك تأكدت', true), [])
  for (const t of ['تحب نأكدو طلبيتك؟', 'واش طلبيتك تأكدت؟', 'ما تأكدتش طلبيتك بعد', 'باش طلبيتك تتأكد قولي نعم', 'إذا قلت نعم طلبيتك تأكدت', 'ملخص الطلب: ساعة فضي', 'الطلب يوصلك من 24 إلى 72 ساعة', 'Voulez-vous confirmer la commande ?', 'talabitek mazal ma tsajlatch'])
    assert.deepEqual(falseOrder(t, false), [], t)
})

// ═══ shape of the reply ═══
test('splitReply: one line per bubble, max 3, lists stay together, no trailing full stop', () => {
  assert.deepEqual(splitReply('مرحبا.\nواش تحب تطلب؟'), ['مرحبا', 'واش تحب تطلب؟'])
  assert.deepEqual(splitReply('أ\nب\nج\nد\nه'), ['أ', 'ب', 'ج\nد\nه'])
  assert.deepEqual(splitReply('الدورات:\n- إنجليزية\n- فرنسية\nأيهما؟'), ['الدورات:\n- إنجليزية\n- فرنسية', 'أيهما؟'])
  assert.deepEqual(splitReply(''), [])
})
test('tooShort: a bare greeting to a real question; a question back is fine', () => {
  assert.equal(tooShort('مرحبا', 'شحال السعر؟'), true)
  assert.equal(tooShort('مرحبا، واش تحب تطلب؟', 'شحال السعر؟'), false)
  assert.equal(tooShort('مرحبا', 'سلام'), false)
})
test('dropMeta / dropEcho / textToolCalls: internal text never reaches the student', () => {
  assert.equal(dropMeta('Bien sûr, voici la même réponse sans le mot :\nLe cours coûte 6000 DA'), 'Le cours coûte 6000 DA')
  assert.equal(dropMeta('الأوقات:\nمن 9 حتى 17'), 'الأوقات:\nمن 9 حتى 17')
  assert.equal(dropEcho('تم.\nمرحبا بيك'), 'مرحبا بيك')
  const t = textToolCalls('نسجلك؟\n<function_calls>\n<invoke name="handoff">\n<parameter name="reason">غضب</parameter>\n</invoke>\n</function_calls>')
  assert.deepEqual(t, { text: 'نسجلك؟', calls: [{ name: 'handoff', input: { reason: 'غضب' } }] })
  const inj = textToolCalls('تمام\n<invoke name="enroll_trial"><parameter name="slot_id">t1</parameter></invoke>')
  assert.deepEqual(inj, { text: 'تمام', calls: [] }) // enroll never runs from text
  assert.equal(textToolCalls('<function_calls').text, '')
  assert.equal(textToolCalls('{"a":1}\nمرحبا').text, 'مرحبا')
})
test('nearSame / dropRepeats: the same question twice in two minutes is asked once', () => {
  assert.equal(nearSame('واش تحب تطلب؟', 'واش تحب تطلب ؟'), true)
  assert.equal(nearSame('الفرنسية 5500 دج', 'الفرنسية 4000 دج'), false)
  const now = Date.parse('2026-11-01T10:00:00Z')
  const rows = [{ role: 'bot', text: 'واش تحب تطلب؟', at: new Date(now - 30_000).toISOString() }]
  assert.equal(dropRepeats('أهلا\nواش تحب تطلب؟', rows, now), 'أهلا')
  assert.equal(dropRepeats('واش تحب تطلب؟', rows, now), 'واش تحب تطلب؟') // never empty
  assert.equal(dropRepeats('أهلا\nواش تحب تطلب؟', [{ ...rows[0], at: new Date(now - 300_000).toISOString() }], now), 'أهلا\nواش تحب تطلب؟')
  assert.equal(dropRepeats('أهلا\nواش تحب تطلب؟', [{ role: 'bot', text: 'واش تحب تطلب؟' }], now), 'أهلا\nواش تحب تطلب؟') // no time => nothing dropped
})

// ═══ cost / provider fields ═══
test('costOf: provider cost wins; else 1h cache write 2x, 5m write 1.25x, read 0.1x', () => {
  const P = { input: 2, output: 10 }
  assert.equal(costOf({ cost: 0.5 }, P), 0.5)
  assert.equal(costOf(undefined, P), 0)
  assert.equal(costOf({ cache_creation_input_tokens: 1e6 }, P), 2.5)
  assert.equal(costOf({ cache_creation_input_tokens: 1e6, cache_creation: { ephemeral_1h_input_tokens: 1e6 } }, P), 4)
  assert.equal(costOf({ cache_read_input_tokens: 1e6, output_tokens: 1e5 }, P), 0.2 + 1)
  assert.ok(costOf({ input_tokens: 1000, output_tokens: 100 }) > 0) // default Haiku constants
})
test('softAi strips provider/thinking and the 1h ttl; fieldReject matches only 4xx that blame them', () => {
  const body = { model: 'm', provider: { order: ['anthropic'] }, thinking: {}, system: [{ type: 'text', text: 'a', cache_control: { type: 'ephemeral', ttl: '1h' } }, { type: 'text', text: 'b' }] }
  assert.deepEqual(softAi(body), { model: 'm', system: [{ type: 'text', text: 'a', cache_control: { type: 'ephemeral' } }, { type: 'text', text: 'b' }] })
  assert.equal(fieldReject(400, 'Unknown field: provider'), true)
  assert.equal(fieldReject(400, 'messages: roles must alternate'), false)
  assert.equal(fieldReject(429, 'provider rate limited'), false)
  assert.equal(fieldReject(500, 'provider error'), false)
})

// ═══ history => messages ═══
test('toMessages: student=user, bot/human=assistant, same role merges, starts with user', () => {
  const m = toMessages([B('أهلا بيك'), { role: 'human', text: 'معاك أحمد' }, S('سلام'), S('شحال السعر؟'), B('6000 دج'), S('')])
  assert.deepEqual(m, [
    { role: 'user', content: '(بداية المحادثة)' },
    { role: 'assistant', content: 'أهلا بيك\nمعاك أحمد' },
    { role: 'user', content: 'سلام\nشحال السعر؟' },
    { role: 'assistant', content: '6000 دج' },
  ])
  assert.equal(toMessages([S('a')])[0].role, 'user')
})

// ═══ answer() ═══
test('answer: a clean reply goes through; request shape (cache blocks, provider pin, headers, history merge); usd summed', async () => {
  const r = await run([text('أهلا بيك! واش تحب تطلب؟', { input_tokens: 1_000_000, output_tokens: 0, cost: 0.25 })], [S('سلام'), S('مرحبا')])
  assert.deepEqual({ reply: r.reply, handoff: r.handoff, usd: r.usd, guards: r.guards }, { reply: 'أهلا بيك! واش تحب تطلب؟', handoff: null, usd: 0.25, guards: [] })
  const c = r.calls[0]
  assert.equal(c.url, 'https://openrouter.ai/api/v1/messages')
  assert.equal(c.headers.authorization, 'Bearer k')
  assert.equal(c.headers['anthropic-version'], '2023-06-01')
  assert.deepEqual(c.body.provider, { order: ['anthropic'], allow_fallbacks: true })
  assert.deepEqual(c.body.system[0].cache_control, { type: 'ephemeral', ttl: '1h' })
  assert.equal(c.body.system[0].text, buildSystem(card))
  assert.equal(c.body.system[1].cache_control, undefined)
  assert.match(c.body.system[1].text, /2026-11-01 11:00/)
  assert.equal(c.body.max_tokens, 6000)
  assert.deepEqual(c.body.messages, [{ role: 'user', content: 'سلام\nمرحبا' }])
  assert.deepEqual(c.body.tools.map((t) => t.name), ['prepare_order', 'confirm_order', 'show_photos', 'handoff', 'recheck_order', 'remind_later'])
})

test('answer: invented price => one retry with a correction note and tools off; fixed second answer passes', async () => {
  const r = await run([text('الساعة بـ 4900 دج. واش تحب تطلبها؟'), text('الساعة بـ 4800 دج. تحب تطلبها؟')], [S('شحال سعر الساعة؟')])
  assert.equal(r.reply, 'الساعة بـ 4800 دج. تحب تطلبها؟')
  assert.equal(r.handoff, null)
  assert.deepEqual(r.guards, [{ guard: 'number', action: 'retry' }])
  assert.equal(r.calls.length, 2)
  assert.deepEqual(r.calls[1].body.tool_choice, { type: 'none' })
  const msgs = r.calls[1].body.messages
  assert.equal(msgs.at(-2).role, 'assistant')
  assert.equal(msgs.at(-1).role, 'user')
  assert.match(msgs.at(-1).content, /4900/)
})

test('answer: a violation twice => handoff guard:number with the fixed line', async () => {
  const r = await run([text('بـ 7000 دج. واش تحب تطلبها؟'), text('بـ 7500 دج. واش تحب تطلبها؟')], [S('شحال السعر؟')])
  assert.equal(r.handoff, 'guard:number')
  assert.equal(r.reply, 'واحد من الفريق يجاوبك قريب إن شاء الله، ولا عيّطلنا على 0555 98 76 54.')
  assert.deepEqual(r.guards, [{ guard: 'number', action: 'retry' }, { guard: 'number', action: 'handoff' }])
  assert.equal(r.calls.length, 2)
})

test('answer: French student gets the French handoff line', async () => {
  const r = await run([text('La montre coûte 9999 DA, vous voulez commander ?'), text('La montre coûte 9999 DA, vous voulez commander ?')], [S('Bonjour, combien coûte la montre ?')])
  assert.equal(r.handoff, 'guard:number')
  assert.match(r.reply, /équipe.*0555 98 76 54/)
})

test('answer: invented phone and link are guarded', async () => {
  const r = await run([text('كلمنا على 0661 22 33 44. واش تحب تطلب؟'), text('كلمنا على 0555 98 76 54. واش تحب تطلب؟')], [S('نحب نتصل بيكم')])
  assert.equal(r.reply, 'كلمنا على 0555 98 76 54. واش تحب تطلب؟')
  assert.deepEqual(r.guards, [{ guard: 'contact', action: 'retry' }])
  const l = await run([text('اطلب من هنا https://fake.example.com. واش تحب تطلب؟'), text('اطلب من هنا https://fake.example.com. واش تحب تطلب؟')], [S('كيفاش نطلب؟')])
  assert.equal(l.handoff, 'guard:contact')
})

const ORDER = { items: [{ product_id: 'p2', variant: { 'اللون': 'فضي' }, qty: 1 }], name: 'أحمد بن علي', phone: '0555123456', wilaya: 'العاصمة', address: 'شارع ديدوش مراد 12', delivery: 'home' }
const SUMMARY = 'ملخص الطلب:\n- ساعة كلاسيك رجالية (اللون: فضي): 4800 دج × 1 = 4800 دج\nالتوصيل إلى الجزائر (للمنزل): 400 دج\nالمجموع: 5200 دج، الدفع عند الاستلام.'
test('answer: tool loop calls runTool, sends tool_result back; the total from prepare_order is allowed in the reply', async () => {
  const seen = []
  const runTool = async (name, input) => { seen.push([name, input]); return { ok: true, message: SUMMARY } }
  const r = await run([use('prepare_order', ORDER), text('ملخص طلبك:\nساعة فضي × 1 = 4800 دج\nالتوصيل 400 دج، المجموع 5200 دج\nنأكدو؟')],
    [S('نحب ساعة فضي'), B('وين تسكن؟'), S('العاصمة، شارع ديدوش مراد 12، اسمي أحمد بن علي 0555123456')], runTool)
  assert.deepEqual(seen, [['prepare_order', ORDER]])
  assert.match(r.reply, /5200/)
  assert.deepEqual(r.guards, [])
  assert.equal(r.handoff, null)
  const last = r.calls[1].body.messages
  assert.equal(last.at(-2).role, 'assistant')
  assert.equal(last.at(-2).content[0].type, 'tool_use')
  assert.deepEqual(last.at(-1), { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'tu_prepare_order', content: SUMMARY, is_error: false }] })
})

test('answer: total 7600 is allowed right after prepare_order returned it; the same 7600 invented without a tool is a violation', async () => {
  const msg = 'المجموع: 7600 دج، الدفع عند الاستلام.'
  const ok = await run([use('prepare_order', ORDER), text('المجموع 7600 دج مع التوصيل. نأكدو؟')], [S('نعم كمل')], async () => ({ ok: true, message: msg }))
  assert.deepEqual(ok.guards, [])
  assert.match(ok.reply, /7600/)
  const bad = await run([text('المجموع 7600 دج مع التوصيل. نأكدو؟'), text('المجموع 7600 دج مع التوصيل. نأكدو؟')], [S('شحال المجموع؟')])
  assert.equal(bad.handoff, 'guard:number')
  assert.deepEqual(bad.guards, [{ guard: 'number', action: 'retry' }, { guard: 'number', action: 'handoff' }])
  // a number from a tool result of ANOTHER turn does not count: only this turn's results are used
  const other = await run([text('المجموع 7600 دج. نأكدو؟'), text('المجموع 7600 دج. نأكدو؟')], [S('نعم'), B(msg), S('شحال المجموع؟')])
  assert.equal(other.handoff, 'guard:number')
})

test('answer: a tool-result total does not license a different total', async () => {
  const r = await run([use('prepare_order', ORDER), text('المجموع 7700 دج. نأكدو؟'), text('المجموع 7600 دج. نأكدو؟')], [S('نعم')], async () => ({ ok: true, message: 'المجموع: 7600 دج' }))
  assert.deepEqual(r.guards, [{ guard: 'number', action: 'retry' }])
  assert.match(r.reply, /7600/)
})

test('answer: «طلبيتك تأكدت» is allowed after a successful confirm_order, a violation after a failed one or none', async () => {
  const ok = await run([use('confirm_order', {}), text('طلبيتك تأكدت. توصلك من 24 إلى 72 ساعة')], [S('نعم')], async () => ({ ok: true, message: 'confirmed #5' }))
  assert.deepEqual(ok.guards, [])
  assert.match(ok.reply, /تأكدت/)
  const failed = await run([use('confirm_order', {}), text('طلبيتك تأكدت'), text('ما لقيتش طلب جاهز، وش تحب تطلب؟')], [S('نعم')], async () => ({ ok: false, message: 'no draft' }))
  assert.deepEqual(failed.guards, [{ guard: 'false-order', action: 'retry' }])
  assert.equal(failed.handoff, null)
  const none = await run([text('طلبيتك تأكدت، راهي في الطريق'), text('تم تسجيل طلبيتك')], [S('نعم')])
  assert.equal(none.handoff, 'guard:false-order')
  assert.deepEqual(none.guards, [{ guard: 'false-order', action: 'retry' }, { guard: 'false-order', action: 'handoff' }])
})

test('answer: the handoff tool short-circuits (one call, no runTool, fixed line)', async () => {
  let ran = 0
  const r = await run([use('handoff', { reason: 'طلب استرجاع المال' })], [S('نحب نرجع فلوسي')], async () => { ran++; return { ok: true, message: '' } })
  assert.equal(r.handoff, 'طلب استرجاع المال')
  assert.equal(r.reply, 'واحد من الفريق يجاوبك قريب إن شاء الله، ولا عيّطلنا على 0555 98 76 54.')
  assert.equal(r.calls.length, 1)
  assert.equal(ran, 0)
})

test('answer: tool loop stops after 3 rounds and forces a text answer', async () => {
  const script = [use('prepare_order', ORDER, 'a'), use('prepare_order', ORDER, 'b'), use('prepare_order', ORDER, 'c'), text('عندي مشكل، واش تحب تعاود الطلب؟')]
  const r = await run(script, [S('نحب ساعة')], async () => ({ ok: false, message: 'خطأ' }))
  assert.equal(r.calls.length, 4)
  assert.deepEqual(r.calls[3].body.tool_choice, { type: 'none' })
  assert.match(r.reply, /تعاود/)
})

test('answer: order already confirmed but the reply keeps failing a guard => fixed confirmation line, never a handoff', async () => {
  const confirm = async () => ({ ok: true, message: 'confirmed #5' })
  const bad = 'Commande الدفع عند الاستلام والتوصيل خلال يومين'
  const ar = await run([use('confirm_order', {}), text('طلبيتك تأكدت، المجموع 9999 دج'), text('طلبيتك تأكدت، المجموع 9999 دج')], [S('نعم')], confirm)
  assert.equal(ar.handoff, null)
  assert.equal(ar.reply, orderDoneLine([S('نعم')]))
  assert.deepEqual(ar.guards, [{ guard: 'number', action: 'retry' }, { guard: 'number', action: 'trimmed' }])
  const la = await run([use('confirm_order', {}), text(bad), text(bad)], [S('oui wah')], confirm)
  assert.equal(la.handoff, null)
  assert.equal(la.reply, orderDoneLine([S('oui wah')]))
  assert.match(orderDoneLine([S('oui wah')]), /^[\x00-\x7f]+$/) // Latin only
  assert.match(orderDoneLine([S('Bonjour, je confirme la commande')]), /commande/)
  assert.match(orderDoneLine([S('نعم')]), /تأكدت/)
  assert.ok(!falseOrder(orderDoneLine([S('نعم')]), true).length)
})

test('nowBlock / answer: a saved draft awaiting the customer yes is stated in the per-turn block', async () => {
  const now = new Date('2026-11-01T10:00:00Z')
  assert.ok(!/confirm_order/.test(nowBlock(now, 'arabic', true)))
  assert.match(nowBlock(now, 'arabic', true, 'ملخص الطلب: X'), /confirm_order[\s\S]*ملخص الطلب: X|ملخص الطلب: X[\s\S]*confirm_order/)
  const f = fake([text('أهلا، واش تحب تطلب؟')])
  await answer({ card, history: [S('سلام')], pending: 'ملخص الطلب: Y', apiKey: 'k', model: 'm', fetchImpl: f.fetchImpl, runTool: async () => ({ ok: true, message: '' }) })
  assert.match(f.calls[0].body.system[1].text, /ملخص الطلب: Y/)
  assert.ok(!f.calls[0].body.system[0].text.includes('ملخص الطلب: Y')) // the cached block stays the same
  // the draft's own numbers are legitimate in the reply; others are not
  const ok = await answer({ card, history: [S('شحال المجموع؟')], pending: 'المجموع: 7600 دج', apiKey: 'k', model: 'm', fetchImpl: fake([text('المجموع 7600 دج، نأكدو؟')]).fetchImpl, runTool: async () => ({ ok: true, message: '' }) })
  assert.deepEqual(ok.guards, [])
})

test('answer: a tool call written as text is stripped; a text handoff still escalates', async () => {
  const r = await run([text('أهلا\n<invoke name="confirm_order"></invoke>\nواش تحب تطلب؟')], [S('سلام')])
  assert.equal(r.reply, 'أهلا\nواش تحب تطلب؟')
  assert.equal(r.calls.length, 1) // confirm_order never runs from text
  const h = await run([text('<invoke name="handoff"><parameter name="reason">غضب</parameter></invoke>')], [S('انتم نصابين')])
  assert.equal(h.handoff, 'غضب')
})

test('answer: empty or too-short reply => retry', async () => {
  const r = await run([text('مرحبا'), text('الساعة 4800 دج، تحب تعرف أكثر؟')], [S('شحال سعر الساعة؟')])
  assert.deepEqual(r.guards, [{ guard: 'short', action: 'retry' }])
  assert.match(r.reply, /4800/)
})

test('answer: network error or 5xx => one retry, then handoff ai-error, never throws', async () => {
  const a = await run([new Error('ECONNRESET'), new Error('ECONNRESET')], [S('سلام')])
  assert.deepEqual({ reply: a.reply, handoff: a.handoff, usd: a.usd }, { reply: null, handoff: 'ai-error', usd: 0 })
  assert.equal(a.calls.length, 2)
  const b = await run([{ status: 503 }, { status: 502 }], [S('سلام')])
  assert.equal(b.handoff, 'ai-error')
  assert.equal(b.calls.length, 2)
  const c = await run([{ status: 503 }, text('أهلا، واش تحب تطلب؟')], [S('سلام')])
  assert.equal(c.reply, 'أهلا، واش تحب تطلب؟')
  const d = await run([{ status: 401 }], [S('سلام')])
  assert.equal(d.handoff, 'ai-error')
  assert.equal(d.calls.length, 1) // 4xx is final
})

test('answer: a 4xx that blames the new fields is retried once without them', async () => {
  const f = fake([{ status: 400 }, text('أهلا، واش تحب تطلب؟')])
  const orig = f.fetchImpl
  const fetchImpl = async (u, o) => { const r = await orig(u, o); if (!r.ok) r.json = async () => ({ error: { message: 'Unknown field: provider' } }); return r }
  const r = await answer({ card, history: [S('سلام')], apiKey: 'k', model: 'm', fetchImpl, runTool: async () => ({ ok: true, message: '' }) })
  assert.equal(r.reply, 'أهلا، واش تحب تطلب؟')
  assert.equal(f.calls[1].body.provider, undefined)
  assert.deepEqual(f.calls[1].body.system[0].cache_control, { type: 'ephemeral' })
})

test('answer: note is a final system turn, merges after a student turn, does not count as the student text', async () => {
  const f = fake([text('أهلا، كيف حالك؟ نحبو نطمئن عليك.')])
  await answer({ card, history: [S('سلام'), B('أهلا، واش تحب تطلب؟')], note: 'تابع بلطف', apiKey: 'k', model: 'm', fetchImpl: f.fetchImpl, runTool: async () => ({ ok: true, message: '' }) })
  const m = f.calls[0].body.messages
  assert.deepEqual(m.map((x) => x.role), ['user', 'assistant', 'user'])
  assert.equal(m[2].content, '(ملاحظة من النظام، ماشي من الزبون: تابع بلطف)')
  // history ending with a student turn: merged into the same user turn, alternation kept
  const g = fake([text('أهلا، كيف حالك؟ نحبو نطمئن عليك.')])
  await answer({ card, history: [S('شحال سعر الساعة؟')], note: 'x', apiKey: 'k', model: 'm', fetchImpl: g.fetchImpl, runTool: async () => ({ ok: true, message: '' }) })
  assert.deepEqual(g.calls[0].body.messages.map((x) => x.role), ['user'])
  assert.match(g.calls[0].body.messages[0].content, /شحال سعر الساعة؟\n\(ملاحظة من النظام/)
  // asked stays the real student text (not the note): short-reply guard still judges against it
  const h = fake([text('ok'), text('الساعة 4800 دج، تحب تعرف أكثر؟')])
  const r = await answer({ card, history: [S('شحال سعر الساعة؟'), B('x')], note: 'n', apiKey: 'k', model: 'm', fetchImpl: h.fetchImpl, runTool: async () => ({ ok: true, message: '' }) })
  assert.deepEqual(r.guards, [{ guard: 'short', action: 'retry' }])
})

// ═══ review fixes (2026-11-01) ═══
test('foreignTime: invented date/time flagged; card slots, opening hours and today pass', () => {
  const now = new Date('2026-11-01T10:00:00Z')
  assert.deepEqual(foreignTime('الحصة يوم 20 نوفمبر على 11:00', card, now), ['20/11', '11:00'])
  assert.deepEqual(foreignTime('الأحد 8 نوفمبر 2026 على 10:00 صباحاً', card, now), ['8/11', '10:00'])
  assert.deepEqual(foreignTime('الأحد 8 نوفمبر 2026 على 10:00 صباحاً', card, now, 'موعد التسليم 2026-11-08 10:00'), []) // a tool result may name it
  assert.deepEqual(foreignTime('نحلو من 9:00 إلى 21:00', card, now), [])
  assert.deepEqual(foreignTime('نسكرو على 18:00', card, now), ['18:00'])
  assert.deepEqual(foreignTime('lundi 12 novembre à 10h', card, now), ['12/11', '10:00'])
  assert.deepEqual(foreignTime('اليوم 1 نوفمبر', card, now), [])
})

test('checkReply: banned words are not whitelisted by a FAQ question; negated sentences and «تتخصم» pass', () => {
  assert.ok(checkReply('عندنا خصم وتخفيض للإخوة', card).length > 0)
  assert.deepEqual(checkReply('ما كاينش تخفيض، السعر ثابت للجميع', card), [])
  assert.deepEqual(checkReply('السعر يتخصم عند الاستلام 3500 دج', card), [])
})

test('answer: a reply still short after the retry is sent, not handed off', async () => {
  const r = await run([text('4800 دج'), text('4800 دج للساعة')], [S('شحال السعر؟')])
  assert.equal(r.handoff, null)
  assert.equal(r.reply, '4800 دج للساعة')
})

test('answer: ai-error carries the error message', async () => {
  const r = await run([new Error('network down'), new Error('network down')], [S('سلام')])
  assert.equal(r.handoff, 'ai-error')
  assert.match(r.error, /network down/)
})

// ═══ script follows the student ═══
test('scriptOf: letters only; digits, emoji, punctuation ignored; none => null', () => {
  assert.equal(scriptOf('سلام عليكم'), 'arabic')
  assert.equal(scriptOf('salam chhal el prix 3la 7'), 'latin')
  assert.equal(scriptOf('Bonjour, je veux étudier'), 'latin')
  assert.equal(scriptOf('3 7 9 😀 !!'), null)
  assert.equal(scriptOf(''), null)
  assert.equal(scriptOf(undefined), null)
})
test('wrongScript: script mismatch and mixed words are violations', () => {
  assert.ok(wrongScript('Wa 3likoum salam, marhba bik f el boutique!', 'arabic').length)
  assert.ok(wrongScript('وعليكم السلام، مرحبا بيك', 'latin').length)
  assert.deepEqual(wrongScript('وعليكم السلام، مرحبا بيك. الدورة بـ 6000 دج', 'arabic'), [])
  assert.deepEqual(wrongScript('salam, el prix 6000 DA', 'latin'), [])
  assert.deepEqual(wrongScript('الثمن 6000 DA في الشهر', 'arabic'), [])
  for (const w of ['Dورة', 'nqolك', 'الthaman']) assert.ok(wrongScript(`مرحبا ${w} هنا`, 'arabic').length, w)
  assert.ok(wrongScript(`salam ${'nqolك'} ici`, 'latin').length)
  assert.deepEqual(wrongScript('أي شيء', null), [])
})
test('nowBlock: one explicit script line per turn', () => {
  assert.match(nowBlock(new Date('2026-11-01T10:00:00Z'), 'arabic'), /الزبون يكتب بالحروف العربية.*بالحروف العربية فقط/)
  assert.match(nowBlock(new Date('2026-11-01T10:00:00Z'), 'latin'), /بحروف لاتينية.*لاتينية فقط/)
  assert.ok(!/الزبون يكتب/.test(nowBlock(new Date('2026-11-01T10:00:00Z'))))
})
test('answer: Latin reply to an Arabic-letter student => retry, final Arabic; the per-turn block carries the line', async () => {
  const r = await run([text('Wa 3likoum salam, marhba bik f el boutique!'), text('وعليكم السلام، مرحبا بيك في المتجر. واش تحب تطلب؟')], [S('سلام عليكم لعزيز وش راك')])
  assert.equal(r.reply, 'وعليكم السلام، مرحبا بيك في المتجر. واش تحب تطلب؟')
  assert.ok(r.guards.some((g) => g.guard === 'script' && g.action === 'retry'))
  assert.match(r.calls[0].body.system[1].text, /بالحروف العربية فقط/)
  assert.equal(r.calls[0].body.system[0].text, buildSystem(card))
})
test('answer: Latin student gets Latin reply; Arabic reply twice => handoff guard:script', async () => {
  const ok = await run([text('Salam, la montre b 4800 DA. Wach t7eb tcommandiha?')], [S('salam chhal el prix')])
  assert.deepEqual(ok.guards, [])
  const bad = await run([text('السلام عليكم، الثمن 4800 دج.'), text('السلام عليكم، الثمن 4800 دج.')], [S('salam chhal el prix')])
  assert.equal(bad.handoff, 'guard:script')
})

// ═══ token usage per call ═══
test('answer: calls[] has one entry per model call (tool rounds and retries)', async () => {
  const u1 = { input_tokens: 10, output_tokens: 5, cache_read_input_tokens: 100, cache_creation_input_tokens: 20, cost: 0.001 }
  const u2 = { input_tokens: 7, output_tokens: 3, cost: 0.002 }
  const r = await run([{ ...use('confirm_order', {}), usage: u1 }, text('طلبيتك تأكدت يا أحمد.', u2)], [S('نعم')])
  assert.deepEqual(r.tokens, [
    { input: 10, output: 5, cacheRead: 100, cacheWrite: 20, usd: 0.001 },
    { input: 7, output: 3, cacheRead: 0, cacheWrite: 0, usd: 0.002 },
  ])
  assert.equal(r.usd, 0.003)
})

// ═══ replay-2026-11-01 fixes (invented darja examples) ═══
test('buildSystem: answer-first rules replace the rigid stages; no promises; darja ban list', () => {
  const a = buildSystem(card)
  assert.ok(!/المراحل بالترتيب/.test(a))
  assert.match(a, /الجواب أولاً/)
  assert.match(a, /ديال/)
  assert.match(a, /لا تعد بفعل/)
  assert.match(a, /«شكراً»/)
})
test('handoffLine: follows the student script and carries the card phone', () => {
  assert.equal(handoffLine([S('كيفاش نخلص')], card), 'واحد من الفريق يجاوبك قريب إن شاء الله، ولا عيّطلنا على 0555 98 76 54.')
  assert.match(handoffLine([S('kifach nkhalles')], card), /^Wahed men el fariq yjawbek 9rib inchallah, wla 3ayetlna 3la 0555 98 76 54\.$/)
  assert.match(handoffLine([S('Bonjour, je veux un remboursement')], card), /équipe.*0555 98 76 54/)
  assert.equal(handoffLine([S('كيفاش')], { ...card, phone: undefined }), 'واحد من الفريق يجاوبك قريب إن شاء الله.')
  assert.match(handoffLine([S('x')], { phone: '0555000190 (واتساب الدعم)' }), /0555000190\.$/)
})
test('isClosing: thanks and goodbyes only', () => {
  for (const t of ['شكرا', 'شكرا جزيلا 🙏', 'صحيت', 'merci', 'Merci beaucoup', 'باي', 'barakallah fik', 'ok merci']) assert.ok(isClosing(t), t)
  for (const t of ['شكرا، كيفاش نخلص؟', 'سلام', 'merci mais je veux être remboursé', 'ok', '']) assert.ok(!isClosing(t), t)
  assert.match(closingLine([S('Bonjour'), S('merci')]), /plaisir/) // French needs 2+ French words (third review)
  assert.match(closingLine([S('salam chhal el prix'), B('...'), S('merci')]), /^Allah/) // «merci» after Latin darja stays Latin darja
  assert.match(closingLine([S('merci')]), /الله يسلمك/) // thanks alone say nothing about the script: Arabic default
  assert.match(closingLine([S('shokran')]), /^Allah/)
})
test('answer: handoff tool on a thank-you is not a handoff: one warm line in the student script', async () => {
  const r = await run([use('handoff', { reason: 'شكر' })], [S('كيفاش نخلص'), B('بالبريدي موب'), S('صحيت')])
  assert.equal(r.handoff, null)
  assert.match(r.reply, /الله يسلمك/)
  const f = await run([use('handoff', { reason: 'merci' })], [S('Bonjour'), B('Bonjour'), S('merci')])
  assert.equal(f.handoff, null)
  assert.match(f.reply, /plaisir/)
  const real = await run([use('handoff', { reason: 'استرجاع' })], [S('صحيت، نحب نرجع فلوسي')])
  assert.ok(real.handoff)
})
test('moroccan: clearly Moroccan words only; Algerian ones pass', () => {
  for (const t of ['هذا ديالك', 'الثمن ديال الباقة', 'دابا نبعثلك', 'دبا', 'شنو بغيتي', 'وشنو', 'كيداير', 'dyalek', 'daba nsajlek', 'chno bghiti', 'أنهي لون تحب', 'انهي مقاس', 'ما فماش صور', 'فماش', 'برشا', 'barcha']) assert.ok(moroccan(t).length, t)
  for (const t of ['واش تحب', 'بزاف', 'كيفاش راك', 'ديما نجاوبوك', 'هذا تاعك', 'wach bghiti', 'bzef', 'واش من لون', 'ما كانش صور', 'فماه', 'انهار', 'ديال'.slice(0, 2)]) assert.deepEqual(moroccan(t), [], t)
})
test('answer: Moroccan word => retry with a note; fixed second answer passes; still Moroccan is sent, not handed off', async () => {
  const r = await run([text('هذا ديالك، الساعة الكلاسيك الرجالية عندنا بـ 4800 دج'), text('هذا تاعك، الساعة الكلاسيك الرجالية عندنا بـ 4800 دج')], [S('شحال السعر')])
  assert.deepEqual(r.guards, [{ guard: 'darja', action: 'retry' }])
  assert.equal(r.reply, 'هذا تاعك، الساعة الكلاسيك الرجالية عندنا بـ 4800 دج')
  const again = await run([text('هذا ديالك، الساعة الكلاسيك الرجالية عندنا بـ 4800 دج'), text('هذا ديالك الساعة الكلاسيك الرجالية عندنا بـ 4800 دج')], [S('شحال السعر')])
  assert.equal(again.handoff, null)
  assert.match(again.reply, /4800/)
})
test('dropNote: guard notes never reach the student', () => {
  assert.equal(dropNote('6000 دج في الشهر\n(ملاحظة من النظام، ماشي من الزبون: اكتب بالعربي)'), '6000 دج في الشهر')
  assert.equal(dropNote('راح نكتبلك الخطوات بالعربي فقط\nالسعر 6000 دج'), 'السعر 6000 دج')
  assert.equal(dropNote('السعر 6000 دج'), 'السعر 6000 دج')
})
test('answer: a retry that echoes the note is cleaned before sending', async () => {
  const r = await run([text('Wa 3likoum salam, marhba!'), text('ملاحظة من النظام: راح نكتبلك بالحروف العربية فقط\nوعليكم السلام، واش تحب تطلب؟')], [S('سلام عليكم')])
  assert.equal(r.reply, 'وعليكم السلام، واش تحب تطلب؟')
})
test('dropGreeting: no re-greeting mid-conversation', () => {
  const mid = [S('سلام'), B('أهلا بيك'), S('ايه')]
  // a bare greeting line goes (≤ 3 words); a longer first line may carry an answer and stays (third review)
  assert.equal(dropGreeting('أهلا بيك خويا\nالساعة 4800 دج', mid), 'الساعة 4800 دج')
  assert.equal(dropGreeting('أهلا بيك في الأكاديمية', mid), 'أهلا بيك في الأكاديمية')
  assert.equal(dropGreeting('أهلا بيك\nالسعر 6000', [S('سلام')]), 'أهلا بيك\nالسعر 6000')
  assert.equal(dropGreeting('وعليكم السلام\nالسعر 6000', [S('سلام'), B('x'), S('السلام عليكم')]), 'وعليكم السلام\nالسعر 6000')
})
test('nowBlock: tells the model not to greet again when the chat has started', () => {
  const n = new Date('2026-11-01T10:00:00Z')
  assert.ok(!/ترحّب/.test(nowBlock(n, 'arabic')))
  assert.match(nowBlock(n, 'arabic', true), /لا ترحّب ولا تسلّم/)
})
test('answer: per-turn block says started only when a bot or human turn exists', async () => {
  const a = await run([text('أهلا')], [S('سلام')])
  assert.ok(!/لا ترحّب/.test(a.calls[0].body.system[1].text))
  const b = await run([text('السعر 6000 دج')], [S('سلام'), B('أهلا'), S('شحال')])
  assert.match(b.calls[0].body.system[1].text, /لا ترحّب/)
})

// third review (2026-11-01)
test('studentScript: «ok»/«merci» and one Latin product name do not flip an Arabic-letter student', async () => {
  const { studentScript } = await import('../src/brain.js')
  assert.equal(studentScript([S('كم سعر الدورة'), S('ok')]), 'arabic')
  assert.equal(studentScript([S('سعر Photoshop')]), 'arabic')
  assert.equal(studentScript([S('salam chhal el prix'), S('شكرا')]), 'latin')
})

test('dropGreeting: only a bare greeting line goes, a greeting with an answer stays', async () => {
  const { dropGreeting } = await import('../src/brain.js')
  const h = [S('واش عندكم'), B('عندنا دورات'), S('والفرنسية؟')]
  assert.equal(dropGreeting('أهلا، دورة الفرنسية مناسبة للمبتدئين\nوتدوم شهرين', h), 'أهلا، دورة الفرنسية مناسبة للمبتدئين\nوتدوم شهرين')
  assert.equal(dropGreeting('أهلا بيك خويا\nالسعر 5500 دج', h), 'السعر 5500 دج')
})

test('langOf: one French-looking word («la») does not make Latin darja French', async () => {
  const { langOf } = await import('../src/brain.js')
  assert.equal(langOf([S('la, ma3endich drahem')]), 'latin')
  assert.equal(langOf([S("Bonjour, c'est combien la formation ?")]), 'fr')
})

test('falseOrder: more darja forms of «your order is confirmed»', async () => {
  const { falseOrder } = await import('../src/brain.js')
  for (const t of ['راهي مسجلة طلبيتك', 'الكوموند تاعك ثبتت', 'طلبيتك وصلتنا', 'تمّ الطلب بنجاح'])
    assert.ok(falseOrder(t).length > 0, t)
  for (const t of ['باش نسجلو طلبك نحتاج اسمك', 'تحب نأكدو الطلب؟', 'اذا قلت نعم طلبيتك تتأكد']) assert.deepEqual(falseOrder(t), [], t)
})

test('studentScript: only what the customer typed decides — not voice transcripts, media placeholders or our photo notes', () => {
  const s = (...texts) => studentScript(texts.map((text) => ({ role: 'student', text })))
  assert.equal(s('salam chhal', '🎤 نحب le rouge taille M'), 'latin') // the transcript (Arabic + French) does not flip it
  assert.equal(s('شحال الساعة', '🎤 واش كاين livraison à Oran'), 'arabic')
  assert.equal(s('🎤 واش كاين livraison à Oran'), null) // voice only: no typed script yet
  assert.equal(s('شحال الساعة', '[voice]', 'ok'), 'arabic') // «[voice]» is not Latin writing
  assert.equal(s('📷 [صورة من الزبون]\nchhal hadi'), 'latin') // his caption counts, our note does not
  assert.equal(s('📷 [صورة من الزبون]'), null)
})

test('langOf: a voice placeholder or transcript is never read as French', () => {
  const h = (...texts) => texts.map((text) => ({ role: 'student', text }))
  assert.equal(langOf(h('[voice]')), 'ar')
  assert.equal(langOf(h('🎤 bonjour je veux la montre noire')), 'ar')
})

// ═══ launch review 2026-11-01: the summary the customer sees carries the code's numbers ═══
const TOOL_SUMMARY = 'ملخص الطلب:\n- عطر عود ملكي: 3500 دج × 2 = 7000 دج\nالتوصيل إلى الجزائر (للمنزل): 400 دج\nالمجموع: 7400 دج، الدفع عند الاستلام.\nالاسم: سارة\nالهاتف: 0555123456\nالعنوان: حي النصر'
const prepared = async (name) => (name === 'prepare_order' ? { ok: true, message: `${TOOL_SUMMARY}\nاعرض الملخص على الزبون`, summary: TOOL_SUMMARY } : { ok: true, message: 'تم' })
test('wrongSummary: the total must be there and every price must come from the summary', () => {
  assert.deepEqual(wrongSummary('المجموع 7400 دج، التوصيل 400 دج. نأكدو؟', TOOL_SUMMARY), [])
  assert.deepEqual(wrongSummary('المجموع 7 400 دج. نأكدو؟', TOOL_SUMMARY), [])
  assert.deepEqual(wrongSummary('المجموع: 3500 دج. نأكدو؟', TOOL_SUMMARY), ['7400']) // 3500 is a unit price, not the total
  assert.deepEqual(wrongSummary('التوصيل 600 دج، المجموع 7400 دج', TOOL_SUMMARY), ['600'])
})
test('answer: after prepare_order a reply with a wrong total is retried, then replaced by the code summary', async () => {
  const ok = await run([use('prepare_order', {}), text('عطرين بـ7000 دج والتوصيل 400 دج، المجموع 7400 دج. نأكدو؟')], [S('سارة 0555123456 حي النصر الجزائر للدار')], prepared)
  assert.deepEqual(ok.guards, [])
  const bad = await run([use('prepare_order', {}), text('المجموع: 3500 دج. نأكدو؟'), text('المجموع: 3500 دج. نأكدو؟')], [S('سارة 0555123456 حي النصر الجزائر للدار')], prepared)
  assert.equal(bad.handoff, null)
  assert.ok(bad.reply.startsWith(TOOL_SUMMARY) && /نأكدو/.test(bad.reply))
  assert.deepEqual(bad.guards, [{ guard: 'summary', action: 'retry' }, { guard: 'summary', action: 'trimmed' }])
})
test('TOOLS: remind_later takes days from today and an optional hour', () => {
  const t = TOOLS.find((x) => x.name === 'remind_later')
  assert.deepEqual(t.input_schema.required, []) // «نخمم» with no time is the usual case
  assert.deepEqual(Object.keys(t.input_schema.properties), ['days', 'hour', 'minute'])
  assert.match(nowBlock(new Date('2026-11-01T10:00:00Z')), /الإثنين 1، الثلاثاء 2.*الأحد 7/) // 2026-11-01 is a Sunday
})

// ═══ a shop that sells online only, no shop to visit ═══
test('renderCard: no city in the card = an online shop, said once so «وين راكم؟» is answered, not handed off', () => {
  const online = { ...card, city: '' }
  assert.match(renderCard(online), /نبيع أونلاين بالتوصيل فقط: لا يوجد محل/)
  assert.ok(!/لا يوجد محل/.test(renderCard({ ...card, city: 'وهران' })))
})

// ═══ the OpenRouter balance: a low one warns the owner before the bot stops ═══
test('orBalance: what is left on the OpenRouter key, null when unknown', async () => {
  const ok = async (url, o) => { assert.match(url, /openrouter\.ai\/api\/v1\/credits$/); assert.equal(o.headers.authorization, 'Bearer K'); return { ok: true, json: async () => ({ data: { total_credits: 10, total_usage: 7.25 } }) } }
  assert.equal(await orBalance('K', ok), 2.75)
  assert.equal(await orBalance('K', async () => ({ ok: false, json: async () => ({}) })), null)
  assert.equal(await orBalance('K', async () => { throw new Error('net') }), null)
  assert.equal(await orBalance('', ok), null)
})

test('renderCard: private owner numbers never reach the prompt; «about» is labelled', () => {
  const r = renderCard({ ...card, about: 'ساعات وعطور', owner: { bot_phone: '0555223344', orders_phone: '0555112233' } })
  assert.ok(!r.includes('0555223344') && !r.includes('0555112233'))
  assert.match(r, /ماذا نبيع: ساعات وعطور/)
})

test('feeTable: home-only, office-only and no-delivery wilayas are each said plainly; free comes first', () => {
  const c = structuredClone(card)
  const w = c.delivery.wilayas
  for (const x of w) { x.home = 600; x.office = 400 }
  w[0].home = null; w[1].office = null; w[2].home = null; w[2].office = null; w[3].home = 0
  const r = renderCard(c)
  assert.match(r, /- للمنزل: لا يوجد توصيل \/ للمكتب 400 دج: أدرار \(1\)/)
  assert.match(r, /- للمنزل 600 دج \/ للمكتب: لا يوجد توصيل: الشلف \(2\)/)
  assert.match(r, /- لا يوجد توصيل: الأغواط \(3\)/)
  assert.ok(r.indexOf('للمنزل 0 دج') < r.indexOf('للمنزل 600 دج'))
})
