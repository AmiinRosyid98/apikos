import { Request, Response } from 'express';
import { ok } from '../../utils/response';
import * as svc from './public.service';
import type { PublicBookingInput } from './public.validators';

/**
 * PUBLIC controllers (PRD §6.2, §6.13). UNAUTHENTICATED — no req.auth, no tenant context. The slug
 * param is validated by the route's param schema; the body by the booking schema.
 */

export async function getProperty(req: Request, res: Response) {
  const data = await svc.getPublicProperty(req.params.slug);
  return ok(res, data);
}

export async function createBooking(req: Request, res: Response) {
  const body = req.body as PublicBookingInput;

  // HONEYPOT: a filled `_hp` is a bot. Silently return a fake success (HTTP 200, plausible shape)
  // WITHOUT creating anything — never tell the bot it was detected.
  if (body._hp) {
    return ok(
      res,
      {
        reference: 'PENDING',
        status: 'pending',
        message: 'Permintaan booking Anda telah diterima. Pengelola akan segera menghubungi Anda.',
      },
      201,
    );
  }

  const data = await svc.createPublicBooking(req.params.slug, body);
  return ok(res, data, 201);
}
