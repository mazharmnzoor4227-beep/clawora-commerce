const JSON_HEADERS = { 'content-type': 'application/json; charset=utf-8' };
const SESSION_COOKIE = 'clawora_session';
const SESSION_DAYS = 30;

export default {
  async fetch(request, env) {
    try {
      const url = new URL(request.url);
      if (url.pathname === '/sitemap.xml') return sitemap(env, url.origin);
      if (url.pathname.startsWith('/media/')) return serveMedia(request, env, url.pathname.slice('/media/'.length));
      if (!url.pathname.startsWith('/api/')) return env.ASSETS.fetch(request);
      return await routeApi(request, env, url);
    } catch (error) {
      if (error instanceof HttpError) return json({ error: error.message }, error.status);
      console.error(error);
      return json({ error: 'Internal server error' }, 500);
    }
  }
};

async function routeApi(request, env, url) {
  const path = url.pathname;
  const method = request.method.toUpperCase();

  if (path === '/api/health') return json({ ok: true, service: 'clawora-commerce', now: new Date().toISOString() });
  if (path === '/api/config') return publicConfig(env);
  if (path === '/api/catalog' && method === 'GET') return catalog(env, url);
  if (path.startsWith('/api/products/') && method === 'GET') return productDetail(env, decodeURIComponent(path.split('/').pop()));
  if (path === '/api/orders' && method === 'POST') return createOrder(request, env);
  if (path === '/api/auth/register' && method === 'POST') return register(request, env);
  if (path === '/api/auth/login' && method === 'POST') return login(request, env);
  if (path === '/api/auth/logout' && method === 'POST') return logout(request, env);
  if (path === '/api/me' && method === 'GET') return me(request, env);
  if (path === '/api/my/orders' && method === 'GET') return myOrders(request, env);
  if (path === '/api/reviews' && method === 'POST') return createReview(request, env);
  if (path === '/api/wishlist' && method === 'GET') return wishlistGet(request, env);
  if (path === '/api/wishlist' && method === 'POST') return wishlistToggle(request, env);

  if (path === '/api/setup/status' && method === 'GET') return setupStatus(env);
  if (path === '/api/setup/bootstrap' && method === 'POST') return setupBootstrap(request, env);

  if (path === '/api/admin/stats' && method === 'GET') return withAdmin(request, env, adminStats);
  if (path === '/api/admin/products' && method === 'GET') return withAdmin(request, env, adminProducts);
  if (path === '/api/admin/products' && method === 'POST') return withAdmin(request, env, adminCreateProduct);
  if (path.startsWith('/api/admin/products/') && method === 'PUT') return withAdmin(request, env, adminUpdateProduct);
  if (path.startsWith('/api/admin/products/') && method === 'DELETE') return withAdmin(request, env, adminDeleteProduct);
  if (path === '/api/admin/orders' && method === 'GET') return withAdmin(request, env, adminOrders);
  if (path.startsWith('/api/admin/orders/') && method === 'PUT') return withAdmin(request, env, adminUpdateOrder);
  if (path === '/api/admin/customers' && method === 'GET') return withAdmin(request, env, adminCustomers);
  if (path === '/api/admin/settings' && method === 'GET') return withAdmin(request, env, adminSettingsGet);
  if (path === '/api/admin/settings' && method === 'PUT') return withAdmin(request, env, adminSettingsPut);
  if (path === '/api/admin/upload' && method === 'POST') return withAdmin(request, env, adminUpload);
  if (path === '/api/admin/coupons' && method === 'GET') return withAdmin(request, env, adminCouponsGet);
  if (path === '/api/admin/coupons' && method === 'POST') return withAdmin(request, env, adminCouponsPost);
  if (path === '/api/admin/reviews' && method === 'GET') return withAdmin(request, env, adminReviewsGet);
  if (path.startsWith('/api/admin/reviews/') && method === 'PUT') return withAdmin(request, env, adminReviewsPut);

  return json({ error: 'Not found' }, 404);
}

async function publicConfig(env) {
  const settings = await getSetting(env, 'store', {});
  const homepage = await getSetting(env, 'homepage', {});
  return json({
    store: { ...settings, name: settings.name || env.STORE_NAME || 'Clawora Beauty', currency: settings.currency || env.CURRENCY || 'PKR' },
    homepage
  });
}

