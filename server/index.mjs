import http from 'node:http';
import { DatabaseSync } from 'node:sqlite';
import { createHash, randomBytes, scrypt as scryptCallback, timingSafeEqual, createHmac } from 'node:crypto';
import { promisify } from 'node:util';
import { mkdir, readFile, writeFile, stat, unlink } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { uid, error, identifier, validText, validateMessage, toggleReaction, normalizeEvent, validateDocument, messageFingerprint, MAX_FILE_SIZE, MAX_CALL_PEERS } from '../public/core/model.js';

import { callState } from '../public/core/call-state.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const scrypt = promisify(scryptCallback);
const SESSION_MS = 7 * 86400000;
const hash = value => createHash('sha256').update(value).digest('hex');
const mime = {'.html':'text/html; charset=utf-8','.js':'text/javascript; charset=utf-8','.css':'text/css; charset=utf-8','.json':'application/json','.svg':'image/svg+xml','.webmanifest':'application/manifest+json','.png':'image/png'};

/** One installation is one trust domain. Private-room membership is enforced for every operation. */
export async function createWorkspaceServer(options = {}) {
  const config = {
    dataDir: path.resolve(options.dataDir || process.env.DATA_DIR || path.join(ROOT,'data')),
    origin: options.origin ?? process.env.PUBLIC_ORIGIN ?? '',
    allowRegistration: options.allowRegistration ?? (process.env.ALLOW_REGISTRATION !== 'false'),
    clientId: process.env.MICROSOFT_CLIENT_ID || '', tenantId: process.env.MICROSOFT_TENANT_ID || 'common'
  };
  if (config.origin) config.origin = new URL(config.origin).origin;
  await mkdir(path.join(config.dataDir,'uploads'),{recursive:true,mode:0o700});
  const db = new DatabaseSync(path.join(config.dataDir,'workspace.sqlite'));
  db.exec(`PRAGMA journal_mode=WAL; PRAGMA foreign_keys=ON; PRAGMA busy_timeout=5000;
CREATE TABLE IF NOT EXISTS users(id TEXT PRIMARY KEY,name TEXT NOT NULL,email TEXT UNIQUE NOT NULL,password TEXT NOT NULL,color TEXT NOT NULL,status TEXT NOT NULL DEFAULT 'available',createdAt TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS sessions(hash TEXT PRIMARY KEY,userId TEXT NOT NULL REFERENCES users(id),expires INTEGER NOT NULL);
CREATE TABLE IF NOT EXISTS rooms(id TEXT PRIMARY KEY,name TEXT NOT NULL,type TEXT NOT NULL,description TEXT NOT NULL DEFAULT '',createdBy TEXT NOT NULL REFERENCES users(id),createdAt TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS members(roomId TEXT NOT NULL REFERENCES rooms(id),userId TEXT NOT NULL REFERENCES users(id),PRIMARY KEY(roomId,userId));
CREATE TABLE IF NOT EXISTS messages(id TEXT PRIMARY KEY,roomId TEXT NOT NULL REFERENCES rooms(id),authorId TEXT NOT NULL REFERENCES users(id),content TEXT NOT NULL,createdAt TEXT NOT NULL,editedAt TEXT,deleted INTEGER NOT NULL DEFAULT 0,replyTo TEXT,attachments TEXT NOT NULL DEFAULT '[]',reactions TEXT NOT NULL DEFAULT '[]',fingerprint TEXT NOT NULL);
CREATE INDEX IF NOT EXISTS messages_room_time ON messages(roomId,createdAt,id);
CREATE TABLE IF NOT EXISTS files(id TEXT PRIMARY KEY,roomId TEXT NOT NULL REFERENCES rooms(id),ownerId TEXT NOT NULL REFERENCES users(id),name TEXT NOT NULL,type TEXT NOT NULL,size INTEGER NOT NULL,createdAt TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS docs(id TEXT PRIMARY KEY,roomId TEXT NOT NULL REFERENCES rooms(id),kind TEXT NOT NULL,body TEXT NOT NULL,version INTEGER NOT NULL);
CREATE TABLE IF NOT EXISTS events(id TEXT PRIMARY KEY,roomId TEXT REFERENCES rooms(id),creatorId TEXT NOT NULL REFERENCES users(id),body TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS preferences(userId TEXT NOT NULL REFERENCES users(id),roomId TEXT NOT NULL REFERENCES rooms(id),body TEXT NOT NULL,PRIMARY KEY(userId,roomId));
CREATE TABLE IF NOT EXISTS acs_users(userId TEXT PRIMARY KEY REFERENCES users(id),communicationUserId TEXT NOT NULL);
`);
  const one = (sql,...args) => db.prepare(sql).get(...args);
  const all = (sql,...args) => db.prepare(sql).all(...args);
  const run = (sql,...args) => db.prepare(sql).run(...args);
  const transaction = fn => { db.exec('BEGIN IMMEDIATE'); try { const result=fn(); db.exec('COMMIT'); return result; } catch(e) { db.exec('ROLLBACK'); throw e; } };
  const clients = new Map(), buckets = new Map();
  const publicUser = u => ({id:u.id,name:u.name,email:u.email,color:u.color,status:u.status});
  const origin = () => config.origin || `http://localhost:${server.address()?.port || 4173}`;
  const cookie = (token,expire=false) => `veyra_session=${token}; Path=/; HttpOnly; SameSite=Strict; Max-Age=${expire?0:SESSION_MS/1000}${origin().startsWith('https:')?'; Secure':''}`;
  function rate(key,limit,period=60000) {
    let b=buckets.get(key); const now=Date.now();
    if (!b || b.until<now) { b={count:0,until:now+period}; buckets.set(key,b); }
    if (++b.count>limit) throw error('Too many requests. Try again later.',429);
    if (buckets.size>20000) for (const [k,v] of buckets) if(v.until<now) buckets.delete(k);
  }
  function getSession(req) {
    const entry=req.headers.cookie?.split(';').map(v=>v.trim()).find(v=>v.startsWith('veyra_session='));
    const token=entry?.slice('veyra_session='.length);
    if (!token || !/^[\w-]{40,100}$/.test(token)) return null;
    const s=one('SELECT * FROM sessions WHERE hash=? AND expires>?',hash(token),Date.now());
    return s ? {...s,user:one('SELECT * FROM users WHERE id=?',s.userId)} : null;
  }
  function requireMember(roomId,userId) {
    identifier(roomId,'Conversation');
    if (!one('SELECT 1 FROM members WHERE roomId=? AND userId=?',roomId,userId)) throw error('You are not a member of this conversation.',403);
  }
  const members = roomId => all('SELECT userId FROM members WHERE roomId=?',roomId).map(r=>r.userId);
  const roomDTO = (r,userId) => ({...r,members:members(r.id),color:'#e7dff7',unread:0,...JSON.parse(one('SELECT body FROM preferences WHERE userId=? AND roomId=?',userId,r.id)?.body || '{}')});
  function messageDTO(m) {
    if (!m) return null;
    const {fingerprint,...rest}=m;
    return {...rest,deleted:!!m.deleted,authorName:one('SELECT name FROM users WHERE id=?',m.authorId)?.name || 'Participant',attachments:JSON.parse(m.attachments),reactions:JSON.parse(m.reactions)};
  }
  const userRooms = userId => all('SELECT r.* FROM rooms r JOIN members m ON r.id=m.roomId WHERE m.userId=? ORDER BY r.createdAt',userId).map(r=>roomDTO(r,userId));
  const userEvents = userId => all('SELECT e.body FROM events e WHERE e.creatorId=? OR EXISTS(SELECT 1 FROM members m WHERE m.roomId=e.roomId AND m.userId=?)',userId,userId).map(e=>JSON.parse(e.body));
  function writeEvent(client,event) {
    if (client.res.writableLength>1024*1024) { client.res.destroy(); return; }
    client.res.write(`data: ${JSON.stringify(event)}\n\n`);
  }
  function broadcast(event,{roomId=null,userId=null,exclude=null}={}) {
    const allowed=roomId ? new Set(members(roomId)) : null;
    for (const [id,c] of clients) if(id!==exclude && (!userId || c.user.id===userId) && (!allowed || allowed.has(c.user.id))) writeEvent(c,event);
  }
  function disconnect(peerId) {
    const client=clients.get(peerId); if(!client) return;
    clients.delete(peerId);
    if(client.callRoom) broadcast({type:'call-leave',roomId:client.callRoom,peerId,userId:client.user.id},{roomId:client.callRoom});
    broadcast({type:'presence',userId:client.user.id,online:[...clients.values()].some(c=>c.user.id===client.user.id)});
  }
  async function body(req,limit=128*1024,raw=false) {
    if (Number(req.headers['content-length']||0)>limit) { req.resume(); throw error('Request is too large.',413); }
    const chunks=[]; let size=0;
    for await(const chunk of req) { size+=chunk.length; if(size>limit) throw error('Request is too large.',413); chunks.push(chunk); }
    const buffer=Buffer.concat(chunks);
    if(raw) return buffer;
    let value; try {value=JSON.parse(buffer.toString() || '{}');}catch{throw error('Invalid JSON.');}
    if(!value || typeof value!=='object' || Array.isArray(value)) throw error('A JSON object is required.');
    return value;
  }
  function json(res,status,data,headers={}) {
    res.writeHead(status,{'Content-Type':'application/json; charset=utf-8','Cache-Control':'no-store',...headers});
    res.end(status===204?'':JSON.stringify(data));
  }
  async function api(req,res,url) {
    const route=url.pathname.slice(4),method=req.method;
    if (!['GET','HEAD','OPTIONS'].includes(method)) {
      if (req.headers.origin!==origin()) throw error('Request origin is not allowed. Set PUBLIC_ORIGIN to the exact browser origin.',403);
      rate(`write:${req.socket.remoteAddress}`,360);
    }
    if(route==='/health'&&method==='GET') return json(res,200,{ok:true,service:'veyra',version:'1.0.0'});
    if(route==='/config'&&method==='GET') return json(res,200,{server:true,registrationEnabled:config.allowRegistration,clientId:config.clientId,tenantId:config.tenantId,acsEnabled:!!process.env.ACS_CONNECTION_STRING});
    if(['/auth/register','/auth/login'].includes(route)&&method==='POST') {
      rate(`auth:${req.socket.remoteAddress}`,30,15*60000);
      const input=await body(req),email=validText(input.email,'Email',254).toLowerCase();
      if(!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) throw error('Enter a valid email address.');
      if(typeof input.password!=='string'||input.password.length<12||input.password.length>256) throw error('Password must contain 12–256 characters.');
      let user=one('SELECT * FROM users WHERE email=?',email);
      if(route==='/auth/register') {
        if(!config.allowRegistration) throw error('Registration is disabled by the administrator.',403);
        const name=validText(input.name,'Name',80);
        if(user) throw error('Unable to register this email. Try signing in.',409);
        const salt=randomBytes(16).toString('hex'), derived=Buffer.from(await scrypt(input.password,salt,64)).toString('hex');
        user={id:uid(),name,email,password:`${salt}:${derived}`,color:'#dce8e0',status:'available',createdAt:new Date().toISOString()};
        transaction(()=>{
          if(one('SELECT 1 FROM users WHERE email=?',email)) throw error('Unable to register this email. Try signing in.',409);
          run('INSERT INTO users VALUES(?,?,?,?,?,?,?)',user.id,user.name,user.email,user.password,user.color,user.status,user.createdAt);
          if(!one("SELECT 1 FROM rooms WHERE id='general'")) run('INSERT INTO rooms VALUES(?,?,?,?,?,?)','general','General','channel','The shared space for this Veyra installation.',user.id,user.createdAt);
          run('INSERT INTO members VALUES(?,?)','general',user.id);
        });
        broadcast({type:'directory'});
      } else {
        const [salt,expected]=user?.password.split(':') || ['dummysalt','00'.repeat(64)];
        const actual=Buffer.from(await scrypt(input.password,salt,64));
        if(!timingSafeEqual(actual,Buffer.from(expected,'hex'))||!user) throw error('Email or password is incorrect.',401);
      }
      const token=randomBytes(32).toString('base64url');
      run('INSERT INTO sessions VALUES(?,?,?)',hash(token),user.id,Date.now()+SESSION_MS);
      return json(res,200,{me:publicUser(user)},{'Set-Cookie':cookie(token)});
    }
    const auth=getSession(req); if(!auth?.user) throw error('Sign in to the live workspace.',401);
    const user=auth.user; rate(`user:${user.id}`,600);
    if(route==='/auth/logout'&&method==='POST') {
      run('DELETE FROM sessions WHERE hash=?',auth.hash);
      for(const [id,c] of clients) if(c.sessionHash===auth.hash) {c.res.end();disconnect(id);}
      return json(res,200,{ok:true},{'Set-Cookie':cookie('',true)});
    }
    if(route==='/bootstrap'&&method==='GET') return json(res,200,{me:publicUser(user),rooms:userRooms(user.id),users:all('SELECT * FROM users ORDER BY name').map(publicUser),events:userEvents(user.id)});
    if(route==='/ice'&&method==='GET') {
      const iceServers=process.env.ICE_SERVERS_JSON ? JSON.parse(process.env.ICE_SERVERS_JSON) : [];
      if(process.env.TURN_SECRET&&process.env.TURN_URLS) {
        const username=`${Math.floor(Date.now()/1000)+3600}:${user.id}`;
        iceServers.push({urls:process.env.TURN_URLS.split(','),username,credential:createHmac('sha1',process.env.TURN_SECRET).update(username).digest('base64')});
      }
      return json(res,200,{iceServers});
    }
    if(route==='/stream'&&method==='GET') {
      const peerId=url.searchParams.get('peerId');
      if(!/^[\w-]{20,80}$/.test(peerId||'')) throw error('Invalid connection identifier.');
      if(clients.has(peerId)) throw error('This connection identifier is already in use.',409);
      if([...clients.values()].filter(c=>c.user.id===user.id).length>=8) throw error('Too many open connections.',429);
      res.writeHead(200,{'Content-Type':'text/event-stream','Cache-Control':'no-cache, no-transform','Connection':'keep-alive','X-Accel-Buffering':'no'});
      res.write('retry: 1500\n\n');
      const client={res,user,sessionHash:auth.hash,callRoom:null}; clients.set(peerId,client);
      writeEvent(client,{type:'ready',peerId,online:[...new Set([...clients.values()].map(c=>c.user.id))]});
      broadcast({type:'presence',userId:user.id,online:true});
      res.on('close',()=>disconnect(peerId)); return;
    }
    if(route==='/profile'&&method==='PATCH') {
      const input=await body(req),name=input.name===undefined?user.name:validText(input.name,'Name',80),status=input.status||user.status;
      if(!['available','busy','away','offline'].includes(status)) throw error('Invalid status.');
      run('UPDATE users SET name=?,status=? WHERE id=?',name,status,user.id);
      const updated=publicUser(one('SELECT * FROM users WHERE id=?',user.id)); broadcast({type:'profile',user:updated});
      return json(res,200,updated);
    }
    if(route==='/rooms'&&method==='POST') {
      const input=await body(req),name=validText(input.name,'Conversation name',100),type=input.type||'group';
      if(!['direct','group','channel'].includes(type)) throw error('Invalid conversation type.');
      if(!Array.isArray(input.members||[])||(input.members?.length||0)>200) throw error('Invalid conversation members.');
      const ids=[...new Set([user.id,...(input.members||[])])];
      for(const id of ids) if(typeof id!=='string'||!one('SELECT 1 FROM users WHERE id=?',id)) throw error('One or more members do not exist.');
      if(type==='direct'&&ids.length!==2) throw error('A direct chat needs exactly two members.');
      const id=uid();transaction(()=>{run('INSERT INTO rooms VALUES(?,?,?,?,?,?)',id,name,type,'',user.id,new Date().toISOString());for(const memberId of ids)run('INSERT INTO members VALUES(?,?)',id,memberId);});
      const room=roomDTO(one('SELECT * FROM rooms WHERE id=?',id),user.id);broadcast({type:'room',room},{roomId:id});return json(res,201,room);
    }
    let match=route.match(/^\/rooms\/([^/]+)$/);
    if(match&&method==='PATCH') {
      const id=decodeURIComponent(match[1]);requireMember(id,user.id);const input=await body(req);
      const pref=JSON.parse(one('SELECT body FROM preferences WHERE userId=? AND roomId=?',user.id,id)?.body||'{}');
      if(typeof input.favorite==='boolean') pref.favorite=input.favorite;
      run('INSERT INTO preferences VALUES(?,?,?) ON CONFLICT(userId,roomId) DO UPDATE SET body=excluded.body',user.id,id,JSON.stringify(pref));
      return json(res,200,roomDTO(one('SELECT * FROM rooms WHERE id=?',id),user.id));
    }
    match=route.match(/^\/rooms\/([^/]+)\/messages$/);
    if(match&&method==='GET') {
      const id=decodeURIComponent(match[1]);requireMember(id,user.id);
      // Bounded first-load window; full authorized history is available through export.
      return json(res,200,all('SELECT * FROM (SELECT * FROM messages WHERE roomId=? ORDER BY createdAt DESC,id DESC LIMIT 2000) ORDER BY createdAt,id',id).map(messageDTO));
    }
    if(route==='/messages'&&method==='POST') {
      const input=validateMessage(await body(req));requireMember(input.roomId,user.id);
      const fingerprint=hash(messageFingerprint(input));
      const existing=one('SELECT * FROM messages WHERE id=?',input.id);
      if(existing) {
        if(existing.authorId!==user.id||existing.fingerprint!==fingerprint) throw error('This identifier belongs to a different send operation.',409);
        return json(res,200,messageDTO(existing));
      }
      if(input.replyTo&&!one('SELECT 1 FROM messages WHERE id=? AND roomId=?',input.replyTo,input.roomId)) throw error('The replied-to message is not in this conversation.');
      const files=input.attachments.map(f=>{
        const record=one('SELECT * FROM files WHERE id=? AND roomId=? AND ownerId=?',f.id,input.roomId,user.id);
        if(!record) throw error('An attachment is missing or is not owned by you.');
        return {id:record.id,roomId:record.roomId,name:record.name,type:record.type,size:record.size,createdAt:record.createdAt};
      });
      run('INSERT INTO messages(id,roomId,authorId,content,createdAt,replyTo,attachments,fingerprint) VALUES(?,?,?,?,?,?,?,?)',input.id,input.roomId,user.id,input.content,new Date().toISOString(),input.replyTo,JSON.stringify(files),fingerprint);
      const message=messageDTO(one('SELECT * FROM messages WHERE id=?',input.id));broadcast({type:'message',message},{roomId:input.roomId});return json(res,201,message);
    }
    match=route.match(/^\/messages\/([^/]+)(\/reactions)?$/);
    if(match) {
      const id=decodeURIComponent(match[1]);identifier(id);const current=one('SELECT * FROM messages WHERE id=?',id);
      if(!current) throw error('Message not found.',404); requireMember(current.roomId,user.id);
      if(match[2]&&method==='POST') {
        const input=await body(req);
        // Read-modify-write after body parsing; no await within the atomic mutation.
        transaction(()=>{const latest=messageDTO(one('SELECT * FROM messages WHERE id=?',id));const updated=toggleReaction(latest,input.emoji,user.id);run('UPDATE messages SET reactions=? WHERE id=?',JSON.stringify(updated.reactions),id);});
      } else if(!match[2]&&(method==='PATCH'||method==='DELETE')) {
        if(current.authorId!==user.id) throw error('Only the author can change this message.',403);
        if(method==='DELETE') run("UPDATE messages SET content='',deleted=1,attachments='[]',reactions='[]' WHERE id=?",id);
        else {
          const input=await body(req),content=validText(input.content,'Message');
          const result=run('UPDATE messages SET content=?,editedAt=? WHERE id=? AND deleted=0',content,new Date().toISOString(),id);
          if(!result.changes) throw error('This message was deleted.',409);
        }
      } else throw error('Method not allowed.',405);
      const message=messageDTO(one('SELECT * FROM messages WHERE id=?',id));broadcast({type:'message',message},{roomId:current.roomId});return json(res,200,message);
    }
    if(route==='/files'&&method==='POST') {
      const roomId=url.searchParams.get('roomId');requireMember(roomId,user.id);
      let filename;try{filename=decodeURIComponent(String(req.headers['x-file-name']||'file'));}catch{throw error('Invalid filename encoding.');}
      filename=validText(filename,'Filename',240).replace(/[\r\n\u0000/\\]/g,'_');
      const type=String(req.headers['x-file-type']||'application/octet-stream').slice(0,128);
      const bytes=await body(req,MAX_FILE_SIZE,true),id=uid(),createdAt=new Date().toISOString(),target=path.join(config.dataDir,'uploads',id);
      await writeFile(target,bytes,{flag:'wx',mode:0o600});
      try{run('INSERT INTO files VALUES(?,?,?,?,?,?,?)',id,roomId,user.id,filename,type,bytes.length,createdAt);}catch(e){await unlink(target).catch(()=>{});throw e;}
      return json(res,201,{id,roomId,name:filename,type,size:bytes.length,createdAt,authorName:user.name});
    }
    if(route==='/files'&&method==='GET') {
      const roomId=url.searchParams.get('roomId');if(roomId)requireMember(roomId,user.id);
      return json(res,200,all('SELECT f.*,u.name AS authorName FROM files f JOIN members m ON m.roomId=f.roomId JOIN users u ON u.id=f.ownerId WHERE m.userId=? AND (? IS NULL OR f.roomId=?) ORDER BY f.createdAt DESC',user.id,roomId,roomId));
    }
    match=route.match(/^\/files\/([\w-]+)$/);
    if(match&&method==='GET') {
      const file=one('SELECT * FROM files WHERE id=?',match[1]);if(!file)throw error('File not found.',404);requireMember(file.roomId,user.id);
      const bytes=await readFile(path.join(config.dataDir,'uploads',file.id));
      res.writeHead(200,{'Content-Type':'application/octet-stream','Content-Length':bytes.length,'Content-Disposition':`attachment; filename="download"; filename*=UTF-8''${encodeURIComponent(file.name).replace(/'/g,'%27')}`,'Cache-Control':'private, no-store','Content-Security-Policy':"default-src 'none'; sandbox"});return res.end(bytes);
    }
    match=route.match(/^\/rooms\/([^/]+)\/docs\/(notes|board)$/);
    if(match) {
      const roomId=decodeURIComponent(match[1]),kind=match[2],id=`${roomId}:${kind}`;requireMember(roomId,user.id);
      if(method==='GET') {const saved=one('SELECT * FROM docs WHERE id=?',id);return json(res,200,saved?{...JSON.parse(saved.body),id,version:saved.version}:{id,text:'',shapes:[],version:0});}
      if(method==='PUT') {
        const input=await body(req,2*1024*1024),value=validateDocument(kind,input);
        const version=transaction(()=>{
          // CAS MUST read after awaiting the body, inside the same transaction as its write.
          const existing=one('SELECT version FROM docs WHERE id=?',id);
          if(input.version!==(existing?.version||0)) throw error('The shared document changed. Export your draft before reloading.',409);
          const next=input.version+1;
          run('INSERT INTO docs VALUES(?,?,?,?,?) ON CONFLICT(id) DO UPDATE SET body=excluded.body,version=excluded.version',id,roomId,kind,JSON.stringify(value),next);
          return next;
        });
        broadcast({type:'doc',roomId,kind,version},{roomId});return json(res,200,{...value,id,version});
      }
      throw error('Method not allowed.',405);
    }
    if(route==='/events'&&method==='POST') {
      const event=normalizeEvent(await body(req));if(event.roomId)requireMember(event.roomId,user.id);
      const existing=one('SELECT creatorId FROM events WHERE id=?',event.id);if(existing&&existing.creatorId!==user.id)throw error('Only the organizer can change this meeting.',403);
      const saved={...event,creatorId:user.id};run('INSERT INTO events VALUES(?,?,?,?) ON CONFLICT(id) DO UPDATE SET roomId=excluded.roomId,body=excluded.body',event.id,event.roomId,user.id,JSON.stringify(saved));
      broadcast({type:'event',event:saved},event.roomId?{roomId:event.roomId}:{userId:user.id});return json(res,200,saved);
    }
    match=route.match(/^\/events\/([^/]+)$/);
    if(match&&method==='DELETE') {
      const id=decodeURIComponent(match[1]),event=one('SELECT * FROM events WHERE id=?',id);if(!event)throw error('Meeting not found.',404);if(event.creatorId!==user.id)throw error('Only the organizer can delete this meeting.',403);
      run('DELETE FROM events WHERE id=?',id);broadcast({type:'event-deleted',id},event.roomId?{roomId:event.roomId}:{userId:user.id});return json(res,204,null);
    }
    if(route==='/signal'&&method==='POST') {
      const input=await body(req,96*1024);requireMember(input.roomId,user.id);
      const client=clients.get(input.peerId);
      if(!client||client.user.id!==user.id||client.sessionHash!==auth.hash)throw error('The live connection is not ready. Reconnect and try again.',409);
      const payload={type:input.type,roomId:input.roomId,peerId:input.peerId,userId:user.id,name:user.name};
      if(input.type==='typing') {broadcast(payload,{roomId:input.roomId,exclude:input.peerId});return json(res,200,{ok:true});}
      if(input.type==='call-join') {
        if(client.callRoom&&client.callRoom!==input.roomId)throw error('Leave the current call first.',409);
        const peers=[...clients].filter(([id,c])=>id!==input.peerId&&c.callRoom===input.roomId).map(([peerId,c])=>({peerId,userId:c.user.id,name:c.user.name,...callState(c.callState)}));
        if(peers.length>=MAX_CALL_PEERS)throw error(`This mesh build supports at most ${MAX_CALL_PEERS} participants.`,409);
        client.callRoom=input.roomId;client.callState=callState(input);Object.assign(payload,client.callState);broadcast(payload,{roomId:input.roomId,exclude:input.peerId});return json(res,200,{peers});
      }
      if(client.callRoom!==input.roomId)throw error('Join the call before sending call signals.',403);
      if(input.type==='call-leave') {client.callRoom=null;client.callState=null;broadcast(payload,{roomId:input.roomId,exclude:input.peerId});return json(res,200,{ok:true});}
      if(input.type==='call-presence'||input.type==='call-state') {
        client.callState=callState({...client.callState,...input});Object.assign(payload,client.callState);
        broadcast(payload,{roomId:input.roomId,exclude:input.peerId});return json(res,200,{ok:true});
      }
      if(input.type!=='rtc')throw error('Unknown signaling message.');
      const target=clients.get(input.target);if(!target||target.callRoom!==input.roomId)throw error('The participant left the call.',404);
      if(input.description&&(!['offer','answer'].includes(input.description.type)||typeof input.description.sdp!=='string'||input.description.sdp.length>70000))throw error('Invalid session description.');
      if(input.candidate&&(typeof input.candidate.candidate!=='string'||input.candidate.candidate.length>4000))throw error('Invalid ICE candidate.');
      if(!input.description&&!input.candidate)throw error('A description or ICE candidate is required.');
      Object.assign(payload,{target:input.target,description:input.description,candidate:input.candidate});writeEvent(target,payload);return json(res,200,{ok:true});
    }
    if(route==='/acs/token'&&method==='POST') {
      rate(`acs:${user.id}`,6);
      if(!process.env.ACS_CONNECTION_STRING)throw error('Configure ACS_CONNECTION_STRING on the server to enable Teams meetings.',503);
      let sdk;try{sdk=await import('@azure/communication-identity');}catch{throw error('Install the optional @azure/communication-identity dependency.',503);}
      const identity=new sdk.CommunicationIdentityClient(process.env.ACS_CONNECTION_STRING);
      let mapping=one('SELECT * FROM acs_users WHERE userId=?',user.id);
      if(!mapping){const created=await identity.createUser();run('INSERT OR IGNORE INTO acs_users VALUES(?,?)',user.id,created.communicationUserId);mapping=one('SELECT * FROM acs_users WHERE userId=?',user.id);if(mapping.communicationUserId!==created.communicationUserId)await identity.deleteUser(created);}
      const token=await identity.getToken({communicationUserId:mapping.communicationUserId},['voip']);
      return json(res,200,{token:token.token,expiresOn:token.expiresOn});
    }
    if(route==='/export'&&method==='GET') {
      const messages=all('SELECT a.* FROM messages a JOIN members m ON a.roomId=m.roomId WHERE m.userId=? ORDER BY a.createdAt',user.id).map(messageDTO);
      const docs=all('SELECT d.* FROM docs d JOIN members m ON d.roomId=m.roomId WHERE m.userId=?',user.id).map(d=>({id:d.id,version:d.version,...JSON.parse(d.body)}));
      const files=all('SELECT f.* FROM files f JOIN members m ON f.roomId=m.roomId WHERE m.userId=?',user.id);
      return json(res,200,{schemaVersion:1,exportedAt:new Date().toISOString(),rooms:userRooms(user.id),messages,docs,events:userEvents(user.id),users:all('SELECT * FROM users').map(publicUser),files});
    }
    throw error('API route not found.',404);
  }
  const server=http.createServer(async(req,res)=>{
    res.setHeader('X-Content-Type-Options','nosniff');res.setHeader('Referrer-Policy','strict-origin-when-cross-origin');
    res.setHeader('Permissions-Policy','camera=(self), microphone=(self), display-capture=(self)');
    res.setHeader('Content-Security-Policy',"default-src 'self'; script-src 'self' https://esm.sh; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob: https:; connect-src 'self' https: wss:; media-src 'self' blob:; worker-src 'self' blob:; frame-src https://login.microsoftonline.com; object-src 'none'; base-uri 'self'; form-action 'self'; frame-ancestors 'self'");
    if(origin().startsWith('https:'))res.setHeader('Strict-Transport-Security','max-age=31536000');
    try {
      const url=new URL(req.url,origin());
      if(url.pathname.startsWith('/api/'))return await api(req,res,url);
      if(!['GET','HEAD'].includes(req.method))throw error('Method not allowed.',405);
      let relative;try{relative=decodeURIComponent(url.pathname).replace(/^\/+/, '')||'index.html';}catch{throw error('Invalid path.');}
      if(relative.split('/').some(p=>p.startsWith('.')))throw error('Not found.',404);
      const filename=path.resolve(ROOT,'public',relative),publicRoot=path.join(ROOT,'public')+path.sep;
      if(!filename.startsWith(publicRoot))throw error('Not found.',404);
      const info=await stat(filename);if(!info.isFile())throw error('Not found.',404);
      res.writeHead(200,{'Content-Type':mime[path.extname(filename)]||'application/octet-stream','Content-Length':info.size,'Cache-Control':'no-cache'});
      res.end(req.method==='HEAD'?undefined:await readFile(filename));
    } catch(e) {
      if(res.headersSent){res.end();return;}
      const status=e.status||(e.code==='ENOENT'?404:500);
      if(status===500)console.error('Veyra request failure:',e.code||e.name);
      json(res,status,{error:e.status?e.message:status===404?'Not found.':'An internal server error occurred.'});
    }
  });
  server.requestTimeout=30000;server.headersTimeout=10000;server.keepAliveTimeout=65000;
  const maintenance=setInterval(()=>{
    const now=Date.now();run('DELETE FROM sessions WHERE expires<?',now);
    for(const [key,b]of buckets)if(b.until<now)buckets.delete(key);
    for(const [id,c]of clients){if(!one('SELECT 1 FROM sessions WHERE hash=? AND expires>?',c.sessionHash,now)){c.res.end();disconnect(id);}else c.res.write(': heartbeat\n\n');}
  },15000);maintenance.unref();
  let closed=false;
  async function close(){if(closed)return;closed=true;clearInterval(maintenance);for(const c of clients.values())c.res.end();server.closeIdleConnections();await new Promise(resolve=>server.close(resolve));db.close();}
  return {server,close,get origin(){return origin();}};
}

if(process.argv[1]&&path.resolve(process.argv[1])===fileURLToPath(import.meta.url)) {
  const app=await createWorkspaceServer();
  app.server.listen(Number(process.env.PORT||4173),process.env.HOST||'0.0.0.0',()=>console.log(`Veyra Workspace: ${app.origin}\nNode/SQLite service ready. Registration: ${process.env.ALLOW_REGISTRATION==='false'?'disabled':'enabled; General is installation-wide'}`));
  for(const signal of ['SIGINT','SIGTERM'])process.on(signal,()=>{app.close().then(()=>process.exit(0));setTimeout(()=>process.exit(0),3000).unref();});
}
