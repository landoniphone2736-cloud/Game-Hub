'use strict';
// Rocket Rivals V83 room controller for the existing Game Hub WebSocket server.
// Install in the Game-Hub repository root alongside server.js, then route
// /ws?room=rocket-rivals connections here as shown in SETUP.txt.
// Does NOT modify Storm Drop, Stick Rounds, account, or chat rooms.
const crypto = require('crypto');
const rooms = new Map();
const palette = ['#36caff','#5d7cff','#30e4b4','#ac8aff','#ff75c9','#ffa24d','#fb6673','#ffdb6c','#d6eef7'];
const bodies = new Set(['balanced','slim','long','wide','wedge','clown']);
const roomChars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
const safeName = raw => Array.from(String(raw || '').replace(/[\x00-\x1f\x7f]/g,'').replace(/[^\p{L}\p{N} _.-]/gu,'').replace(/\s+/g,' ').trim()).slice(0,8).join('') || 'Player';
function carData(raw) { return { body: bodies.has(raw?.body) ? raw.body : 'balanced', color: palette.includes(raw?.color) ? raw.color : '#ffa24d' }; }
function send(ws, data) { if(ws && ws.readyState === 1) try { ws.send(JSON.stringify(data)); } catch {} }
function newCode(){ let code;do{code=Array.from({length:6},()=>roomChars[crypto.randomInt(roomChars.length)]).join('');}while(rooms.has(code));return code; }
function roster(room){
 const teamColors = ['#36caff','#ffa24d'];
 const fixedTeams=room.gameMode!=='racing' && room.players.size>=3;
 return [...room.players.values()].map(p=>({id:p.id,name:p.name,team:p.team,ready:p.ready,host:p.id===room.host,car:fixedTeams?{...p.car,color:teamColors[p.team]}:{...p.car}}));
}
function broadcast(room,msg){for(const p of room.players.values())send(p.ws,msg);}
function lobby(room){broadcast(room,{type:'lobby',players:roster(room),active:room.active,gameMode:room.gameMode,lives:room.lives,map:room.map,racingLaps:room.racingLaps});}
function error(ws,msg){send(ws,{type:'error',message:msg});}
function join(ws,message){
 if(ws.rrV83Code)return error(ws,'You are already in a room.');
 let room;
 if(message.type==='create'){
  if(rooms.size>=400)return error(ws,'Too many rooms. Try again later.');
  room={code:newCode(),host:ws.id,players:new Map(),active:false,finished:false,gameMode:'soccer',map:'classic',lives:3,racingLaps:3};
  rooms.set(room.code,room);
 }else{
  const code=String(message.room||'').toUpperCase().replace(/[^A-Z0-9]/g,'');room=rooms.get(code);
  if(!room)return error(ws,'Room not found. Check your six-character code.');
  if(room.active)return error(ws,'That match is already in progress.');
  if(room.players.size>=4)return error(ws,'Room is full (4 players).');
 }
 const used=new Set([...room.players.values()].map(p=>p.car.color));
 const car=carData(message.car);
 if(used.has(car.color))car.color=palette.find(c=>!used.has(c))||car.color;
 const team=room.players.size===0?0:room.players.size===1?1:([...room.players.values()].filter(p=>p.team===0).length<2?0:1);
 const p={ws,id:ws.id,name:safeName(message.name),team,ready:false,car};
 room.players.set(ws.id,p);ws.rrV83Code=room.code;
 for(const player of room.players.values())player.ready=false;
 send(ws,{type:'room',role:ws.id===room.host?'host':'guest',code:room.code,id:ws.id});lobby(room);
}
function control(raw){
 const v=raw&&typeof raw==='object'?raw:{};
 const axis=x=>Number.isFinite(x)?Math.max(-1,Math.min(1,x)):0;
 const seq=x=>Number.isSafeInteger(x)&&x>=0&&x<=999999999?x:0;
 return {moveX:axis(v.moveX),moveY:axis(v.moveY),boost:v.boost===true,drift:v.drift===true,rpgEnabled:v.rpgEnabled===true,cr7Boost:v.cr7Boost===true,fireSeq:seq(v.fireSeq),shieldEnabled:v.shieldEnabled===true,shieldSeq:seq(v.shieldSeq)};
}
function message(ws,m){
 if(!m||typeof m.type!=='string')return;
 if(m.type==='create'||m.type==='join'){join(ws,m);return;}
 const room=rooms.get(ws.rrV83Code),player=room&&room.players.get(ws.id);
 if(!room||!player)return error(ws,'Create or join a room first.');
 const host=ws.id===room.host;
 if(m.type==='team'){
  if(room.active||room.gameMode==='racing')return;
  const team=m.team===0?0:m.team===1?1:null;
  if(team===null||team!==player.team&&[...room.players.values()].filter(p=>p.team===team).length>=2)return;
  if(team!==player.team){player.team=team;for(const p of room.players.values())p.ready=false;}
  lobby(room);return;
 }
 if(m.type==='game_mode'&&host&&!room.active){
  const next=m.gameMode==='racing'?'racing':m.gameMode==='beyblade'?'beyblade':'soccer';
  if(room.gameMode!==next){room.gameMode=next;if(next==='beyblade')room.map='circle';for(const p of room.players.values())p.ready=false;}
  lobby(room);return;
 }
 if(m.type==='beyblade_lives'&&host&&!room.active){
  const lives=Math.max(1,Math.min(5,Math.round(Number(m.lives)||3)));
  if(room.lives!==lives){room.lives=lives;for(const p of room.players.values())p.ready=false;}lobby(room);return;
 }
 if(m.type==='racing_laps'&&host&&!room.active){
  const laps=Math.max(1,Math.min(5,Math.round(Number(m.laps)||3)));
  if(room.racingLaps!==laps){room.racingLaps=laps;for(const p of room.players.values())p.ready=false;}lobby(room);return;
 }
 if(m.type==='map'&&host&&!room.active){
  const map=room.gameMode==='beyblade'?'circle':m.map==='circle'?'circle':'classic';
  if(room.map!==map){room.map=map;for(const p of room.players.values())p.ready=false;}lobby(room);return;
 }
 if(m.type==='ready'&&!room.active){player.ready=m.ready===true;lobby(room);return;}
 if(m.type==='start'&&host&&!room.active){
  const players=[...room.players.values()];
  if(players.length<2||players.length>4)return error(ws,'Need 2–4 players.');
  if(!players.every(p=>p.ready))return error(ws,'Everyone must ready up first.');
  if(room.gameMode!=='racing'&&(!players.some(p=>p.team===0)||!players.some(p=>p.team===1)))return error(ws,'Both teams need a player.');
  room.active=true;room.finished=false;
  const minutes=Math.max(1,Math.min(5,Math.round(Number(m.minutes)||2)));
  broadcast(room,{type:'start',minutes,map:room.map,gameMode:room.gameMode,lives:room.lives,racingLaps:room.racingLaps,players:roster(room)});return;
 }
 if(m.type==='input'&&!host&&room.active){
  send(room.players.get(room.host)?.ws,{type:'input',from:ws.id,control:control(m.control)});return;
 }
 if(m.type==='snapshot'&&host&&room.active){
  const snap=m.snapshot;
  if(!snap||typeof snap!=='object')return;
  if(!(snap.race&&Array.isArray(snap.race.racers)&&snap.race.racers.length<=4 || Array.isArray(snap.score)&&snap.ball&&snap.blue&&snap.orange))return;
  if(snap.state==='over')room.finished=true;
  for(const p of room.players.values())if(p.id!==ws.id)send(p.ws,{type:'snapshot',snapshot:snap});return;
 }
 if(m.type==='match_finished'&&host&&room.active){room.finished=true;return;}
 if(m.type==='return_lobby'&&(host||room.finished)){
  room.active=false;room.finished=false;for(const p of room.players.values())p.ready=false;
  broadcast(room,{type:'return_lobby'});lobby(room);return;
 }
}
function attach(ws){
 let count=0,windowStart=Date.now();
 ws.on('message',buf=>{
  const now=Date.now();if(now-windowStart>1000){windowStart=now;count=0;}
  if(++count>60)return;
  if(buf.length>64000)return;
  let m;try{m=JSON.parse(buf.toString('utf8'));}catch{return;}
  message(ws,m);
 });
}
function disconnect(ws){
 const code=ws.rrV83Code;if(!code)return;
 ws.rrV83Code=null;const room=rooms.get(code);if(!room)return;
 room.players.delete(ws.id);
 if(ws.id===room.host){
  for(const p of room.players.values())send(p.ws,{type:'peer_left',hostLeft:true});
  rooms.delete(code);return;
 }
 if(room.active){room.active=false;room.finished=false;for(const p of room.players.values())p.ready=false;}
 for(const p of room.players.values())send(p.ws,{type:'peer_left',hostLeft:false});
 lobby(room);if(!room.players.size)rooms.delete(code);
}
module.exports={attach,disconnect};
