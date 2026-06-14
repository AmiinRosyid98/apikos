import { Router } from 'express';
import { authGuard } from '../middleware/authGuard';
import { tenantContext } from '../middleware/tenantContext';
import { registerUuidParams } from '../middleware/validate';

import healthRoutes from '../modules/health/health.routes';
import authRoutes from '../modules/auth/auth.routes';
import usersRoutes from '../modules/users/users.routes';
import propertiesRoutes from '../modules/properties/properties.routes';
import { roomsRouter, propertyRoomsRouter } from '../modules/rooms/rooms.routes';
import { roomMetersRouter, metersRouter } from '../modules/meters/meters.routes';
import { residentDepositsRouter, depositsRouter } from '../modules/deposits/deposits.routes';
import { residentHandoversRouter, handoversRouter } from '../modules/handovers/handovers.routes';
import residentsRoutes from '../modules/residents/residents.routes';
import invoicesRoutes from '../modules/invoices/invoices.routes';
import filesRoutes from '../modules/files/files.routes';
import subscriptionRoutes from '../modules/subscription/subscription.routes';
import dashboardRoutes from '../modules/dashboard/dashboard.routes';
import auditRoutes from '../modules/audit/audit.routes';
import financeRoutes from '../modules/finance/finance.routes';
import bookingsRoutes from '../modules/bookings/bookings.routes';
import reportsRoutes from '../modules/reports/reports.routes';
import {
  maintenanceRouter,
  vendorsRouter,
  roomMaintenanceRouter,
} from '../modules/maintenance/maintenance.routes';
import {
  waRouter,
  propertyReminderRouter,
} from '../modules/whatsapp/whatsapp.routes';
import {
  paymentsRouter,
  txnsRouter,
  webhookRouter,
} from '../modules/payments/payments.routes';
import {
  contractTemplatesRouter,
  contractsRouter,
  documentsRouter,
  residentContractRouter,
  residentDocumentsRouter,
} from '../modules/contracts/contracts.routes';
import {
  notificationsRouter,
  notificationPreferencesRouter,
} from '../modules/notifications/notifications.routes';
import { pushRouter } from '../modules/push/push.routes';
import { publicRouter } from '../modules/public/public.routes';
import { apiKeysRouter } from '../modules/apikeys/apikeys.routes';
import { brandingRouter } from '../modules/branding/branding.routes';
import { accountingRouter } from '../modules/accounting/accounting.routes';

const api = Router();

// Public / self-guarded.
api.use('/health', healthRoutes);
api.use('/auth', authRoutes); // each route declares its own guards
api.use('/users', usersRoutes); // accept-invite is public; rest guarded inside
// Payment gateway webhook (PRD §6.8) — PUBLIC, no auth. Mounted OUTSIDE the protected router; the
// payload is verified via provider.verifyWebhook, and the txn's own tenant scopes the rest.
api.use('/webhooks', webhookRouter);
// Public Landing Page + Public Booking Link (PRD §6.2, §6.13) — PUBLIC, no auth, no tenant-guard JWT.
// Mounted OUTSIDE the protected router (like the webhook). Tenant + property are resolved STRICTLY
// from the URL slug inside the service (runWithTenant), and the router applies permissive CORS +
// per-IP anti-spam rate limits + a honeypot. Returns only marketing-safe data.
api.use('/public', publicRouter);

// Protected: authGuard → tenantContext applied here for the resource modules.
const protectedApi = Router();
protectedApi.use(authGuard, tenantContext);

// BUG-004: malformed UUID path params → 422 VALIDATION_ERROR (never 500/leak).
// Register UUID param validation on the top-level protected router (handles
// mount-path params like /properties/:id/rooms) AND on every sub-router below
// (handles params captured by the router that owns the route). Express fires a
// `router.param()` callback for the router that captured the param, so we need
// it in both places. A well-formed-but-missing UUID still falls through to 404.
registerUuidParams(protectedApi);
[
  usersRoutes,
  propertyRoomsRouter,
  propertiesRoutes,
  roomMetersRouter,
  roomsRouter,
  metersRouter,
  residentDepositsRouter,
  residentHandoversRouter,
  residentsRoutes,
  depositsRouter,
  handoversRouter,
  invoicesRoutes,
  filesRoutes,
  subscriptionRoutes,
  dashboardRoutes,
  auditRoutes,
  financeRoutes,
  bookingsRoutes,
  reportsRoutes,
  maintenanceRouter,
  vendorsRouter,
  roomMaintenanceRouter,
  waRouter,
  propertyReminderRouter,
  paymentsRouter,
  txnsRouter,
  contractTemplatesRouter,
  contractsRouter,
  documentsRouter,
  residentContractRouter,
  residentDocumentsRouter,
  notificationsRouter,
  notificationPreferencesRouter,
  pushRouter,
  apiKeysRouter,
  brandingRouter,
  accountingRouter,
].forEach(registerUuidParams);

