import express from 'express';
import cors from 'cors';
import helmet from 'helmet';
import { env } from './config/env';
import { requestId } from './middleware/requestId';
import { errorHandler, notFoundHandler } from './middleware/errorHandler';
import apiRouter from './routes';

export function createApp() {
  const app = express();

  app.set('trust proxy', 1);

  // Middleware order (PLAN §2.3): requestId → security → cors → json → routes → 404 → errorHandler
  app.use(requestId);
  app.use(helmet());
  app.use(
    cors({
      origin: (origin, cb) => {
        // allow non-browser tools (curl) with no origin, and whitelisted origins
        if (!origin || env.CORS_ORIGINS.includes(origin)) return cb(null, true);
        return cb(null, false);
      },
      credentials: true,
    }),
  );
  app.use(express.json({ limit: '1mb' }));

  app.use('/api/v1', apiRouter);

  app.use(notFoundHandler);
  app.use(errorHandler);

  return app;

  // second committ
}
