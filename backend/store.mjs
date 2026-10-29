import crypto from 'node:crypto';

export class HttpError extends Error {
  constructor(status, message) { super(message); this.status = status; }
}
export const hash = value => crypto.createHash('sha256').update(value).digest('hex');
export const randomToken = () => crypto.randomBytes(32).toString('base64url');
export const paymentMethods = ['EVC Plus','ZAAD','eDahab','Sahal','Premier Wallet','Bank Transfer','Visa / Mastercard','Cash on Delivery'];

export async function transaction(pool, work) {
  const client = await pool.connect();
  let broken = false;
  try {
    await client.query('BEGIN');
    await client.query("SET LOCAL lock_timeout = '5s'");
    const result = await work(client);
    await client.query('COMMIT');
    return result;
  } catch (error) {
    try { await client.query('ROLLBACK'); } catch { broken = true; }
    throw error;
  } finally { client.release(broken); }
}

export async function readState(client, lock = false) {
  const result = await client.query('SELECT data FROM public.store_state WHERE id=1' + (lock ? ' FOR UPDATE' : ''));
  const state = result.rows[0]?.data;
  if (!state || !Array.isArray(state.products) || !state.content || typeof state.content !== 'object' ||
      (state.orders !== undefined && !Array.isArray(state.orders)) ||
      (state.customers !== undefined && !Array.isArray(state.customers))) {
    throw new HttpError(503, 'Store initialization required');
  }
  state.orders ??= [];
  state.customers ??= [];
  return state;
}
export async function updateState(pool, work) {
  return transaction(pool, async client => {
    const state = await readState(client, true);
    const result = await work(state, client);
    const saved = await client.query('UPDATE public.store_state SET data=$1::jsonb,updated_at=NOW() WHERE id=1', [JSON.stringify(state)]);
    if (saved.rowCount !== 1) throw new HttpError(503, 'Store unavailable');
    return result;
  });
}
function text(value, max, min = 1) {
  if (typeof value !== 'string' || value.trim().length < min || value.trim().length > max)
    throw new HttpError(400, 'Invalid delivery details');
  return value.trim();
}
export function normalizeOrder(input) {
  if (!input || !Array.isArray(input.items) || input.items.length < 1 || input.items.length > 50)
    throw new HttpError(400, 'Valid cart items required');
  const items = input.items.map(item => {
    if (!item || !Number.isSafeInteger(item.id) || item.id < 1 || !Number.isInteger(item.qty) ||
        item.qty < 1 || item.qty > 20 || typeof item.size !== 'string' || !item.size || item.size.length > 50)
      throw new HttpError(400, 'Invalid cart item');
    return {id: item.id, qty: item.qty, size: item.size};
  });
  const method = input.paymentMethod ?? 'Cash on Delivery';
  if (!paymentMethods.includes(method)) throw new HttpError(400, 'Invalid payment method');
  return {items, country: text(input.country,100), city: text(input.city,100),
    address: text(input.address,600,5), phone: text(input.phone,60,5),
    name: input.name === undefined ? '' : text(input.name,150),
    notes: input.notes === undefined || input.notes === '' ? '' : text(input.notes,1000),
    paymentMethod: method};
}
export function cents(value) {
  if (typeof value !== 'number' || !Number.isFinite(value) || value <= 0 || value > 1000000 ||
      Math.abs(value * 100 - Math.round(value * 100)) > 0.000001)
    throw new HttpError(400, 'Price must be a positive amount with at most two decimal places');
  return Math.round(value * 100);
}
function quantities(items) {
  const totals = new Map();
  for (const item of items) totals.set(item.id, (totals.get(item.id) || 0) + item.qty);
  return totals;
}
function restoreStock(state, order) {
  for (const [id, qty] of quantities(order.items)) {
    const product = state.products.find(p => p.id === id);
    if (!product || !Number.isSafeInteger(product.stock) || !Number.isSafeInteger(qty) || qty < 1 ||
        !Number.isSafeInteger(product.stock + qty)) throw new HttpError(409, 'Reserved product requires owner review');
    product.stock += qty;
  }
  order.stockReleased = true;
}
export function expireReservations(state, now = Date.now()) {
  let changed = false;
  for (const order of state.orders) {
    // Legacy orders without an expiry remain available for manual owner review/cancellation.
    if (order.status === 'Awaiting payment' && order.reservationExpiresAt &&
        Date.parse(order.reservationExpiresAt) <= now && !order.stockReleased) {
      restoreStock(state, order);
      order.status = 'Cancelled';
      order.cancellationReason = 'Unpaid reservation expired';
      order.updatedAt = new Date(now).toISOString();
      changed = true;
    }
  }
  return changed;
}
export function placeOrder(state, customer, input, key, now = Date.now()) {
  if (typeof key !== 'string' || !/^[a-zA-Z0-9_-]{16,100}$/.test(key))
    throw new HttpError(400, 'A valid Idempotency-Key header is required');
  const normalized = normalizeOrder(input);
  const requestHash = hash(JSON.stringify(normalized));
  const existing = state.orders.find(o => o.googleSub === customer.googleSub && o.idempotencyKey === key);
  if (existing) {
    if (existing.requestHash !== requestHash) throw new HttpError(409, 'This checkout key was already used for different order details');
    return {order: existing, replayed: true};
  }
  expireReservations(state, now);
  if (state.orders.filter(o => o.googleSub === customer.googleSub && o.status === 'Awaiting payment').length >= 3)
    throw new HttpError(429, 'Please resolve your existing unpaid orders before ordering again');
  const totals = quantities(normalized.items);
  const lines = [];
  let subtotalCents = 0;
  for (const [id, qty] of totals) {
    const product = state.products.find(p => p.id === id);
    if (!product || !Number.isSafeInteger(product.stock) || product.stock < qty || qty > 20)
      throw new HttpError(409, 'Insufficient stock or quantity exceeds the product limit');
  }
  for (const item of normalized.items) {
    const product = state.products.find(p => p.id === item.id);
    if (!Array.isArray(product.sizes) || !product.sizes.includes(item.size))
      throw new HttpError(400, 'Invalid product size');
    const unitPriceCents = cents(product.price);
    subtotalCents += unitPriceCents * item.qty;
    lines.push({...item, name: product.name, unitPrice: unitPriceCents / 100, unitPriceCents});
  }
  if (!Number.isSafeInteger(subtotalCents)) throw new HttpError(400, 'Invalid order total');
  const deliveryCents = subtotalCents >= 15000 ? 0 : 500;
  const order = {id:'WS-' + crypto.randomUUID().toUpperCase(), googleSub:customer.googleSub,
    user:customer.email, items:lines, subtotalCents, deliveryCents, totalCents:subtotalCents+deliveryCents,
    total:(subtotalCents+deliveryCents)/100, country:normalized.country, city:normalized.city,
    address:normalized.address, phone:normalized.phone, name:normalized.name || customer.name,
    notes:normalized.notes, paymentMethod:normalized.paymentMethod,
    payment:'UNPAID — manual confirmation required', status:'Awaiting payment',
    date:new Date(now).toISOString(), reservationExpiresAt:new Date(now+30*60000).toISOString(),
    stockReleased:false, idempotencyKey:key, requestHash};
  for (const [id, qty] of totals) state.products.find(p => p.id === id).stock -= qty;
  state.orders.unshift(order);
  return {order, replayed:false};
}
export function changeOrderStatus(state, id, status, now = Date.now()) {
  expireReservations(state, now);
  const order = state.orders.find(o => o.id === id);
  if (!order) throw new HttpError(404, 'Order not found');
  const transitions = {'Awaiting payment':['Confirmed','Cancelled'],Confirmed:['Processing','Cancelled'],
    Processing:['Shipped','Cancelled'],Shipped:['Delivered'],Delivered:[],Cancelled:[]};
  if (!Object.hasOwn(transitions,status)) throw new HttpError(400, 'Invalid status');
  if (order.status === status) return order;
  if (!transitions[order.status]?.includes(status)) throw new HttpError(409, 'Invalid order status transition');
  if (status === 'Cancelled' && !order.stockReleased) restoreStock(state,order);
  order.status = status;
  order.updatedAt = new Date(now).toISOString();
  if (status === 'Confirmed') order.reservationExpiresAt = null;
  return order;
}
export function validateProduct(input) {
  if (!input || typeof input.name !== 'string' || input.name.trim().length < 2 || input.name.length > 149 ||
      !['Suits','Blazers','Shirts','Shoes','Trousers','Accessories','Casual'].includes(input.category) ||
      !Number.isSafeInteger(input.stock) || input.stock < 0 ||
      !Array.isArray(input.sizes) || !input.sizes.length || input.sizes.length > 50 ||
      !Array.isArray(input.colors) || input.colors.length > 50 ||
      [...input.sizes,...input.colors].some(v => typeof v !== 'string' || !v.trim() || v.length > 50) ||
      typeof input.image !== 'string' || input.image.length > 3000000 ||
      !(/^(https?:\/\/|data:image\/(png|jpeg|webp);base64,)/i.test(input.image)) ||
      (input.description !== undefined && (typeof input.description !== 'string' || input.description.length > 5000)))
    throw new HttpError(400, 'Invalid product');
  cents(input.price);
  return {name:input.name.trim(),category:input.category,stock:input.stock,price:input.price,
    sizes:input.sizes,colors:input.colors,image:input.image,description:input.description || ''};
}
