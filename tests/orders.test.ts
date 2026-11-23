import { randomUUID } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { env } from '../src/config';
import { admin, expectError, expectResponse, newCustomer, newProduct, placeOrder, waitForStatus } from '../src/helpers';
import { get, post } from '../src/http';
import { Order, pageOf } from '../src/schemas';

const O = env.ordersApi;

describe('Orders API: placing orders', () => {
  it('creates a PENDING order priced from the catalog (201)', async () => {
    const [a, b] = await Promise.all([newProduct({ priceCents: 1250 }), newProduct({ priceCents: 799 })]);
    const c = await newCustomer();
    const res = await placeOrder(c, [
      { productId: a.id, quantity: 2 },
      { productId: b.id, quantity: 3 },
    ]);
    const order = expectResponse(res, 201, Order);
    expect(order).toMatchObject({ userId: c.id, status: 'PENDING', totalCents: 2 * 1250 + 3 * 799, failureReason: null });
    expect(order.items).toEqual([
      { productId: a.id, sku: a.sku, name: a.name, unitPriceCents: 1250, quantity: 2, lineTotalCents: 2500 },
      { productId: b.id, sku: b.sku, name: b.name, unitPriceCents: 799, quantity: 3, lineTotalCents: 2397 },
    ]);
    expect(res.headers.get('location')).toBe(`/orders/${order.id}`);
  });

  it('ignores prices and totals sent by the client', async () => {
    const p = await newProduct({ priceCents: 4000 });
    const c = await newCustomer();
    const res = await post(`${O}/orders`, { token: c.token, body: { items: [{ productId: p.id, quantity: 1, unitPriceCents: 1 }], totalCents: 1 } });
    expect(expectResponse(res, 201, Order).totalCents).toBe(4000);
  });

  it('requires a token (401)', async () => {
    expectError(await post(`${O}/orders`, { body: { items: [] } }), 401, 'UNAUTHORIZED');
  });

  it.each([
    ['no items', { items: [] }],
    ['missing items', {}],
    ['zero quantity', { items: [{ productId: 'x', quantity: 0 }] }],
    ['quantity over 100', { items: [{ productId: 'x', quantity: 101 }] }],
    ['non-integer quantity', { items: [{ productId: 'x', quantity: 1.5 }] }],
    ['duplicate product lines', { items: [{ productId: 'x', quantity: 1 }, { productId: 'x', quantity: 2 }] }],
  ])('rejects %s (400)', async (_n, body) => {
    const c = await newCustomer();
    expectError(await post(`${O}/orders`, { token: c.token, body }), 400, 'VALIDATION_ERROR');
  });

  it('rejects unknown products (422) and lists them', async () => {
    const p = await newProduct();
    const c = await newCustomer();
    const err = expectError(
      await placeOrder(c, [
        { productId: p.id, quantity: 1 },
        { productId: '000000000000000000000000', quantity: 1 },
      ]),
      422,
      'PRODUCT_NOT_FOUND',
    );
    expect(err.details).toEqual({ productIds: ['000000000000000000000000'] });
  });

  it('rejects quantities above current stock (409) with the shortfall', async () => {
    const p = await newProduct({ stock: 2 });
    const c = await newCustomer();
    const err = expectError(await placeOrder(c, [{ productId: p.id, quantity: 3 }]), 409, 'INSUFFICIENT_STOCK');
    expect(err.details).toEqual({ items: [{ productId: p.id, requested: 3, available: 2 }] });
  });
});

describe('Orders API: Idempotency-Key', () => {
  it('returns the original order for a repeated key (200, Idempotent-Replayed)', async () => {
    const p = await newProduct();
    const c = await newCustomer();
    const key = randomUUID();
    const first = expectResponse(await placeOrder(c, [{ productId: p.id, quantity: 1 }], key), 201, Order);
    const again = await placeOrder(c, [{ productId: p.id, quantity: 4 }], key);
    expect(expectResponse(again, 200, Order).id).toBe(first.id);
    expect(again.headers.get('idempotent-replayed')).toBe('true');
  });

  it('creates exactly one order for concurrent requests with the same key', async () => {
    const p = await newProduct({ stock: 50 });
    const c = await newCustomer();
    const key = randomUUID();
    const results = await Promise.all(Array.from({ length: 6 }, () => placeOrder(c, [{ productId: p.id, quantity: 1 }], key)));
    expect(new Set(results.map((r) => r.body.id)).size).toBe(1);
    expect(results.filter((r) => r.status === 201)).toHaveLength(1);
    const list = await get(`${O}/orders`, { token: c.token });
    expect(list.body.total).toBe(1);
  });

  it('scopes keys to the user', async () => {
    const p = await newProduct();
    const [a, b] = await Promise.all([newCustomer(), newCustomer()]);
    const key = randomUUID();
    const oa = await placeOrder(a, [{ productId: p.id, quantity: 1 }], key);
    const ob = await placeOrder(b, [{ productId: p.id, quantity: 1 }], key);
    expect(ob.status).toBe(201);
    expect(ob.body.id).not.toBe(oa.body.id);
  });
});