async function catalog(env, url) {
  const q = (url.searchParams.get('q') || '').trim();
  const category = (url.searchParams.get('category') || '').trim();
  const brand = (url.searchParams.get('brand') || '').trim();
  const featured = url.searchParams.get('featured') === '1';
  const sort = url.searchParams.get('sort') || 'newest';
  const limit = Math.min(Math.max(Number(url.searchParams.get('limit') || 60), 1), 100);

  const where = ["p.status='active'"];
  const binds = [];
  if (q) { where.push('(p.title LIKE ? OR p.short_description LIKE ? OR p.sku LIKE ?)'); binds.push(`%${q}%`, `%${q}%`, `%${q}%`); }
  if (category) { where.push('c.slug = ?'); binds.push(category); }
  if (brand) { where.push('b.slug = ?'); binds.push(brand); }
  if (featured) where.push('p.featured = 1');
  const orderBy = sort === 'price-asc' ? 'p.price ASC' : sort === 'price-desc' ? 'p.price DESC' : 'p.created_at DESC';

  const productsStmt = env.DB.prepare(`
    SELECT p.*, c.name category_name, c.slug category_slug, b.name brand_name, b.slug brand_slug,
      COALESCE((SELECT ROUND(AVG(r.rating),1) FROM reviews r WHERE r.product_id=p.id AND r.status='approved'),0) rating,
      COALESCE((SELECT COUNT(*) FROM reviews r WHERE r.product_id=p.id AND r.status='approved'),0) review_count
    FROM products p
    LEFT JOIN categories c ON c.id=p.category_id
    LEFT JOIN brands b ON b.id=p.brand_id
    WHERE ${where.join(' AND ')}
    ORDER BY ${orderBy}
    LIMIT ?`).bind(...binds, limit);

  const [products, categories, brands] = await Promise.all([
    productsStmt.all(),
    env.DB.prepare("SELECT id,name,slug FROM categories WHERE active=1 ORDER BY sort_order,name").all(),
    env.DB.prepare("SELECT id,name,slug FROM brands WHERE active=1 ORDER BY name").all()
  ]);

  return json({
    products: products.results.map(mapProduct),
    categories: categories.results,
    brands: brands.results
  });
}

async function productDetail(env, slug) {
  const row = await env.DB.prepare(`
    SELECT p.*, c.name category_name, c.slug category_slug, b.name brand_name, b.slug brand_slug,
      COALESCE((SELECT ROUND(AVG(r.rating),1) FROM reviews r WHERE r.product_id=p.id AND r.status='approved'),0) rating,
      COALESCE((SELECT COUNT(*) FROM reviews r WHERE r.product_id=p.id AND r.status='approved'),0) review_count
    FROM products p LEFT JOIN categories c ON c.id=p.category_id LEFT JOIN brands b ON b.id=p.brand_id
    WHERE p.slug=? AND p.status='active'`).bind(slug).first();
  if (!row) return json({ error: 'Product not found' }, 404);
  const reviews = await env.DB.prepare("SELECT customer_name,rating,title,body,created_at FROM reviews WHERE product_id=? AND status='approved' ORDER BY created_at DESC LIMIT 30").bind(row.id).all();
  return json({ product: mapProduct(row), reviews: reviews.results });
}

