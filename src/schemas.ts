/** Response contracts the suite checks every response against (mirrors each service's openapi.yaml). */
import { z } from 'zod';

const isoDate = z.string().refine((s) => !Number.isNaN(Date.parse(s)), 'not an ISO date');

export const ErrorBody = z.object({
  error: z.object({ code: z.string().min(1), message: z.string().min(1), details: z.unknown().optional() }),
});

export const Health = z.object({
  status: z.enum(['ok', 'error']),
  service: z.string(),
  checks: z.record(z.enum(['up', 'down'])),
});

export const User = z
  .object({
    id: z.string().uuid(),
    email: z.string().email(),
    name: z.string(),
    role: z.enum(['customer', 'admin']),
    createdAt: isoDate,
  })
  .strict();

export const LoginResponse = z.object({ token: z.string(), tokenType: z.literal('Bearer'), expiresIn: z.string(), user: User }).strict();

export const Product = z
  .object({
    id: z.string().regex(/^[0-9a-f]{24}$/),
    sku: z.string(),
    name: z.string(),
    description: z.string(),
    category: z.string(),
    priceCents: z.number().int().positive(),
    stock: z.number().int().min(0),
    createdAt: isoDate,
    updatedAt: isoDate,
  })
  .strict();

export const Stock = z.object({ productId: z.string(), sku: z.string(), stock: z.number().int().min(0), inStock: z.boolean() }).strict();

export const OrderStatus = z.enum(['PENDING', 'PROCESSED', 'FAILED', 'CANCELLED']);

export const Order = z
  .object({
    id: z.string().uuid(),
    userId: z.string().uuid(),
    status: OrderStatus,
    totalCents: z.number().int().min(0),
    currency: z.literal('USD'),
    failureReason: z.string().nullable(),
    items: z
      .array(
        z
          .object({
            productId: z.string(),
            sku: z.string(),
            name: z.string(),
            unitPriceCents: z.number().int().positive(),
            quantity: z.number().int().positive(),
            lineTotalCents: z.number().int().positive(),
          })
          .strict(),
      )
      .min(1),
    createdAt: isoDate,
    updatedAt: isoDate,
  })
  .strict();

export const Activity = z.object({
  id: z.string(),
  orderId: z.string(),
  userId: z.string(),
  type: z.string(),
  message: z.string(),
  data: z.record(z.unknown()),
  createdAt: isoDate,
});

export const DailySummary = z.object({
  date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  ordersByStatus: z.record(z.number().int()),
  orderCount: z.number().int().min(0),
  revenueCents: z.number().int().min(0),
  generatedAt: isoDate,
});

export const pageOf = <T extends z.ZodTypeAny>(item: T) =>
  z.object({ items: z.array(item), total: z.number().int().min(0), page: z.number().int().min(1), limit: z.number().int().min(1) }).strict();