// Nested rooms under a property MUST be registered before the bare properties router so the
// /:id/rooms path resolves to the rooms sub-router.
protectedApi.use('/properties/:id/rooms', propertyRoomsRouter);
// Reminder-config nested under a property (PRD §6.10) — before the bare /properties router.
protectedApi.use('/properties/:id/reminder-config', propertyReminderRouter);
protectedApi.use('/properties', propertiesRoutes);
// Nested meter-readings under a room MUST precede the bare /rooms router so /:id/meter-readings resolves.
protectedApi.use('/rooms/:id/meter-readings', roomMetersRouter);
// Per-room maintenance history (PRD §6.14) — nested under a room, before the bare /rooms router.
protectedApi.use('/rooms/:id/maintenance', roomMaintenanceRouter);
protectedApi.use('/rooms', roomsRouter);
protectedApi.use('/meter-readings', metersRouter);
// Nested deposit/handover routers under a resident MUST precede the bare /residents router so
// /:id/deposits and /:id/handovers resolve to the sub-routers.
protectedApi.use('/residents/:id/deposits', residentDepositsRouter);
protectedApi.use('/residents/:id/handovers', residentHandoversRouter);
// Dokumen & Kontrak (PRD §6.15): convenience contract generate + document registry, nested under a
// resident — registered before the bare /residents router so /:id/contract and /:id/documents resolve.
protectedApi.use('/residents/:id/contract', residentContractRouter);
protectedApi.use('/residents/:id/documents', residentDocumentsRouter);
protectedApi.use('/residents', residentsRoutes);
protectedApi.use('/deposits', depositsRouter);
protectedApi.use('/handovers', handoversRouter);
// The invoice WA send route (POST /invoices/:id/send-wa, PRD §6.9) lives ON the invoices router
// (registered there) rather than as a separate /invoices/:id mount — a separate mount would
// shadow /invoices/generate (matching :id="generate"). See invoices.routes.ts.
protectedApi.use('/invoices', invoicesRoutes);
protectedApi.use('/files', filesRoutes);
protectedApi.use('/subscription', subscriptionRoutes);
protectedApi.use('/dashboard', dashboardRoutes);
protectedApi.use('/audit-logs', auditRoutes);
protectedApi.use('/finance', financeRoutes);
protectedApi.use('/bookings', bookingsRoutes);
protectedApi.use('/reports', reportsRoutes);
// Maintenance Module (PRD §6.14): tickets + vendor DB. Per-room history is the nested
// /rooms/:id/maintenance router mounted above (alongside meter-readings).
protectedApi.use('/maintenance', maintenanceRouter);
protectedApi.use('/vendors', vendorsRouter);
protectedApi.use('/wa', waRouter);
// Payment Gateway (PRD §6.8): /payments/* (methods, reconciliation) + /payment-txns (list, simulate).
// The invoice-scoped charge routes live on the invoices router (see invoices.routes.ts). The PUBLIC
// webhook is mounted above (api.use('/webhooks', ...)), OUTSIDE this protected router.
protectedApi.use('/payments', paymentsRouter);
protectedApi.use('/payment-txns', txnsRouter);
// Dokumen & Kontrak Module (PRD §6.15): contract templates, contracts (lifecycle + PDF), document
// registry (+ expiring). The resident-scoped convenience routes are nested under /residents above.
protectedApi.use('/contract-templates', contractTemplatesRouter);
protectedApi.use('/contracts', contractsRouter);
protectedApi.use('/documents', documentsRouter);
// In-App Notification Module (PRD §6.18): per-user notification center + unread badge + prefs.
protectedApi.use('/notifications', notificationsRouter);
protectedApi.use('/notification-preferences', notificationPreferencesRouter);
// Web Push (PRD §6.18 web-push seam): per-user browser subscriptions (subscribe / unsubscribe /
// public-key / test). The notify() seam fans out OS/browser pushes to these subscriptions.
protectedApi.use('/push', pushRouter);
// Public API key MANAGEMENT (PRD Modul 22) — dashboard, Owner-only, Premium-gated. The EXTERNAL
// API itself (/api/ext/v1, key-authed) is mounted OUTSIDE this protected router in app.ts.
protectedApi.use('/api-keys', apiKeysRouter);
// White-label Branding (PRD Modul 23): GET (All) serves brandName/brandColor/logoUrl for theming;
// PUT (Owner-only, Premium-gated) sets them. Custom domain DEFERRED.
protectedApi.use('/branding', brandingRouter);
// Integrasi Akuntansi (PRD Modul 21 — Premium-only, STUB MODE): config (Owner-only, Premium-gated),
// status, sync (maps payments→income + expenses→expense journals via the provider seam), entries log.
protectedApi.use('/accounting', accountingRouter);

api.use(protectedApi);

export default api;