async function createOrder(request, env) {
  await assertJson(request);
  const body = await request.json();
  const items = Array.isArray(body.items) ? body.items : [];
  if (!items.length) return json({ error: 'Cart is empty' }, 400);
  const customerName = clean(body.customerName, 100);
  const phone = clean(body.phone, 40);
  const email = clean(body.email, 180).toLowerCase();
  const address = body.address || {};
  if (!customerName || !phone || !clean(address.line1, 180) || !clean(address.city, 100)) return json({ error: 'Name, phone, address and city are required' }, 400);

  const qtyById = new Map();
  for (const item of items) {
    const id = String(item.productId || '');
    const qty = Math.min(Math.max(Number(item.quantity || 0), 1), 20);
    if (id) qtyById.set(id, (qtyById.get(id) || 0) + qty);
  }
  const ids = [...qtyById.keys()];
  if (!ids.length) return json({ error: 'Invalid cart' }, 400);
  const placeholders = ids.map(() => '?').join(',');
  const dbProducts = await env.DB.prepare(`SELECT id,title,sku,price,stock,status FROM products WHERE id IN (${placeholders})`).bind(...ids).all();
  if (dbProducts.results.length !== ids.length) return json({ error: 'One or more products are unavailable' }, 409);

  let subtotal = 0;
  const normalized = [];
  for (const p of dbProducts.results) {
    const qty = qtyById.get(p.id);
    if (p.status !== 'active' || p.stock < qty) return json({ error: `${p.title} does not have enough stock` }, 409);
    const lineTotal = p.price * qty;
    subtotal += lineTotal;
    normalized.push({ ...p, qty, lineTotal });
  }

  const store = await getSetting(env, 'store', {});
  let discount = 0;
  const couponCode = clean(body.couponCode, 40).toUpperCase();
  if (couponCode) {
    const coupon = await env.DB.prepare(`SELECT * FROM coupons WHERE code=? AND active=1 AND (starts_at IS NULL OR starts_at<=CURRENT_TIMESTAMP) AND (ends_at IS NULL OR ends_at>=CURRENT_TIMESTAMP)`).bind(couponCode).first();
    if (coupon && subtotal >= Number(coupon.min_order || 0)) discount = coupon.type === 'percent' ? Math.floor(subtotal * Math.min(coupon.value, 100) / 100) : Math.min(coupon.value, subtotal);
  }
  const freeShippingAbove = Number(store.freeShippingAbove || 0);
  const shipping = freeShippingAbove > 0 && subtotal >= freeShippingAbove ? 0 : Number(store.shippingFlat || 0);
  const total = Math.max(subtotal - discount + shipping, 0);
  const user = await currentUser(request, env);
  const id = crypto.randomUUID();
  const orderNumber = `CLW-${Date.now().toString(36).toUpperCase()}-${randomCode(4)}`;

  const statements = [env.DB.prepare(`INSERT INTO orders (id,order_number,user_id,customer_name,email,phone,address_json,subtotal,discount,shipping,total,payment_method,payment_status,status,notes) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`).bind(
    id, orderNumber, user?.id || null, customerName, email, phone, JSON.stringify({ line1: clean(address.line1,180), line2: clean(address.line2,180), city: clean(address.city,100), province: clean(address.province,100), postalCode: clean(address.postalCode,30) }), subtotal, discount, shipping, total, 'cod', 'unpaid', 'pending', clean(body.notes,500)
  )];
  for (const item of normalized) {
    statements.push(env.DB.prepare(`INSERT INTO order_items (id,order_id,product_id,title,sku,quantity,unit_price,line_total) VALUES (?,?,?,?,?,?,?,?)`).bind(crypto.randomUUID(), id, item.id, item.title, item.sku || '', item.qty, item.price, item.lineTotal));
    statements.push(env.DB.prepare(`UPDATE products SET stock=stock-?, updated_at=CURRENT_TIMESTAMP WHERE id=? AND stock>=?`).bind(item.qty, item.id, item.qty));
  }
  await env.DB.batch(statements);
  return json({ ok: true, order: { id, orderNumber, subtotal, discount, shipping, total, status: 'pending' } }, 201);
}

async function register(request, env) {
  await assertJson(request);
  const body = await request.json();
  const name = clean(body.name, 100);
  const email = clean(body.email, 180).toLowerCase();
  const password = String(body.password || '');
  if (!name || !validEmail(email) || password.length < 8) return json({ error: 'Valid name/email and password of at least 8 characters required' }, 400);
  const exists = await env.DB.prepare('SELECT id FROM users WHERE email=?').bind(email).first();
  if (exists) return json({ error: 'Email already registered' }, 409);
  const { hash, salt } = await hashPassword(password);
  const id = crypto.randomUUID();
  await env.DB.prepare(`INSERT INTO users (id,email,name,password_hash,password_salt,role) VALUES (?,?,?,?,?,'customer')`).bind(id,email,name,hash,salt).run();
  return issueSession(env, { id, email, name, role: 'customer' }, 201);
}

async function login(request, env) {
  await assertJson(request);
  const { email = '', password = '' } = await request.json();
  const user = await env.DB.prepare('SELECT * FROM users WHERE email=? AND status=\'active\'').bind(String(email).trim().toLowerCase()).first();
  if (!user || !(await verifyPassword(String(password), user.password_salt, user.password_hash))) return json({ error: 'Invalid email or password' }, 401);
  return issueSession(env, user);
}

async function logout(request, env) {
  const token = cookieValue(request, SESSION_COOKIE);
  if (token) await env.DB.prepare('DELETE FROM sessions WHERE token_hash=?').bind(await sha256(token)).run();
  return json({ ok: true }, 200, { 'set-cookie': clearSessionCookie() });
}

async function me(request, env) {
  const user = await currentUser(request, env);
  return json({ user: user ? publicUser(user) : null });
}

