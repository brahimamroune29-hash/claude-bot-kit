# تشغيل البوت على خادم (بوت واحد، خادم واحد)

تحتاج: خادم أوبونتو 24.04 صغير (نواة واحدة وذاكرة 1 جيجا تكفي، افتراض لم يُقس)، ونطاقاً أو نطاقاً فرعياً
(مثل `bot.متجرك.com`)، وجهازك فيه نسخة البوت وقد جرّبتها محلياً (`DRY_RUN=1` وصفحة `/try`).

لماذا خادم وليس استضافة مواقع مثل فيرسل: البوت يحتاج قرصاً لقاعدة البيانات، وعملية تبقى شغالة للمتابعات والنسخ الاحتياطي.

## 1. الخادم (مرة واحدة، بحساب الجذر)

```sh
# المستخدم الذي يشغّل البوت، ومجلده
adduser --disabled-password --gecos "" bot
mkdir -p /opt/shop-bot/data && chown -R bot:bot /opt/shop-bot
echo 'bot ALL=(root) NOPASSWD: /usr/bin/systemctl restart shop-bot' > /etc/sudoers.d/shop-bot
mkdir -p /home/bot/.ssh && cp ~/.ssh/authorized_keys /home/bot/.ssh/ && chown -R bot:bot /home/bot/.ssh

# نود 22، وكادي (يعطي شهادة الأمان وحده)، والجدار الناري
curl -fsSL https://deb.nodesource.com/setup_22.x | bash - && apt-get install -y nodejs rsync caddy
ufw allow 22 && ufw allow 80 && ufw allow 443 && ufw --force enable
```

## 2. النطاق
عند مزوّد النطاق: سجلّ من نوع `A` يشير إلى عنوان الخادم. انتظر حتى يعمل (`ping bot.متجرك.com` يرد بعنوان الخادم).
ليس عندك نطاق؟ خدمات مجانية مثل sslip.io تعطي اسماً من عنوان الخادم نفسه (مثال: `1-2-3-4.sslip.io`).

## 3. أول رفع
من جهازك، داخل مجلد البوت:

```sh
deploy/deploy.sh bot@SERVER_IP
```

سيفشل فحص الصحة في آخره لأن الخدمة لم تُركّب بعد: هذا عادي في أول مرة.

## 4. المفاتيح والبطاقة على الخادم
```sh
# على الخادم، بحساب bot
cd /opt/shop-bot
cp .env.example .env && chmod 600 .env
mkdir -p data/media
```

افتح `.env` وغيّر:
- `DRY_RUN=` فارغ (في الإنتاج البوت يرفض التشغيل مع `DRY_RUN=1`).
- `DB_PATH=./data/bot.db`، `CARD_PATH=./data/card.json`، `MEDIA_DIR=./data/media`، `BACKUP_DIR=./data/backups`
  (البوت يرفض التشغيل إن كانت خارج `data/`: الرفع يمسح كل شيء آخر).
- `PUBLIC_URL=https://bot.متجرك.com` بلا خط مائل في الآخر.
- `DASHBOARD_PASSWORD`: 12 حرفاً على الأقل.
- مفاتيح واسندر وأوبن راوتر وأوبن إي آي، و`AGENT_PHONE` رقم واتساب صاحب المتجر.
- `TEST_NUMBERS`: رقمك أنت فقط للتجربة الأولى.

ثم ضع بطاقة المتجر الحقيقية وصور المنتجات:
```sh
# من جهازك
scp card.json bot@SERVER_IP:/opt/shop-bot/data/card.json
scp media/* bot@SERVER_IP:/opt/shop-bot/data/media/
```
البطاقة الحقيقية بلا `"test": true`. إن كان فيها خطأ، البوت لا يشتغل ويكتب في السجل ما الناقص.

## 5. الخدمة وكادي (بحساب الجذر)
```sh
cp /opt/shop-bot/deploy/shop-bot.service /etc/systemd/system/
systemctl daemon-reload && systemctl enable --now shop-bot
sed "s/DOMAIN_HERE/bot.متجرك.com/" /opt/shop-bot/deploy/Caddyfile > /etc/caddy/Caddyfile && systemctl reload caddy
curl https://bot.متجرك.com/health
```
`ok` = يعمل. `waiting for keys` = مفتاح ناقص في `.env`. غير ذلك: `journalctl -u shop-bot -n 50`.

## 6. ربط واتساب (واسندر)
- جلسة جديدة في واسندر، وامسح الرمز من هاتف رقم المتجر. رقم خاص بالمتجر فقط: البوت يرد على كل محادثة فيه.
- رابط الاستقبال: `https://bot.متجرك.com/wa`، والسر نفسه الذي في `WASENDER_WEBHOOK_SECRET`.
- الحدث: `messages.upsert` فقط.

إنستغرام وماسنجر (اختياري): الخطوات في `deploy/META.md`.

## 7. التجربة ثم الإطلاق
1. من رقمك (الذي في `TEST_NUMBERS`): طلب كامل، رسالة صوتية، طلب صورة منتج، وطلب إنسان.
2. افتح اللوحة `https://bot.متجرك.com` بكلمة السر، ورد على المحادثة المحوّلة.
3. كل شيء صحيح؟ فرّغ `TEST_NUMBERS` ثم `sudo systemctl restart shop-bot`.

## 8. المراقبة والنسخ
- حساب مجاني في خدمة مراقبة (مثل أب تايم روبوت) يفحص `https://bot.متجرك.com/health` كل 5 دقائق ويرسل لك بريداً إن سقط.
  تنبيهات البوت نفسه تصل صاحب المتجر على واتساب، لكنها تسكت إن سقط الخادم كله.
- نسخة يومية من قاعدة البيانات في `data/backups` (آخر 7). فعّل أيضاً النسخ الأسبوعي في لوحة مزوّد الخادم.

## يومياً
- بعد كل تعديل: `deploy/deploy.sh bot@SERVER_IP` (يشغّل الاختبارات، يرفع، يعيد التشغيل ويفحص).
- السجل: `journalctl -u shop-bot -f`.
- تعديل البطاقة: عدّل `data/card.json` على الخادم ثم `sudo systemctl restart shop-bot`.
  أزرار المخزون في اللوحة تكتب في نفس الملف.
