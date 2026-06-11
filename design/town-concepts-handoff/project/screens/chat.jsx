// chat.jsx — three from-scratch directions for Agent ↔ Visitor chat.
// Exports: ChatFloating, ChatDocked, ChatDiegetic.

/* ---------- shared bits ---------- */
function StatusDot({ color, size = 8 }) {
  return <span style={{ width:size, height:size, borderRadius:'50%', background:color,
    boxShadow:`0 0 0 3px ${color}33`, display:'inline-block', animation:'pulse 2.4s infinite' }} />;
}
function Bubble({ side, color, name, children, memory }) {
  const mine = side === 'visitor';
  return (
    <div style={{ display:'flex', justifyContent: mine ? 'flex-end':'flex-start', marginBottom:12 }}>
      <div style={{ maxWidth:'82%' }}>
        {!mine && <div style={{ font:'600 11px var(--mono)', letterSpacing:'.04em', color, marginBottom:5, paddingLeft:2 }}>{name}</div>}
        <div style={{
          padding:'11px 14px', borderRadius: mine ? '16px 16px 5px 16px' : '16px 16px 16px 5px',
          background: mine ? 'var(--ink)' : '#fff', color: mine ? '#fff' : 'var(--ink)',
          border: mine ? 'none' : `1px solid ${color}2e`, fontSize:14.5, lineHeight:1.5,
          boxShadow: mine ? 'none' : `0 1px 0 ${color}14, 0 8px 20px -14px rgba(60,48,30,.4)` }}>
          {memory && (
            <div style={{ display:'inline-flex', alignItems:'center', gap:6, font:'600 10px var(--mono)',
              letterSpacing:'.03em', color, background:`${color}14`, padding:'3px 8px', borderRadius:999, marginBottom:8 }}>
              <span style={{ fontSize:11 }}>↩</span> RECALLED FROM EARLIER TODAY
            </div>
          )}
          <div>{children}</div>
        </div>
      </div>
    </div>
  );
}
function StreamDots({ color }) {
  return (
    <div style={{ display:'flex', gap:5, padding:'13px 16px', background:'#fff', width:'fit-content',
      border:`1px solid ${color}2e`, borderRadius:'16px 16px 16px 5px' }}>
      {[0,1,2].map(i => <span key={i} style={{ width:7, height:7, borderRadius:'50%', background:color,
        opacity:.5, animation:`stream 1.1s ${i*0.16}s infinite` }} />)}
    </div>
  );
}
function useTypewriter(text, speed = 26, on = true) {
  const [n, setN] = React.useState(on ? 0 : text.length);
  React.useEffect(() => {
    if (!on) { setN(text.length); return; }
    setN(0); let i = 0;
    const t = setInterval(() => { i++; setN(i); if (i >= text.length) clearInterval(t); }, speed);
    return () => clearInterval(t);
  }, [text, on]);
  return text.slice(0, n);
}

/* =========================================================
   01 · FLOATING OVERLAY — glassy warm card over the world
   ========================================================= */
function ChatFloating() {
  const a = AGENTS.career;
  return (
    <div style={{ position:'absolute', inset:0, fontFamily:'var(--sans)' }}>
      <TownBackdrop time="day" dim={0.14} />
      {/* ambient: another agent's thought drifting in-world */}
      <div className="float-card" style={{ position:'absolute', right:26, bottom:24, width:392,
        background:'rgba(252,247,238,.92)', backdropFilter:'blur(10px)', borderRadius:20,
        border:'1px solid rgba(255,255,255,.6)', boxShadow:'0 2px 6px rgba(40,30,15,.14), 0 30px 60px -22px rgba(40,30,15,.5)', overflow:'hidden' }}>
        {/* header */}
        <div style={{ display:'flex', alignItems:'center', gap:11, padding:'13px 15px', background:`${a.color}12`, borderBottom:`1px solid ${a.color}22` }}>
          <div style={{ width:40, height:40, borderRadius:11, background:`${a.color}1f`, display:'grid', placeItems:'center', boxShadow:`inset 0 0 0 1px ${a.color}33` }}>
            <Sprite color={a.color} scale={3} />
          </div>
          <div style={{ flex:1, minWidth:0 }}>
            <div style={{ font:'600 16px var(--display)', color:'var(--ink)' }}>{a.full}</div>
            <div style={{ display:'flex', alignItems:'center', gap:7, marginTop:2 }}>
              <StatusDot color={a.color} />
              <span style={{ font:'500 10.5px var(--mono)', letterSpacing:'.02em', color:'var(--ink-2)', textTransform:'uppercase' }}>{a.status}</span>
            </div>
          </div>
          <div style={{ color:'var(--ink-3)', fontSize:18, cursor:'pointer', lineHeight:1 }}>×</div>
        </div>
        {/* continuity ribbon */}
        <div style={{ padding:'8px 15px', background:'#fff', borderBottom:'1px solid var(--line)', display:'flex', gap:8, alignItems:'center' }}>
          <span style={{ fontSize:12 }}>🔗</span>
          <span style={{ fontSize:12, color:'var(--ink-2)', lineHeight:1.35 }}>You caught him mid-thought — he was just DMing <b style={{color:AGENTS.builder.color}}>Builder</b> about the demo.</span>
        </div>
        {/* messages */}
        <div style={{ padding:'16px 15px 6px', maxHeight:300, overflow:'hidden' }}>
          <Bubble side="agent" color={a.color} name="CAREER THOMAS">
            Hey — good timing. Builder and I were just going back and forth about whether the eval numbers are ready to ship. What brings you by?
          </Bubble>
          <Bubble side="visitor">What's the story from BYU to founding a startup?</Bubble>
          <Bubble side="agent" color={a.color} name="CAREER THOMAS" memory>
            Statistics degree at BYU, then SambaNova for the AI-infra deep end — now Billables AI, automating legal billing with LLMs. The throughline is the same: build things that ship.
          </Bubble>
          <StreamDots color={a.color} />
        </div>
        {/* input */}
        <div style={{ display:'flex', gap:9, padding:'12px 13px 14px' }}>
          <div style={{ flex:1, padding:'11px 14px', borderRadius:12, background:'#fff', border:'1px solid var(--line)', color:'var(--ink-3)', fontSize:14 }}>Say something…</div>
          <button style={{ padding:'0 16px', borderRadius:12, border:'none', background:a.color, color:'#fff', font:'600 14px var(--display)', cursor:'pointer' }}>Send</button>
        </div>
      </div>
    </div>
  );
}