async function myOrders(request, env) {
  const user = await requireUser(request, env);
  if (user instanceof Response) return user;
  const rows = await env.DB.prepare(`SELECT id,order_number,total,status,payment_status,created_at FROM orders WHERE user_id=? ORDER BY created_at DESC LIMIT 50`).bind(user.id).all();
  return json({ orders: rows.results });
}

async function createReview(request, env) {
  const user = await requireUser(request, env);
  if (user instanceof Response) return user;
  await assertJson(request);
  const body = await request.json();
  const productId = String(body.productId || '');
  const rating = Number(body.rating || 0);
  if (!productId || rating < 1 || rating > 5) return json({ error: 'Invalid review' }, 400);
  const product = await env.DB.prepare('SELECT id FROM products WHERE id=? AND status=\'active\'').bind(productId).first();
  if (!product) return json({ error: 'Product not found' }, 404);
  await env.DB.prepare(`INSERT INTO reviews (id,product_id,user_id,customer_name,rating,title,body,status) VALUES (?,?,?,?,?,?,?,'pending')`).bind(crypto.randomUUID(),productId,user.id,user.name,rating,clean(body.title,120),clean(body.body,1000)).run();
  return json({ ok: true, message: 'Review submitted for approval' }, 201);
}

async function wishlistGet(request, env) {
  const user = await requireUser(request, env);
  if (user instanceof Response) return user;
  const rows = await env.DB.prepare(`SELECT p.*, b.name brand_name, b.slug brand_slug, c.name category_name, c.slug category_slug FROM wishlist w JOIN products p ON p.id=w.product_id LEFT JOIN brands b ON b.id=p.brand_id LEFT JOIN categories c ON c.id=p.category_id WHERE w.user_id=? AND p.status='active' ORDER BY w.created_at DESC`).bind(user.id).all();
  return json({ products: rows.results.map(mapProduct) });
}

async function wishlistToggle(request, env) {
  const user = await requireUser(request, env);
  if (user instanceof Response) return user;
  await assertJson(request);
  const { productId } = await request.json();
  const id = String(productId || '');
  if (!id) return json({ error: 'Product required' }, 400);
  const existing = await env.DB.prepare('SELECT 1 x FROM wishlist WHERE user_id=? AND product_id=?').bind(user.id,id).first();
  if (existing) await env.DB.prepare('DELETE FROM wishlist WHERE user_id=? AND product_id=?').bind(user.id,id).run();
  else await env.DB.prepare('INSERT INTO wishlist (user_id,product_id) VALUES (?,?)').bind(user.id,id).run();
  return json({ ok: true, saved: !existing });
}

async function setupStatus(env) {
  const admin = await env.DB.prepare("SELECT id FROM users WHERE role='admin' LIMIT 1").first();
  return json({ configured: !!admin });
}

async function setupBootstrap(request, env) {
  const existing = await env.DB.prepare("SELECT id FROM users WHERE role='admin' LIMIT 1").first();
  if (existing) return json({ error: 'Admin is already configured' }, 409);
  await assertJson(request);
  const body = await request.json();
  if (!env.SETUP_KEY || String(body.setupKey || '') !== env.SETUP_KEY) return json({ error: 'Invalid setup key' }, 403);
  const email = clean(body.email,180).toLowerCase();
  const name = clean(body.name,100) || 'Store Admin';
  const password = String(body.password || '');
  if (!validEmail(email) || password.length < 10) return json({ error: 'Valid email and password of at least 10 characters required' }, 400);
  const { hash, salt } = await hashPassword(password);
  const id = crypto.randomUUID();
  await env.DB.prepare(`INSERT INTO users (id,email,name,password_hash,password_salt,role) VALUES (?,?,?,?,?,'admin')`).bind(id,email,name,hash,salt).run();
  return issueSession(env, { id,email,name,role:'admin' }, 201);
}

async function withAdmin(request, env, handler) {
  const user = await requireUser(request, env, 'admin');
  if (user instanceof Response) return user;
  if (request.method !== 'GET') {
    const originError = assertSameOrigin(request);
    if (originError) return originError;
  }
  return handler(request, env, user, new URL(request.url));
}

