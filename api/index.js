/**
 * سيرفر إشعارات Push — نسخة Vercel (بدون Server تقليدي، بدون بطاقة ائتمان).
 *
 * الفرق عن نسخة Render: هنا الكود شغّال كـ "Serverless Function" — Vercel بيشغّله
 * فقط وقت وصول طلب فعلي، فمفيش app.listen() ولا سيرفر دايم الشغل. الحالة (الاشتراكات)
 * متخزنة في Upstash Redis برضو، فمفيش أي فرق في الموثوقية عن نسخة Render.
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
   إعداد VAPID
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
   1) حفظ اشتراك جديد
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
   2) إرسال إشعار لجميع المشتركين (محمي بمفتاح سري)
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
      if (![404, 410].includes(err.statusCode)) stillValid.push(sub);
    }
  }));

  await saveSubscriptions(stillValid);
  res.json({ sent: sentCount, total: stillValid.length });
});

/* -----------------------------------------------------------
   فحص صحة السيرفر
----------------------------------------------------------- */
app.get('/api/health', (req, res) => res.json({ ok: true }));

// ⚠️ مفيش app.listen() هنا عمداً — Vercel بيشغّل الدالة دي بنفسه عند كل طلب
module.exports = app;
