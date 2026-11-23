import { describe, expect, it } from 'vitest';
import { env } from '../src/config';
import { admin, expectError, expectResponse, newCustomer, newProduct, uid } from '../src/helpers';
import { del, get, patch, post } from '../src/http';
import { pageOf, Product, Stock } from '../src/schemas';

const C = env.catalogApi;

describe('Catalog API: products', () => {
  it('creates a product as admin (201) and reads it back', async () => {
    const sku = `cat-${uid()}`;
    const res = await post(`${C}/products`, {
      token: (await admin()).token,
      body: { sku, name: 'Desk Lamp', description: 'Warm light', category: 'Lighting', priceCents: 3499, stock: 7 },
    });
    const created = expectResponse(res, 201, Product);
    expect(created).toMatchObject({ sku: sku.toUpperCase(), category: 'lighting', priceCents: 3499, stock: 7 });
    expect(expectResponse(await get(`${C}/products/${created.id}`), 200, Product)).toEqual(created);
  });

  it('allows anyone to read but only admins to write', async () => {
    const p = await newProduct();
    expectResponse(await get(`${C}/products/${p.id}`), 200, Product);
    const customer = await newCustomer();
    expectError(await post(`${C}/products`, { body: { sku: 'X1', name: 'x', category: 'c', priceCents: 1, stock: 1 } }), 401, 'UNAUTHORIZED');
    expectError(await post(`${C}/products`, { token: customer.token, body: { sku: 'X1', name: 'x', category: 'c', priceCents: 1, stock: 1 } }), 403, 'FORBIDDEN');
    expectError(await patch(`${C}/products/${p.id}`, { token: customer.token, body: { stock: 0 } }), 403, 'FORBIDDEN');
    expectError(await del(`${C}/products/${p.id}`, { token: customer.token }), 403, 'FORBIDDEN');
  });

  it('rejects a duplicate SKU (409)', async () => {
    const p = await newProduct();
    const res = await post(`${C}/products`, { token: (await admin()).token, body: { sku: p.sku.toLowerCase(), name: 'Dup', category: 'c', priceCents: 1, stock: 1 } });
    expectError(res, 409, 'CONFLICT');
  });

  it.each([
    ['zero price', { priceCents: 0 }],
    ['fractional price', { priceCents: 9.99 }],
    ['negative stock', { stock: -1 }],
    ['bad sku', { sku: 'has spaces' }],
    ['missing name', { name: undefined }],
  ])('rejects %s (400)', async (_n, over) => {
    const body = { sku: `V-${uid()}`, name: 'Valid', category: 'c', priceCents: 100, stock: 1, ...over };
    expectError(await post(`${C}/products`, { token: (await admin()).token, body }), 400, 'VALIDATION_ERROR');
  });

  it('updates price and stock but not the SKU', async () => {
    const p = await newProduct({ priceCents: 1000, stock: 3 });
    const token = (await admin()).token;
    const updated = expectResponse(await patch(`${C}/products/${p.id}`, { token, body: { priceCents: 1500, stock: 9 } }), 200, Product);
    expect(updated).toMatchObject({ sku: p.sku, priceCents: 1500, stock: 9 });
    expectError(await patch(`${C}/products/${p.id}`, { token, body: { sku: 'NEW-SKU' } }), 400, 'VALIDATION_ERROR');
    expectError(await patch(`${C}/products/${p.id}`, { token, body: {} }), 400, 'VALIDATION_ERROR');
  });

  it('deletes a product (204), then returns 404', async () => {
    const p = await newProduct();
    const token = (await admin()).token;
    const res = await del(`${C}/products/${p.id}`, { token });
    expect(res.status).toBe(204);
    expectError(await get(`${C}/products/${p.id}`), 404, 'NOT_FOUND');
    expectError(await del(`${C}/products/${p.id}`, { token }), 404, 'NOT_FOUND');
  });

  it.each(['000000000000000000000000', 'not-an-object-id'])('returns 404 for product id %s', async (id) => {
    expectError(await get(`${C}/products/${id}`), 404, 'NOT_FOUND');
    expectError(await get(`${C}/products/${id}/stock`), 404, 'NOT_FOUND');
  });

  it('reports stock for a product', async () => {
    const p = await newProduct({ stock: 0 });
    expect(expectResponse(await get(`${C}/products/${p.id}/stock`), 200, Stock)).toEqual({ productId: p.id, sku: p.sku, stock: 0, inStock: false });
  });
});

describe('Catalog API: listing and search', () => {
  it('filters by category, search text and stock, and sorts by price', async () => {
    const category = `list-${uid().toLowerCase()}`;
    const cheap = await newProduct({ category, priceCents: 500, stock: 1, name: `Cheap ${uid()}` });
    const pricey = await newProduct({ category, priceCents: 9000, stock: 0, name: `Pricey ${uid()}` });

    const byCategory = expectResponse(await get(`${C}/products?category=${category}&sort=price_desc`), 200, pageOf(Product));
    expect(byCategory.items.map((p) => p.id)).toEqual([pricey.id, cheap.id]);
    expect(byCategory.total).toBe(2);

    const inStock = await get(`${C}/products?category=${category}&inStock=true`);
    expect(inStock.body.items.map((p: { id: string }) => p.id)).toEqual([cheap.id]);

    const search = await get(`${C}/products?q=${encodeURIComponent(pricey.sku)}`);
    expect(search.body.items.map((p: { id: string }) => p.id)).toEqual([pricey.id]);
  });

  it('treats regex characters in the search literally', async () => {
    const res = await get(`${C}/products?q=${encodeURIComponent('.*(')}`);
    expect(res.status).toBe(200);
    expect(res.body.total).toBe(0);
  });

  it('pages results', async () => {
    const res = expectResponse(await get(`${C}/products?limit=2&page=1`), 200, pageOf(Product));
    expect(res.items.length).toBeLessThanOrEqual(2);
    expect(res).toMatchObject({ page: 1, limit: 2 });
  });

  it.each(['limit=0', 'limit=101', 'page=0', 'sort=random', 'inStock=maybe'])('rejects %s (400)', async (q) => {
    expectError(await get(`${C}/products?${q}`), 400, 'VALIDATION_ERROR');
  });

  it('lists categories with counts', async () => {
    const res = await get(`${C}/categories`);
    expect(res.status).toBe(200);
    expect(res.body.items.length).toBeGreaterThan(0);
    for (const c of res.body.items) expect(c).toEqual({ category: expect.any(String), count: expect.any(Number) });
  });
});

describe('Catalog API: reports and activity access', () => {
  it('requires a token for activity and the admin role for reports', async () => {
    expectError(await get(`${C}/activity`), 401, 'UNAUTHORIZED');
    expectError(await get(`${C}/reports/daily`, { token: (await newCustomer()).token }), 403, 'FORBIDDEN');
    expectError(await get(`${C}/reports/daily?date=2026-13-45x`, { token: (await admin()).token }), 400, 'VALIDATION_ERROR');
    expectError(await get(`${C}/reports/daily?date=1999-01-01`, { token: (await admin()).token }), 404, 'NOT_FOUND');
  });
});
