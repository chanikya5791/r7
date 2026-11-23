import { env } from './config';

/** Fails fast with a clear message if the stack is not running. */
export default async function setup() {
  const targets = {
    'users-api': `${env.usersApi}/health`,
    'catalog-api': `${env.catalogApi}/health`,
    'orders-api': `${env.ordersApi}/health`,
    jobs: `${env.jobsHealth}/health`,
  };
  const down: string[] = [];
  for (const [name, url] of Object.entries(targets)) {
    try {
      const res = await fetch(url, { signal: AbortSignal.timeout(5000) });
      if (!res.ok) down.push(`${name} (${url} -> ${res.status})`);
    } catch (err) {
      down.push(`${name} (${url}: ${String(err)})`);
    }
  }
  if (down.length) {
    throw new Error(`ShopLite services are not healthy: ${down.join(', ')}.\nStart the stack first (in the infra repo: make up).`);
  }
}
