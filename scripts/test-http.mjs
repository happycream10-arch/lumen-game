import assert from 'node:assert/strict';
import {createApp} from '../standalone/server.mjs';
const app=createApp({database:':memory:'});
await new Promise(r=>app.server.listen(0,'127.0.0.1',r));
const origin='http://127.0.0.1:'+app.server.address().port;
try{
 const html=await fetch(origin);assert.equal(html.status,200);assert((await html.text()).includes('LUMEN'));
 const reg=await fetch(origin+'/api/account/register',{method:'POST',headers:{'Content-Type':'application/json',Origin:origin},body:JSON.stringify({username:'http_player',password:'http_password_123'})});assert.equal(reg.status,200);const cookie=reg.headers.get('set-cookie').split(';')[0];
 const state=await fetch(origin+'/api/state',{headers:{cookie}});assert.equal(state.status,200);assert.equal((await state.json()).state.profiles[0].coins,600);
 const unauthorized=await fetch(origin+'/api/state',{headers:{'oai-authenticated-user-id':'http_player','oai-authenticated-user-email':'example@test.com'}});assert.equal(unauthorized.status,401);
 const image=await fetch(origin+'/assets/forest.webp');assert.equal(image.headers.get('content-type'),'image/webp');assert((await image.arrayBuffer()).byteLength>100000);
 const csrf=await fetch(origin+'/api/account/logout',{method:'POST',headers:{'Content-Type':'application/json',Origin:'https://evil.test',cookie},body:'{}'});assert.equal(csrf.status,403);
 console.log('PASS: listening HTTP server, homepage/assets, secure signup cookie, authenticated wallet, forged headers and cross-origin rejection.');
}finally{app.close();}
