// The api service entry point.
import { createServer } from 'node:http';

import { createOidcClient } from '../auth/oidc.js';
import { loadConfig } from '../config.js';
import { createDb } from '../db.js';
import { createLogger, errorFields } from '../logger.js';
import { createApp } from './app.js';

const config = loadConfig();
const logger = createLogger({ level: config.logLevel, production: config.production, service: 'api' });
const db = createDb(config.databaseUrl);
const oidc = config.auth.enabled ? createOidcClient(config, logger) : null;

const server = createServer(createApp({ config, logger, db, oidc }));
server.listen(config.port, () => {
  logger.info('api listening', { port: config.port, signIn: config.auth.enabled ? 'enabled' : 'disabled' });
});

const shutdown = (signal: string) => {
  logger.info('api shutting down', { signal });
  server.close(() => {
    db.end().catch((err) => logger.error('db close failed', errorFields(err)));
  });
};
process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));