/* =========================================================
   02 · DOCKED PANEL — game shrinks; chat gets a context rail
   ========================================================= */
function ChatDocked() {
  const a = AGENTS.career;
  const pre = [
    { t:'9:12', type:'think', text:'The AI billing space is evolving fast.' },
    { t:'9:31', type:'work', text:'Reviewing candidate resumes' },
    { t:'9:40', type:'say', text:'DM\u2019d Builder: how\u2019s the demo coming along?', to:AGENTS.builder.color },
  ];
  const TYPE_ICON = { think:'💭', work:'🛠️', say:'✉️' };
  return (
    <div style={{ position:'absolute', inset:0, display:'flex', fontFamily:'var(--sans)', background:'#15110c' }}>
      {/* letterboxed world */}
      <div style={{ flex:1, position:'relative', minWidth:0 }}>
        <TownBackdrop time="day" dim={0.06} />
        <div style={{ position:'absolute', top:14, left:14, padding:'6px 11px', borderRadius:8, background:'rgba(252,247,238,.9)', font:'600 10px var(--mono)', letterSpacing:'.06em', color:'var(--ink-2)' }}>OFFICE · DOWNTOWN</div>
      </div>
      {/* docked panel */}
      <div style={{ width:368, background:'var(--paper-2)', borderLeft:'1px solid var(--line)', display:'flex', flexDirection:'column', boxShadow:'-20px 0 50px -30px rgba(0,0,0,.6)' }}>
        <div style={{ display:'flex', alignItems:'center', gap:11, padding:'15px 16px', borderBottom:'1px solid var(--line)' }}>
          <div style={{ width:38, height:38, borderRadius:11, background:`${a.color}1f`, display:'grid', placeItems:'center' }}><Sprite color={a.color} scale={2.6} /></div>
          <div style={{ flex:1 }}>
            <div style={{ font:'600 16px var(--display)' }}>{a.full}</div>
            <div style={{ display:'flex', alignItems:'center', gap:6, marginTop:2 }}><StatusDot color={a.color} size={7} /><span style={{ font:'500 10px var(--mono)', color:'var(--ink-2)', textTransform:'uppercase' }}>{a.status}</span></div>
          </div>
        </div>
        {/* before-you-walked-in rail */}
        <div style={{ padding:'13px 16px', background:`${a.color}0b`, borderBottom:'1px solid var(--line)' }}>
          <div style={{ font:'700 9.5px var(--mono)', letterSpacing:'.12em', color:'var(--ink-3)', marginBottom:10 }}>BEFORE YOU WALKED IN</div>
          <div style={{ position:'relative', paddingLeft:4 }}>
            {pre.map((e,i) => (
              <div key={i} style={{ display:'flex', gap:9, marginBottom: i<pre.length-1?10:0 }}>
                <div style={{ fontSize:13, width:18, textAlign:'center' }}>{TYPE_ICON[e.type]}</div>
                <div style={{ flex:1 }}>
                  <div style={{ fontSize:12.5, color:'var(--ink-2)', lineHeight:1.4 }}>{e.text}</div>
                </div>
                <div style={{ font:'500 10px var(--mono)', color:'var(--ink-3)' }}>{e.t}</div>
              </div>
            ))}
          </div>
        </div>
        {/* conversation */}
        <div style={{ flex:1, padding:'15px 16px 4px', overflow:'hidden' }}>
          <Bubble side="agent" color={a.color} name="CAREER THOMAS">Hey there! Want to hear about the journey from BYU to building AI billing systems?</Bubble>
          <Bubble side="visitor">What was SambaNova like?</Bubble>
          <Bubble side="agent" color={a.color} name="CAREER THOMAS">An incredible ride — building out their AI infrastructure. That's where data science turned into real AI engineering for me.</Bubble>
        </div>
        {/* quick replies */}
        <div style={{ display:'flex', gap:7, padding:'4px 16px 10px', flexWrap:'wrap' }}>
          {['The BYU days','Why start Billables?','Best career advice'].map(q => (
            <div key={q} style={{ padding:'6px 11px', borderRadius:999, border:`1px solid ${a.color}40`, color:a.color, fontSize:12, fontWeight:600, background:'#fff' }}>{q}</div>
          ))}
        </div>
        <div style={{ display:'flex', gap:8, padding:'10px 14px 14px', borderTop:'1px solid var(--line)' }}>
          <div style={{ flex:1, padding:'10px 13px', borderRadius:11, background:'#fff', border:'1px solid var(--line)', color:'var(--ink-3)', fontSize:13.5 }}>Say something…</div>
          <button style={{ padding:'0 15px', borderRadius:11, border:'none', background:a.color, color:'#fff', font:'600 13.5px var(--display)' }}>Send</button>
        </div>
      </div>
    </div>
  );
}

