import { randomBytes, randomUUID, createHash, scrypt, timingSafeEqual } from 'node:crypto';
import { promisify } from 'node:util';
import worker from '../dist/server/index.js';

const scryptAsync = promisify(scrypt);
const hash = value => createHash('sha256').update(value).digest('hex');
const safeEqual = (a, b) => typeof a === 'string' && typeof b === 'string' && a.length === b.length && timingSafeEqual(Buffer.from(a), Buffer.from(b));
const reply = (body, status = 200, headers = {}) => new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store', ...headers } });
const migrations = [
  `CREATE TABLE IF NOT EXISTS lumen_saves (owner text PRIMARY KEY NOT NULL, payload text NOT NULL, revision integer NOT NULL DEFAULT 0, updated_at bigint NOT NULL)`,
  `CREATE TABLE IF NOT EXISTS lumen_rooms (code text PRIMARY KEY NOT NULL, host text NOT NULL, guest text, created_at bigint NOT NULL)`,
  `CREATE INDEX IF NOT EXISTS lumen_rooms_host_created ON lumen_rooms (host, created_at)`,
  `CREATE INDEX IF NOT EXISTS lumen_rooms_guest_created ON lumen_rooms (guest, created_at)`,
  `CREATE TABLE IF NOT EXISTS local_users (id text PRIMARY KEY, username text UNIQUE NOT NULL, salt text NOT NULL, password_hash text NOT NULL, recovery_hash text NOT NULL, created_at bigint NOT NULL)`,
  `CREATE TABLE IF NOT EXISTS local_sessions (token_hash text PRIMARY KEY, user_id text NOT NULL REFERENCES local_users(id) ON DELETE CASCADE, expires bigint NOT NULL)`,
  `CREATE INDEX IF NOT EXISTS local_sessions_user ON local_sessions (user_id)`,
  `CREATE TABLE IF NOT EXISTS local_auth_limits (key text PRIMARY KEY, attempts integer NOT NULL, resets bigint NOT NULL)`,
];

function postgresSQL(source) {
  let index = 0;
  let text = source.trim().replace(/^INSERT\s+OR\s+IGNORE\s+INTO\s+/i, 'INSERT INTO ')
    .replace(/\?/g, () => `$${++index}`);
  if (/^INSERT\s+INTO\s+/i.test(text) && !/\bON\s+CONFLICT\b/i.test(text)) text += ' ON CONFLICT DO NOTHING';
  if (/^(?:INSERT|UPDATE)\s+/i.test(text) && !/\bRETURNING\b/i.test(text)) text += ' RETURNING 1 AS __changed';
  return text;
}

export function createD1Adapter(sql) {
  return {
    prepare(source) {
      let values = [];
      return {
        bind(...args) { values = args; return this; },
        async first() { const rows = await sql.query(postgresSQL(source), values); return rows[0] ?? null; },
        async run() { const rows = await sql.query(postgresSQL(source), values); return { meta: { changes: rows.length } }; },
      };
    },
  };
}

async function initialize(sql) {
  for (const statement of migrations) await sql.query(statement);
}

function makeCookie(token, clear = false) {
  return `lumen_session=${token}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${clear ? 0 : 60 * 60 * 24 * 30}; Secure`;
}

function cookieToken(request) {
  const value = request.headers.get('cookie')?.split(';').map(part => part.trim()).find(part => part.startsWith('lumen_session='))?.slice('lumen_session='.length);
  return value && /^[a-f0-9]{64}$/.test(value) ? value : null;
}

async function session(sql, request) {
  const token = cookieToken(request);
  if (!token) return null;
  const rows = await sql.query('SELECT user_id, token_hash FROM local_sessions WHERE token_hash=$1 AND expires>$2 LIMIT 1', [hash(token), Date.now()]);
  return rows[0] ?? null;
}

async function limited(sql, ip) {
  const now = Date.now();
  const key = hash(ip || 'unknown');
  const rows = await sql.query(`INSERT INTO local_auth_limits(key,attempts,resets) VALUES ($1,1,$2)
    ON CONFLICT(key) DO UPDATE SET
      attempts=CASE WHEN local_auth_limits.resets<$3 THEN 1 ELSE local_auth_limits.attempts+1 END,
      resets=CASE WHEN local_auth_limits.resets<$4 THEN EXCLUDED.resets ELSE local_auth_limits.resets END
    RETURNING attempts`, [key, now + 60000, now, now]);
  return Number(rows[0]?.attempts || 0) > 15;
}