describe('Orders API: reading orders', () => {
  it("customers only see their own orders, newest first; admins see everyone's", async () => {
    const p = await newProduct({ stock: 50 });
    const [a, b] = await Promise.all([newCustomer(), newCustomer()]);
    const a1 = (await placeOrder(a, [{ productId: p.id, quantity: 1 }])).body;
    const b1 = (await placeOrder(b, [{ productId: p.id, quantity: 1 }])).body;
    const a2 = (await placeOrder(a, [{ productId: p.id, quantity: 1 }])).body;

    const mine = expectResponse(await get(`${O}/orders`, { token: a.token }), 200, pageOf(Order));
    expect(mine.items.map((o) => o.id)).toEqual([a2.id, a1.id]);

    const ignoredFilter = await get(`${O}/orders?userId=${b.id}`, { token: a.token });
    expect(ignoredFilter.body.items.map((o: { id: string }) => o.id)).not.toContain(b1.id);

    const forB = await get(`${O}/orders?userId=${b.id}`, { token: (await admin()).token });
    expect(forB.body.items.map((o: { id: string }) => o.id)).toEqual([b1.id]);
  });

  it('filters by status and validates the query', async () => {
    const c = await newCustomer();
    expectResponse(await get(`${O}/orders?status=CANCELLED`, { token: c.token }), 200, pageOf(Order));
    expectError(await get(`${O}/orders?status=SHIPPED`, { token: c.token }), 400, 'VALIDATION_ERROR');
    expectError(await get(`${O}/orders?limit=1000`, { token: c.token }), 400, 'VALIDATION_ERROR');
  });

  it("returns 403 for someone else's order and 404 for unknown ids", async () => {
    const p = await newProduct();
    const [a, b] = await Promise.all([newCustomer(), newCustomer()]);
    const order = (await placeOrder(a, [{ productId: p.id, quantity: 1 }])).body;
    expectResponse(await get(`${O}/orders/${order.id}`, { token: a.token }), 200, Order);
    expectResponse(await get(`${O}/orders/${order.id}`, { token: (await admin()).token }), 200, Order);
    expectError(await get(`${O}/orders/${order.id}`, { token: b.token }), 403, 'FORBIDDEN');
    expectError(await get(`${O}/orders/00000000-0000-4000-8000-000000000000`, { token: a.token }), 404, 'NOT_FOUND');
    expectError(await get(`${O}/orders/not-a-uuid`, { token: a.token }), 404, 'NOT_FOUND');
  });
});

describe('Orders API: cancelling', () => {
  it('cancels an order once; a second cancel is 409 INVALID_STATUS', async () => {
    const p = await newProduct();
    const c = await newCustomer();
    const order = (await placeOrder(c, [{ productId: p.id, quantity: 1 }])).body;
    await waitForStatus(c, order.id, ['PROCESSED']);
    const cancelled = expectResponse(await post(`${O}/orders/${order.id}/cancel`, { token: c.token }), 200, Order);
    expect(cancelled.status).toBe('CANCELLED');
    const err = expectError(await post(`${O}/orders/${order.id}/cancel`, { token: c.token }), 409, 'INVALID_STATUS');
    expect(err.details).toEqual({ status: 'CANCELLED' });
  });

  it("does not let a customer cancel someone else's order", async () => {
    const p = await newProduct();
    const [a, b] = await Promise.all([newCustomer(), newCustomer()]);
    const order = (await placeOrder(a, [{ productId: p.id, quantity: 1 }])).body;
    expectError(await post(`${O}/orders/${order.id}/cancel`, { token: b.token }), 403, 'FORBIDDEN');
  });

  it('lets an admin cancel any order', async () => {
    const p = await newProduct();
    const c = await newCustomer();
    const order = (await placeOrder(c, [{ productId: p.id, quantity: 1 }])).body;
    const res = await post(`${O}/orders/${order.id}/cancel`, { token: (await admin()).token });
    expect(expectResponse(res, 200, Order).status).toBe('CANCELLED');
  });
});
