import { neon } from '@neondatabase/serverless';
import { createVercelHandler } from '../src/vercel-runtime.mjs';

const connectionString = process.env.STORAGE_URL;
const handler = connectionString ? createVercelHandler({ sql: neon(connectionString) }) : null;

async function readBody(req) {
  if (req.body !== undefined && req.body !== null) {
    if (Buffer.isBuffer(req.body)) return req.body;
    return Buffer.from(typeof req.body === 'string' ? req.body : JSON.stringify(req.body));
  }
  const chunks = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > 32768) throw new Error('Request body too large');
    chunks.push(chunk);
  }
  return Buffer.concat(chunks);
}

export default async function api(req, res) {
  if (!connectionString || !handler) {
    res.statusCode = 503;
    res.setHeader('content-type', 'application/json; charset=utf-8');
    res.end(JSON.stringify({ error: '저장소 설정(STORAGE_URL)을 확인해 주세요.' }));
    return;
  }
  try {
    const host = String(req.headers['x-forwarded-host'] || req.headers.host || '').split(',')[0].trim();
    const protocol = String(req.headers['x-forwarded-proto'] || 'https').split(',')[0].trim();
    const headers = new Headers();
    for (const [name, value] of Object.entries(req.headers)) {
      if (value !== undefined) headers.set(name, Array.isArray(value) ? value.join(',') : String(value));
    }
    const method = req.method || 'GET';
    const body = ['GET', 'HEAD'].includes(method) ? undefined : await readBody(req);
    const request = new Request(new URL(req.url || '/', `${protocol}://${host}`), { method, headers, body });
    const response = await handler(request);
    res.statusCode = response.status;
    for (const [name, value] of response.headers) res.setHeader(name, value);
    res.end(method === 'HEAD' ? undefined : Buffer.from(await response.arrayBuffer()));
  } catch (error) {
    const status = error.message === 'Request body too large' ? 413 : 500;
    res.statusCode = status;
    res.setHeader('content-type', 'application/json; charset=utf-8');
    res.setHeader('cache-control', 'no-store');
    res.end(JSON.stringify({ error: status === 413 ? '요청이 너무 커요.' : '일시적인 오류가 발생했어요. 다시 시도해 주세요.' }));
  }
}
