/**
 * سيرفر الحسوبابابي — API موحّد (إشعارات Push + لوحة تحكم إدارية).
 * نفس السيرفر القديم بتاع الإشعارات، بس مضاف عليه لوحة التحكم.
 * نفس التركيبة: Vercel (استضافة مجانية) + Upstash Redis (تخزين دائم مجاني).
 */

const express = require('express');
const webpush = require('web-push');
const jwt = require('jsonwebtoken');
const { Redis } = require('@upstash/redis');

const app = express();
app.use(express.json());

/* -----------------------------------------------------------
   CORS
----------------------------------------------------------- */
const ALLOWED_ORIGIN = process.env.SITE_ORIGIN || 'https://www.alhasoubababi.sd';
app.use((req, res, next) => {
  res.setHeader('Access-Control-Allow-Origin', ALLOWED_ORIGIN);
  res.setHeader('Access-Control-Allow-Methods', 'GET,POST,PATCH,DELETE,OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
  if (req.method === 'OPTIONS') return res.sendStatus(204);
  next();
});

/* -----------------------------------------------------------
   VAPID (إشعارات Push)
----------------------------------------------------------- */
webpush.setVapidDetails(
  'mailto:info@alhasoubababi.sd',
  process.env.VAPID_PUBLIC_KEY,
  process.env.VAPID_PRIVATE_KEY
);

/* -----------------------------------------------------------
   Upstash Redis
----------------------------------------------------------- */
const redis = new Redis({
  url: process.env.UPSTASH_REDIS_REST_URL,
  token: process.env.UPSTASH_REDIS_REST_TOKEN,
});

const KEYS = {
  subs: 'push:subscriptions',
  leads: 'admin:leads',
  products: 'admin:products',
  customerNotes: 'admin:customer-notes', // { [phone]: note }
};

async function getList(key) {
  const raw = await redis.get(key);
  return raw || [];
}
async function saveList(key, list) {
  await redis.set(key, list);
}
async function getMap(key) {
  const raw = await redis.get(key);
  return raw || {};
}
async function saveMap(key, map) {
  await redis.set(key, map);
}

function newId() {
  return Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
}

/* =============================================================
   1) نقطة عامة: استقبال طلب معاينة جديد من نموذج الموقع
   (بدون تسجيل دخول — أي زائر في الموقع يقدر يبعت منها)
============================================================= */
app.post('/api/leads', async (req, res) => {
  try {
    const { name, phone, facilityType, cameraCount, city } = req.body;
    if (!name || !phone) return res.status(400).json({ error: 'الاسم ورقم الهاتف مطلوبان' });

    const leads = await getList(KEYS.leads);
    const lead = {
      id: newId(),
      name,
      phone,
      facilityType: facilityType || '',
      cameraCount: cameraCount || '',
      city: city || '',
      status: 'جديد', // جديد | تم التواصل | مجدول | مكتمل | ملغي
      notes: '',
      createdAt: new Date().toISOString(),
    };
    leads.unshift(lead);
    await saveList(KEYS.leads, leads);
    res.status(201).json({ ok: true, id: lead.id });
  } catch (err) {
    console.error(err);
    res.status(500).json({ ok: false });
  }
});

/* =============================================================
   2) تسجيل دخول الإدارة (اسم مستخدم + كلمة سر → JWT)
============================================================= */
app.post('/api/admin/login', (req, res) => {
  const { username, password } = req.body;
  if (
    username === process.env.ADMIN_USERNAME &&
    password === process.env.ADMIN_PASSWORD
  ) {
    const token = jwt.sign({ username }, process.env.ADMIN_JWT_SECRET, { expiresIn: '7d' });
    return res.json({ token });
  }
  res.status(401).json({ error: 'اسم المستخدم أو كلمة السر غير صحيحة' });
});

// وسيط للتحقق من تسجيل الدخول على كل مسارات /api/admin/* (عدا /login)
function requireAuth(req, res, next) {
  const authHeader = req.header('Authorization') || '';
  const token = authHeader.replace('Bearer ', '');
  if (!token) return res.status(401).json({ error: 'غير مصرح' });
  try {
    jwt.verify(token, process.env.ADMIN_JWT_SECRET);
    next();
  } catch (err) {
    res.status(401).json({ error: 'الجلسة منتهية، سجّل الدخول مرة أخرى' });
  }
}
app.use('/api/admin', (req, res, next) => {
  if (req.path === '/login') return next();
  requireAuth(req, res, next);
});

/* =============================================================
   3) إدارة الطلبات الواردة (Leads)
============================================================= */
app.get('/api/admin/leads', async (req, res) => {
  res.json(await getList(KEYS.leads));
});

app.patch('/api/admin/leads/:id', async (req, res) => {
  const leads = await getList(KEYS.leads);
  const idx = leads.findIndex((l) => l.id === req.params.id);
  if (idx === -1) return res.status(404).json({ error: 'غير موجود' });
  leads[idx] = { ...leads[idx], ...req.body };
  await saveList(KEYS.leads, leads);
  res.json({ ok: true });
});

app.delete('/api/admin/leads/:id', async (req, res) => {
  const leads = await getList(KEYS.leads);
  const filtered = leads.filter((l) => l.id !== req.params.id);
  await saveList(KEYS.leads, filtered);
  res.json({ ok: true });
});

/* =============================================================
   4) إدارة المنتجات والأسعار
============================================================= */
app.get('/api/admin/products', async (req, res) => {
  res.json(await getList(KEYS.products));
});

app.post('/api/admin/products', async (req, res) => {
  const { name, category, price, description, active } = req.body;
  if (!name || price == null) return res.status(400).json({ error: 'الاسم والسعر مطلوبان' });
  const products = await getList(KEYS.products);
  const product = {
    id: newId(),
    name,
    category: category || '',
    price,
    description: description || '',
    active: active !== false,
    updatedAt: new Date().toISOString(),
  };
  products.unshift(product);
  await saveList(KEYS.products, products);
  res.status(201).json(product);
});

app.put('/api/admin/products/:id', async (req, res) => {
  const products = await getList(KEYS.products);
  const idx = products.findIndex((p) => p.id === req.params.id);
  if (idx === -1) return res.status(404).json({ error: 'غير موجود' });
  products[idx] = { ...products[idx], ...req.body, updatedAt: new Date().toISOString() };
  await saveList(KEYS.products, products);
  res.json(products[idx]);
});

app.delete('/api/admin/products/:id', async (req, res) => {
  const products = await getList(KEYS.products);
  const filtered = products.filter((p) => p.id !== req.params.id);
  await saveList(KEYS.products, filtered);
  res.json({ ok: true });
});

/* =============================================================
   5) العملاء (مُشتقّة من الطلبات + ملاحظات المتابعة)
============================================================= */
app.get('/api/admin/customers', async (req, res) => {
  const leads = await getList(KEYS.leads);
  const notes = await getMap(KEYS.customerNotes);

  const byPhone = {};
  for (const lead of leads) {
    if (!byPhone[lead.phone]) {
      byPhone[lead.phone] = {
        phone: lead.phone,
        name: lead.name,
        city: lead.city,
        requestsCount: 0,
        lastRequestAt: lead.createdAt,
        note: notes[lead.phone] || '',
      };
    }
    byPhone[lead.phone].requestsCount += 1;
    if (lead.createdAt > byPhone[lead.phone].lastRequestAt) {
      byPhone[lead.phone].lastRequestAt = lead.createdAt;
    }
  }
  res.json(Object.values(byPhone));
});

app.patch('/api/admin/customers/:phone/note', async (req, res) => {
  const notes = await getMap(KEYS.customerNotes);
  notes[req.params.phone] = req.body.note || '';
  await saveMap(KEYS.customerNotes, notes);
  res.json({ ok: true });
});

/* =============================================================
   6) إرسال عروض — Push جماعي أو واتساب لعميل محدد
============================================================= */

// 6أ) إشعار Push جماعي لكل الزوار المشتركين
app.post('/api/admin/send-offer/push', async (req, res) => {
  const { title, body, url } = req.body;
  const payload = JSON.stringify({ title: title || 'عرض خاص', body: body || '', url: url || '/' });

  const subs = await getList(KEYS.subs);
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

  await saveList(KEYS.subs, stillValid);
  res.json({ sent: sentCount, total: stillValid.length });
});

// 6ب) توليد رابط واتساب جاهز لعميل محدد (الإرسال الفعلي يدوي بضغطة من الإدارة)
app.post('/api/admin/send-offer/whatsapp-link', (req, res) => {
  const { phone, message } = req.body;
  if (!phone || !message) return res.status(400).json({ error: 'رقم الهاتف والرسالة مطلوبان' });

  // تنظيف رقم الهاتف السوداني لصيغة دولية (يبدأ بـ 249)
  let cleanPhone = phone.replace(/[^\d]/g, '');
  if (cleanPhone.startsWith('0')) cleanPhone = '249' + cleanPhone.slice(1);
  if (!cleanPhone.startsWith('249')) cleanPhone = '249' + cleanPhone;

  const link = `https://wa.me/${cleanPhone}?text=${encodeURIComponent(message)}`;
  res.json({ link });
});

/* -----------------------------------------------------------
   حفظ اشتراك إشعارات جديد (من pwa-init.js في الموقع)
----------------------------------------------------------- */
app.post('/api/save-subscription', async (req, res) => {
  try {
    const subscription = req.body;
    const subs = await getList(KEYS.subs);
    const exists = subs.some((s) => s.endpoint === subscription.endpoint);
    if (!exists) {
      subs.push(subscription);
      await saveList(KEYS.subs, subs);
    }
    res.status(201).json({ ok: true });
  } catch (err) {
    console.error(err);
    res.status(500).json({ ok: false });
  }
});

/* -----------------------------------------------------------
   إرسال إشعار عام (نفس المسار القديم، لسه شغال للتوافق مع curl القديم)
----------------------------------------------------------- */
app.post('/api/send-notification', async (req, res) => {
  const adminKey = req.header('x-admin-key');
  if (!process.env.ADMIN_KEY || adminKey !== process.env.ADMIN_KEY) {
    return res.status(401).json({ error: 'غير مصرح' });
  }
  const { title, body, url } = req.body;
  const payload = JSON.stringify({ title: title || 'الحسوبابابي', body: body || '', url: url || '/' });

  const subs = await getList(KEYS.subs);
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
  await saveList(KEYS.subs, stillValid);
  res.json({ sent: sentCount, total: stillValid.length });
});

app.get('/api/health', (req, res) => res.json({ ok: true }));

module.exports = app;
