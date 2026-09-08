import {uid,clone,escapeHTML} from './model.js';
import {SceneRenderer} from './renderer.js';
function distanceToSegment(p,a,b){const dx=b[0]-a[0],dy=b[1]-a[1],t=Math.max(0,Math.min(1,((p[0]-a[0])*dx+(p[1]-a[1])*dy)/(dx*dx+dy*dy||1)));return Math.hypot(p[0]-a[0]-t*dx,p[1]-a[1]-t*dy);}
export class Whiteboard {
  constructor(stage,{shapes=[],onChange=()=>{},onMode=()=>{}}={}){
    this.stage=stage;this.shapes=clone(shapes);this.onChange=onChange;this.view={x:0,y:0,zoom:1};this.tool='select';this.color='#7162b8';this.history=[];this.future=[];this.selected=null;this.abort=new AbortController();
    stage.innerHTML='<canvas class="board-canvas" aria-label="Whiteboard geometry"></canvas><div class="board-text" aria-hidden="true"></div>';
    this.labels=stage.querySelector('.board-text');this.renderer=new SceneRenderer(stage.querySelector('canvas'),onMode);this.renderer.init();
    const options={signal:this.abort.signal};
    stage.addEventListener('pointerdown',e=>this.down(e),options);stage.addEventListener('pointermove',e=>this.move(e),options);stage.addEventListener('pointerup',()=>this.up(),options);stage.addEventListener('pointercancel',()=>this.cancel(),options);
    stage.addEventListener('dblclick',e=>{const s=this.hit(this.point(e));if(s?.type==='note'){const text=prompt('Edit sticky note',s.text||'');if(text!==null){this.remember();s.text=text.slice(0,1000);this.commit();}}},options);
    stage.addEventListener('wheel',e=>{e.preventDefault();const r=stage.getBoundingClientRect();if(e.ctrlKey||e.metaKey)this.zoom(Math.exp(-e.deltaY*.008),e.clientX-r.left,e.clientY-r.top);else{this.view.x-=e.deltaX;this.view.y-=e.deltaY;this.draw(false);}},{...options,passive:false});
    stage.addEventListener('keydown',e=>{if(e.key==='Delete'||e.key==='Backspace'){e.preventDefault();this.deleteSelected();}if((e.ctrlKey||e.metaKey)&&e.key.toLowerCase()==='z'){e.preventDefault();e.shiftKey?this.redo():this.undo();}if(e.key==='Escape'){this.cancel();this.selected=null;this.setTool('select');this.draw();}},options);
    this.observer=new ResizeObserver(()=>{this.renderer.resize();this.draw(false);});this.observer.observe(stage);this.draw();
  }
  point(e){const r=this.stage.getBoundingClientRect();return[(e.clientX-r.left-this.view.x)/this.view.zoom,(e.clientY-r.top-this.view.y)/this.view.zoom];}
  hit(p){return [...this.shapes].reverse().find(s=>{
    const x=Math.min(s.x,s.x+s.w),y=Math.min(s.y,s.y+s.h),w=Math.abs(s.w),h=Math.abs(s.h),gap=8/this.view.zoom;
    if(p[0]<x-gap||p[0]>x+w+gap||p[1]<y-gap||p[1]>y+h+gap)return false;
    if(s.type==='pen'||s.type==='arrow'){const points=s.points||[];return points.some((b,i)=>i&&distanceToSegment(p,points[i-1],b)<gap);}
    if(s.type==='ellipse')return ((p[0]-x-w/2)/(w/2+gap))**2+((p[1]-y-h/2)/(h/2+gap))**2<=1;
    return true;
  });}
  setTool(tool){this.tool=tool;this.stage.dataset.tool=tool;}
  down(e){
    if(e.button!==0&&e.button!==1)return;e.preventDefault();this.stage.focus();this.stage.setPointerCapture(e.pointerId);
    this.start=this.point(e);this.startScreen=[e.clientX,e.clientY];this.startView={...this.view};this.before=clone(this.shapes);
    if(e.button===1||this.tool==='pan'){this.dragging='pan';return;}
    const selected=this.shapes.find(s=>s.id===this.selected);
    if(this.tool==='select'&&selected&&Math.hypot(this.start[0]-(selected.x+selected.w),this.start[1]-(selected.y+selected.h))<10/this.view.zoom){this.dragging='resize';return;}
    if(this.tool==='select'){const shape=this.hit(this.start);this.selected=shape?.id||null;this.dragging=shape?'move':null;this.draw();return;}
    if(this.shapes.length>=3000){this.start=null;return;}
    const s={id:uid(),type:this.tool,x:this.start[0],y:this.start[1],w:0,h:0,color:this.tool==='note'?'#fff0b8':this.color};
    if(s.type==='note'){s.w=200;s.h=165;s.text='Your next big idea…';}
    if(s.type==='pen'||s.type==='arrow')s.points=[this.start,this.start];
    this.shapes.push(s);this.selected=s.id;this.dragging='draw';this.draw();
  }
  move(e){
    if(!this.start)return;
    if(this.dragging==='pan'){this.view.x=this.startView.x+e.clientX-this.startScreen[0];this.view.y=this.startView.y+e.clientY-this.startScreen[1];this.draw(false);return;}
    const p=this.point(e),dx=p[0]-this.start[0],dy=p[1]-this.start[1],s=this.shapes.find(s=>s.id===this.selected);if(!s)return;
    if(this.dragging==='move'){const old=this.before.find(o=>o.id===s.id);s.x=old.x+dx;s.y=old.y+dy;if(old.points)s.points=old.points.map(([x,y])=>[x+dx,y+dy]);}
    else if(this.dragging==='resize'){const old=this.before.find(o=>o.id===s.id);s.w=Math.max(30,old.w+dx);s.h=Math.max(30,old.h+dy);if(old.points)s.points=old.points.map(([x,y])=>[old.x+(x-old.x)*s.w/(old.w||1),old.y+(y-old.y)*s.h/(old.h||1)]);}
    else if(this.dragging==='draw'){
      if(s.type==='note')return;
      if(s.type==='pen'){const last=s.points.at(-1);if(Math.hypot(p[0]-last[0],p[1]-last[1])<1.5/this.view.zoom||s.points.length>=10000)return;s.points.push(p);let minX=Infinity,minY=Infinity,maxX=-Infinity,maxY=-Infinity;for(const [x,y]of s.points){minX=Math.min(minX,x);minY=Math.min(minY,y);maxX=Math.max(maxX,x);maxY=Math.max(maxY,y);}s.x=minX;s.y=minY;s.w=maxX-minX;s.h=maxY-minY;}
      else{s.w=dx;s.h=dy;if(s.type==='arrow')s.points=[this.start,p];}
    }
    this.draw();
  }
  up(){if(!this.start)return;if(this.dragging&&this.dragging!=='pan'&&JSON.stringify(this.before)!==JSON.stringify(this.shapes)){this.history.push(this.before);this.history=this.history.slice(-60);this.future=[];this.onChange(clone(this.shapes));}this.start=null;this.dragging=null;this.draw();}
  cancel(){if(this.start&&this.before)this.shapes=this.before;this.start=null;this.dragging=null;this.draw();}
  remember(){this.history.push(clone(this.shapes));this.history=this.history.slice(-60);this.future=[];}
  commit(){this.draw();this.onChange(clone(this.shapes));}
  undo(){if(!this.history.length)return;this.future.push(clone(this.shapes));this.shapes=this.history.pop();this.selected=null;this.commit();}
  redo(){if(!this.future.length)return;this.history.push(clone(this.shapes));this.shapes=this.future.pop();this.selected=null;this.commit();}
  deleteSelected(){if(!this.selected)return;this.remember();this.shapes=this.shapes.filter(s=>s.id!==this.selected);this.selected=null;this.commit();}
  zoom(factor,x=this.stage.clientWidth/2,y=this.stage.clientHeight/2){const before=this.view.zoom,next=Math.max(.15,Math.min(5,before*factor));this.view.x=x-(x-this.view.x)/before*next;this.view.y=y-(y-this.view.y)/before*next;this.view.zoom=next;this.draw();}
  fit(){
    if(!this.shapes.length){this.view={x:0,y:0,zoom:1};this.draw();return;}
    const l=Math.min(...this.shapes.map(s=>Math.min(s.x,s.x+s.w))),t=Math.min(...this.shapes.map(s=>Math.min(s.y,s.y+s.h))),r=Math.max(...this.shapes.map(s=>Math.max(s.x,s.x+s.w))),b=Math.max(...this.shapes.map(s=>Math.max(s.y,s.y+s.h)));
    const z=Math.max(.15,Math.min(1.4,(this.stage.clientWidth-100)/Math.max(1,r-l),(this.stage.clientHeight-100)/Math.max(1,b-t)));
    this.view={zoom:z,x:(this.stage.clientWidth-(r-l)*z)/2-l*z,y:(this.stage.clientHeight-(b-t)*z)/2-t*z};this.draw();
  }
  draw(sceneChanged=true){
    if(!this.renderer)return;this.renderer.setView(this.view);if(sceneChanged)this.renderer.setScene(this.shapes,this.selected);
    const {x,y,zoom}=this.view;this.stage.style.backgroundPosition=`${x}px ${y}px`;this.stage.style.backgroundSize=`${24*zoom}px ${24*zoom}px`;
    this.labels.innerHTML=this.shapes.filter(s=>s.type==='note').map(s=>`<div class="sticky-text" style="left:${s.x*zoom+x}px;top:${s.y*zoom+y}px;width:${Math.abs(s.w)}px;height:${Math.abs(s.h)}px;transform:scale(${zoom})">${escapeHTML(s.text)}</div>`).join('');
    const label=this.stage.parentElement?.querySelector('[data-board-zoom]');if(label)label.textContent=`${Math.round(zoom*100)}%`;
  }
  toSVG(){
    const l=Math.min(0,...this.shapes.map(s=>Math.min(s.x,s.x+s.w)))-30,t=Math.min(0,...this.shapes.map(s=>Math.min(s.y,s.y+s.h)))-30,r=Math.max(800,...this.shapes.map(s=>Math.max(s.x,s.x+s.w)))+30,b=Math.max(600,...this.shapes.map(s=>Math.max(s.y,s.y+s.h)))+30;
    return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="${l} ${t} ${r-l} ${b-t}"><rect x="${l}" y="${t}" width="${r-l}" height="${b-t}" fill="#fbfafc"/>${this.shapes.map(s=>{
      const x=Math.min(s.x,s.x+s.w),y=Math.min(s.y,s.y+s.h),w=Math.abs(s.w),h=Math.abs(s.h);
      if(s.type==='note')return `<rect x="${x}" y="${y}" width="${w}" height="${h}" fill="${s.color}"/><text x="${x+16}" y="${y+30}" font-family="sans-serif" font-size="14" fill="#453c4c">${String(s.text||'').split('\n').map((text,i)=>`<tspan x="${x+16}" dy="${i?22:0}">${escapeHTML(text)}</tspan>`).join('')}</text>`;
      if(s.type==='rect')return `<rect x="${x}" y="${y}" width="${w}" height="${h}" fill="none" stroke="${s.color}" stroke-width="2"/>`;
      if(s.type==='ellipse')return `<ellipse cx="${x+w/2}" cy="${y+h/2}" rx="${w/2}" ry="${h/2}" fill="none" stroke="${s.color}" stroke-width="2"/>`;
      const points=s.points||[[s.x,s.y],[s.x+s.w,s.y+s.h]];let extra='';if(s.type==='arrow'&&points.length>1){const p=points.at(-1),q=points.at(-2),a=Math.atan2(p[1]-q[1],p[0]-q[0]);extra=`<polygon points="${p.join(',')} ${p[0]-14*Math.cos(a-.45)},${p[1]-14*Math.sin(a-.45)} ${p[0]-14*Math.cos(a+.45)},${p[1]-14*Math.sin(a+.45)}" fill="${s.color}"/>`;}
      return `<polyline points="${points.map(p=>p.join(',')).join(' ')}" fill="none" stroke="${s.color}" stroke-width="3" stroke-linecap="round"/>${extra}`;
    }).join('')}</svg>`;
  }
  dispose(){this.abort.abort();this.observer.disconnect();this.renderer.dispose();}
}