async function adminStats(_request, env) {
  const [products, orders, customers, revenue, pending] = await Promise.all([
    env.DB.prepare("SELECT COUNT(*) count FROM products WHERE status!='archived'").first(),
    env.DB.prepare('SELECT COUNT(*) count FROM orders').first(),
    env.DB.prepare("SELECT COUNT(*) count FROM users WHERE role='customer'").first(),
    env.DB.prepare("SELECT COALESCE(SUM(total),0) amount FROM orders WHERE status='delivered'").first(),
    env.DB.prepare("SELECT COUNT(*) count FROM orders WHERE status IN ('pending','confirmed','packed','shipped')").first()
  ]);
  return json({ products: products.count, orders: orders.count, customers: customers.count, revenue: revenue.amount, pendingOrders: pending.count });
}

async function adminProducts(_request, env, _user, url) {
  const status = url.searchParams.get('status');
  const sql = status ? 'SELECT * FROM products WHERE status=? ORDER BY updated_at DESC LIMIT 200' : 'SELECT * FROM products ORDER BY updated_at DESC LIMIT 200';
  const result = status ? await env.DB.prepare(sql).bind(status).all() : await env.DB.prepare(sql).all();
  const [categories, brands] = await Promise.all([env.DB.prepare('SELECT * FROM categories ORDER BY sort_order,name').all(), env.DB.prepare('SELECT * FROM brands ORDER BY name').all()]);
  return json({ products: result.results.map(mapProduct), categories: categories.results, brands: brands.results });
}

async function adminCreateProduct(request, env, user) {
  await assertJson(request);
  const body = await request.json();
  const normalized = await normalizeProductInput(env, body);
  if (normalized.error) return json({ error: normalized.error }, 400);
  const id = crypto.randomUUID();
  await env.DB.prepare(`INSERT INTO products (id,slug,title,brand_id,category_id,short_description,description,price,compare_at_price,stock,sku,status,featured,images_json) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)`).bind(
    id, normalized.slug, normalized.title, normalized.brandId, normalized.categoryId, normalized.shortDescription, normalized.description, normalized.price, normalized.compareAtPrice, normalized.stock, normalized.sku, normalized.status, normalized.featured, JSON.stringify(normalized.images)
  ).run();
  await logActivity(env,user.id,'product.create','product',id,{ title: normalized.title });
  return json({ ok: true, id }, 201);
}

async function adminUpdateProduct(request, env, user, url) {
  await assertJson(request);
  const id = decodeURIComponent(url.pathname.split('/').pop());
  const exists = await env.DB.prepare('SELECT id FROM products WHERE id=?').bind(id).first();
  if (!exists) return json({ error: 'Product not found' }, 404);
  const body = await request.json();
  const normalized = await normalizeProductInput(env, body, id);
  if (normalized.error) return json({ error: normalized.error }, 400);
  await env.DB.prepare(`UPDATE products SET slug=?,title=?,brand_id=?,category_id=?,short_description=?,description=?,price=?,compare_at_price=?,stock=?,sku=?,status=?,featured=?,images_json=?,updated_at=CURRENT_TIMESTAMP WHERE id=?`).bind(
    normalized.slug, normalized.title, normalized.brandId, normalized.categoryId, normalized.shortDescription, normalized.description, normalized.price, normalized.compareAtPrice, normalized.stock, normalized.sku, normalized.status, normalized.featured, JSON.stringify(normalized.images), id
  ).run();
  await logActivity(env,user.id,'product.update','product',id,{ title: normalized.title });
  return json({ ok: true });
}

async function adminDeleteProduct(_request, env, user, url) {
  const id = decodeURIComponent(url.pathname.split('/').pop());
  await env.DB.prepare("UPDATE products SET status='archived',updated_at=CURRENT_TIMESTAMP WHERE id=?").bind(id).run();
  await logActivity(env,user.id,'product.archive','product',id,{});
  return json({ ok: true });
}

async function normalizeProductInput(env, body, currentId='') {
  const title = clean(body.title,180);
  const slug = slugify(clean(body.slug,180) || title);
  const price = Math.max(0, Math.round(Number(body.price || 0)));
  const compareAtPrice = body.compareAtPrice === '' || body.compareAtPrice == null ? null : Math.max(0, Math.round(Number(body.compareAtPrice)));
  const stock = Math.max(0, Math.round(Number(body.stock || 0)));
  const status = ['draft','active','archived'].includes(body.status) ? body.status : 'draft';
  if (!title || !slug) return { error: 'Title is required' };
  const dupe = await env.DB.prepare('SELECT id FROM products WHERE slug=? AND id!=?').bind(slug,currentId).first();
  if (dupe) return { error: 'Slug already exists' };
  return {
    title, slug, price, compareAtPrice, stock, status,
    brandId: body.brandId || null,
    categoryId: body.categoryId || null,
    shortDescription: clean(body.shortDescription,500),
    description: clean(body.description,12000),
    sku: clean(body.sku,80),
    featured: body.featured ? 1 : 0,
    images: Array.isArray(body.images) ? body.images.slice(0,10).map(x=>clean(x,500)).filter(Boolean) : []
  };
}

