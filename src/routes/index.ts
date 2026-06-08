import { Router } from 'express';
import { authGuard } from '../middleware/authGuard';
import { tenantContext } from '../middleware/tenantContext';

import healthRoutes from '../modules/health/health.routes';
import authRoutes from '../modules/auth/auth.routes';
import usersRoutes from '../modules/users/users.routes';
import propertiesRoutes from '../modules/properties/properties.routes';
import { roomsRouter, propertyRoomsRouter } from '../modules/rooms/rooms.routes';
import residentsRoutes from '../modules/residents/residents.routes';
import invoicesRoutes from '../modules/invoices/invoices.routes';
import filesRoutes from '../modules/files/files.routes';
import subscriptionRoutes from '../modules/subscription/subscription.routes';
import dashboardRoutes from '../modules/dashboard/dashboard.routes';
import auditRoutes from '../modules/audit/audit.routes';

const api = Router();

// Public / self-guarded.
api.use('/health', healthRoutes);
api.use('/auth', authRoutes); // each route declares its own guards
api.use('/users', usersRoutes); // accept-invite is public; rest guarded inside

// Protected: authGuard → tenantContext applied here for the resource modules.
const protectedApi = Router();
protectedApi.use(authGuard, tenantContext);

// Nested rooms under a property MUST be registered before the bare properties router so the
// /:id/rooms path resolves to the rooms sub-router.
protectedApi.use('/properties/:id/rooms', propertyRoomsRouter);
protectedApi.use('/properties', propertiesRoutes);
protectedApi.use('/rooms', roomsRouter);
protectedApi.use('/residents', residentsRoutes);
protectedApi.use('/invoices', invoicesRoutes);
protectedApi.use('/files', filesRoutes);
protectedApi.use('/subscription', subscriptionRoutes);
protectedApi.use('/dashboard', dashboardRoutes);
protectedApi.use('/audit-logs', auditRoutes);

api.use(protectedApi);

export default api;
