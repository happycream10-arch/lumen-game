import http from 'node:http';
import {DatabaseSync} from 'node:sqlite';
import {randomBytes,randomUUID,createHash,scrypt,timingSafeEqual} from 'node:crypto';
import {promisify} from 'node:util';
import {fileURLToPath,pathToFileURL} from 'node:url';
import fs from 'node:fs';
import path from 'node:path';
import worker from '../dist/server/index.js';

const scryptAsync=promisify(scrypt), root=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..');
const hash=s=>createHash('sha256').update(s).digest('hex');
const safeEqual=(a,b)=>typeof a==='string'&&typeof b==='string'&&a.length===b.length&&timingSafeEqual(Buffer.from(a),Buffer.from(b));
const reply=(body,status=200,headers={})=>new Response(JSON.stringify(body),{status,headers:{'Content-Type':'application/json; charset=utf-8','Cache-Control':'no-store',...headers}});

export function createApp({database=process.env.DATABASE_PATH||path.join(root,'data','lumen.sqlite'),publicURL=process.env.PUBLIC_URL||'',production=process.env.NODE_ENV==='production'}={}) {
  const publicOrigin=publicURL?new URL(publicURL).origin:'';
  if(production&&(!publicOrigin||!publicOrigin.startsWith('https://')))throw Error('Production requires PUBLIC_URL=https://your-domain');
  if(database!==':memory:')fs.mkdirSync(path.dirname(path.resolve(database)),{recursive:true,mode:0o700});
  const db=new DatabaseSync(database);db.exec('PRAGMA journal_mode=WAL; PRAGMA foreign_keys=ON; PRAGMA busy_timeout=5000;');
  db.exec('CREATE TABLE IF NOT EXISTS _lumen_migrations (name TEXT PRIMARY KEY NOT NULL)');
  for(const name of fs.readdirSync(path.join(root,'drizzle')).filter(n=>n.endsWith('.sql')).sort()){
    if(db.prepare('SELECT name FROM _lumen_migrations WHERE name=?').get(name))continue;
    db.exec('BEGIN IMMEDIATE');try{db.exec(fs.readFileSync(path.join(root,'drizzle',name),'utf8'));db.prepare('INSERT INTO _lumen_migrations(name) VALUES (?)').run(name);db.exec('COMMIT');}catch(e){db.exec('ROLLBACK');throw e;}
  }
  db.exec(`CREATE TABLE IF NOT EXISTS local_users (id TEXT PRIMARY KEY, username TEXT UNIQUE NOT NULL, salt TEXT NOT NULL, password_hash TEXT NOT NULL, recovery_hash TEXT NOT NULL, created_at INTEGER NOT NULL);
  CREATE TABLE IF NOT EXISTS local_sessions (token_hash TEXT PRIMARY KEY,user_id TEXT NOT NULL REFERENCES local_users(id), expires INTEGER NOT NULL);
  CREATE INDEX IF NOT EXISTS local_sessions_user ON local_sessions(user_id);
  CREATE TABLE IF NOT EXISTS local_auth_limits (key TEXT PRIMARY KEY, attempts INTEGER NOT NULL, resets INTEGER NOT NULL);`);
  const DB={prepare(sql){let values=[];return {bind(...v){values=v;return this;},async first(){return db.prepare(sql).get(...values)||null;},async run(){return {meta:{changes:db.prepare(sql).run(...values).changes}};}}}};
  function session(req){const token=req.headers.get('cookie')?.split(';').map(x=>x.trim()).find(x=>x.startsWith('lumen_session='))?.slice(14);if(!token||!/^[a-f0-9]{64}$/.test(token))return null;return db.prepare('SELECT user_id,token_hash FROM local_sessions WHERE token_hash=? AND expires>?').get(hash(token),Date.now())||null;}
  function cookie(token,clear=false){return `lumen_session=${token}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${clear?0:60*60*24*30}${production||publicOrigin.startsWith('https://')?'; Secure':''}`;}
  function newSession(id){const token=randomBytes(32).toString('hex');db.prepare('INSERT INTO local_sessions(token_hash,user_id,expires) VALUES (?,?,?)').run(hash(token),id,Date.now()+30*86400000);return cookie(token);}
  function rateLimit(ip){const key=hash(ip),now=Date.now();db.prepare('INSERT INTO local_auth_limits(key,attempts,resets) VALUES (?,1,?) ON CONFLICT(key) DO UPDATE SET attempts=CASE WHEN resets<? THEN 1 ELSE attempts+1 END,resets=CASE WHEN resets<? THEN excluded.resets ELSE resets END').run(key,now+60000,now,now);return db.prepare('SELECT attempts FROM local_auth_limits WHERE key=?').get(key).attempts>15;}
  const cleanup=setInterval(()=>{const now=Date.now();db.prepare('DELETE FROM local_sessions WHERE expires<?').run(now);db.prepare('DELETE FROM local_auth_limits WHERE resets<?').run(now-60000);},60000);cleanup.unref();
  async function handle(req,{ip='local'}={}){
    const url=new URL(req.url);
    if(url.pathname==='/healthz')return reply({status:'ok'});
    if(req.method==='POST'){
      if(req.headers.get('origin')!==url.origin)return reply({error:'페이지를 새로 열어 다시 시도해 주세요.'},403);
      if(!req.headers.get('content-type')?.startsWith('application/json'))return reply({error:'지원하지 않는 요청이에요.'},415);
    }
    if(url.pathname.startsWith('/api/account/')){
      if(req.method!=='POST')return reply({error:'허용되지 않은 요청이에요.'},405);
      if(rateLimit(ip))return reply({error:'시도가 많아요. 1분 뒤 다시 시도해 주세요.'},429);
      let b;try{const raw=await req.text();if(raw.length>4096)throw Error();b=JSON.parse(raw);}catch{return reply({error:'입력 내용을 확인해 주세요.'},400);}
      const op=url.pathname.split('/').pop(),current=session(req);
      if(op==='logout'){if(current)db.prepare('DELETE FROM local_sessions WHERE token_hash=?').run(current.token_hash);return reply({ok:true},200,{'Set-Cookie':cookie('',true)});}
      const username=String(b.username||'').trim().toLowerCase(),password=String(b.password||'');
      if(!/^[a-z0-9_]{3,24}$/.test(username)||password.length<10||password.length>128)return reply({error:'아이디는 영문·숫자·밑줄 3–24자, 비밀번호는 10–128자로 입력해 주세요.'},400);
      const user=db.prepare('SELECT * FROM local_users WHERE username=?').get(username);
      if(op==='register'){
        if(user)return reply({error:'이미 사용 중인 아이디예요.'},409);
        const salt=randomBytes(16).toString('hex'),passwordHash=(await scryptAsync(password,salt,64)).toString('hex'),recovery=randomBytes(24).toString('hex'),id='local:'+randomUUID();
        try{db.prepare('INSERT INTO local_users(id,username,salt,password_hash,recovery_hash,created_at) VALUES (?,?,?,?,?,?)').run(id,username,salt,passwordHash,hash(recovery),Date.now());}catch(e){if(e.code?.includes('CONSTRAINT'))return reply({error:'이미 사용 중인 아이디예요.'},409);throw e;}
        return reply({ok:true,recoveryCode:recovery},200,{'Set-Cookie':newSession(id)});
      }
      if(op==='login'){
        const derived=(await scryptAsync(password,user?.salt||'00000000000000000000000000000000',64)).toString('hex');
        if(!user||!safeEqual(derived,user.password_hash))return reply({error:'아이디 또는 비밀번호가 맞지 않아요.'},401);
        return reply({ok:true},200,{'Set-Cookie':newSession(user.id)});
      }
      if(op==='recover'){
        if(!user||!safeEqual(hash(String(b.recoveryCode||'').trim()),user.recovery_hash))return reply({error:'아이디 또는 복구 코드가 맞지 않아요.'},401);
        const salt=randomBytes(16).toString('hex'),passwordHash=(await scryptAsync(password,salt,64)).toString('hex'),recovery=randomBytes(24).toString('hex');
        // Include the previous recovery hash to prevent two concurrent recoveries.
        db.exec('BEGIN IMMEDIATE');try{const updated=db.prepare('UPDATE local_users SET salt=?,password_hash=?,recovery_hash=? WHERE id=? AND recovery_hash=?').run(salt,passwordHash,hash(recovery),user.id,user.recovery_hash);if(!updated.changes){db.exec('ROLLBACK');return reply({error:'이미 사용된 복구 코드예요.'},409);}db.prepare('DELETE FROM local_sessions WHERE user_id=?').run(user.id);db.exec('COMMIT');}catch(e){db.exec('ROLLBACK');throw e;}
        return reply({ok:true,recoveryCode:recovery},200,{'Set-Cookie':newSession(user.id)});
      }
      return reply({error:'없는 계정 작업이에요.'},404);
    }
    // Ignore every caller-supplied platform header. Identity comes only from the session.
    const headers=new Headers(req.headers);for(const key of [...headers.keys()])if(key.startsWith('oai-'))headers.delete(key);
    const current=session(req);if(current)headers.set('oai-authenticated-user-id',current.user_id);
    const forwarded=new Request(req,{headers});return worker.fetch(forwarded,{DB,AUTH_MODE:'local'});
  }
  const server=http.createServer(async(req,res)=>{
    try{
      const origin=publicOrigin||`http://${req.headers.host||'localhost'}`,url=new URL(req.url,origin);
      if(url.origin!==origin){res.writeHead(400);res.end();return;}
      const chunks=[];let length=0;for await(const chunk of req){length+=chunk.length;if(length>32768){res.writeHead(413);res.end('Request too large');return;}chunks.push(chunk);}
      const headers=new Headers();for(const [k,v]of Object.entries(req.headers))if(v)headers.set(k,Array.isArray(v)?v.join(','):v);
      const request=new Request(url,{method:req.method,headers,body:['GET','HEAD'].includes(req.method)?undefined:Buffer.concat(chunks)});
      const result=await handle(request,{ip:req.socket.remoteAddress||'unknown'});
      res.writeHead(result.status,Object.fromEntries(result.headers));res.end(req.method==='HEAD'?undefined:Buffer.from(await result.arrayBuffer()));
    }catch(e){console.error('request_failed',e.message);if(!res.headersSent)res.writeHead(500,{'Content-Type':'application/json'});res.end(JSON.stringify({error:'일시적인 오류가 발생했어요. 다시 시도해 주세요.'}));}
  });
  return {server,handle,db,close(){clearInterval(cleanup);server.close();db.close();}};
}
if(process.argv[1]&&import.meta.url===pathToFileURL(path.resolve(process.argv[1])).href){const app=createApp();const port=Number(process.env.PORT||3000),host=process.env.HOST||'0.0.0.0';app.server.listen(port,host,()=>console.log(`LUMEN ready on port ${port}. Data: ${process.env.DATABASE_PATH||'./data/lumen.sqlite'}`));for(const sig of ['SIGINT','SIGTERM'])process.on(sig,()=>{app.close();process.exit(0);});}
