import { Router } from 'express';
import * as ctrl from './whatsapp.controller';
import { validate } from '../../middleware/validate';
import { asyncHandler } from '../../utils/asyncHandler';
import {
  rbacGuard,
  ALL,
  MANAGER_PLUS,
  loadPropertyScope,
} from '../../middleware/rbacGuard';
import {
  createTemplateSchema,
  updateTemplateSchema,
  listTemplateQuery,
  broadcastSchema,
  listLogsQuery,
  reminderConfigSchema,
} from './whatsapp.validators';

/**
 * WhatsApp + Reminder Otomatis routes (PRD §6.9, §6.10). RBAC (PRD §13):
 *   - Templates: view All, create/update/delete Manager+ (konfigurasi template owner/manager)
 *   - Send invoice WA: Admin+ (kirim reminder manual / send invoice)
 *   - Broadcast: Manager+
 *   - Logs / status: All (lihat log all roles)
 *   - Reminder config: view All, update Manager+
 *
 * STUB MODE: messages are recorded but not actually sent (provider seam — see providers/).
 */

// ── /wa/* (templates, broadcast, logs, status) ──
const waRouter = Router();
waRouter.use(loadPropertyScope);

waRouter.get(
  '/templates',
  rbacGuard(ALL),
  validate(listTemplateQuery, 'query'),
  asyncHandler(ctrl.listTemplates),
);
waRouter.post(
  '/templates',
  rbacGuard(MANAGER_PLUS),
  validate(createTemplateSchema),
  asyncHandler(ctrl.createTemplate),
);
waRouter.put(
  '/templates/:id',
  rbacGuard(MANAGER_PLUS),
  validate(updateTemplateSchema),
  asyncHandler(ctrl.updateTemplate),
);
waRouter.delete('/templates/:id', rbacGuard(MANAGER_PLUS), asyncHandler(ctrl.deleteTemplate));

waRouter.post(
  '/broadcast',
  rbacGuard(MANAGER_PLUS),
  validate(broadcastSchema),
  asyncHandler(ctrl.broadcast),
);

waRouter.get('/logs', rbacGuard(ALL), validate(listLogsQuery, 'query'), asyncHandler(ctrl.listLogs));
waRouter.get('/status', rbacGuard(ALL), asyncHandler(ctrl.status));

// ── /properties/:id/reminder-config (view All, update Manager+) — nested under /properties/:id ──
const propertyReminderRouter = Router({ mergeParams: true });
propertyReminderRouter.use(loadPropertyScope);
propertyReminderRouter.get(
  '/',
  rbacGuard(ALL),
  asyncHandler(ctrl.getReminderConfig),
);
propertyReminderRouter.put(
  '/',
  rbacGuard(MANAGER_PLUS),
  validate(reminderConfigSchema),
  asyncHandler(ctrl.updateReminderConfig),
);

export { waRouter, propertyReminderRouter };
