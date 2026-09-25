import request from 'supertest';
import { describe, expect, it } from 'vitest';
import { app } from '../src/index.js';

describe('API', () => {
  it('reports service health', async () => {
    const response = await request(app).get('/api/health');

    expect(response.status).toBe(200);
    expect(response.body).toEqual({ status: 'ok', service: 'dmarcharbor-api' });
  });

  it('rejects invalid domain input', async () => {
    const response = await request(app).post('/api/scan').send({ domain: 'https://example.com/path' });

    expect(response.status).toBe(400);
    expect(response.body.error.message).toContain('domain');
  });
});