async function adminOrders(_request, env, _user, url) {
  const status = url.searchParams.get('status');
  const result = status ? await env.DB.prepare('SELECT * FROM orders WHERE status=? ORDER BY created_at DESC LIMIT 200').bind(status).all() : await env.DB.prepare('SELECT * FROM orders ORDER BY created_at DESC LIMIT 200').all();
  return json({ orders: result.results.map(o => ({ ...o, address: safeJson(o.address_json,{}) })) });
}

async function adminUpdateOrder(request, env, user, url) {
  await assertJson(request);
  const id = decodeURIComponent(url.pathname.split('/').pop());
  const body = await request.json();
  const status = String(body.status || '');
  const paymentStatus = String(body.paymentStatus || '');
  if (!['pending','confirmed','packed','shipped','delivered','cancelled','returned'].includes(status)) return json({ error: 'Invalid status' }, 400);
  if (!['unpaid','paid','refunded'].includes(paymentStatus)) return json({ error: 'Invalid payment status' }, 400);
  await env.DB.prepare('UPDATE orders SET status=?,payment_status=?,updated_at=CURRENT_TIMESTAMP WHERE id=?').bind(status,paymentStatus,id).run();
  await logActivity(env,user.id,'order.update','order',id,{ status,paymentStatus });
  return json({ ok: true });
}

async function adminCustomers(_request, env) {
  const rows = await env.DB.prepare(`SELECT u.id,u.name,u.email,u.status,u.created_at,COUNT(o.id) orders_count,COALESCE(SUM(o.total),0) total_spent FROM users u LEFT JOIN orders o ON o.user_id=u.id WHERE u.role='customer' GROUP BY u.id ORDER BY u.created_at DESC LIMIT 200`).all();
  return json({ customers: rows.results });
}

async function adminSettingsGet(_request, env) {
  return json({ store: await getSetting(env,'store',{}), homepage: await getSetting(env,'homepage',{}) });
}

async function adminSettingsPut(request, env, user) {
  await assertJson(request);
  const body = await request.json();
  for (const key of ['store','homepage']) {
    if (body[key] && typeof body[key] === 'object') {
      await env.DB.prepare(`INSERT INTO settings (key,value_json,updated_at) VALUES (?,?,CURRENT_TIMESTAMP) ON CONFLICT(key) DO UPDATE SET value_json=excluded.value_json,updated_at=CURRENT_TIMESTAMP`).bind(key, JSON.stringify(body[key])).run();
    }
  }
  await logActivity(env,user.id,'settings.update','settings','global',{});
  return json({ ok: true });
}

async function adminUpload(request, env, user) {
  const form = await request.formData();
  const file = form.get('file');
  if (!(file instanceof File)) return json({ error: 'File required' }, 400);
  if (file.size > 8 * 1024 * 1024) return json({ error: 'Image must be 8 MB or smaller' }, 413);
  const allowed = ['image/jpeg','image/png','image/webp','image/avif','image/gif'];
  if (!allowed.includes(file.type)) return json({ error: 'Unsupported image type' }, 415);
  const ext = extensionFor(file.type);
  const key = `products/${new Date().toISOString().slice(0,10)}/${crypto.randomUUID()}.${ext}`;
  await env.MEDIA.put(key, file.stream(), { httpMetadata: { contentType: file.type, cacheControl: 'public, max-age=31536000, immutable' }, customMetadata: { uploadedBy: user.id } });
  await logActivity(env,user.id,'media.upload','media',key,{ size:file.size,type:file.type });
  return json({ ok: true, key, url: `/media/${key}` }, 201);
}

async function serveMedia(request, env, key) {
  if (!key || key.includes('..')) return new Response('Not found',{status:404});
  const object = await env.MEDIA.get(key);
  if (!object) return new Response('Not found',{status:404});
  const headers = new Headers();
  object.writeHttpMetadata(headers);
  headers.set('etag', object.httpEtag);
  headers.set('cache-control', headers.get('cache-control') || 'public, max-age=86400');
  if (request.method === 'HEAD') return new Response(null,{headers});
  return new Response(object.body,{headers});
}

