/**
 * سيرفر الحسوبابي — API موحّد (إشعارات Push + لوحة تحكم إدارية).
 * نفس السيرفر القديم بتاع الإشعارات، بس مضاف عليه لوحة التحكم.
 * نفس التركيبة: Vercel (استضافة مجانية) + Upstash Redis (تخزين دائم مجاني).
 */

const express = require('express');
const webpush = require('web-push');
const jwt = require('jsonwebtoken');
const { Redis } = require('@upstash/redis');
const { put, del, list: listBlobs } = require('@vercel/blob');

const app = express();
app.use(express.json({ limit: '8mb' })); // مرفوع من الافتراضي عشان يستوعب صور المشاريع/الخدمات (base64)

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
  customerNotes: 'admin:customer-notes', // { [phone]: note } — قديم، يُقرأ فقط لترحيل الملاحظات القديمة
  customers: 'admin:customers', // { [phone]: customerObject } — سجل العملاء الكامل
  projects: 'admin:projects', // معرض الأعمال (قسم "أعمالنا" في الموقع)
  services: 'admin:services', // قسم "خدماتنا" في الموقع
};

// المحتوى الافتراضي لقسم "خدماتنا" — يُستخدم مرة واحدة فقط لملء اللوحة أول ما تفتح
// تبويب الخدمات (نفس الخدمات الأربعة الموجودة حالياً في HTML)، وبعدها بيتحكم فيه الأدمن بالكامل.
const DEFAULT_SERVICES = [
  { icon: '🎥', title: 'أنظمة المراقبة (CCTV)', description: 'كاميرات مراقبة ذكية وعالية الدقة للمتابعة الحية على مدار الساعة، مع تخزين سحابي ومحلي ودعم فني ميداني.', tag: 'متاح في الخرطوم، بحري، أمدرمان' },
  { icon: '🌐', title: 'شبكات البنية التحتية', description: 'تمديد وتصميم الكابلات المهيكلة وحلول الفايبر أوبتيك المتقدمة للشركات والمكاتب والمجمعات السكنية.', tag: 'تغطية شاملة للمدن السودانية' },
  { icon: '🔐', title: 'الأبواب الذكية والدخول', description: 'أنظمة أمنية متطورة للتحكم في الأبواب والبصمة والبطاقات لتأمين منشأتك وإدارتها بكفاءة.', tag: 'بالجنيه السوداني (SDG)' },
  { icon: '🛠️', title: 'الدعم والصيانة الدورية', description: 'عقود صيانة وقائية ودورية، مع فريق استجابة سريعة لضمان استمرارية عمل أنظمتك بأعلى كفاءة.', tag: 'عقود سنوية ونصف سنوية' },
];

// مراحل متابعة العميل بالترتيب
const PIPELINE_STATUSES = [
  'جديد',
  'تم الاتصال',
  'زيارة ميدانية',
  'عرض سعر',
  'تم الاتفاق',
  'تم التركيب',
  'صيانة دورية',
];

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
   1ب) نقاط عامة: قراءة المشاريع والخدمات المنشورة (بدون تسجيل دخول)
   الموقع الرئيسي بيستدعيها عشان يعرض قسمي "خدماتنا" و"أعمالنا" تلقائياً
============================================================= */
app.get('/api/projects', async (req, res) => {
  const projects = (await getList(KEYS.projects))
    .filter((p) => p.active !== false)
    .sort((a, b) => (a.order ?? 0) - (b.order ?? 0));
  res.json(projects);
});

app.get('/api/services', async (req, res) => {
  const services = await getOrSeedServices();
  const active = services.filter((s) => s.active !== false).sort((a, b) => (a.order ?? 0) - (b.order ?? 0));
  res.json(active);
});

async function getOrSeedServices() {
  let services = await getList(KEYS.services);
  if (!services.length) {
    services = DEFAULT_SERVICES.map((s, i) => ({
      ...s,
      id: newId(),
      order: i,
      active: true,
      updatedAt: new Date().toISOString(),
    }));
    await saveList(KEYS.services, services);
  }
  return services;
}

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
   4ب) إدارة المشاريع (قسم "أعمالنا" — معرض صور المشاريع المنفّذة)
