// shared.jsx — common pieces for the Thomas's Town concept mockups.
// Exports to window: TownBackdrop, Sprite, AGENTS, agentById, injectTokens.

const AGENTS = {
  career:     { id:'career',     name:'Career',     full:'Career Thomas',     color:'#4A90D9', home:'Office',   status:'Reviewing AI billing metrics' },
  researcher: { id:'researcher', name:'Researcher', full:'Researcher Thomas', color:'#9B59B6', home:'Library',  status:'Reading papers on Bayesian methods' },
  builder:    { id:'builder',    name:'Builder',    full:'Builder Thomas',    color:'#E67E22', home:'Workshop', status:'Shipping a new eval pipeline' },
  writer:     { id:'writer',     name:'Writer',     full:'Writer Thomas',     color:'#27AE60', home:'Cafe',     status:'Drafting an article on AI in law' },
  hobby:      { id:'hobby',      name:'Hobby',      full:'Hobby Thomas',      color:'#E74C3C', home:'Park',     status:'Planning a board game night' },
};
const agentById = (id) => AGENTS[id] || AGENTS.career;

// tiny pixel avatar
function Sprite({ color, scale = 3 }) {
  const ref = React.useRef(null);
  React.useEffect(() => {
    const c = ref.current; if (!c) return;
    c.width = 8; c.height = 11;
    const x = c.getContext('2d'); x.imageSmoothingEnabled = false;
    const px = (a, b, w, h, col) => { x.fillStyle = col; x.fillRect(a, b, w, h); };
    px(1,0,6,5,'#F0C9A0'); px(1,0,6,2,'#5A3E2A'); px(0,5,8,4,color);
    px(1,6,6,1,'rgba(255,255,255,.3)'); px(1,9,2,2,'#3A3A3A'); px(5,9,2,2,'#3A3A3A');
  }, [color]);
  return <canvas ref={ref} style={{ width: 8*scale, height: 11*scale, imageRendering:'pixelated', display:'block' }} />;
}

// town render as a fixed backdrop inside an artboard
function TownBackdrop({ time = 'day', dim = 0.0, blur = 0, style }) {
  const ref = React.useRef(null);
  React.useEffect(() => {
    if (ref.current && window.renderTown) window.renderTown(ref.current, { scale: 2, time });
  }, [time]);
  return (
    <div className="town-bg" style={{ position:'absolute', inset:0, overflow:'hidden', ...style }}>
      <canvas ref={ref} style={{ filter: blur ? `blur(${blur}px)` : 'none' }} />
      {dim > 0 && <div style={{ position:'absolute', inset:0, background:`rgba(20,24,16,${dim})` }} />}
    </div>
  );
}

Object.assign(window, { AGENTS, agentById, Sprite, TownBackdrop });