async function adminCouponsGet(_request, env) {
  const rows = await env.DB.prepare('SELECT * FROM coupons ORDER BY created_at DESC').all();
  return json({ coupons: rows.results });
}

async function adminCouponsPost(request, env, user) {
  await assertJson(request);
  const body = await request.json();
  const code = clean(body.code,40).toUpperCase();
  const type = body.type === 'fixed' ? 'fixed' : 'percent';
  const value = Math.max(1,Math.round(Number(body.value||0)));
  if (!code) return json({ error:'Coupon code required' },400);
  await env.DB.prepare(`INSERT INTO coupons (id,code,type,value,min_order,active,starts_at,ends_at) VALUES (?,?,?,?,?,?,?,?) ON CONFLICT(code) DO UPDATE SET type=excluded.type,value=excluded.value,min_order=excluded.min_order,active=excluded.active,starts_at=excluded.starts_at,ends_at=excluded.ends_at`).bind(crypto.randomUUID(),code,type,value,Math.max(0,Math.round(Number(body.minOrder||0))),body.active===false?0:1,body.startsAt||null,body.endsAt||null).run();
  await logActivity(env,user.id,'coupon.upsert','coupon',code,{});
  return json({ok:true});
}

async function adminReviewsGet(_request, env) {
  const rows = await env.DB.prepare(`SELECT r.*,p.title product_title FROM reviews r JOIN products p ON p.id=r.product_id ORDER BY r.created_at DESC LIMIT 200`).all();
  return json({reviews:rows.results});
}

async function adminReviewsPut(request, env, user, url) {
  await assertJson(request);
  const id = decodeURIComponent(url.pathname.split('/').pop());
  const {status} = await request.json();
  if (!['pending','approved','rejected'].includes(status)) return json({error:'Invalid status'},400);
  await env.DB.prepare('UPDATE reviews SET status=? WHERE id=?').bind(status,id).run();
  await logActivity(env,user.id,'review.moderate','review',id,{status});
  return json({ok:true});
}

async function sitemap(env, origin) {
  const rows = await env.DB.prepare("SELECT slug,updated_at FROM products WHERE status='active' ORDER BY updated_at DESC LIMIT 5000").all();
  const urls = [`<url><loc>${xml(origin)}/</loc></url>`,`<url><loc>${xml(origin)}/shop</loc></url>`,...rows.results.map(p=>`<url><loc>${xml(origin)}/product/${encodeURIComponent(p.slug)}</loc><lastmod>${new Date(p.updated_at+'Z').toISOString()}</lastmod></url>`)].join('');
  return new Response(`<?xml version="1.0" encoding="UTF-8"?><urlset xmlns="http://www.sitemaps.org/sitemap/0.9">${urls}</urlset>`,{headers:{'content-type':'application/xml; charset=utf-8','cache-control':'public,max-age=3600'}});
}

async function issueSession(env, user, status=200) {
  const raw = randomToken();
  const hash = await sha256(raw);
  const id = crypto.randomUUID();
  const expires = new Date(Date.now()+SESSION_DAYS*86400000).toISOString();
  await env.DB.prepare('INSERT INTO sessions (id,token_hash,user_id,expires_at) VALUES (?,?,?,?)').bind(id,hash,user.id,expires).run();
  return json({ user: publicUser(user) }, status, { 'set-cookie': sessionCookie(raw, SESSION_DAYS*86400) });
}

async function currentUser(request, env) {
  const token = cookieValue(request, SESSION_COOKIE);
  if (!token) return null;
  const row = await env.DB.prepare(`SELECT u.id,u.email,u.name,u.role,u.status FROM sessions s JOIN users u ON u.id=s.user_id WHERE s.token_hash=? AND s.expires_at>CURRENT_TIMESTAMP AND u.status='active'`).bind(await sha256(token)).first();
  return row || null;
}

async function requireUser(request, env, role='customer') {
  const user = await currentUser(request, env);
  if (!user) return json({ error:'Authentication required' },401);
  if (role==='admin' && user.role!=='admin') return json({ error:'Admin access required' },403);
  return user;
}