============================================================= */
app.get('/api/admin/projects', async (req, res) => {
  const projects = (await getList(KEYS.projects)).sort((a, b) => (a.order ?? 0) - (b.order ?? 0));
  res.json(projects);
});

app.post('/api/admin/projects', async (req, res) => {
  const { title, location, category, description, imageUrl, active } = req.body;
  if (!title) return res.status(400).json({ error: 'عنوان المشروع مطلوب' });
  const projects = await getList(KEYS.projects);
  const project = {
    id: newId(),
    title,
    location: location || '',
    category: category || '',
    description: description || '',
    imageUrl: imageUrl || '',
    order: projects.length,
    active: active !== false,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  };
  projects.push(project);
  await saveList(KEYS.projects, projects);
  res.status(201).json(project);
});

app.put('/api/admin/projects/:id', async (req, res) => {
  const projects = await getList(KEYS.projects);
  const idx = projects.findIndex((p) => p.id === req.params.id);
  if (idx === -1) return res.status(404).json({ error: 'غير موجود' });
  projects[idx] = { ...projects[idx], ...req.body, updatedAt: new Date().toISOString() };
  await saveList(KEYS.projects, projects);
  res.json(projects[idx]);
});

app.delete('/api/admin/projects/:id', async (req, res) => {
  const projects = await getList(KEYS.projects);
  await saveList(KEYS.projects, projects.filter((p) => p.id !== req.params.id));
  res.json({ ok: true });
});

/* =============================================================
   4ج) إدارة الخدمات (قسم "خدماتنا" في الصفحة الرئيسية)
============================================================= */
app.get('/api/admin/services', async (req, res) => {
  const services = (await getOrSeedServices()).sort((a, b) => (a.order ?? 0) - (b.order ?? 0));
  res.json(services);
});

app.post('/api/admin/services', async (req, res) => {
  const { icon, title, description, tag, active } = req.body;
  if (!title) return res.status(400).json({ error: 'عنوان الخدمة مطلوب' });
  const services = await getOrSeedServices();
  const service = {
    id: newId(),
    icon: icon || '🛠️',
    title,
    description: description || '',
    tag: tag || '',
    order: services.length,
    active: active !== false,
    updatedAt: new Date().toISOString(),
  };
  services.push(service);
  await saveList(KEYS.services, services);
  res.status(201).json(service);
});

app.put('/api/admin/services/:id', async (req, res) => {
  const services = await getOrSeedServices();
  const idx = services.findIndex((s) => s.id === req.params.id);
  if (idx === -1) return res.status(404).json({ error: 'غير موجود' });
  services[idx] = { ...services[idx], ...req.body, updatedAt: new Date().toISOString() };
  await saveList(KEYS.services, services);
  res.json(services[idx]);
});

app.delete('/api/admin/services/:id', async (req, res) => {
  const services = await getOrSeedServices();
  await saveList(KEYS.services, services.filter((s) => s.id !== req.params.id));
  res.json({ ok: true });
});

/* =============================================================
   4د) إعادة ترتيب المشاريع أو الخدمات (سحب وإفلات في اللوحة)
   body: { ids: [id1, id2, id3, ...] } بالترتيب الجديد المطلوب
============================================================= */
app.post('/api/admin/reorder/:type', async (req, res) => {
  const key = req.params.type === 'projects' ? KEYS.projects : req.params.type === 'services' ? KEYS.services : null;
  if (!key) return res.status(400).json({ error: 'نوع غير صحيح' });
  const { ids } = req.body;
  if (!Array.isArray(ids)) return res.status(400).json({ error: 'قائمة ترتيب غير صحيحة' });
  const list = await getList(key);
  const byId = Object.fromEntries(list.map((x) => [x.id, x]));
  const reordered = ids.map((id, i) => (byId[id] ? { ...byId[id], order: i } : null)).filter(Boolean);
  await saveList(key, reordered);
  res.json({ ok: true });
});

