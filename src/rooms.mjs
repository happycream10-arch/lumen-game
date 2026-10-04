const scores=[1,3,8,20,60,200];
const matchKey=(code,matchNo)=>`${code}:${matchNo}`;
const packScore=pack=>pack.cards.reduce((sum,card)=>sum+scores[Number(card.key.split('-')[1])],0);

async function matchState(db,code){
  await db.prepare('INSERT OR IGNORE INTO lumen_room_matches (code) VALUES (?)').bind(code).run();
  return db.prepare('SELECT match_no,host_ready,guest_ready FROM lumen_room_matches WHERE code=?').bind(code).first();
}

export async function roomView(db,code,owner){
  const row=await db.prepare('SELECT * FROM lumen_rooms WHERE code=?').bind(code).first();
  if(!row)throw Error('방을 찾을 수 없어요.');
  if(row.host!==owner&&row.guest!==owner)throw Error('이 방의 참가자가 아니에요.');
  const state=await matchState(db,code),matchNo=Number(state.match_no||1),key=matchKey(code,matchNo),players=[];
  for(const [index,id] of [row.host,row.guest].entries()){
    if(!id){players.push(null);continue;}
    const save=await db.prepare('SELECT payload FROM lumen_saves WHERE owner=?').bind(id).first();
    const profile=save?JSON.parse(save.payload).profiles[0]:null;
    const packs=profile?.duels?.[key]||[];
    players.push({name:profile?.name||'수집가',me:id===owner,ready:index===0?!!state.host_ready:!!state.guest_ready,reward:profile?.duelPayouts?.[key]??null,rounds:packs.map(pack=>({id:pack.id,cards:pack.cards,score:packScore(pack)})),wins:0});
  }
  const roundCount=Math.max(...players.map(player=>player?.rounds.length||0));
  const roundResults=[];
  for(let i=0;i<roundCount;i++){
    const a=players[0]?.rounds[i],b=players[1]?.rounds[i];
    const winner=!a||!b?null:a.score===b.score?-1:a.score>b.score?0:1;
    roundResults.push({round:i+1,scores:[a?.score??null,b?.score??null],winner});
    if(winner===0)players[0].wins++;
    if(winner===1)players[1].wins++;
    for(let p=0;p<2;p++)if(players[p]?.rounds[i])players[p].rounds[i].result=winner===null?'대기':winner===-1?'무승부':winner===p?'승리':'패배';
  }
  const winner=players.findIndex(player=>player&&player.wins>=3);
  const complete=winner>=0||(players[0]&&players[1]&&players[0].rounds.length===5&&players[1].rounds.length===5);
  return {code,matchNo,players,roundResults,complete,winner:winner>=0?winner:null,draw:complete&&winner<0,rematchReady:[!!state.host_ready,!!state.guest_ready]};
}

async function grantDuelReward(db,owner,key,amount){
  for(let attempt=0;attempt<5;attempt++){
    const row=await db.prepare('SELECT payload,revision FROM lumen_saves WHERE owner=?').bind(owner).first();
    if(!row)return false;
    const state=JSON.parse(row.payload),profile=state.profiles[0];
    profile.duelPayouts??={};
    if(Object.hasOwn(profile.duelPayouts,key))return false;
    profile.coins+=amount;profile.duelPayouts[key]=amount;
    const updated=await db.prepare('UPDATE lumen_saves SET payload=?,revision=revision+1,updated_at=? WHERE owner=? AND revision=?').bind(JSON.stringify(state),Date.now(),owner,row.revision).run();
    if(updated.meta.changes===1)return true;
  }
  throw Error('대결 보상 저장이 지연되고 있어요. 잠시 후 다시 확인해 주세요.');
}

export async function settleRoomRewards(db,code){
  const row=await db.prepare('SELECT host,guest FROM lumen_rooms WHERE code=?').bind(code).first();
  if(!row?.guest)return false;
  const snapshot=await roomView(db,code,row.host);
  if(!snapshot.complete)return false;
  const key=matchKey(code,snapshot.matchNo),rewards=snapshot.draw?[100,100]:snapshot.winner===0?[400,100]:[100,400];
  for(let i=0;i<2;i++)await grantDuelReward(db,[row.host,row.guest][i],key,rewards[i]);
  return true;
}

export async function handleRoom(req,db,owner){
  const url=new URL(req.url);
  if(req.method==='GET'){
    let code=url.searchParams.get('code');
    if(!code){const r=await db.prepare('SELECT code FROM lumen_rooms WHERE host=? OR guest=? ORDER BY created_at DESC LIMIT 1').bind(owner,owner).first();if(!r)return {room:null};code=r.code;}
    await settleRoomRewards(db,code);
    return {room:await roomView(db,code,owner)};
  }
  const b=await req.json();let code=String(b.code||'').toUpperCase();
  if(b.op==='create'){
    const since=Date.now()-60000,recent=await db.prepare('SELECT code FROM lumen_rooms WHERE host=? AND created_at>? ORDER BY created_at DESC LIMIT 1').bind(owner,since).first();
    if(recent)code=recent.code;
    else{
      const alphabet='ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
      for(let tries=0;tries<4;tries++){
        const a=new Uint8Array(6);crypto.getRandomValues(a);code=Array.from(a,n=>alphabet[n%alphabet.length]).join('');
        const r=await db.prepare('INSERT OR IGNORE INTO lumen_rooms (code,host,created_at) VALUES (?,?,?)').bind(code,owner,Date.now()).run();
        if(r.meta.changes)break;
      }
    }
    await matchState(db,code);
  }else if(b.op==='join'){
    if(!/^[A-Z0-9]{6}$/.test(code))throw Error('6자리 방 코드를 입력해 주세요.');
    await db.prepare('UPDATE lumen_rooms SET guest=? WHERE code=? AND guest IS NULL AND host<>?').bind(owner,code,owner).run();
  }else if(b.op==='rematch'){
    if(!/^[A-Z0-9]{6}$/.test(code))throw Error('방 코드가 올바르지 않아요.');
    await settleRoomRewards(db,code);
    const current=await roomView(db,code,owner);
    if(!current.complete)throw Error('대결이 끝난 뒤 재대결할 수 있어요.');
    const player=current.players.findIndex(player=>player?.me);
    if(player===0)await db.prepare('UPDATE lumen_room_matches SET host_ready=1 WHERE code=? AND match_no=?').bind(code,current.matchNo).run();
    else await db.prepare('UPDATE lumen_room_matches SET guest_ready=1 WHERE code=? AND match_no=?').bind(code,current.matchNo).run();
    const ready=await matchState(db,code);
    if(Number(ready.host_ready)===1&&Number(ready.guest_ready)===1){
      await db.prepare('UPDATE lumen_room_matches SET match_no=match_no+1,host_ready=0,guest_ready=0 WHERE code=? AND match_no=? AND host_ready=1 AND guest_ready=1').bind(code,current.matchNo).run();
    }
  }else throw Error('잘못된 요청이에요.');
  await settleRoomRewards(db,code);
  return {room:await roomView(db,code,owner)};
}