/* =========================================================
   03 · DIEGETIC — in-world RPG dialog box, modern type
   ========================================================= */
function ChatDiegetic() {
  const a = AGENTS.career;
  const line = "Statistics at BYU, then SambaNova for the AI-infra deep end, now Billables AI. Same throughline the whole way: build things that actually ship.";
  const typed = useTypewriter(line, 22, true);
  const done = typed.length >= line.length;
  return (
    <div style={{ position:'absolute', inset:0, fontFamily:'var(--sans)' }}>
      <TownBackdrop time="dusk" dim={0.16} />
      {/* in-world standing sprite + memory wisp */}
      <div style={{ position:'absolute', left:'50%', top:'42%', transform:'translateX(-50%)', textAlign:'center' }}>
        <div style={{ display:'inline-block', transform:'scale(4)', imageRendering:'pixelated', filter:'drop-shadow(0 3px 2px rgba(0,0,0,.4))' }}><Sprite color={a.color} scale={4} /></div>
        <div style={{ marginTop:46, font:'600 10px var(--mono)', letterSpacing:'.08em', color:'#fff', background:'rgba(20,16,11,.55)', padding:'4px 10px', borderRadius:999, display:'inline-block' }}>CAREER THOMAS</div>
      </div>
      {/* pixel dialog box */}
      <div style={{ position:'absolute', left:'50%', bottom:30, transform:'translateX(-50%)', width:760, maxWidth:'92%' }}>
        <div className="pixel-frame" style={{ background:'#fdf6e8', position:'relative', padding:'22px 24px 20px 152px', minHeight:120 }}>
          {/* portrait */}
          <div style={{ position:'absolute', left:18, top:18, bottom:18, width:116 }}>
            <div className="pixel-frame-inner" style={{ width:116, height:'100%', background:`${a.color}1a`, display:'grid', placeItems:'center' }}>
              <div style={{ transform:'scale(2.2)' }}><Sprite color={a.color} scale={4} /></div>
            </div>
          </div>
          {/* nameplate */}
          <div style={{ position:'absolute', top:-15, left:150, background:a.color, color:'#fff', font:'700 12px var(--mono)', letterSpacing:'.06em', padding:'5px 13px', boxShadow:'4px 4px 0 rgba(20,16,11,.25)' }}>CAREER THOMAS</div>
          {/* recalling wisp */}
          {done && <div style={{ position:'absolute', top:-14, right:18, font:'600 9.5px var(--mono)', letterSpacing:'.06em', color:a.color, background:'#fff', padding:'4px 10px', borderRadius:999, border:`1px solid ${a.color}40` }}>❖ DREW ON A MEMORY</div>}
          <div style={{ fontSize:18, lineHeight:1.55, color:'#241a10', minHeight:54 }}>
            {typed}<span style={{ opacity: done?0:1, animation:'blink 1s steps(1) infinite' }}>▌</span>
          </div>
          <div style={{ display:'flex', justifyContent:'space-between', alignItems:'center', marginTop:14 }}>
            <div style={{ display:'flex', alignItems:'center', gap:9, flex:1 }}>
              <span style={{ color:a.color, fontWeight:700 }}>▸</span>
              <div style={{ flex:1, maxWidth:340, padding:'9px 13px', background:'#fff', border:'2px solid #241a10', color:'var(--ink-3)', fontSize:13.5, font:'400 13.5px var(--sans)' }}>ask Career Thomas…</div>
            </div>
            <div style={{ font:'700 12px var(--mono)', color:'#241a10', animation:'blink 1.1s steps(1) infinite' }}>{done ? '▾ CONTINUE' : ''}</div>
          </div>
        </div>
      </div>
    </div>
  );
}

Object.assign(window, { ChatFloating, ChatDocked, ChatDiegetic });