/* =============================================================
   4هـ) رفع وإدارة الصور (تُستخدم لصور المشاريع والخدمات، وتخزينها دائم عبر Vercel Blob)
============================================================= */

// رفع صورة جديدة — الواجهة ترسلها كـ base64 data URL بعد ضغطها في المتصفح
app.post('/api/admin/upload', async (req, res) => {
  try {
    const { dataUrl, filename } = req.body;
    if (!dataUrl) return res.status(400).json({ error: 'الصورة مطلوبة' });
    const matches = String(dataUrl).match(/^data:(image\/[a-zA-Z+]+);base64,(.+)$/);
    if (!matches) return res.status(400).json({ error: 'صيغة صورة غير صحيحة' });
    const contentType = matches[1];
    const buffer = Buffer.from(matches[2], 'base64');
    if (buffer.length > 4 * 1024 * 1024) {
      return res.status(400).json({ error: 'حجم الصورة كبير جداً (الحد الأقصى 4 ميجا بعد الضغط)' });
    }
    const ext = contentType.split('/')[1] || 'jpg';
    const safeName = (filename || 'image').replace(/[^a-zA-Z0-9._-]/g, '-').slice(0, 60);
    const blob = await put(`uploads/${newId()}-${safeName}.${ext}`, buffer, {
      access: 'public',
      contentType,
    });
    res.status(201).json({ url: blob.url });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'فشل رفع الصورة' });
  }
});

// قائمة كل الصور المرفوعة (مكتبة الصور)
app.get('/api/admin/images', async (req, res) => {
  try {
    const { blobs } = await listBlobs({ prefix: 'uploads/' });
    const images = blobs
      .map((b) => ({ url: b.url, uploadedAt: b.uploadedAt, size: b.size }))
      .sort((a, b) => (b.uploadedAt || '').localeCompare(a.uploadedAt || ''));
    res.json(images);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'فشل تحميل مكتبة الصور' });
  }
});

// حذف صورة من المكتبة نهائياً
app.delete('/api/admin/images', async (req, res) => {
  try {
    const { url } = req.body;
    if (!url) return res.status(400).json({ error: 'رابط الصورة مطلوب' });
    await del(url);
    res.json({ ok: true });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'فشل حذف الصورة' });
  }
});

/* =============================================================
   5) العملاء — سجل متابعة كامل (حالة العميل + سجل مكالمات + تاريخ تعديلات + تذكير متابعة)
   العميل يتولّد تلقائياً أول ما يوصل طلب جديد بنفس رقم الهاتف،
   وبعدين بيتبع مسار متابعة مستقل عن حالة الطلب نفسه.
============================================================= */

// يزامن سجل العملاء مع أحدث بيانات الطلبات (بدون ما يلمس حالة/ملاحظات/سجل عميل موجود بالفعل)
async function syncCustomersFromLeads() {
  const leads = await getList(KEYS.leads);
  const legacyNotes = await getMap(KEYS.customerNotes);
  const customers = await getMap(KEYS.customers);

  const leadStats = {};
  for (const lead of leads) {
    if (!leadStats[lead.phone]) {
      leadStats[lead.phone] = {
        name: lead.name,
        city: lead.city,
        requestsCount: 0,
        firstRequestAt: lead.createdAt,
        lastRequestAt: lead.createdAt,
      };
    }
    const s = leadStats[lead.phone];
    s.requestsCount += 1;
    if (lead.createdAt > s.lastRequestAt) {
      s.lastRequestAt = lead.createdAt;
      s.name = lead.name;
      s.city = lead.city;
    }
    if (lead.createdAt < s.firstRequestAt) s.firstRequestAt = lead.createdAt;
  }

  let changed = false;
  for (const phone of Object.keys(leadStats)) {
    const s = leadStats[phone];
    if (!customers[phone]) {
      customers[phone] = {
        phone,
        name: s.name,
        city: s.city,
        status: 'جديد',
        note: legacyNotes[phone] || '',
        reminderAt: null,
        requestsCount: s.requestsCount,
        lastRequestAt: s.lastRequestAt,
        createdAt: s.firstRequestAt,
        updatedAt: new Date().toISOString(),
        calls: [],
        history: [
          { at: s.firstRequestAt, field: 'status', from: null, to: 'جديد' },
        ],
      };
      changed = true;
    } else {
      const c = customers[phone];
      if (c.name !== s.name || c.city !== s.city || c.requestsCount !== s.requestsCount || c.lastRequestAt !== s.lastRequestAt) {
        c.name = s.name;
        c.city = s.city;
        c.requestsCount = s.requestsCount;
        c.lastRequestAt = s.lastRequestAt;
        changed = true;
      }
      // ترحيل ملاحظة قديمة لو العميل اتولّد قبل إضافة نظام الملاحظات الموحّد ولسه فاضية
      if (!c.note && legacyNotes[phone]) {
        c.note = legacyNotes[phone];
        changed = true;
      }
      if (!c.calls) c.calls = [];
      if (!c.history) c.history = [];
    }
  }

  if (changed) await saveMap(KEYS.customers, customers);
  return customers;
}

