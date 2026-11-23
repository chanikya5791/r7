import { describe, expect, it } from 'vitest';
import { env } from '../src/config';
import { expectResponse } from '../src/helpers';
import { get } from '../src/http';
import { Health } from '../src/schemas';

describe('health checks', () => {
  it.each([
    ['users-api', env.usersApi, ['postgres']],
    ['catalog-api', env.catalogApi, ['mongodb']],
    ['orders-api', env.ordersApi, ['postgres', 'kafka', 'catalogApi']],
    ['jobs', env.jobsHealth, ['kafka', 'postgres', 'mongodb']],
  ])('%s is healthy and reports its dependencies', async (service, base, deps) => {
    const res = await get(`${base}/health`);
    const body = expectResponse(res, 200, Health);
    expect(body.service).toBe(service);
    for (const d of deps) expect(body.checks[d], d).toBe('up');
  });

  it('jobs worker exposes processing counters', async () => {
    const res = await get(`${env.jobsHealth}/health`);
    expect(Object.keys(res.body.stats)).toEqual(expect.arrayContaining(['processed', 'failed', 'deadLettered']));
  });

  it.each([env.usersApi, env.catalogApi, env.ordersApi])('%s returns a JSON 404 for unknown routes', async (base) => {
    const res = await get(`${base}/definitely-not-a-route`);
    expect(res.status).toBe(404);
    expect(res.body.error.code).toBe('NOT_FOUND');
  });

  it.each([env.usersApi, env.catalogApi, env.ordersApi])('%s echoes X-Request-Id', async (base) => {
    const res = await get(`${base}/health`, { headers: { 'X-Request-Id': 'api-test-trace-1' } });
    expect(res.headers.get('x-request-id')).toBe('api-test-trace-1');
  });
});
