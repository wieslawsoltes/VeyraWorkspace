/** Explicitly fictional, local-only example content. No bot replies or synthetic online peers. */
export function createSample() {
  const at = (hour, minute = 0, days = 0) => { const d = new Date(); d.setDate(d.getDate() + days); d.setHours(hour, minute, 0, 0); return d.toISOString(); };
  const users = [
    {id:'local-me', name:'Alex Morgan', title:'Product designer', color:'#dce8e0', status:'available'},
    {id:'maya', name:'Maya Chen', title:'Design lead', color:'#e8dcf6', status:'sample'},
    {id:'oliver', name:'Oliver James', title:'Frontend engineer', color:'#d8e9f4', status:'sample'},
    {id:'sophie', name:'Sophie Martin', title:'Product manager', color:'#f6e4d5', status:'sample'},
    {id:'daniel', name:'Daniel Kim', title:'Brand designer', color:'#e2e9d6', status:'sample'},
    {id:'emma', name:'Emma Wilson', title:'Engineering lead', color:'#f2dfe7', status:'sample'}
  ];
  const all = users.map(u => u.id);
  const rooms = [
    {id:'product-design', name:'Product & Design', type:'group', description:'A little clarity. A lot of good ideas. Our home for everything product and design.', members:all, color:'#e7dff7', icon:'sparkles', favorite:true, unread:0},
    {id:'maya-chat', name:'Maya Chen', type:'direct', members:['local-me','maya'], color:'#e8dcf6', favorite:true, unread:2},
    {id:'launch', name:'Website launch', type:'group', members:['local-me','oliver','sophie','emma'], color:'#dcece5', icon:'rocket', unread:3},
    {id:'oliver-chat', name:'Oliver James', type:'direct', members:['local-me','oliver'], color:'#d8e9f4', unread:0},
    {id:'sophie-chat', name:'Sophie Martin', type:'direct', members:['local-me','sophie'], color:'#f6e4d5', unread:0},
    ...[['general','General'],['design-system','Design system'],['coffee','The coffee corner']].map(([id,name]) => ({id,name,type:'channel',teamName:'Veyra Studio',members:all,color:'#e8e1f5',unread:id==='design-system'?1:0}))
  ];
  const m = (id, authorId, content, hour, minute, extra={}) => ({id,roomId:'product-design',authorId,authorName:users.find(u=>u.id===authorId).name,content,createdAt:at(hour,minute),attachments:[],reactions:[],...extra});
  const messages = [
    m('sample-1','maya','Good morning, team! ☀️\nThe new workspace explorations are ready for a first look. I’d love your thoughts before our design sync.',9,12),
    m('sample-2','maya','The direction: **less noise, more room for the work.**\nA calmer canvas, purposeful color, and all the little details that make a workspace feel like home.',9,13,{card:'design',reactions:[{emoji:'❤️',userId:'sophie'},{emoji:'❤️',userId:'oliver'},{emoji:'❤️',userId:'local-me'},{emoji:'✨',userId:'daniel'}]}),
    m('sample-3','oliver','This feels really good. The extra breathing room makes such a difference. Already thinking about the component architecture 👀',9,18,{reactions:[{emoji:'👍',userId:'maya'},{emoji:'👍',userId:'local-me'}]}),
    m('sample-4','local-me','Love this direction, @Maya. The softer palette is exactly what we talked about.\nI’m putting together a few interaction ideas on the whiteboard.',9,24),
    m('sample-5','sophie','Beautiful work, everyone! Let’s walk through it together at 11:00. I’ve added the design review to our calendar.',9,31,{card:'meeting'}),
    m('sample-6','daniel','The details are coming together ✨\nI’ve added the updated color tokens to our shared notes. Ready for your feedback!',9,42,{reactions:[{emoji:'🙌',userId:'maya'},{emoji:'🙌',userId:'oliver'}]}),
    m('sample-7','maya','Perfect. Bring your ideas, and we’ll figure out the rest together.',9,45),
    m('sample-maya','maya','What do you think of the new direction?',9,46,{roomId:'maya-chat'}),
    m('sample-launch','sophie','The launch checklist is ready for review 🚀',9,38,{roomId:'launch'}),
    m('sample-oliver','oliver','Thanks! I’ll take a look at the components.',8,52,{roomId:'oliver-chat'}),
    m('sample-sophie','sophie','See you at the design sync!',8,30,{roomId:'sophie-chat'}),
    m('sample-general','emma','Welcome to our studio. A shared space to build something thoughtful.',8,0,{roomId:'general'}),
    m('sample-system','daniel','Spacing, color, typography. The foundation is looking good.',8,15,{roomId:'design-system'}),
    m('sample-coffee','maya','Today’s important question: pour-over or espresso? ☕',8,20,{roomId:'coffee'})
  ];
  const events = [
    {id:'design-review',title:'Workspace design review',start:at(11),end:at(11,45),roomId:'product-design',description:'Walk through the new direction and share feedback.'},
    {id:'launch-check',title:'Launch readiness',start:at(14),end:at(14,30),roomId:'launch',description:'Website launch checklist and handoff.'},
    {id:'weekly-planning',title:'Weekly planning',start:at(10,0,1),end:at(10,45,1),roomId:'general',description:'Priorities, progress, and what comes next.'}
  ];
  const docs = [
    {id:'product-design:notes',version:1,text:'# Design principles\n\n01  Make space for the work.\n02  Use color with intention.\n03  Let details do the talking.\n04  Keep collaboration effortless.\n\nColor tokens\nPrimary: #7162B8\nCanvas: #F8F7FA\nInk: #282630\n\nThis is editable sample content, saved on this device.'},
    {id:'product-design:board',version:1,shapes:[
      {id:'note-1',type:'note',x:120,y:100,w:210,h:170,color:'#fff0b8',text:'The big idea\n\nLess noise.\nMore room for the work.'},
      {id:'note-2',type:'note',x:450,y:100,w:210,h:170,color:'#e2d9ff',text:'A calmer canvas\n\nPurposeful color\nThoughtful typography'},
      {id:'note-3',type:'note',x:290,y:350,w:210,h:170,color:'#d4f1e5',text:'What should we explore?\n\nAdd a note or sketch your idea.'},
      {id:'arrow-1',type:'arrow',x:340,y:180,w:96,h:0,color:'#8d83ac',points:[[340,180],[436,180]]}
    ]}
  ];
  const brief = new Blob(['VEYRA / WORKSPACE DESIGN BRIEF\n\nObjective: less noise, more room for the work.\n\nPrinciples\n- Make space for the work.\n- Use color with intention.\n- Let details do the talking.\n- Keep collaboration effortless.\n\nThis is an actual downloadable sample document.'],{type:'text/plain'});
  const tokens = new Blob([JSON.stringify({primary:'#7162B8',canvas:'#F8F7FA',ink:'#282630',spacing:[4,8,12,16,24,32]},null,2)],{type:'application/json'});
  const files = [{id:'sample-brief',roomId:'product-design',ownerId:'maya',name:'Workspace design brief.txt',size:brief.size,type:brief.type,blob:brief,createdAt:at(9,13),authorName:'Maya Chen'}, {id:'sample-tokens',roomId:'product-design',ownerId:'daniel',name:'Color tokens.json',size:tokens.size,type:tokens.type,blob:tokens,createdAt:at(9,42),authorName:'Daniel Kim'}];
  return {users,rooms,messages,events,docs,files};
}
