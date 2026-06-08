import { Request, Response } from 'express';
import { ok } from '../../utils/response';
import * as authService from './auth.service';
import { writeAudit } from '../../services/audit.service';

export async function register(req: Request, res: Response) {
  const result = await authService.register(req.body);
  return ok(res, result, 201);
}

export async function login(req: Request, res: Response) {
  const result = await authService.login(req.body);
  return ok(res, result);
}

export async function refresh(req: Request, res: Response) {
  const result = await authService.refresh(req.body.refreshToken);
  return ok(res, result);
}

export async function logout(req: Request, res: Response) {
  const result = await authService.logout(req.body.refreshToken);
  return ok(res, result);
}

export async function forgotPassword(req: Request, res: Response) {
  const result = await authService.forgotPassword(req.body.email);
  return ok(res, result);
}

export async function resetPassword(req: Request, res: Response) {
  const result = await authService.resetPassword(req.body.token, req.body.newPassword);
  return ok(res, result);
}

export async function me(req: Request, res: Response) {
  const result = await authService.getMe(req.auth!.userId);
  return ok(res, result);
}

// Re-export so other modules can attach audit on auth-adjacent flows if needed.
export { writeAudit };
