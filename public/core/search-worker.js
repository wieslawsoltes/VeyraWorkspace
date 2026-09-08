/** Only authorized, loaded message text enters this worker; tokens never do. */
const records=new Map();
const normalize=value=>String(value||'').normalize('NFKD').replace(/[\u0300-\u036f]/g,'').toLowerCase();
self.onmessage=({data})=>{
  if(data.type==='reset'){records.clear();return;}
  if(data.type==='index'){for(const m of data.messages||[])records.set(`${m.roomId}:${m.id}`,{message:m,text:normalize(`${m.authorName} ${m.content}`)});return;}
  if(data.type==='query'){
    const terms=normalize(data.query).trim().split(/\s+/).filter(Boolean),result=[];
    if(terms.length)for(const record of records.values())if(!record.message.deleted&&terms.every(t=>record.text.includes(t)))result.push(record.message);
    result.sort((a,b)=>b.createdAt.localeCompare(a.createdAt));self.postMessage({id:data.id,query:data.query,messages:result.slice(0,20),total:result.length});
  }
};
