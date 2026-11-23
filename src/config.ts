export const env = {
  usersApi: process.env.USERS_API_URL ?? 'http://localhost:3001',
  catalogApi: process.env.CATALOG_API_URL ?? 'http://localhost:3003',
  ordersApi: process.env.ORDERS_API_URL ?? 'http://localhost:3002',
  jobsHealth: process.env.JOBS_HEALTH_URL ?? 'http://localhost:3004',
  admin: {
    email: process.env.ADMIN_EMAIL ?? 'admin@shoplite.local',
    password: process.env.ADMIN_PASSWORD ?? 'Admin123!',
  },
  asyncTimeoutMs: Number(process.env.ASYNC_TIMEOUT_MS ?? 20_000),
};
