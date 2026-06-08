import { createApp } from './app';
import { env } from './config/env';
import { prisma } from './config/database';

async function main() {
  const app = createApp();

  // Verify DB connectivity on boot (fail fast).
  try {
    await prisma.$queryRaw`SELECT 1`;
    // eslint-disable-next-line no-console
    console.log('✅ Database connection OK');
  } catch (e) {
    // eslint-disable-next-line no-console
    console.error('❌ Database connection failed:', (e as Error).message);
    process.exit(1);
  }

  const server = app.listen(env.PORT, () => {
    // eslint-disable-next-line no-console
    console.log(`🚀 KosManager API listening on http://localhost:${env.PORT} (${env.NODE_ENV})`);
    // eslint-disable-next-line no-console
    console.log(`   Health: http://localhost:${env.PORT}/api/v1/health`);
  });

  const shutdown = async (sig: string) => {
    // eslint-disable-next-line no-console
    console.log(`\n${sig} received — shutting down...`);
    server.close(async () => {
      await prisma.$disconnect();
      process.exit(0);
    });
  };
  process.on('SIGINT', () => shutdown('SIGINT'));
  process.on('SIGTERM', () => shutdown('SIGTERM'));
}

main().catch((e) => {
  // eslint-disable-next-line no-console
  console.error('Fatal boot error:', e);
  process.exit(1);
});
