import { describe, expect, it } from 'vitest';
import { env } from '../src/config';
import { admin, expectError, expectResponse, newCustomer, uid } from '../src/helpers';
import { get, post } from '../src/http';
import { LoginResponse, pageOf, User } from '../src/schemas';

const U = env.usersApi;

describe('Users API: registration', () => {
  it('registers a customer (201) without exposing the password', async () => {
    const email = `reg-${uid().toLowerCase()}@test.local`;
    const res = await post(`${U}/auth/register`, { body: { email, password: 'Password1!', name: 'Reg Test' } });
    const user = expectResponse(res, 201, User);
    expect(user).toMatchObject({ email, role: 'customer', name: 'Reg Test' });
    expect(res.headers.get('location')).toBe(`/users/${user.id}`);
    expect(JSON.stringify(res.body)).not.toMatch(/password/i);
  });

  it('normalises the email to lower case', async () => {
    const res = await post(`${U}/auth/register`, { body: { email: `  MiXeD-${uid()}@Test.Local `, password: 'Password1!', name: 'Case' } });
    expect(expectResponse(res, 201, User).email).toMatch(/^mixed-[a-z0-9]+@test\.local$/);
  });

  it('rejects a duplicate email (409), case-insensitively', async () => {
    const email = `dup-${uid().toLowerCase()}@test.local`;
    await post(`${U}/auth/register`, { body: { email, password: 'Password1!', name: 'A' } });
    expectError(await post(`${U}/auth/register`, { body: { email: email.toUpperCase(), password: 'Password1!', name: 'B' } }), 409, 'CONFLICT');
  });

  it.each([
    ['invalid email', { email: 'nope', password: 'Password1!', name: 'X' }, 'email'],
    ['short password', { email: 'a@test.local', password: '1234567', name: 'X' }, 'password'],
    ['password over 72 chars', { email: 'a@test.local', password: 'x'.repeat(73), name: 'X' }, 'password'],
    ['blank name', { email: 'a@test.local', password: 'Password1!', name: '  ' }, 'name'],
    ['missing fields', {}, 'email'],
  ])('rejects %s with 400 VALIDATION_ERROR', async (_n, body, field) => {
    const err = expectError(await post(`${U}/auth/register`, { body }), 400, 'VALIDATION_ERROR');
    expect((err.details as { path: string }[]).map((d) => d.path)).toContain(field);
  });

  it('rejects malformed JSON with 400 INVALID_JSON', async () => {
    expectError(await post(`${U}/auth/register`, { rawBody: '{"email": ' }), 400, 'INVALID_JSON');
  });

  it('ignores an attempt to self-assign the admin role', async () => {
    const res = await post(`${U}/auth/register`, { body: { email: `role-${uid().toLowerCase()}@test.local`, password: 'Password1!', name: 'X', role: 'admin' } });
    expect(expectResponse(res, 201, User).role).toBe('customer');
  });
});

describe('Users API: login and tokens', () => {
  it('logs in and the token works on /users/me', async () => {
    const c = await newCustomer();
    const me = expectResponse(await get(`${U}/users/me`, { token: c.token }), 200, User);
    expect(me).toMatchObject({ id: c.id, email: c.email });
  });

  it('returns the same 401 for a wrong password and an unknown email', async () => {
    const c = await newCustomer();
    const wrong = expectError(await post(`${U}/auth/login`, { body: { email: c.email, password: 'WrongPass1!' } }), 401, 'UNAUTHORIZED');
    const unknown = expectError(await post(`${U}/auth/login`, { body: { email: `ghost-${uid()}@test.local`, password: 'x' } }), 401, 'UNAUTHORIZED');
    expect(wrong.message).toBe(unknown.message);
  });

  it('logs in the admin with role admin', async () => {
    const res = await post(`${U}/auth/login`, { body: env.admin });
    expect(expectResponse(res, 200, LoginResponse).user.role).toBe('admin');
  });

  it.each([
    ['no token', undefined],
    ['garbage token', 'not.a.jwt'],
  ])('rejects %s on /users/me', async (_n, token) => {
    expectError(await get(`${U}/users/me`, { token }), 401, 'UNAUTHORIZED');
  });

  it('rejects a token whose payload was tampered with', async () => {
    const c = await newCustomer();
    const [h, p, s] = c.token.split('.');
    const payload = JSON.parse(Buffer.from(p, 'base64url').toString());
    const forged = `${h}.${Buffer.from(JSON.stringify({ ...payload, role: 'admin' })).toString('base64url')}.${s}`;
    expectError(await get(`${U}/users`, { token: forged }), 401, 'UNAUTHORIZED');
  });

  it('rejects an unsigned (alg none) token', async () => {
    const c = await newCustomer();
    const payload = c.token.split('.')[1];
    const none = `${Buffer.from(JSON.stringify({ alg: 'none', typ: 'JWT' })).toString('base64url')}.${payload}.`;
    expectError(await get(`${U}/users/me`, { token: none }), 401, 'UNAUTHORIZED');
  });
});

describe('Users API: user management', () => {
  it('lets admins page through users', async () => {
    const res = await get(`${U}/users?page=1&limit=5`, { token: (await admin()).token });
    const page = expectResponse(res, 200, pageOf(User));
    expect(page.items.length).toBeLessThanOrEqual(5);
    expect(page.total).toBeGreaterThanOrEqual(1);
  });

  it('forbids customers from listing users (403)', async () => {
    expectError(await get(`${U}/users`, { token: (await newCustomer()).token }), 403, 'FORBIDDEN');
  });

  it('rejects invalid paging (400)', async () => {
    expectError(await get(`${U}/users?limit=0`, { token: (await admin()).token }), 400, 'VALIDATION_ERROR');
  });

  it('lets a customer read themself but not another user', async () => {
    const [a, b] = await Promise.all([newCustomer(), newCustomer()]);
    expectResponse(await get(`${U}/users/${a.id}`, { token: a.token }), 200, User);
    expectError(await get(`${U}/users/${b.id}`, { token: a.token }), 403, 'FORBIDDEN');
  });

  it('returns 404 to admins for unknown users', async () => {
    expectError(await get(`${U}/users/00000000-0000-4000-8000-000000000000`, { token: (await admin()).token }), 404, 'NOT_FOUND');
  });
});
