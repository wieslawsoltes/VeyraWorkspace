/* Browser rendering fixture ONLY. Replaces storage infrastructure, not app/domain code.
   This is never copied into public/ or the production build. */
class Database {
  constructor(){this.tables=globalThis.__fixtureTables||(globalThis.__fixtureTables=new Map());this.db={close(){}};}
  async open(){return this;}
  table(name){if(!this.tables.has(name))this.tables.set(name,new Map());return this.tables.get(name);}
  async get(store,id){return structuredClone(this.table(store).get(id));}
  async all(store,roomId){return structuredClone([...this.table(store).values()].filter(record=>roomId===undefined||record.roomId===roomId));}
  async put(store,value){this.table(store).set(value.id,structuredClone(value));return structuredClone(value);}
  async remove(store,id){this.table(store).delete(id);}
  async change(store,id,fn){const value=fn(structuredClone(this.table(store).get(id)));if(value)this.table(store).set(id,structuredClone(value));return structuredClone(value);}
  transaction(names,mode,fn){return new Promise((resolve,reject)=>{
    let pending=0,returned=false,result,failed=false;
    const finish=()=>{if(returned&&!pending&&!failed){try{resolve(typeof result==='function'?result():result);}catch(e){reject(e);}}};
    const tx={abort:()=>{failed=true;reject(new Error('Fixture transaction aborted.'));},objectStore:name=>({
      get:id=>{const req={};pending++;queueMicrotask(()=>{try{req.result=structuredClone(this.table(name).get(id));req.onsuccess?.();}catch(e){failed=true;reject(e);}finally{pending--;finish();}});return req;},
      put:value=>{this.table(name).set(value.id,structuredClone(value));return{result:value.id};},
      delete:id=>this.table(name).delete(id)
    })};
    try{result=fn(tx);returned=true;finish();}catch(e){failed=true;reject(e);}
  });}
}
