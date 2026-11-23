import { randomUUID } from 'node:crypto';
import { expect } from 'vitest';
import type { z } from 'zod';
import { env } from './config';
import { get, post, type HttpResponse } from './http';
import { ErrorBody, LoginResponse } from './schemas';

export const uid = () => randomUUID().slice(0, 8).toUpperCase();

/** Asserts status and response shape in one go; prints the body on failure. */
export function expectResponse<S extends z.ZodTypeAny>(res: HttpResponse, status: number, schema?: S): z.infer<S> {
  expect(res.status, `expected ${status}, got ${res.status}: ${JSON.stringify(res.body)}`).toBe(status);
  if (!schema) return res.body;
  const parsed = schema.safeParse(res.body);
  expect(parsed.success, parsed.success ? '' : `${JSON.stringify(parsed.error.issues)}\n${JSON.stringify(res.body)}`).toBe(true);
  return parsed.data;
}

export function expectError(res: HttpResponse, status: number, code: string) {
  const body = expectResponse(res, status, ErrorBody);
  expect(body.error.code).toBe(code);
  return body.error;
}

export interface Account {
  id: string;
  email: string;
  password: string;
  token: string;
  role: 'customer' | 'admin';
}

let adminCache: Promise<Account> | undefined;

export async function login(email: string, password: string): Promise<Account> {
  const res = await post(`${env.usersApi}/auth/login`, { body: { email, password } });
  const body = expectResponse(res, 200, LoginResponse);
  return { id: body.user.id, email, password, token: body.token, role: body.user.role };
}

export const admin = () => (adminCache ??= login(env.admin.email, env.admin.password));

export async function newCustomer(name = 'API Test Customer'): Promise<Account> {
  const email = `api-${uid().toLowerCase()}-${Date.now()}@test.local`;
  const password = 'Password1!';
  expectResponse(await post(`${env.usersApi}/auth/register`, { body: { email, password, name } }), 201);
  return login(email, password);
}

export interface TestProduct {
  id: string;
  sku: string;
  name: string;
  priceCents: number;
  stock: number;
  category: string;
}

export async function newProduct(over: Partial<Omit<TestProduct, 'id'>> & { description?: string } = {}): Promise<TestProduct> {
  const id = uid();
  const res = await post(`${env.catalogApi}/products`, {
    token: (await admin()).token,
    body: { sku: `API-${id}`, name: `API Product ${id}`, category: 'api-tests', priceCents: 1000, stock: 10, description: '', ...over },
  });
  return expectResponse(res, 201);
}

export async function stockOf(productId: string): Promise<number> {
  return (await get(`${env.catalogApi}/products/${productId}/stock`)).body.stock;
}

export function placeOrder(account: Account, items: { productId: string; quantity: number }[], idempotencyKey?: string) {
  return post(`${env.ordersApi}/orders`, {
    token: account.token,
    body: { items },
    headers: idempotencyKey ? { 'Idempotency-Key': idempotencyKey } : {},
  });
}

/** Polls until fn returns a truthy value or the async timeout passes. */
export async function eventually<T>(fn: () => Promise<T | false | null | undefined>, what: string, timeoutMs = env.asyncTimeoutMs): Promise<T> {
  const until = Date.now() + timeoutMs;
  for (;;) {
    const v = await fn();
    if (v) return v;
    if (Date.now() > until) throw new Error(`Timed out after ${timeoutMs} ms waiting for: ${what}`);
    await new Promise((r) => setTimeout(r, 300));
  }
}

export async function waitForStatus(account: Account, orderId: string, statuses: string[]) {
  return eventually(async () => {
    const res = await get(`${env.ordersApi}/orders/${orderId}`, { token: account.token });
    return statuses.includes(res.body?.status) ? res.body : null;
  }, `order ${orderId} to reach ${statuses.join(' or ')}`);
}

export async function activityTypes(account: Account, orderId: string): Promise<string[]> {
  const res = await get(`${env.catalogApi}/activity?orderId=${orderId}`, { token: account.token });
  return res.body.items.map((a: { type: string }) => a.type);
}
