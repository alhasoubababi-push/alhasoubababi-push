/**
 * سيرفر إشعارات Push جاهز للنشر المجاني (Render.com + Upstash Redis).
 *
 * لماذا هذا التركيب بالذات؟
 * - Render: استضافة Node.js مجانية دائماً (750 ساعة/شهر مجاناً، تكفي موقعاً واحداً).
 *   ملاحظة: السيرفر "ينام" بعد 15 دقيقة بدون طلبات، ويحتاج ~30-50 ثانية ليصحى
 *   عند أول طلب بعدها. هذا مقبول تماماً لإرسال إشعارات (مش وقت حرج للمستخدم).
 * - Upstash Redis: تخزين مجاني دائم (Free Forever) للاشتراكات، لأن قرص Render
 *   المجاني يُمسح مع كل إعادة تشغيل، فلازم تخزين خارجي يبقى بعد نوم السيرفر.
 *
 * التثبيت محلياً للتجربة:
 *   npm install
 *   VAPID_PUBLIC_KEY=... VAPID_PRIVATE_KEY=... UPSTASH_REDIS_REST_URL=... UPSTASH_REDIS_REST_TOKEN=... npm start
 */

const express = require('express');
const webpush = require('web-push');
const { Redis } = require('@upstash/redis');

const app = express();
app.use(express.json());

/* -----------------------------------------------------------
   CORS — يسمح فقط لموقعك بإرسال طلبات لهذا السيرفر
----------------------------------------------------------- */
const ALLOWED_ORIGIN = process.env.SITE_ORIGIN || 'https://www.alhasoubababi.sd';
app.use((req, res, next) => {
  res.setHeader('Access-Control-Allow-Origin', ALLOWED_ORIGIN);
  res.setHeader('Access-Control-Allow-Methods', 'GET,POST,OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
  if (req.method === 'OPTIONS') return res.sendStatus(204);
  next();
});

/* -----------------------------------------------------------
   إعداد VAPID (تم توليد المفاتيح فعلياً — راجع رسالة التسليم)
----------------------------------------------------------- */
webpush.setVapidDetails(
  'mailto:info@alhasoubababi.sd',
  process.env.VAPID_PUBLIC_KEY,
  process.env.VAPID_PRIVATE_KEY
);

/* -----------------------------------------------------------
   Upstash Redis — تخزين دائم مجاني للاشتراكات
----------------------------------------------------------- */
const redis = new Redis({
  url: process.env.UPSTASH_REDIS_REST_URL,
  token: process.env.UPSTASH_REDIS_REST_TOKEN,
});
const SUBS_KEY = 'push:subscriptions';

async function getSubscriptions() {
  const raw = await redis.get(SUBS_KEY);
  return raw || [];
}
async function saveSubscriptions(subs) {
  await redis.set(SUBS_KEY, subs);
}

/* -----------------------------------------------------------
   1) حفظ اشتراك جديد (يُستدعى تلقائياً من pwa-init.js)
----------------------------------------------------------- */
app.post('/api/save-subscription', async (req, res) => {
  try {
    const subscription = req.body;
    const subs = await getSubscriptions();
    const exists = subs.some((s) => s.endpoint === subscription.endpoint);
    if (!exists) {
      subs.push(subscription);
      await saveSubscriptions(subs);
    }
    res.status(201).json({ ok: true });
  } catch (err) {
    console.error(err);
    res.status(500).json({ ok: false });
  }
});

/* -----------------------------------------------------------
   2) إرسال إشعار لجميع المشتركين
   احمِ هذا المسار بمفتاح سري بسيط عشان محدش غيرك يقدر يبعت إشعارات
----------------------------------------------------------- */
app.post('/api/send-notification', async (req, res) => {
  const adminKey = req.header('x-admin-key');
  if (!process.env.ADMIN_KEY || adminKey !== process.env.ADMIN_KEY) {
    return res.status(401).json({ error: 'غير مصرح' });
  }

  const { title, body, url } = req.body;
  const payload = JSON.stringify({
    title: title || 'الحسوبابابي',
    body: body || 'لديك تحديث جديد',
    url: url || '/',
  });

  const subs = await getSubscriptions();
  const stillValid = [];
  let sentCount = 0;

  await Promise.all(subs.map(async (sub) => {
    try {
      await webpush.sendNotification(sub, payload);
      stillValid.push(sub);
      sentCount++;
    } catch (err) {
      // 404/410 = الاشتراك انتهى أو أُلغي، لا تحتفظ به
      if (![404, 410].includes(err.statusCode)) stillValid.push(sub);
    }
  }));

  await saveSubscriptions(stillValid);
  res.json({ sent: sentCount, total: stillValid.length });
});

/* -----------------------------------------------------------
   فحص صحة السيرفر (مفيد مع Render لإبقائه صاحياً لو حبيت)
----------------------------------------------------------- */
app.get('/health', (req, res) => res.json({ ok: true }));

const PORT = process.env.PORT || 3001;
app.listen(PORT, () => console.log(`Push server running on port ${PORT}`));