async function hashPassword(password, saltBytes=null) {
  const enc = new TextEncoder();
  const salt = saltBytes || crypto.getRandomValues(new Uint8Array(16));
  const material = await crypto.subtle.importKey('raw',enc.encode(password),'PBKDF2',false,['deriveBits']);
  const bits = await crypto.subtle.deriveBits({name:'PBKDF2',salt,iterations:160000,hash:'SHA-256'},material,256);
  return { hash: bytesToBase64(new Uint8Array(bits)), salt: bytesToBase64(salt) };
}
async function verifyPassword(password, saltB64, expected) {
  const salt = base64ToBytes(saltB64);
  const {hash} = await hashPassword(password,salt);
  return timingSafeEqual(hash,expected);
}
async function sha256(value) {
  const digest = await crypto.subtle.digest('SHA-256',new TextEncoder().encode(value));
  return [...new Uint8Array(digest)].map(b=>b.toString(16).padStart(2,'0')).join('');
}
function timingSafeEqual(a,b){ if(a.length!==b.length)return false; let x=0; for(let i=0;i<a.length;i++)x|=a.charCodeAt(i)^b.charCodeAt(i); return x===0; }
function bytesToBase64(bytes){ let s=''; for(const b of bytes)s+=String.fromCharCode(b); return btoa(s); }
function base64ToBytes(s){ const raw=atob(s); return Uint8Array.from(raw,c=>c.charCodeAt(0)); }
function randomToken(){ return bytesToBase64(crypto.getRandomValues(new Uint8Array(32))).replace(/\+/g,'-').replace(/\//g,'_').replace(/=+$/,''); }
function randomCode(n){ const chars='ABCDEFGHJKLMNPQRSTUVWXYZ23456789'; const a=crypto.getRandomValues(new Uint8Array(n)); return [...a].map(x=>chars[x%chars.length]).join(''); }

function sessionCookie(token,maxAge){ return `${SESSION_COOKIE}=${token}; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=${maxAge}`; }
function clearSessionCookie(){ return `${SESSION_COOKIE}=; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=0`; }
function cookieValue(request,name){ const raw=request.headers.get('cookie')||''; for(const p of raw.split(';')){ const [k,...v]=p.trim().split('='); if(k===name)return v.join('='); } return ''; }
function publicUser(u){ return {id:u.id,email:u.email,name:u.name,role:u.role}; }
function validEmail(v){ return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(v); }
function clean(v,max=500){ return String(v??'').trim().replace(/\u0000/g,'').slice(0,max); }
function slugify(v){ return v.toLowerCase().normalize('NFKD').replace(/[\u0300-\u036f]/g,'').replace(/[^a-z0-9]+/g,'-').replace(/^-|-$/g,'').slice(0,160); }
function safeJson(v,fallback){ try{return JSON.parse(v)}catch{return fallback} }
function mapProduct(p){ return {...p, featured:!!p.featured, images:safeJson(p.images_json,[]), price:Number(p.price), compare_at_price:p.compare_at_price==null?null:Number(p.compare_at_price), stock:Number(p.stock), rating:Number(p.rating||0), review_count:Number(p.review_count||0)}; }
async function getSetting(env,key,fallback){ const row=await env.DB.prepare('SELECT value_json FROM settings WHERE key=?').bind(key).first(); return row?safeJson(row.value_json,fallback):fallback; }
async function logActivity(env,userId,action,entityType,entityId,meta){ await env.DB.prepare('INSERT INTO activity_logs (id,actor_user_id,action,entity_type,entity_id,meta_json) VALUES (?,?,?,?,?,?)').bind(crypto.randomUUID(),userId,action,entityType,entityId,JSON.stringify(meta||{})).run(); }
function extensionFor(type){ return ({'image/jpeg':'jpg','image/png':'png','image/webp':'webp','image/avif':'avif','image/gif':'gif'})[type]||'bin'; }
function xml(s){ return String(s).replace(/[<>&'"]/g,c=>({'<':'&lt;','>':'&gt;','&':'&amp;',"'":'&apos;','"':'&quot;'}[c])); }

async function assertJson(request){
  const ct=request.headers.get('content-type')||'';
  if(!ct.includes('application/json')) throw new HttpError(415,'Expected application/json');
  const same=assertSameOrigin(request); if(same) throw new HttpError(403,'Cross-origin write blocked');
}
function assertSameOrigin(request){ const origin=request.headers.get('origin'); if(!origin)return null; const url=new URL(request.url); return origin===url.origin?null:json({error:'Cross-origin write blocked'},403); }
class HttpError extends Error{ constructor(status,message){super(message);this.status=status;} }
function json(body,status=200,extraHeaders={}){ return new Response(JSON.stringify(body),{status,headers:{...JSON_HEADERS,'cache-control':'no-store',...extraHeaders}}); }
