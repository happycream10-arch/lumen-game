import assert from 'node:assert/strict';
import {createApp} from '../standalone/server.mjs';
import fs from 'node:fs';import os from 'node:os';import path from 'node:path';
const dir=fs.mkdtempSync(path.join(os.tmpdir(),'lumen-release-test-')),database=path.join(dir,'save.sqlite');
let app=createApp({database}),sequence=0;const clients={a:{},b:{},third:{}};
async function request(client,route,body,headers={}){
 const reqHeaders={'Content-Type':'application/json','Origin':'http://test.local',...headers};if(client.cookie)reqHeaders.cookie=client.cookie;
 const res=await app.handle(new Request('http://test.local'+route,{method:body?'POST':'GET',headers:reqHeaders,body:body?JSON.stringify(body):undefined}),{ip:client===clients.a?'a':client===clients.b?'b':'third'});
 const cookie=res.headers.get('set-cookie');if(cookie)client.cookie=cookie.split(';')[0];return {status:res.status,body:await res.json(),cookie};
}
async function act(client,kind,data={}){return request(client,'/api/action',{id:'release-test-'+(++sequence),profile:0,kind,data});}
try{
 assert.equal((await request(clients.a,'/api/runtime')).body.authMode,'local');
 assert.equal((await request(clients.a,'/api/state',null,{'oai-authenticated-user-id':'admin','oai-authenticated-user-email':'admin@example.com'})).status,401);
 let reg=await request(clients.a,'/api/account/register',{username:'alice_collector',password:'Alice_password_123!'});assert.equal(reg.status,200);assert.match(reg.cookie,/HttpOnly/);assert.match(reg.cookie,/SameSite=Lax/);const recovery=reg.body.recoveryCode;assert.equal(recovery.length,48);
 assert.equal((await request(clients.b,'/api/account/register',{username:'bob_collector',password:'Bob_password_123!'})).status,200);
 assert.equal((await request(clients.third,'/api/account/register',{username:'third_collector',password:'Third_password_123!'})).status,200);
 for(const c of Object.values(clients))assert.equal((await request(c,'/api/state')).body.state.profiles[0].coins,600);
 assert.equal((await request({},'/api/account/login',{username:'alice_collector',password:'wrong_password_123'})).status,401);
 const device2={};assert.equal((await request(device2,'/api/account/login',{username:'alice_collector',password:'Alice_password_123!'})).status,200);
 await act(clients.a,'rename',{name:'앨리스'});assert.equal((await request(device2,'/api/state')).body.state.profiles[0].name,'앨리스');assert.equal((await request(clients.b,'/api/state')).body.state.profiles[0].name,'별빛 수집가');
 // Earn actual rewards through the game service, while advancing only test-server time.
 for(const c of [clients.a,clients.b]){for(let n=0;n<2;n++){const start=await act(c,'startGame',{game:'timing'});const tokenHash=app.db.prepare('SELECT user_id FROM local_sessions WHERE token_hash=?').get((await import('node:crypto')).createHash('sha256').update(c.cookie.split('=')[1]).digest('hex')).user_id;const row=app.db.prepare('SELECT payload FROM lumen_saves WHERE owner=?').get(tokenHash);const save=JSON.parse(row.payload);save.profiles[0].session.started-=5000;app.db.prepare('UPDATE lumen_saves SET payload=? WHERE owner=?').run(JSON.stringify(save),tokenHash);assert.equal((await act(c,'finishGame',{id:start.body.result.id,hits:[100,100,100,100,100,100]})).body.result.reward,480);}}
 const create=await request(clients.a,'/api/room',{op:'create'}),code=create.body.room.code;assert.equal((await request(clients.b,'/api/room',{op:'join',code})).status,200);assert.equal((await request(clients.third,'/api/room',{op:'join',code})).status,400);
 for(let n=0;n<5;n++){assert.equal((await act(clients.a,'duelPack',{code})).status,200);assert.equal((await act(clients.b,'duelPack',{code})).status,200);}
 const result=(await request(clients.a,'/api/room?code='+code)).body.room;assert.equal(result.complete,true);assert.equal(result.players[0].rounds.length,5);assert.equal(result.players[1].rounds.length,5);assert.equal((await act(clients.a,'duelPack',{code})).status,400);
 const saved=(await request(clients.a,'/api/state')).body.state;assert.equal(saved.profiles[0].coins,360);assert.equal(Object.values(saved.profiles[0].cards).reduce((a,b)=>a+b,0),25);
 const oldDeviceCookie=device2.cookie;reg=await request(clients.a,'/api/account/recover',{username:'alice_collector',password:'new_secure_password_123',recoveryCode:recovery});assert.equal(reg.status,200);assert.notEqual(reg.body.recoveryCode,recovery);assert.equal((await request({cookie:oldDeviceCookie},'/api/state')).status,401);assert.equal((await request(clients.a,'/api/account/recover',{username:'alice_collector',password:'another_password_123',recoveryCode:recovery})).status,401);
 assert.equal((await request(clients.a,'/api/account/logout',{})).status,200);assert.equal((await request(clients.a,'/api/state')).status,401);
 assert.equal((await request(clients.a,'/api/account/login',{username:'alice_collector',password:'new_secure_password_123'})).status,200);
 assert.equal((await request(clients.a,'/api/action',{id:'bad-origin-123',kind:'rename',profile:0,data:{name:'hacked'}},{Origin:'https://evil.test'})).status,403);
 app.close();app=createApp({database});assert.deepEqual((await request(clients.a,'/api/state')).body.state.profiles[0],saved.profiles[0]);assert.equal((await request(clients.b,'/api/room?code='+code)).body.room.complete,true);
 assert.throws(()=>createApp({database:':memory:',production:true,publicURL:'http://example.com'}),/https/);
 console.log('PASS: real SQLite persistence, signup/login/recovery/logout, forged-header rejection, password rejection, session invalidation, two-device same-account sync, separate-account isolation, full 5-pack online duel, rewards, CSRF and restart survival.');
}finally{app.close();fs.rmSync(dir,{recursive:true,force:true});}
