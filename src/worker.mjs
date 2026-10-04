import {platformIdentity} from './identity.mjs';
import {handleRoom,roomView,settleRoomRewards} from './rooms.mjs';
import ASSETS from 'virtual:assets';
import {apply,newSave} from './game.mjs';

const json=(value,status=200)=>new Response(JSON.stringify(value),{status,headers:{'Content-Type':'application/json; charset=utf-8','Cache-Control':'no-store','X-Content-Type-Options':'nosniff'}});

export default {async fetch(req,env){
  const url=new URL(req.url);
  if(!url.pathname.startsWith('/api/')){
    const key=url.pathname==='/'?'/index.html':url.pathname,asset=ASSETS[key];
    if(!asset)return new Response('Not found',{status:404});
    const body=asset.binary?Uint8Array.from(atob(asset.body),char=>char.charCodeAt(0)):asset.body;
    return new Response(body,{headers:{'Content-Type':asset.type,'Cache-Control':asset.binary?'public, max-age=86400':'no-cache','X-Content-Type-Options':'nosniff','Referrer-Policy':'same-origin'}});
  }
  if(url.pathname==='/api/runtime')return json({authMode:env.AUTH_MODE||'platform'});
  const owner=await platformIdentity(req);
  if(!owner)return json({error:'로그인이 필요해요. 페이지를 새로 열어 주세요.'},401);
  if(!env.DB)return json({error:'저장소에 연결할 수 없어요. 잠시 뒤 다시 시도해 주세요.'},503);
  try{
    if(req.method==='POST'){
      const origin=req.headers.get('Origin');
      if(origin&&origin!==url.origin)return json({error:'허용되지 않은 요청이에요.'},403);
      if(!req.headers.get('content-type')?.includes('application/json'))return json({error:'잘못된 요청이에요.'},415);
    }
    if(url.pathname==='/api/room'&&['GET','POST'].includes(req.method)){
      try{return json(await handleRoom(req,env.DB,owner));}catch(error){return json({error:error.message},400);}
    }
    if(url.pathname==='/api/state'&&req.method==='GET'){
      await env.DB.prepare('INSERT OR IGNORE INTO lumen_saves (owner,payload,revision,updated_at) VALUES (?,?,0,?)').bind(owner,JSON.stringify(newSave()),Date.now()).run();
      const row=await env.DB.prepare('SELECT payload,revision FROM lumen_saves WHERE owner=?').bind(owner).first();
      return json({state:JSON.parse(row.payload),revision:row.revision});
    }
    if(url.pathname==='/api/action'&&req.method==='POST'){
      const text=await req.text();
      if(text.length>24000)return json({error:'요청이 너무 커요.'},413);
      let body;try{body=JSON.parse(text);}catch{return json({error:'잘못된 요청이에요.'},400);}
      if(typeof body.id!=='string'||body.id.length>80||body.id.length<8)return json({error:'요청 번호가 없어요.'},400);
      for(let attempt=0;attempt<3;attempt++){
        const row=await env.DB.prepare('SELECT payload,revision FROM lumen_saves WHERE owner=?').bind(owner).first();
        if(!row)return json({error:'먼저 페이지를 새로 열어 주세요.'},409);
        const state=JSON.parse(row.payload),prior=state.receipts.find(item=>item.id===body.id);
        if(prior){
          if(body.kind==='duelPack'){
            await settleRoomRewards(env.DB,String(body.data?.code||''));
            const fresh=await env.DB.prepare('SELECT payload,revision FROM lumen_saves WHERE owner=?').bind(owner).first();
            return json({state:JSON.parse(fresh.payload),revision:fresh.revision,result:prior.result});
          }
          return json({state,revision:row.revision,result:prior.result});
        }
        if(body.kind==='duelPack'){
          try{
            const duel=await roomView(env.DB,String(body.data?.code||''),owner);
            const me=duel.players.find(player=>player?.me),opponent=duel.players.find(player=>player&&!player.me);
            if(!opponent||duel.complete)throw Error('대결이 끝났거나 상대가 아직 입장하지 않았어요.');
            if(me.rounds.length>opponent.rounds.length)throw Error('상대가 이번 라운드 팩을 열 때까지 기다려 주세요.');
            if(opponent.rounds.length>me.rounds.length+1)throw Error('대결 진행 상태를 새로고침해 주세요.');
            body.data={...body.data,matchNo:duel.matchNo};
          }catch(error){return json({error:error.message},400);}
          body.profile=0;
        }
        let result;
        try{result=apply(state,body.profile,body.kind,body.data);}catch(error){return json({error:error.message},400);}
        state.receipts.push({id:body.id,result});state.receipts=state.receipts.slice(-25);
        const updated=await env.DB.prepare('UPDATE lumen_saves SET payload=?,revision=revision+1,updated_at=? WHERE owner=? AND revision=?').bind(JSON.stringify(state),Date.now(),owner,row.revision).run();
        if(updated.meta.changes===1){
          if(body.kind==='duelPack'){
            await settleRoomRewards(env.DB,String(body.data?.code||''));
            const fresh=await env.DB.prepare('SELECT payload,revision FROM lumen_saves WHERE owner=?').bind(owner).first();
            return json({state:JSON.parse(fresh.payload),revision:fresh.revision,result});
          }
          return json({state,revision:row.revision+1,result});
        }
      }
      return json({error:'다른 창에서 변경 중이에요. 잠시 뒤 다시 시도해 주세요.'},409);
    }
    return json({error:'없는 경로예요.'},404);
  }catch(error){console.error('lumen-api',error.message);return json({error:'저장에 실패했어요. 연결을 확인한 뒤 다시 시도해 주세요.'},503);}
}};
