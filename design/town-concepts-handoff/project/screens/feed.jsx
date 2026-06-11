// feed.jsx — the Day-in-the-Life look-back, three directions.
// A believable day built from the real simulation scripts + relationships.
// Exports: FeedTimeline, FeedNewspaper, FeedLanes, DAY_LOG.

const DAY_LOG = [
  { t:'8:05',  a:'career',     type:'think', loc:'Office',   text:'Time to review the quarterly goals…' },
  { t:'8:20',  a:'researcher', type:'work',  loc:'Library',  text:'Reading papers on Bayesian optimization' },
  { t:'8:35',  a:'builder',    type:'work',  loc:'Workshop', text:'Running the Codenames eval batch' },
  { t:'8:50',  a:'builder',    type:'think', loc:'Workshop', text:'Accuracy dropped 2%. Need to investigate.' },
  { t:'9:02',  a:'builder',    type:'say',   to:'researcher',loc:'Workshop', text:'Got a minute? The eval numbers look weird.' },
  { t:'9:10',  a:'researcher', type:'say',   to:'builder',   loc:'Library',  text:'Your metrics might benefit from stratified sampling.' },
  { t:'9:25',  a:'researcher', type:'work',  loc:'Library',  text:'Deriving confidence intervals for LLM benchmarks' },
  { t:'9:40',  a:'career',     type:'say',   to:'builder',   loc:'Office',   text:'Hey Builder — how’s the demo coming along?' },
  { t:'9:55',  a:'writer',     type:'work',  loc:'Cafe',     text:'Drafting “The Future of AI in Legal Billing”' },
  { t:'10:10', a:'writer',     type:'say',   to:'career',    loc:'Cafe',     text:'Can I interview you for my piece on AI leadership?' },
  { t:'10:30', a:'builder',    type:'think', loc:'Workshop', text:'Found it — the system prompt was getting truncated.' },
  { t:'10:45', a:'builder',    type:'work',  loc:'Workshop', text:'Shipping the fix and re-running' },
  { t:'11:15', a:'hobby',      type:'say',   to:'public',    loc:'Park',     text:'Anyone up for a game tonight?' },
  { t:'13:20', a:'career',     type:'work',  loc:'Office',   text:'Reviewing candidate resumes' },
  { t:'14:00', a:'writer',     type:'think', loc:'Cafe',     text:'Good writing is rewriting. One more pass.' },
  { t:'15:30', a:'hobby',      type:'think', loc:'Park',     text:'Builder’s been in the workshop all day. I should check on him.' },
  { t:'15:45', a:'hobby',      type:'say',   to:'builder',   loc:'Park',     text:'Take a break! Let’s go for a walk.' },
  { t:'16:10', a:'builder',    type:'move',  loc:'Workshop → Park', text:'Stepped out with Hobby' },
  { t:'16:40', a:'researcher', type:'think', loc:'Library',  text:'Perhaps a Dirichlet process mixture would model this better.' },
  { t:'17:30', a:'writer',     type:'work',  loc:'Cafe',     text:'Editing the third paragraph' },
];

const TYPE = {
  think: { icon:'💭', label:'THOUGHT' },
  work:  { icon:'🛠️', label:'WORK' },
  say:   { icon:'💬', label:'MESSAGE' },
  move:  { icon:'🚶', label:'MOVED' },
  idle:  { icon:'🌙', label:'IDLE' },
};
const toMin = (t) => { const [h,m]=t.split(':').map(Number); return h*60+m; };

/* =========================================================
   01 · UNIFIED TIMELINE — one river, all five, color-coded
   ========================================================= */
