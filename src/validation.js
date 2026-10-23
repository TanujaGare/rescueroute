import { z } from 'zod';
import { CATEGORIES } from './domain/planning.js';

// Strips control characters (except newline/tab) from free text.
const cleanText = (min, max) =>
  // eslint-disable-next-line no-control-regex -- matching control characters is the purpose of this sanitiser
  z.string().transform((s) => s.replace(/[\u0000-\u0008\u000B-\u001F\u007F]/g, '').trim()).pipe(z.string().min(min).max(max));

const id = z.string().regex(/^[a-z0-9_]{1,64}$/);

export const loginSchema = z.object({
  email: z.string().trim().toLowerCase().max(254).pipe(z.email()),
  password: z.string().min(1).max(200),
}).strict();

export const donationSchema = z.object({
  donor_id: id,
  category: z.enum(CATEGORIES),
  description: cleanText(3, 200),
  quantity_kg: z.number().positive().max(1000),
  needs_cold: z.boolean(),
  ready_at: z.iso.datetime({ offset: true }),
  expires_at: z.iso.datetime({ offset: true }),
  notes: cleanText(0, 300).optional(),
}).strict().refine((d) => Date.parse(d.expires_at) > Date.parse(d.ready_at), {
  message: 'expires_at must be after ready_at',
  path: ['expires_at'],
});

export const runSchema = z.object({
  objective: cleanText(5, 500),
}).strict();

export const decisionSchema = z.object({
  decision: z.enum(['approve', 'reject']),
}).strict();

export const idParam = id;
export const runIdParam = z.string().regex(/^run_[0-9a-f-]{36}$/);

/** Express helper: validates req.body and responds 400 with field issues on failure. */
export function parseBody(schema, req, res) {
  const result = schema.safeParse(req.body ?? {});
  if (!result.success) {
    res.status(400).json({
      error: {
        code: 'VALIDATION_FAILED',
        message: 'Request body is invalid',
        issues: result.error.issues.slice(0, 10).map((i) => ({ path: i.path.join('.'), message: i.message })),
      },
    });
    return null;
  }
  return result.data;
}