app.get('/api/admin/customers', async (req, res) => {
  const customers = await syncCustomersFromLeads();
  const list = Object.values(customers).sort((a, b) =>
    (b.lastRequestAt || '').localeCompare(a.lastRequestAt || '')
  );
  res.json(list);
});

app.get('/api/admin/customer-statuses', (req, res) => {
  res.json(PIPELINE_STATUSES);
});

// تحديث حالة العميل / ملاحظة المتابعة / تاريخ تذكير المتابعة — وتسجيل كل تغيير في تاريخ التعديلات
app.patch('/api/admin/customers/:phone', async (req, res) => {
  const customers = await getMap(KEYS.customers);
  const phone = req.params.phone;
  const c = customers[phone];
  if (!c) return res.status(404).json({ error: 'العميل غير موجود' });

  if (req.body.status !== undefined && !PIPELINE_STATUSES.includes(req.body.status)) {
    return res.status(400).json({ error: 'حالة غير صحيحة' });
  }

  const editableFields = ['status', 'note', 'reminderAt'];
  const now = new Date().toISOString();
  const newHistory = [];

  for (const field of editableFields) {
    if (req.body[field] === undefined) continue;
    const oldValue = c[field] ?? null;
    const newValue = req.body[field] === '' ? null : req.body[field];
    if (oldValue !== newValue) {
      newHistory.push({ at: now, field, from: oldValue, to: newValue });
      c[field] = newValue;
    }
  }

  if (newHistory.length) {
    c.history = [...(c.history || []), ...newHistory];
    c.updatedAt = now;
    customers[phone] = c;
    await saveMap(KEYS.customers, customers);
  }
  res.json(c);
});

// إضافة سجل مكالمة جديد للعميل
app.post('/api/admin/customers/:phone/calls', async (req, res) => {
  const customers = await getMap(KEYS.customers);
  const phone = req.params.phone;
  const c = customers[phone];
  if (!c) return res.status(404).json({ error: 'العميل غير موجود' });

  const { outcome, notes } = req.body;
  if (!outcome) return res.status(400).json({ error: 'نتيجة المكالمة مطلوبة' });

  const now = new Date().toISOString();
  const call = { id: newId(), at: now, outcome, notes: notes || '' };

  c.calls = [call, ...(c.calls || [])];
  c.history = [...(c.history || []), { at: now, field: 'call', from: null, to: outcome }];
  c.updatedAt = now;
  customers[phone] = c;
  await saveMap(KEYS.customers, customers);
  res.status(201).json(call);
});

// حذف سجل مكالمة (بالغلط مثلاً)
app.delete('/api/admin/customers/:phone/calls/:callId', async (req, res) => {
  const customers = await getMap(KEYS.customers);
  const phone = req.params.phone;
  const c = customers[phone];
  if (!c) return res.status(404).json({ error: 'العميل غير موجود' });

  c.calls = (c.calls || []).filter((call) => call.id !== req.params.callId);
  customers[phone] = c;
  await saveMap(KEYS.customers, customers);
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
  const payload = JSON.stringify({ title: title || 'الحسوبابي', body: body || '', url: url || '/' });

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
