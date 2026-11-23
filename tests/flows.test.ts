/**
 * Cross-service flows: Orders API -> Kafka -> jobs worker -> MongoDB/Postgres -> Catalog API.
 * These need the jobs worker running and wait (with a timeout) for it to finish.
 */
import { describe, expect, it } from 'vitest';
import { env } from '../src/config';
import { activityTypes, admin, eventually, expectResponse, newCustomer, newProduct, placeOrder, stockOf, waitForStatus } from '../src/helpers';
import { get, post } from '../src/http';
import { Activity, DailySummary, Order } from '../src/schemas';

describe('order processing across services', () => {
  it('PENDING -> PROCESSED: stock is reserved and the timeline is written', async () => {
    const p = await newProduct({ stock: 10 });
    const c = await newCustomer();
    const created = expectResponse(await placeOrder(c, [{ productId: p.id, quantity: 3 }]), 201, Order);
    expect(created.status).toBe('PENDING');

    const processed = await waitForStatus(c, created.id, ['PROCESSED', 'FAILED']);
    expect(processed.status).toBe('PROCESSED');
    expect(new Date(processed.updatedAt).getTime()).toBeGreaterThan(new Date(processed.createdAt).getTime());
    expect(await stockOf(p.id)).toBe(7);

    const timeline = await get(`${env.catalogApi}/activity?orderId=${created.id}`, { token: c.token });
    for (const a of timeline.body.items) Activity.parse(a);
    expect(timeline.body.items.map((a: { type: string }) => a.type)).toEqual(['ORDER_RECEIVED', 'STOCK_RESERVED', 'ORDER_PROCESSED']);
  });

  it('two orders racing for the last unit: one PROCESSED, one FAILED, stock never negative', async () => {
    const p = await newProduct({ stock: 1 });
    const [a, b] = await Promise.all([newCustomer(), newCustomer()]);
    // The Orders API only checks stock; the jobs worker reserves it. Both can be accepted.
    const results = await Promise.all([placeOrder(a, [{ productId: p.id, quantity: 1 }]), placeOrder(b, [{ productId: p.id, quantity: 1 }])]);
    const accepted = results.map((r, i) => ({ r, who: [a, b][i] })).filter(({ r }) => r.status === 201);
    for (const r of results) expect([201, 409]).toContain(r.status);

    const finals = await Promise.all(accepted.map(({ r, who }) => waitForStatus(who, r.body.id, ['PROCESSED', 'FAILED'])));
    expect(finals.filter((o) => o.status === 'PROCESSED')).toHaveLength(1);
    for (const o of finals.filter((f) => f.status === 'FAILED')) {
      expect(o.failureReason).toBe('INSUFFICIENT_STOCK');
    }
    expect(await stockOf(p.id)).toBe(0);
  });

  it('an order FAILS if stock is gone by the time the worker processes it', async () => {
    const p = await newProduct({ stock: 2 });
    const c = await newCustomer();
    const order = expectResponse(await placeOrder(c, [{ productId: p.id, quantity: 2 }]), 201, Order);
    // Stock drops after the order was accepted but before the worker reserves it.
    await fetch(`${env.catalogApi}/products/${p.id}`, {
      method: 'PATCH',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${(await admin()).token}` },
      body: JSON.stringify({ stock: 1 }),
    });
    const final = await waitForStatus(c, order.id, ['PROCESSED', 'FAILED']);
    // With the default PROCESSING_DELAY_MS the PATCH lands first; on a very fast worker the order may already be PROCESSED.
    if (final.status === 'FAILED') {
      expect(final.failureReason).toBe('INSUFFICIENT_STOCK');
      expect(await stockOf(p.id)).toBe(1);
      expect(await activityTypes(c, order.id)).toEqual(['ORDER_RECEIVED', 'ORDER_FAILED']);
    } else {
      expect(await stockOf(p.id)).toBe(0);
    }
  });

  it('cancelling a PROCESSED order returns the stock', async () => {
    const p = await newProduct({ stock: 5 });
    const c = await newCustomer();
    const order = (await placeOrder(c, [{ productId: p.id, quantity: 2 }])).body;
    await waitForStatus(c, order.id, ['PROCESSED']);
    expect(await stockOf(p.id)).toBe(3);

    expectResponse(await post(`${env.ordersApi}/orders/${order.id}/cancel`, { token: c.token }), 200, Order);
    await eventually(async () => (await stockOf(p.id)) === 5, 'stock to be released');
    await eventually(async () => (await activityTypes(c, order.id)).includes('ORDER_CANCELLED'), 'ORDER_CANCELLED activity');
    expect(await activityTypes(c, order.id)).toEqual(['ORDER_RECEIVED', 'STOCK_RESERVED', 'ORDER_PROCESSED', 'STOCK_RELEASED', 'ORDER_CANCELLED']);
  });

  it('cancelling while still PENDING leaves stock unchanged once the worker catches up', async () => {
    const p = await newProduct({ stock: 5 });
    const c = await newCustomer();
    const order = (await placeOrder(c, [{ productId: p.id, quantity: 2 }])).body;
    const cancel = await post(`${env.ordersApi}/orders/${order.id}/cancel`, { token: c.token });
    expect(cancel.status).toBe(200);
    await eventually(async () => (await activityTypes(c, order.id)).includes('ORDER_CANCELLED'), 'ORDER_CANCELLED activity');
    // Wait until the worker has also handled order.created (it releases what it reserved).
    await eventually(async () => {
      const t = await activityTypes(c, order.id);
      return t.includes('STOCK_RELEASED') || t.includes('ORDER_FAILED') || (t.includes('ORDER_RECEIVED') && !t.includes('STOCK_RESERVED'));
    }, 'worker to finish with the order');
    await eventually(async () => (await stockOf(p.id)) === 5, 'stock back to 5');
    const final = await get(`${env.ordersApi}/orders/${order.id}`, { token: c.token });
    expect(final.body.status).toBe('CANCELLED');
  });

  it("customers cannot read another customer's activity", async () => {
    const p = await newProduct();
    const [a, b] = await Promise.all([newCustomer(), newCustomer()]);
    const order = (await placeOrder(a, [{ productId: p.id, quantity: 1 }])).body;
    await waitForStatus(a, order.id, ['PROCESSED']);
    expect(await activityTypes(b, order.id)).toEqual([]);
    expect((await activityTypes(await admin(), order.id)).length).toBeGreaterThan(0);
  });

  it('a JWT from the Users API is accepted by the Orders and Catalog APIs', async () => {
    const c = await newCustomer();
    expect((await get(`${env.ordersApi}/orders`, { token: c.token })).status).toBe(200);
    expect((await get(`${env.catalogApi}/activity`, { token: c.token })).status).toBe(200);
  });

  it("the daily report (built by the jobs worker) includes today's orders", async () => {
    const p = await newProduct();
    const c = await newCustomer();
    await placeOrder(c, [{ productId: p.id, quantity: 1 }]);
    const today = new Date().toISOString().slice(0, 10);
    const token = (await admin()).token;
    // The worker rebuilds the summary every SUMMARY_INTERVAL_MS (10 s in docker-compose).
    const report = await eventually(async () => {
      const res = await get(`${env.catalogApi}/reports/daily?date=${today}`, { token });
      return res.status === 200 && res.body.orderCount > 0 ? res.body : null;
    }, "today's daily summary", Math.max(env.asyncTimeoutMs, 30_000));
    expect(DailySummary.parse(report).date).toBe(today);
  });
});
