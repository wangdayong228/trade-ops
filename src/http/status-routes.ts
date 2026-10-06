import type { FastifyInstance } from 'fastify';
import type { RuntimeStatus } from '../operations/runtime-status.js';

export function registerStatusRoutes(app: FastifyInstance, status?: RuntimeStatus): void {
  app.get('/health/live', async () => ({ status: 'alive' }));
  app.get('/health/ready', async (_request, reply) => {
    if (status === undefined) {
      return reply.code(503).send({ status: 'not_ready', reason: 'runtime status provider is not configured' });
    }
    const health = status.health();
    return reply.code(health.status === 'ready' ? 200 : 503).send(health);
  });
  app.get('/api/status', async (_request, reply) => {
    if (status === undefined) {
      return reply.code(503).send({ status: 'unavailable', reason: 'runtime status provider is not configured' });
    }
    return status.snapshot();
  });
}
