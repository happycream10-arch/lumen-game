import assert from 'node:assert/strict';
import { createD1Adapter, createVercelHandler, postgresSQL } from '../src/vercel-runtime.mjs';

assert.equal(postgresSQL('INSERT OR IGNORE INTO lumen_rooms (code,host,created_at) VALUES (?,?,?)'), 'INSERT INTO lumen_rooms (code,host,created_at) VALUES ($1,$2,$3) ON CONFLICT DO NOTHING RETURNING 1 AS __changed');
assert.equal(postgresSQL('UPDATE lumen_saves SET payload=?,revision=revision+1 WHERE owner=? AND revision=?'), 'UPDATE lumen_saves SET payload=$1,revision=revision+1 WHERE owner=$2 AND revision=$3 RETURNING 1 AS __changed');

const adapterCalls = [];
const adapter = createD1Adapter({ async query(text, values) { adapterCalls.push({ text, values }); return [{ __changed: 1 }]; } });
const inserted = await adapter.prepare('INSERT OR IGNORE INTO lumen_rooms (code,host,created_at) VALUES (?,?,?)').bind('ABC234', 'user', 123).run();
assert.equal(inserted.meta.changes, 1);
assert.deepEqual(adapterCalls[0].values, ['ABC234', 'user', 123]);

const users = new Map();
const sessions = new Map();
const authLimits = new Map();
const migrations = [];
const sql = { async query(text, values = []) {
  if (/^CREATE TABLE|^CREATE INDEX/.test(text)) { migrations.push(text); return []; }
  if (text.startsWith('INSERT INTO local_auth_limits')) {
    const [key, expiry, now] = values;
    const record = authLimits.get(key);
    const attempts = record && record.resets >= now ? record.attempts + 1 : 1;
    authLimits.set(key, { attempts, resets: record && record.resets >= now ? record.resets : expiry });
    return [{ attempts }];
  }
  if (text.startsWith('SELECT id, salt, password_hash, recovery_hash FROM local_users')) {
    const user = [...users.values()].find(value => value.username === values[0]);
    return user ? [{ id: user.id, salt: user.salt, password_hash: user.password_hash, recovery_hash: user.recovery_hash }] : [];
  }
  if (text.startsWith('INSERT INTO local_users')) {
    const [id, username, salt, password_hash, recovery_hash] = values;
    if ([...users.values()].some(value => value.username === username)) { const error = new Error('duplicate'); error.code = '23505'; throw error; }
    users.set(id, { id, username, salt, password_hash, recovery_hash }); return [];
  }
  if (text.startsWith('INSERT INTO local_sessions')) { const [token_hash, user_id, expires] = values; sessions.set(token_hash, { token_hash, user_id, expires }); return []; }
  if (text.startsWith('SELECT user_id, token_hash FROM local_sessions')) {
    const record = sessions.get(values[0]); return record && record.expires > values[1] ? [{ user_id: record.user_id, token_hash: record.token_hash }] : [];
  }
  if (text.startsWith('DELETE FROM local_sessions WHERE token_hash')) { sessions.delete(values[0]); return []; }
  if (text.startsWith('DELETE FROM local_sessions WHERE user_id')) { for (const [key, row] of sessions) if (row.user_id === values[0]) sessions.delete(key); return []; }
  if (text.startsWith('UPDATE local_users SET salt=')) {
    const [salt, password_hash, recovery_hash, id, oldHash] = values;
    const user = users.get(id); if (!user || user.recovery_hash !== oldHash) return [];
    Object.assign(user, { salt, password_hash, recovery_hash }); return [{ id }];
  }
  throw new Error(`Unhandled test SQL: ${text}`);
} };

let seenOwner = null;
const worker = { async fetch(request) {
  seenOwner = request.headers.get('oai-authenticated-user-id');
  return Response.json({ authMode: 'local', owner: seenOwner, path: new URL(request.url).pathname });
} };
const handle = createVercelHandler({ sql, gameWorker: worker, ipForRequest: () => 'test-ip' });
const origin = 'https://lumen.test';
const post = (path, body, headers = {}) => new Request(origin + path, { method: 'POST', headers: { origin, 'content-type': 'application/json', ...headers }, body: JSON.stringify(body) });

const registered = await handle(post('/api/account/register', { username: 'tester', password: 'correct horse battery staple' }));
assert.equal(registered.status, 200);
const credentials = await registered.json();
assert.match(credentials.recoveryCode, /^[a-f0-9]{48}$/);
const registerCookie = registered.headers.get('set-cookie');
assert.match(registerCookie, /HttpOnly/);
assert.match(registerCookie, /SameSite=Lax/);
assert.match(registerCookie, /Secure/);

const badOrigin = await handle(new Request(origin + '/api/account/login', { method: 'POST', headers: { origin: 'https://attacker.test', 'content-type': 'application/json' }, body: '{}' }));
assert.equal(badOrigin.status, 403);

const login = await handle(post('/api/account/login', { username: 'tester', password: 'correct horse battery staple' }));
assert.equal(login.status, 200);
const loginCookie = login.headers.get('set-cookie').split(';')[0];
const state = await handle(new Request(origin + '/api/state', { headers: { cookie: loginCookie, 'oai-authenticated-user-id': 'forged-by-client' } }));
assert.equal(state.status, 200);
assert.ok(seenOwner?.startsWith('local:'));
assert.notEqual(seenOwner, 'forged-by-client');
assert.equal((await state.json()).owner, seenOwner);
assert.equal(migrations.length, 9);

const recovered = await handle(post('/api/account/recover', { username: 'tester', password: 'a new long password', recoveryCode: credentials.recoveryCode }));
assert.equal(recovered.status, 200);
const oldLogin = await handle(post('/api/account/login', { username: 'tester', password: 'correct horse battery staple' }));
assert.equal(oldLogin.status, 401);
const newLogin = await handle(post('/api/account/login', { username: 'tester', password: 'a new long password' }));
assert.equal(newLogin.status, 200);

console.log('Vercel/Neon runtime: SQL translation, registration, login, origin guard, identity isolation, and recovery passed');
