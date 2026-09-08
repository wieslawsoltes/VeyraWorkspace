/** A retained, demand-driven triangle batch: no animation loop when the scene is idle. */
const WGSL = `
struct View { viewportPan: vec4f, scale: vec4f };
@group(0) @binding(0) var<uniform> view: View;
struct Out { @builtin(position) position: vec4f, @location(0) color: vec4f };
@vertex fn vs(@location(0) position: vec2f, @location(1) color: vec4f) -> Out {
  var output: Out;
  let p = (position * view.scale.x + view.viewportPan.zw) / view.viewportPan.xy;
  output.position = vec4f(p.x * 2.0 - 1.0, 1.0 - p.y * 2.0, 0.0, 1.0);
  output.color = color;
  return output;
}
@fragment fn fs(input: Out) -> @location(0) vec4f { return input.color; }
`;
const rgba=(hex,alpha=1)=>{const n=parseInt(hex.slice(1),16);return[(n>>16&255)/255,(n>>8&255)/255,(n&255)/255,alpha];};
function tri(out,a,b,c,color){for(const p of [a,b,c])out.push(p[0],p[1],...color);}
function rect(out,x,y,w,h,color){tri(out,[x,y],[x+w,y],[x,y+h],color);tri(out,[x+w,y],[x+w,y+h],[x,y+h],color);}
function disc(out,x,y,r,color,n=8){for(let i=0;i<n;i++){const a=i*2*Math.PI/n,b=(i+1)*2*Math.PI/n;tri(out,[x,y],[x+Math.cos(a)*r,y+Math.sin(a)*r],[x+Math.cos(b)*r,y+Math.sin(b)*r],color);}}
function line(out,a,b,width,color){const dx=b[0]-a[0],dy=b[1]-a[1],len=Math.hypot(dx,dy)||1,nx=-dy/len*width/2,ny=dx/len*width/2;tri(out,[a[0]+nx,a[1]+ny],[b[0]+nx,b[1]+ny],[a[0]-nx,a[1]-ny],color);tri(out,[b[0]+nx,b[1]+ny],[b[0]-nx,b[1]-ny],[a[0]-nx,a[1]-ny],color);}
export function tessellate(shapes,selected=null,zoom=1){
  const vertices=[];
  for(const s of shapes){
    const color=rgba(s.color),x=Math.min(s.x,s.x+s.w),y=Math.min(s.y,s.y+s.h),w=Math.abs(s.w),h=Math.abs(s.h);
    if(s.type==='note'){rect(vertices,x+3,y+5,w,h,[.15,.1,.25,.065]);rect(vertices,x,y,w,h,color);rect(vertices,x,y,w,5,[...color.slice(0,3).map(v=>v*.93),1]);}
    else if(s.type==='rect'){rect(vertices,x,y,w,h,rgba(s.color,.10));const p=[[x,y],[x+w,y],[x+w,y+h],[x,y+h],[x,y]];for(let i=1;i<p.length;i++)line(vertices,p[i-1],p[i],2,color);}
    else if(s.type==='ellipse'){for(let i=0;i<48;i++){const a=i*2*Math.PI/48,b=(i+1)*2*Math.PI/48,p=[x+w/2+Math.cos(a)*w/2,y+h/2+Math.sin(a)*h/2],q=[x+w/2+Math.cos(b)*w/2,y+h/2+Math.sin(b)*h/2];tri(vertices,[x+w/2,y+h/2],p,q,rgba(s.color,.10));line(vertices,p,q,2,color);}}
    else {
      const p=s.points||[[s.x,s.y],[s.x+s.w,s.y+s.h]];
      for(let i=1;i<p.length;i++)line(vertices,p[i-1],p[i],s.type==='pen'?3:2.5,color);
      if(s.type==='pen')for(const [px,py]of p)disc(vertices,px,py,1.5,color);
      if(s.type==='arrow'&&p.length>1){const b=p.at(-1),a=p.at(-2),angle=Math.atan2(b[1]-a[1],b[0]-a[0]);tri(vertices,b,[b[0]-14*Math.cos(angle-.45),b[1]-14*Math.sin(angle-.45)],[b[0]-14*Math.cos(angle+.45),b[1]-14*Math.sin(angle+.45)],color);}
    }
    if(s.id===selected){const gap=5/zoom,c=rgba('#7162b8'),p=[[x-gap,y-gap],[x+w+gap,y-gap],[x+w+gap,y+h+gap],[x-gap,y+h+gap],[x-gap,y-gap]];for(let i=1;i<p.length;i++)line(vertices,p[i-1],p[i],1.3/zoom,c);rect(vertices,x+w-4/zoom,y+h-4/zoom,8/zoom,8/zoom,c);}
  }
  return new Float32Array(vertices);
}
export class SceneRenderer {
  constructor(canvas,onMode=()=>{}){this.canvas=canvas;this.onMode=onMode;this.mode='Starting';this.alive=true;this.vertices=new Float32Array();this.view={x:0,y:0,zoom:1};this.frames=0;this.uploads=0;}
  async init(){
    try{
      if(!navigator.gpu)throw new Error('WebGPU unavailable');
      const adapter=await navigator.gpu.requestAdapter({powerPreference:'low-power'});if(!adapter)throw new Error('No WebGPU adapter');
      this.device=await adapter.requestDevice();if(!this.alive){this.device.destroy();return;}
      this.context=this.canvas.getContext('webgpu');if(!this.context)throw new Error('No GPU canvas');
      this.format=navigator.gpu.getPreferredCanvasFormat();this.context.configure({device:this.device,format:this.format,alphaMode:'premultiplied'});
      const module=this.device.createShaderModule({label:'Veyra triangle shader',code:WGSL});
      this.pipeline=await this.device.createRenderPipelineAsync({label:'Veyra retained batch',layout:'auto',vertex:{module,entryPoint:'vs',buffers:[{arrayStride:24,attributes:[{shaderLocation:0,offset:0,format:'float32x2'},{shaderLocation:1,offset:8,format:'float32x4'}]}]},fragment:{module,entryPoint:'fs',targets:[{format:this.format,blend:{color:{srcFactor:'src-alpha',dstFactor:'one-minus-src-alpha',operation:'add'},alpha:{srcFactor:'one',dstFactor:'one-minus-src-alpha',operation:'add'}}}]},primitive:{topology:'triangle-list'},multisample:{count:4}});
      if(!this.alive){this.device.destroy();return;}
      this.uniform=this.device.createBuffer({size:32,usage:GPUBufferUsage.UNIFORM|GPUBufferUsage.COPY_DST});
      this.bind=this.device.createBindGroup({layout:this.pipeline.getBindGroupLayout(0),entries:[{binding:0,resource:{buffer:this.uniform}}]});
      this.device.addEventListener('uncapturederror',event=>console.error('Veyra WebGPU:',event.error.message));
      this.device.lost.then(info=>{if(this.alive){console.warn('Veyra GPU device lost:',info.reason);this.fallback();this.resize();}});
      this.mode='WebGPU';this.onMode(this.mode);this.resize();this.upload();this.request();
    }catch(e){if(this.alive){console.info('Veyra renderer fallback:',e.message);this.fallback();this.resize();}}
  }
  fallback(){
    this.msaa?.destroy();this.buffer?.destroy();this.uniform?.destroy();
    if(this.context){const replacement=this.canvas.cloneNode();this.canvas.replaceWith(replacement);this.canvas=replacement;}
    this.context=null;this.ctx=this.canvas.getContext('2d');this.mode='Canvas 2D';this.onMode(this.mode);this.request();
  }
  resize(){
    if(!this.alive)return;const rect=this.canvas.parentElement.getBoundingClientRect();this.width=Math.max(1,rect.width);this.height=Math.max(1,rect.height);this.dpr=Math.min(devicePixelRatio||1,2);
    const w=Math.max(1,Math.round(this.width*this.dpr)),h=Math.max(1,Math.round(this.height*this.dpr));
    if(this.canvas.width!==w||this.canvas.height!==h||!this.msaa){this.canvas.width=w;this.canvas.height=h;if(this.mode==='WebGPU'){this.msaa?.destroy();this.msaa=this.device.createTexture({size:[w,h],format:this.format,sampleCount:4,usage:GPUTextureUsage.RENDER_ATTACHMENT});}}
    this.request();
  }
  setScene(shapes,selection){this.vertices=tessellate(shapes,selection,this.view.zoom);this.upload();this.request();}
  setView(view){this.view={...view};this.request();}
  upload(){
    if(this.mode!=='WebGPU')return;const bytes=Math.max(24,this.vertices.byteLength);
    if(!this.buffer||this.capacity<bytes){this.buffer?.destroy();this.capacity=2**Math.ceil(Math.log2(bytes));this.buffer=this.device.createBuffer({size:this.capacity,usage:GPUBufferUsage.VERTEX|GPUBufferUsage.COPY_DST});}
    if(this.vertices.byteLength)this.device.queue.writeBuffer(this.buffer,0,this.vertices);this.uploads++;
  }
  request(){if(this.alive&&!this.pending)this.pending=requestAnimationFrame(()=>{this.pending=0;this.draw();});}
  draw(){
    if(!this.alive||!this.width)return;const {x,y,zoom}=this.view;
    if(this.mode==='WebGPU'&&this.msaa){
      this.device.queue.writeBuffer(this.uniform,0,new Float32Array([this.width,this.height,x,y,zoom,0,0,0]));
      const encoder=this.device.createCommandEncoder();const pass=encoder.beginRenderPass({colorAttachments:[{view:this.msaa.createView(),resolveTarget:this.context.getCurrentTexture().createView(),clearValue:{r:0,g:0,b:0,a:0},loadOp:'clear',storeOp:'discard'}]});
      pass.setPipeline(this.pipeline);pass.setBindGroup(0,this.bind);if(this.vertices.length){pass.setVertexBuffer(0,this.buffer);pass.draw(this.vertices.length/6);}pass.end();this.device.queue.submit([encoder.finish()]);this.frames++;
    }else if(this.ctx){
      const ctx=this.ctx;ctx.setTransform(1,0,0,1,0,0);ctx.clearRect(0,0,this.canvas.width,this.canvas.height);ctx.setTransform(this.dpr*zoom,0,0,this.dpr*zoom,x*this.dpr,y*this.dpr);
      const v=this.vertices;for(let i=0;i<v.length;i+=18){ctx.fillStyle=`rgba(${Math.round(v[i+2]*255)},${Math.round(v[i+3]*255)},${Math.round(v[i+4]*255)},${v[i+5]})`;ctx.beginPath();ctx.moveTo(v[i],v[i+1]);ctx.lineTo(v[i+6],v[i+7]);ctx.lineTo(v[i+12],v[i+13]);ctx.closePath();ctx.fill();}this.frames++;
    }
  }
  dispose(){this.alive=false;cancelAnimationFrame(this.pending);this.msaa?.destroy();this.buffer?.destroy();this.uniform?.destroy();this.device?.destroy();}
}