async function accountRequest(request, sql, ip) {
  const url = new URL(request.url);
  if (request.method !== 'POST') return reply({ error: '허용되지 않은 요청이에요.' }, 405);
  if (request.headers.get('origin') !== url.origin) return reply({ error: '페이지를 새로 열어 다시 시도해 주세요.' }, 403);
  if (!request.headers.get('content-type')?.startsWith('application/json')) return reply({ error: '지원하지 않는 요청이에요.' }, 415);
  if (await limited(sql, ip)) return reply({ error: '시도가 많아요. 1분 뒤 다시 시도해 주세요.' }, 429);
  let body;
  try { const raw = await request.text(); if (raw.length > 4096) throw Error(); body = JSON.parse(raw); }
  catch { return reply({ error: '입력 내용을 확인해 주세요.' }, 400); }

  const operation = url.pathname.split('/').pop();
  const current = await session(sql, request);
  if (operation === 'logout') {
    if (current) await sql.query('DELETE FROM local_sessions WHERE token_hash=$1', [current.token_hash]);
    return reply({ ok: true }, 200, { 'Set-Cookie': makeCookie('', true) });
  }

  const username = String(body.username || '').trim().toLowerCase();
  const password = String(body.password || '');
  if (!/^[a-z0-9_]{3,24}$/.test(username) || password.length < 10 || password.length > 128) {
    return reply({ error: '아이디는 영문·숫자·밑줄 3–24자, 비밀번호는 10–128자로 입력해 주세요.' }, 400);
  }
  const users = await sql.query('SELECT id, salt, password_hash, recovery_hash FROM local_users WHERE username=$1 LIMIT 1', [username]);
  const user = users[0];

  if (operation === 'register') {
    if (user) return reply({ error: '이미 사용 중인 아이디예요.' }, 409);
    const salt = randomBytes(16).toString('hex');
    const passwordHash = (await scryptAsync(password, salt, 64)).toString('hex');
    const recovery = randomBytes(24).toString('hex');
    const id = 'local:' + randomUUID();
    try {
      await sql.query('INSERT INTO local_users(id,username,salt,password_hash,recovery_hash,created_at) VALUES ($1,$2,$3,$4,$5,$6)', [id, username, salt, passwordHash, hash(recovery), Date.now()]);
    } catch (error) {
      if (error.code === '23505') return reply({ error: '이미 사용 중인 아이디예요.' }, 409);
      throw error;
    }
    const cookie = await createSession(sql, id);
    return reply({ ok: true, recoveryCode: recovery }, 200, { 'Set-Cookie': cookie });
  }

  if (operation === 'login') {
    const derived = (await scryptAsync(password, user?.salt || '00000000000000000000000000000000', 64)).toString('hex');
    if (!user || !safeEqual(derived, user.password_hash)) return reply({ error: '아이디 또는 비밀번호가 맞지 않아요.' }, 401);
    return reply({ ok: true }, 200, { 'Set-Cookie': await createSession(sql, user.id) });
  }

  if (operation === 'recover') {
    if (!user || !safeEqual(hash(String(body.recoveryCode || '').trim()), user.recovery_hash)) return reply({ error: '아이디 또는 복구 코드가 맞지 않아요.' }, 401);
    const salt = randomBytes(16).toString('hex');
    const passwordHash = (await scryptAsync(password, salt, 64)).toString('hex');
    const recovery = randomBytes(24).toString('hex');
    const updated = await sql.query(`UPDATE local_users SET salt=$1,password_hash=$2,recovery_hash=$3
      WHERE id=$4 AND recovery_hash=$5 RETURNING id`, [salt, passwordHash, hash(recovery), user.id, user.recovery_hash]);
    if (!updated.length) return reply({ error: '이미 사용된 복구 코드예요.' }, 409);
    await sql.query('DELETE FROM local_sessions WHERE user_id=$1', [user.id]);
    return reply({ ok: true, recoveryCode: recovery }, 200, { 'Set-Cookie': await createSession(sql, user.id) });
  }

  return reply({ error: '없는 계정 작업이에요.' }, 404);
}

async function createSession(sql, userId) {
  const token = randomBytes(32).toString('hex');
  await sql.query('INSERT INTO local_sessions(token_hash,user_id,expires) VALUES ($1,$2,$3)', [hash(token), userId, Date.now() + 30 * 86400000]);
  return makeCookie(token);
}

export function createVercelHandler({ sql, gameWorker = worker, ipForRequest = request => request.headers.get('x-forwarded-for')?.split(',')[0]?.trim() || 'unknown' }) {
  let ready;
  const db = createD1Adapter(sql);
  return async function handle(request) {
    try {
      if (!ready) ready = initialize(sql).catch(error => { ready = null; throw error; });
      await ready;
      const url = new URL(request.url);
      if (url.pathname.startsWith('/api/account/')) return await accountRequest(request, sql, ipForRequest(request));
      const headers = new Headers(request.headers);
      for (const key of [...headers.keys()]) if (key.startsWith('oai-')) headers.delete(key);
      const current = await session(sql, request);
      if (current) headers.set('oai-authenticated-user-id', current.user_id);
      return await gameWorker.fetch(new Request(request, { headers }), { DB: db, AUTH_MODE: 'local' });
    } catch (error) {
      console.error('lumen-vercel-api', error?.message || error);
      return reply({ error: '저장에 실패했어요. 연결을 확인한 뒤 다시 시도해 주세요.' }, 503);
    }
  };
}

export { postgresSQL, migrations };