function FeedTimeline() {
  const [active, setActive] = React.useState('all');
  const rows = DAY_LOG.filter(e => active==='all' || e.a===active);
  return (
    <div style={{ position:'absolute', inset:0, display:'flex', flexDirection:'column', background:'var(--paper)', fontFamily:'var(--sans)' }}>
      {/* header */}
      <div style={{ padding:'18px 22px 14px', borderBottom:'1px solid var(--line)', background:'var(--paper-2)' }}>
        <div style={{ display:'flex', alignItems:'baseline', gap:12 }}>
          <div style={{ font:'700 24px var(--display)' }}>Today in Thomas's Town</div>
          <div style={{ font:'400 11px var(--mono)', color:'var(--ink-3)', letterSpacing:'.04em' }}>TUE · JUN 10 · 20 EVENTS</div>
        </div>
        <div style={{ fontSize:13.5, color:'var(--ink-2)', marginTop:3 }}>What everyone got up to while the town ran itself.</div>
        {/* agent filter chips */}
        <div style={{ display:'flex', gap:7, marginTop:13, flexWrap:'wrap' }}>
          <Chip on={active==='all'} onClick={()=>setActive('all')} color="#2B2620" label="Everyone" dot={false}/>
          {Object.values(AGENTS).map(a => <Chip key={a.id} on={active===a.id} onClick={()=>setActive(a.id)} color={a.color} label={a.name}/>)}
        </div>
      </div>
      {/* river */}
      <div style={{ flex:1, overflow:'hidden', padding:'8px 0 0' }}>
        <div style={{ padding:'10px 22px' }}>
          {rows.map((e,i) => <TimelineRow key={i} e={e} first={i===0} last={i===rows.length-1}/>)}
        </div>
      </div>
    </div>
  );
}
function Chip({ on, onClick, color, label, dot=true }) {
  return (
    <button onClick={onClick} style={{ display:'inline-flex', alignItems:'center', gap:6, padding:'6px 12px', borderRadius:999,
      border:`1px solid ${on?color:'var(--line-2)'}`, background:on?color:(dot?'#fff':'#fff'), color:on?'#fff':'var(--ink-2)',
      font:'600 12.5px var(--sans)', cursor:'pointer', transition:'all .15s' }}>
      {dot && <span style={{ width:8, height:8, borderRadius:'50%', background:on?'#fff':color }}/>}
      {label}
    </button>
  );
}
function TimelineRow({ e, last }) {
  const a = AGENTS[e.a]; const ty = TYPE[e.type];
  const recipient = e.to && (e.to==='public' ? null : AGENTS[e.to]);
  return (
    <div style={{ display:'flex', gap:14, position:'relative' }}>
      {/* time gutter */}
      <div style={{ width:50, textAlign:'right', font:'400 11.5px var(--mono)', color:'var(--ink-3)', paddingTop:9, flexShrink:0 }}>{e.t}</div>
      {/* spine */}
      <div style={{ position:'relative', width:30, flexShrink:0, display:'flex', justifyContent:'center' }}>
        {!last && <div style={{ position:'absolute', top:18, bottom:-14, width:2, background:'var(--line)' }}/>}
        <div style={{ width:30, height:30, borderRadius:9, background:`${a.color}1c`, border:`1px solid ${a.color}40`, display:'grid', placeItems:'center', fontSize:14, zIndex:1, marginTop:3 }}>{ty.icon}</div>
      </div>
      {/* content */}
      <div className="tl-card" style={{ flex:1, paddingBottom:16 }}>
        <div style={{ display:'flex', alignItems:'center', gap:8, marginBottom:3 }}>
          <span style={{ font:'700 13px var(--sans)', color:a.color }}>{a.name}</span>
          <span style={{ font:'700 9px var(--mono)', letterSpacing:'.1em', color:'var(--ink-3)', background:'var(--paper-2)', padding:'2px 6px', borderRadius:5 }}>{ty.label}</span>
          {recipient && <span style={{ font:'600 11px var(--sans)', color:'var(--ink-3)' }}>→ <span style={{ color:recipient.color, fontWeight:700 }}>{recipient.name}</span></span>}
          {e.to==='public' && <span style={{ font:'600 11px var(--sans)', color:'var(--ink-3)' }}>📣 to the town</span>}
          <span className="show-town" style={{ marginLeft:'auto', font:'600 10px var(--mono)', color:a.color, opacity:.0, letterSpacing:'.04em' }}>⌖ SHOW IN TOWN</span>
        </div>
        <div style={{
          fontSize:14.5, lineHeight:1.5,
          color: e.type==='think' ? 'var(--ink-2)' : 'var(--ink)',
          fontStyle: e.type==='think' ? 'italic' : 'normal' }}>
          {e.type==='say' ? <span style={{ position:'relative' }}>“{e.text}”</span> : e.text}
        </div>
        {e.type==='work' && <div style={{ marginTop:7, height:3, borderRadius:2, background:`${a.color}22`, overflow:'hidden' }}><div style={{ width:'62%', height:'100%', background:a.color, borderRadius:2 }}/></div>}
        <div style={{ font:'400 10.5px var(--mono)', color:'var(--ink-3)', marginTop:5 }}>{e.loc}</div>
      </div>
    </div>
  );
}

