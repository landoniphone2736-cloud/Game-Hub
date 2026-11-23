'use strict';
// Rocket Rivals online: dependency-free WebSocket room relay.
// The host's browser runs the existing physics; a guest sends controls and
// receives snapshots. All rooms exist only in this running process.
const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');

const PORT = Number(process.env.PORT) || 10000;
const STATIC_DIR = __dirname;
const MAX_MESSAGE = 32 * 1024;
const MAX_ROOMS = 400;
const rooms = new Map();
const clients = new Set();
const ROOM_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';

function newCode(){
  let value;
  do {value = Array.from({length:6}, () => ROOM_ALPHABET[crypto.randomInt(ROOM_ALPHABET.length)]).join('')} while(rooms.has(value));
  return value;
}
function send(client, obj){if(!client || client.closed)return;client.write(JSON.stringify(obj))}
function sanitizeCar(car){
  const bodies=['balanced','slim','long','wide','wedge','clown'];
  const colors=['#36caff','#5d7cff','#30e4b4','#ac8aff','#ff75c9','#ffa24d','#fb6673','#ffdb6c','#d6eef7'];
  return {body:bodies.includes(car?.body)?car.body:'balanced',color:colors.includes(car?.color)?car.color:'#ffa24d'};
}
function sanitizeUsername(raw){
 const safe=String(raw??'').replace(/[\x00-\x1f\x7f]/g,'').replace(/[^\p{L}\p{N} _.-]/gu,'').replace(/\s+/g,' ').trim();
 return Array.from(safe).slice(0,8).join('')||'Player';
}
const TEAM_MATCH_COLORS=['#36caff','#ffa24d'];
function roster(room){
  // 3- and 4-player rooms are team matches: Blue teammates share Sky Blue,
  // Orange teammates share Flame Orange. Keep 1v1's personal garage colors.
  const teamMatch=room.players.length>=3&&room.gameMode!=='racing';
  return room.players.map(p=>({id:p.id,name:p.name,team:p.team,ready:!!p.ready,host:room.host===p,
    car:teamMatch?{...p.car,color:TEAM_MATCH_COLORS[p.team]}:{...p.car}}));
}
function broadcast(room,data){for(const p of room.players)send(p,data)}
function broadcastLobby(room){broadcast(room,{type:'lobby',players:roster(room),active:room.active,map:room.map,gameMode:room.gameMode,lives:room.lives,racingLaps:room.racingLaps})}
function sanitizeControl(value){
  const v=value||{};
  const bounded=n=>Number.isFinite(n)?Math.max(-1,Math.min(1,n)):0;
  return {moveX:bounded(v.moveX),moveY:bounded(v.moveY),boost:v.boost===true,drift:v.drift===true,rpgEnabled:v.rpgEnabled===true,cr7Boost:v.cr7Boost===true,fireSeq:Number.isSafeInteger(v.fireSeq)&&v.fireSeq>=0&&v.fireSeq<=999999999?v.fireSeq:0,shieldEnabled:v.shieldEnabled===true,shieldSeq:Number.isSafeInteger(v.shieldSeq)&&v.shieldSeq>=0&&v.shieldSeq<=999999999?v.shieldSeq:0};
}
function uniqueRoomCar(room,car){
 const chosen=sanitizeCar(car);
 const used=new Set(room.players.map(p=>p.car.color));
 if(used.has(chosen.color)){
  const palette=['#36caff','#5d7cff','#30e4b4','#ac8aff','#ff75c9','#ffa24d','#fb6673','#ffdb6c','#d6eef7'];
  chosen.color=palette.find(color=>!used.has(color))||chosen.color;
 }
 return chosen;
}
function cleanup(client){
  if(client.disposed)return;
  client.disposed=true;client.closed=true;clients.delete(client);
  const room=client.room;
  if(!room)return;
  client.room=null;
  room.players=room.players.filter(p=>p!==client);
  if(room.host===client){
    rooms.delete(room.code);
    for(const p of room.players){send(p,{type:'peer_left',hostLeft:true});p.room=null;p.close(1001,'Host left')}
  }else{
    if(room.active){room.active=false;room.finished=false;for(const p of room.players)p.ready=false}
    broadcast(room,{type:'peer_left',id:client.id,hostLeft:false});
    broadcastLobby(room);
  }
}
function processMessage(client,payload){
  let message;
  try{message=JSON.parse(payload)}catch{return send(client,{type:'error',message:'Invalid message.'})}
  if(!message || typeof message!=='object')return;
  if(message.type==='create' && !client.room){
    if(rooms.size>=MAX_ROOMS)return send(client,{type:'error',message:'The server is full. Try again later.'});
    client.id=crypto.randomBytes(6).toString('hex');client.team=0;client.ready=false;client.name=sanitizeUsername(message.name);client.car=sanitizeCar(message.car);
    const room={code:newCode(),host:client,players:[client],active:false,finished:false,map:'classic',gameMode:'soccer',lives:3,racingLaps:3};
    rooms.set(room.code,room);client.room=room;
    send(client,{type:'room',role:'host',code:room.code,id:client.id});
    broadcastLobby(room);return;
  }
  if(message.type==='join' && !client.room){
    const code=String(message.room||'').toUpperCase();const room=rooms.get(code);
    if(!room || room.host.closed)return send(client,{type:'error',message:'Room not found. Check the six-character code.'});
    if(room.active)return send(client,{type:'error',message:'Match in progress. Ask your friend to return to the lobby.'});
    if(room.players.length>=4)return send(client,{type:'error',message:'Room is full (4 players).'});
    client.id=crypto.randomBytes(6).toString('hex');
    const blueCount=room.players.filter(p=>p.team===0).length;
    client.team=blueCount<2?0:1;
    // Keep the first arrival opposite the host; later arrivals balance teams.
    if(room.players.length===1)client.team=1;
    client.car=uniqueRoomCar(room,message.car);client.name=sanitizeUsername(message.name);client.ready=false;
    room.players.push(client);client.room=room;
    for(const p of room.players)p.ready=false;
    send(client,{type:'room',role:'guest',code:room.code,id:client.id});
    broadcastLobby(room);return;
  }
  const room=client.room;
  if(!room)return;
  if(message.type==='team'&&!room.active&&room.gameMode!=='racing'){
    const team=message.team===1?1:message.team===0?0:null;
    if(team===null)return;
    if(team!==client.team && room.players.filter(p=>p.team===team).length>=2)
      return send(client,{type:'error',message:'That team already has two players.'});
    if(team!==client.team){client.team=team;for(const p of room.players)p.ready=false}
    broadcastLobby(room);return;
  }
  if(message.type==='game_mode'&&!room.active&&room.host===client){
    const next=message.gameMode==='beyblade'?'beyblade':message.gameMode==='racing'?'racing':'soccer';
    if(next!==room.gameMode){room.gameMode=next;if(next==='beyblade')room.map='circle';for(const p of room.players)p.ready=false}
    broadcastLobby(room);return;
  }
  if(message.type==='beyblade_lives'&&!room.active&&room.host===client){
    const count=Number(message.lives);
    if(!Number.isFinite(count))return;
    const lives=Math.max(1,Math.min(5,Math.round(count)));
    if(lives!==room.lives){room.lives=lives;for(const p of room.players)p.ready=false}
    broadcastLobby(room);return;
  }
  if(message.type==='racing_laps'&&!room.active&&room.host===client){const num=Number(message.laps);if(!Number.isFinite(num))return;const laps=Math.max(1,Math.min(5,Math.round(num)));if(laps!==room.racingLaps){room.racingLaps=laps;for(const p of room.players)p.ready=false}broadcastLobby(room);return;}
  if(message.type==='map'&&!room.active&&room.host===client){
    const next=room.gameMode==='beyblade'?'circle':message.map==='circle'?'circle':'classic';
    if(next!==room.map){room.map=next;for(const p of room.players)p.ready=false}
    broadcastLobby(room);return;
  }
  if(message.type==='ready'&&!room.active){
    client.ready=message.ready===true;broadcastLobby(room);return;
  }
  if(message.type==='start'&&room.host===client&&!room.active){
    const count=room.players.length;
    if(count<2||count>4)return send(client,{type:'error',message:'Need 2–4 players to start.'});
    if(room.gameMode!=='racing'&&(!room.players.some(p=>p.team===0)||!room.players.some(p=>p.team===1)))return send(client,{type:'error',message:'Both teams need at least one player.'});
    if(!room.players.every(p=>p.ready))return send(client,{type:'error',message:'All players must ready up.'});
    const minutes=Number.isFinite(message.minutes)?Math.min(5,Math.max(1,Math.round(message.minutes))):2;
    room.active=true;room.finished=false;
    broadcast(room,{type:'start',minutes,map:room.gameMode==='beyblade'?'circle':room.map,gameMode:room.gameMode,lives:room.lives,racingLaps:room.racingLaps,players:roster(room)});
    return;
  }
  // A guest may return the whole room only after the host has finished
  // the match; this prevents prematurely ending another player's game.
  if(message.type==='match_finished'&&room.host===client&&room.active){
    room.finished=true;return;
  }
  if(message.type==='return_lobby'&&(room.host===client||room.finished)){
    room.active=false;room.finished=false;
    for(const p of room.players)p.ready=false;
    broadcast(room,{type:'return_lobby'});broadcastLobby(room);return;
  }
  if(message.type==='input'&&room.host!==client&&room.active){
    const control=sanitizeControl(message.control);
    // Online participants may use their own developer ability (RPG or forcefield); local Player 2 is restricted in the game client.
    send(room.host,{type:'input',from:client.id,control});return;
  }
  if(message.type==='snapshot'&&room.host===client&&room.active){
    const data=message.snapshot;
    if(data && typeof data==='object' && ((data.race&&Array.isArray(data.race.racers)&&data.race.racers.length<=4) || (Array.isArray(data.score)&&data.ball&&data.blue&&data.orange))){
      if(data.state==='over')room.finished=true;
      for(const p of room.players)if(p!==client)send(p,{type:'snapshot',snapshot:data});
    }
  }
}