/* =========================================================
   02 · TOWN NEWSPAPER — the day as a cozy broadsheet
   ========================================================= */
function FeedNewspaper() {
  return (
    <div style={{ position:'absolute', inset:0, background:'#F2E8D2', fontFamily:'var(--sans)', overflow:'hidden' }}>
      <div style={{ position:'absolute', inset:0, padding:'22px 30px' }}>
        {/* masthead */}
        <div style={{ textAlign:'center', borderBottom:'3px double #241a10', paddingBottom:10 }}>
          <div style={{ display:'flex', justifyContent:'space-between', font:'700 10px var(--mono)', letterSpacing:'.08em', color:'#5C544A' }}>
            <span>VOL. I · NO. 47</span><span>“ALL THE NEWS FIVE THOMASES SEE FIT TO THINK”</span><span>FREE</span>
          </div>
          <div style={{ font:'700 50px var(--display)', letterSpacing:'-.02em', color:'#241a10', lineHeight:1, margin:'6px 0 4px' }}>The Town Crier</div>
          <div style={{ font:'700 10px var(--mono)', letterSpacing:'.14em', color:'#5C544A' }}>TUESDAY, JUNE 10 · CLOUDLESS, A FOUNTAIN BREEZE</div>
        </div>
        {/* body grid */}
        <div style={{ display:'grid', gridTemplateColumns:'1.7fr 1fr', gap:24, marginTop:16 }}>
          {/* lead */}
          <div style={{ borderRight:'1px solid #cbb89a', paddingRight:24 }}>
            <div style={{ font:'700 11px var(--mono)', letterSpacing:'.1em', color:AGENTS.builder.color }}>WORKSHOP DISPATCH</div>
            <div style={{ font:'700 30px var(--display)', color:'#241a10', lineHeight:1.05, margin:'4px 0 8px' }}>Eval Numbers Spark a Productive Workshop Spat</div>
            <div style={{ font:'400 11px var(--mono)', color:'#5C544A', marginBottom:10 }}>By a Staff Thomas · 10:30 AM</div>
            <p style={{ fontSize:13.5, lineHeight:1.62, color:'#2B2620', margin:0 }}>
              <span style={{ float:'left', font:'700 46px var(--display)', lineHeight:.82, padding:'4px 8px 0 0', color:AGENTS.builder.color }}>A</span>
              2% accuracy drop in the Codenames eval sent <b style={{color:AGENTS.builder.color}}>Builder</b> across town for backup. <b style={{color:AGENTS.researcher.color}}>Researcher</b> prescribed stratified sampling — “your metrics might benefit,” he noted, dryly. By 10:30 the culprit was found: a truncated system prompt. The fix shipped before lunch.
            </p>
            <p style={{ fontSize:13.5, lineHeight:1.62, color:'#2B2620', marginTop:10 }}>
              Elsewhere, <b style={{color:AGENTS.writer.color}}>Writer</b> requested an interview with <b style={{color:AGENTS.career.color}}>Career</b> for a forthcoming piece on AI leadership — the cafe’s third draft of the week.
            </p>
          </div>
          {/* sidebar */}
          <div>
            <div style={{ border:'2px solid #241a10', padding:'12px 14px', background:'#FBF6EC' }}>
              <div style={{ font:'700 12px var(--mono)', letterSpacing:'.08em', textAlign:'center', borderBottom:'1px solid #cbb89a', paddingBottom:7, marginBottom:9 }}>OVERHEARD ABOUT TOWN</div>
              {[
                { a:'hobby', q:'Anyone up for a game tonight?', m:'to everyone, 11:15' },
                { a:'career', q:'How’s the demo coming along?', m:'to Builder, 9:40' },
                { a:'hobby', q:'Take a break! Let’s go for a walk.', m:'to Builder, 3:45' },
              ].map((o,i)=>(
                <div key={i} style={{ marginBottom:i<2?10:0 }}>
                  <div style={{ fontSize:13, fontStyle:'italic', color:'#241a10', lineHeight:1.4 }}>“{o.q}”</div>
                  <div style={{ font:'600 10px var(--mono)', color:AGENTS[o.a].color, marginTop:2 }}>— {AGENTS[o.a].name}, <span style={{color:'#8A8174'}}>{o.m}</span></div>
                </div>
              ))}
            </div>
            <div style={{ marginTop:14 }}>
              <div style={{ font:'700 11px var(--mono)', letterSpacing:'.08em', borderBottom:'2px solid #241a10', paddingBottom:5, marginBottom:8 }}>TODAY'S DOINGS</div>
              {[
                { a:'researcher', t:'Confidence intervals derived for LLM benchmarks.' },
                { a:'career', t:'Quarterly goals reviewed; résumés on the desk.' },
                { a:'writer', t:'“AI in Legal Billing” enters its third pass.' },
              ].map((b,i)=>(
                <div key={i} style={{ display:'flex', gap:8, marginBottom:7, fontSize:12.5, color:'#2B2620', lineHeight:1.4 }}>
                  <span style={{ width:7, height:7, borderRadius:'50%', background:AGENTS[b.a].color, marginTop:5, flexShrink:0 }}/>
                  <span>{b.t}</span>
                </div>
              ))}
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}

/* =========================================================
   03 · PER-AGENT LANES — five parallel lives across a clock
   ========================================================= */
function FeedLanes() {
  const START=8*60, END=18*60, PADL=132, PADR=24, TOP=92, LANE_H=78;
  const ids = Object.keys(AGENTS);
  const W = 1180, axisW = W - PADL - PADR;
  const xOf = (min) => PADL + ((min-START)/(END-START))*axisW;
  const yOf = (id) => TOP + ids.indexOf(id)*LANE_H + LANE_H/2;
  const hours = []; for(let h=8;h<=18;h+=2) hours.push(h*60);
  const threads = DAY_LOG.filter(e => e.type==='say' && e.to && e.to!=='public' && AGENTS[e.to]);
  const NOW = 16*60+55;
  return (
    <div style={{ position:'absolute', inset:0, background:'var(--paper)', fontFamily:'var(--sans)' }}>
      {/* header */}
      <div style={{ position:'absolute', top:0, left:0, right:0, padding:'16px 24px', borderBottom:'1px solid var(--line)', background:'var(--paper-2)', zIndex:3 }}>
        <div style={{ font:'700 22px var(--display)' }}>Five parallel days <span style={{ font:'400 12px var(--mono)', color:'var(--ink-3)', letterSpacing:'.04em' }}>· lines between lanes are messages that crossed town</span></div>
      </div>
      {/* hour grid + labels */}
      {hours.map(h => (
        <div key={h}>
          <div style={{ position:'absolute', left:xOf(h), top:TOP-18, font:'400 10.5px var(--mono)', color:'var(--ink-3)', transform:'translateX(-50%)' }}>{h/60}:00</div>
          <div style={{ position:'absolute', left:xOf(h), top:TOP, bottom:20, width:1, background:'var(--line)' }}/>
        </div>
      ))}
      {/* now line */}
      <div style={{ position:'absolute', left:xOf(NOW), top:TOP-6, bottom:20, width:2, background:'#E74C3C', zIndex:4 }}>
        <div style={{ position:'absolute', top:-16, left:'50%', transform:'translateX(-50%)', font:'700 8.5px var(--mono)', color:'#fff', background:'#E74C3C', padding:'2px 6px', borderRadius:4, whiteSpace:'nowrap' }}>NOW</div>
      </div>
      {/* lanes */}
      {ids.map((id,i) => {
        const a = AGENTS[id];
        const y = TOP + i*LANE_H;
        return (
          <div key={id}>
            <div style={{ position:'absolute', left:0, top:y, width:PADL, height:LANE_H, display:'flex', alignItems:'center', gap:9, padding:'0 14px', borderRight:'1px solid var(--line)' }}>
              <span style={{ width:10, height:10, borderRadius:3, background:a.color }}/>
              <div>
                <div style={{ font:'700 13px var(--sans)', color:a.color }}>{a.name}</div>
                <div style={{ font:'400 9px var(--mono)', color:'var(--ink-3)' }}>{a.home}</div>
              </div>
            </div>
            <div style={{ position:'absolute', left:PADL, right:PADR, top:y, height:LANE_H, background: i%2? 'transparent':`${a.color}07`, borderBottom:'1px solid var(--line)' }}/>
          </div>
        );
      })}
      {/* event markers */}
      {DAY_LOG.map((e,i) => {
        const a = AGENTS[e.a]; const ty=TYPE[e.type]; const x=xOf(toMin(e.t)); const y=yOf(e.a);
        const isWork = e.type==='work';
        return (
          <div key={i} title={`${a.name} · ${e.text}`} style={{ position:'absolute', left:x, top:y, transform:'translate(-50%,-50%)', zIndex:2 }}>
            {isWork
              ? <div style={{ width:54, height:18, borderRadius:6, background:`${a.color}28`, border:`1px solid ${a.color}`, transform:'translateX(20px)' }}/>
              : <div style={{ width:22, height:22, borderRadius:7, background:'#fff', border:`1.5px solid ${a.color}`, display:'grid', placeItems:'center', fontSize:11, boxShadow:'0 2px 6px -2px rgba(0,0,0,.25)' }}>{ty.icon}</div>}
          </div>
        );
      })}
      {/* cross-agent threads */}
      <svg style={{ position:'absolute', inset:0, width:'100%', height:'100%', zIndex:1, pointerEvents:'none' }}>
        {threads.map((e,i) => {
          const x=xOf(toMin(e.t)); const y1=yOf(e.a); const y2=yOf(e.to); const my=(y1+y2)/2;
          const a=AGENTS[e.a];
          return <g key={i}>
            <path d={`M ${x} ${y1} C ${x+34} ${my}, ${x+34} ${my}, ${x} ${y2}`} fill="none" stroke={a.color} strokeWidth="1.6" strokeDasharray="3 3" opacity="0.7"/>
            <circle cx={x} cy={y2} r="3" fill={AGENTS[e.to].color}/>
          </g>;
        })}
      </svg>
      {/* legend */}
      <div style={{ position:'absolute', bottom:0, left:0, right:0, padding:'8px 24px', display:'flex', gap:18, alignItems:'center', borderTop:'1px solid var(--line)', background:'var(--paper-2)', font:'400 10.5px var(--mono)', color:'var(--ink-2)' }}>
        {Object.entries(TYPE).filter(([k])=>k!=='idle').map(([k,v])=>(
          <span key={k} style={{ display:'inline-flex', alignItems:'center', gap:5 }}>{v.icon} {v.label}</span>
        ))}
        <span style={{ marginLeft:'auto', display:'inline-flex', alignItems:'center', gap:6 }}><span style={{width:14,height:0,borderTop:'1.6px dashed var(--ink-3)'}}/> a message that crossed town</span>
      </div>
    </div>
  );
}

Object.assign(window, { FeedTimeline, FeedNewspaper, FeedLanes, DAY_LOG });