class WebSocketPeer{
 constructor(socket){
  this.socket=socket;this.buffer=Buffer.alloc(0);this.partial=null;
  this.closed=false;this.disposed=false;this.room=null;this.lastPong=Date.now();
  clients.add(this);
  socket.on('data',chunk=>this.onData(chunk));
  socket.on('error',()=>this.close());
  socket.on('close',()=>cleanup(this));
 }
 writeFrame(opcode,payload){
  if(this.closed || this.socket.destroyed)return;
  const data=Buffer.isBuffer(payload)?payload:Buffer.from(payload||'');
  if(data.length>MAX_MESSAGE)return;
  let header;
  if(data.length<126){header=Buffer.from([0x80|opcode,data.length])}
  else {header=Buffer.alloc(4);header[0]=0x80|opcode;header[1]=126;header.writeUInt16BE(data.length,2)}
  // Drop excessive queued game snapshots rather than lag everyone.
  if(this.socket.writableLength>1024*256){this.close(1009,'Slow connection');return}
  this.socket.write(Buffer.concat([header,data]));
 }
 write(message){this.writeFrame(1,message)}
 close(code=1000,reason=''){if(this.closed)return;this.closed=true;const bytes=Buffer.from(String(reason).slice(0,80));const body=Buffer.alloc(2+bytes.length);body.writeUInt16BE(code,0);bytes.copy(body,2);try{this.socket.write(Buffer.concat([Buffer.from([0x88,body.length]),body]));this.socket.end()}catch{}cleanup(this)}
 onData(chunk){
  if(this.closed)return;
  this.buffer=Buffer.concat([this.buffer,chunk]);
  if(this.buffer.length>MAX_MESSAGE*2){this.close(1009,'Frame too large');return}
  while(this.buffer.length>=2){
   const a=this.buffer[0],b=this.buffer[1],opcode=a&15,fin=!!(a&0x80),masked=!!(b&0x80);
   if(!masked){this.close(1002,'Client frames must be masked');return}
   let length=b&127,head=2;
   if(length===126){if(this.buffer.length<4)return;length=this.buffer.readUInt16BE(2);head=4}
   else if(length===127){if(this.buffer.length<10)return;const high=this.buffer.readUInt32BE(2),low=this.buffer.readUInt32BE(6);if(high||low>MAX_MESSAGE){this.close(1009,'Frame too large');return}length=low;head=10}
   if(length>MAX_MESSAGE){this.close(1009,'Frame too large');return}
   if(this.buffer.length<head+4+length)return;
   const mask=this.buffer.subarray(head,head+4),data=Buffer.from(this.buffer.subarray(head+4,head+4+length));
   this.buffer=this.buffer.subarray(head+4+length);
   for(let i=0;i<data.length;i++)data[i]^=mask[i&3];
   if(opcode===8){this.close();return}
   if(opcode===9){this.writeFrame(10,data);continue}
   if(opcode===10){this.lastPong=Date.now();continue}
   if(opcode===1 && !this.partial && fin){processMessage(this,data.toString('utf8'));continue}
   if(opcode===1 && !this.partial && !fin){this.partial=[data];continue}
   if(opcode===0 && this.partial){this.partial.push(data);if(this.partial.reduce((n,b)=>n+b.length,0)>MAX_MESSAGE){this.close(1009,'Message too large');return}if(fin){processMessage(this,Buffer.concat(this.partial).toString('utf8'));this.partial=null}continue}
   this.close(1002,'Unexpected frame');return;
  }
 }
}

const server=http.createServer((req,res)=>{
 const pathname=new URL(req.url||'/', 'http://localhost').pathname;
 if(pathname==='/health'){res.writeHead(200,{'Content-Type':'application/json'});return res.end(JSON.stringify({ok:true,rooms:rooms.size}))}
 const filename=pathname==='/'? 'index.html': pathname==='/favicon.svg'?'favicon.svg':null;
 if(!filename){res.writeHead(404);return res.end('Not found')}
 const filepath=path.join(STATIC_DIR,filename);
 fs.readFile(filepath,(err,data)=>{
  if(err){res.writeHead(500);return res.end('Unable to load game')}
  res.writeHead(200,{'Content-Type':filename.endsWith('.svg')?'image/svg+xml; charset=utf-8':'text/html; charset=utf-8','Cache-Control':'no-cache','X-Content-Type-Options':'nosniff'});
  res.end(data);
 });
});
server.on('upgrade',(req,socket,head)=>{
 try{
  const pathname=new URL(req.url,'http://localhost').pathname;
  const key=req.headers['sec-websocket-key'];
  const raw=typeof key==='string'?Buffer.from(key,'base64'):Buffer.alloc(0);
  const origin=req.headers.origin;
  if(pathname!=='/ws'||req.headers.upgrade?.toLowerCase()!=='websocket'||raw.length!==16||req.headers['sec-websocket-version']!=='13')return socket.destroy();
  // The published Static Site can connect from its own URL when FRONTEND_ORIGIN is configured.
  let extraOrigin='';
  try{if(process.env.FRONTEND_ORIGIN)extraOrigin=new URL(process.env.FRONTEND_ORIGIN).origin}catch{}
  if(origin){
    let originUrl;
    try{originUrl=new URL(origin)}catch{return socket.destroy()}
    const sameOrigin=originUrl.host===req.headers.host;
    const trustedFrontend=extraOrigin && originUrl.origin===extraOrigin;
    if(!sameOrigin && !trustedFrontend)return socket.destroy();
  }
  const accept=crypto.createHash('sha1').update(key+'258EAFA5-E914-47DA-95CA-C5AB0DC85B11').digest('base64');
  socket.write('HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: '+accept+'\r\n\r\n');
  const client=new WebSocketPeer(socket);
  if(head.length)client.onData(head);
 }catch{socket.destroy()}
});
const heartbeat=setInterval(()=>{
 for(const peer of clients){if(Date.now()-peer.lastPong>75000){peer.close(1001,'Timed out');continue}peer.writeFrame(9,Buffer.from('r'))}
},25000);
server.listen(PORT,'0.0.0.0',()=>console.log('Rocket Rivals Multiplayer listening on port',PORT));
function shutdown(){clearInterval(heartbeat);server.close();for(const peer of clients)peer.close(1001,'Server restarting')}
process.on('SIGTERM',shutdown);process.on('SIGINT',shutdown);
