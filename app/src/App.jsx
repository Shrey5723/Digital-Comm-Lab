import { useState, useEffect, useRef, useCallback, useMemo } from "react";
import "./App.css";

// ═══════════════════════════════════════════════════════════════════
// DSP ENGINE  — one message flows through every stage
// ═══════════════════════════════════════════════════════════════════

// Convert ASCII message → flat bit array
const msgToBits = msg =>
  msg.split("").flatMap(c => {
    const b = c.charCodeAt(0);
    return [7,6,5,4,3,2,1,0].map(i => (b >> i) & 1);
  });

// Bits → continuous analog waveform (simulated baseband via RC low-pass filter)
const bitsToAnalog = (bits, samplesPerBit = 40) => {
  const out = new Float32Array(bits.length * samplesPerBit);
  let val = 0; // low-pass state
  const alpha = 0.15; // RC filter coefficient
  for (let i = 0; i < bits.length; i++) {
    const target = bits[i] === 1 ? 1.0 : -1.0;
    for (let j = 0; j < samplesPerBit; j++) {
      val += alpha * (target - val);
      // Add a small harmonic wobble to give it an authentic 'analog' feel
      const t = (i * samplesPerBit + j) / (bits.length * samplesPerBit);
      const wobble = 0.08 * Math.sin(2 * Math.PI * 12 * t) + 0.04 * Math.sin(2 * Math.PI * 25 * t);
      out[i * samplesPerBit + j] = val * 0.88 + wobble;
    }
  }
  return out;
};

// Analog signal → sample at fs, returning {sampledSig, sampIdx}
const sampleSignal = (analog, fs, signalHz, samplesPerBit) => {
  // analog is NRZ at effective rate = signalHz * samplesPerBit pts per second
  // We re-sample at fs relative to signalHz
  const N = analog.length;
  const ratio = (signalHz * samplesPerBit) / fs; // analog indices per output sample
  const sampIdx = [], sampVals = [];
  for (let i = 0; i * ratio < N; i++) {
    const idx = Math.min(N - 1, Math.round(i * ratio));
    sampIdx.push(idx); sampVals.push(analog[idx]);
  }
  // Reconstruct (ZOH: Zero-Order Hold)
  const recon = new Float32Array(N);
  let currentSamp = 0;
  for (let i = 0; i < N; i++) {
    if (currentSamp < sampIdx.length - 1 && i >= sampIdx[currentSamp + 1]) {
      currentSamp++;
    }
    recon[i] = sampVals[currentSamp];
  }
  return { sampIdx, sampVals, recon };
};

// Quantise a signal to N bits (mapping to extremity levels for visual clarity)
const quantise = (sig, bits) => {
  const levels = Math.pow(2, bits);
  return new Float32Array(sig.map(s => {
    let normalized = (s + 1) / 2;
    let cl = Math.round(normalized * (levels - 1));
    if (cl < 0) cl = 0;
    if (cl >= levels) cl = levels - 1;
    return cl / (levels - 1) * 2 - 1;
  }));
};

// Quantised analog → bit stream representation
const signalToBitStream = (qSig, bits) => {
  const step = 2 / Math.pow(2, bits);
  return Array.from(qSig).map(s => {
    const level = Math.round((s + 1) / step);
    const clamped = Math.max(0, Math.min(Math.pow(2, bits) - 1, level));
    return clamped.toString(2).padStart(bits, "0");
  });
};

// Modulate a bit array → waveform  (ASK / FSK / PSK)
const modulate = (bits, modType, samplesPerBit = 40, fc = 8, askA0 = 0.15, fskDf = 3) => {
  const out = new Float32Array(bits.length * samplesPerBit);
  const df = fskDf;
  for (let i = 0; i < bits.length; i++) {
    const bit = bits[i];
    for (let j = 0; j < samplesPerBit; j++) {
      const t = j / samplesPerBit;
      const idx = i * samplesPerBit + j;
      if (modType === "ASK") out[idx] = (bit ? 1 : askA0) * Math.sin(2 * Math.PI * fc * t);
      else if (modType === "FSK") out[idx] = Math.sin(2 * Math.PI * (fc + (bit ? df : -df)) * t);
      else out[idx] = Math.sin(2 * Math.PI * fc * t + (bit ? 0 : Math.PI)); // BPSK
    }
  }
  return out;
};

// AWGN
const boxMuller = () => { const u = Math.random() || 1e-10, v = Math.random() || 1e-10; return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v); };
const addAWGN = (sig, snrDB) => { const n = 1 / Math.sqrt(Math.pow(10, snrDB / 10)); return new Float32Array(sig.map(s => s + n * boxMuller())); };

// BER
const erfcApprox = x => { const t = 1 / (1 + 0.3275911 * x); return t * (0.254829592 + t * (-0.284496736 + t * (1.421413741 + t * (-1.453152027 + t * 1.061405429)))) * Math.exp(-x * x); };
const berBPSK = snrDB => 0.5 * erfcApprox(Math.sqrt(Math.pow(10, snrDB / 10)));

// Hamming(7,4)
const G74 = [[1,0,0,0,1,1,0],[0,1,0,0,1,0,1],[0,0,1,0,0,1,1],[0,0,0,1,1,1,1]];
const H74 = [[1,1,0,1,1,0,0],[1,0,1,1,0,1,0],[0,1,1,1,0,0,1]];
const hammingEncode = nibble => { const c = new Array(7).fill(0); for (let i=0;i<4;i++) for(let j=0;j<7;j++) c[j]=(c[j]+nibble[i]*G74[i][j])%2; return c; };
const hammingDecode = cw => { const s = new Array(3).fill(0); for(let i=0;i<3;i++) for(let j=0;j<7;j++) s[i]=(s[i]+H74[i][j]*cw[j])%2; const e=s[0]*4+s[1]*2+s[2]; const cor=[...cw]; const map = {6:0, 5:1, 3:2, 7:3, 4:4, 2:5, 1:6}; const errPos = e > 0 && map[e] !== undefined ? map[e] : -1; if(errPos >= 0) cor[errPos]^=1; return {corrected:cor,errPos}; };
const injectErrors = (cw, count) => { const r=[...cw],p=[]; while(p.length<Math.min(count,7)){const x=Math.floor(Math.random()*7);if(!p.includes(x))p.push(x);} p.forEach(x=>r[x]^=1); return {received:r,errorPositions:p}; };
const crc8 = bytes => { let c=0; bytes.forEach(b=>{c^=b;for(let i=0;i<8;i++)c=c&0x80?((c<<1)^0x07)&0xFF:(c<<1)&0xFF;}); return c; };

// ═══════════════════════════════════════════════════════════════════
// THEME
// ═══════════════════════════════════════════════════════════════════
const T = {
  bg:"#F1F5F9", surface:"#FFFFFF", surfaceAlt:"#F8FAFC",
  border:"#E2E8F0", borderStrong:"#CBD5E1",
  text:"#0F172A", textSub:"#475569", textMuted:"#94A3B8",
  blue:"#3B82F6", blueLight:"#EFF6FF",
  teal:"#14B8A6", tealLight:"#F0FDFA",
  amber:"#F59E0B", amberLight:"#FFFBEB",
  red:"#EF4444", redLight:"#FEF2F2",
  green:"#22C55E", greenLight:"#F0FDF4",
  purple:"#8B5CF6", purpleLight:"#F5F3FF",
  canvasBg:"#1E293B", canvasGrid:"rgba(148,163,184,0.12)", canvasGridMid:"rgba(148,163,184,0.25)",
  cyan:"#22D3EE", rose:"#FB7185", indigo:"#6366F1",
};
const font = { sans:"'Inter',system-ui,sans-serif", mono:"'JetBrains Mono',ui-monospace,monospace" };

// ═══════════════════════════════════════════════════════════════════
// CANVAS HELPERS
// ═══════════════════════════════════════════════════════════════════
const setupCanvas = canvas => {
  if (!canvas) return null;
  const dpr = window.devicePixelRatio||1, rect = canvas.getBoundingClientRect();
  if (!rect.width) return null;
  canvas.width = rect.width*dpr; canvas.height = rect.height*dpr;
  const ctx = canvas.getContext("2d"); ctx.scale(dpr,dpr);
  return {ctx, W:rect.width, H:rect.height};
};
const drawBg = (ctx,W,H) => {
  ctx.fillStyle=T.canvasBg; ctx.fillRect(0,0,W,H);
  ctx.strokeStyle=T.canvasGrid; ctx.lineWidth=0.5;
  for(let i=1;i<4;i++){ctx.beginPath();ctx.moveTo(0,H*i/4);ctx.lineTo(W,H*i/4);ctx.stroke();}
  ctx.strokeStyle=T.canvasGridMid; ctx.lineWidth=0.75;
  ctx.beginPath();ctx.moveTo(0,H/2);ctx.lineTo(W,H/2);ctx.stroke();
  // Y-axis labels
  ctx.fillStyle="rgba(148,163,184,0.5)"; ctx.font=`9px ${font.mono}`;
  ctx.fillText("+1",3,H*0.25-3); ctx.fillText("0",3,H*0.5-3); ctx.fillText("-1",3,H*0.75-3);
};
const drawWave = (ctx,sig,color,W,H,ymin=-1,ymax=1,lw=1.5,dashed=false) => {
  if(!sig||!sig.length) return;
  const yR=ymax-ymin; ctx.beginPath(); ctx.strokeStyle=color; ctx.lineWidth=lw;
  if(dashed) ctx.setLineDash([4,4]); else ctx.setLineDash([]);
  for(let i=0;i<sig.length;i++){const x=i/sig.length*W,y=H-(sig[i]-ymin)/yR*H; i===0?ctx.moveTo(x,y):ctx.lineTo(x,y);}
  ctx.stroke(); ctx.setLineDash([]);
};

// ═══════════════════════════════════════════════════════════════════
// SHARED UI ATOMS
// ═══════════════════════════════════════════════════════════════════
const Metric = ({label,value,accent}) => (
  <div className="metric-card" style={{background:T.surface,borderRadius:10,padding:"10px 16px",border:`1px solid ${T.border}`,minWidth:95,boxShadow:"var(--shadow-sm)",borderTop:`3px solid ${accent||T.blue}22`}}>
    <div style={{fontSize:9,color:T.textMuted,marginBottom:5,textTransform:"uppercase",letterSpacing:"0.1em",fontFamily:font.mono,fontWeight:500}}>{label}</div>
    <div style={{fontSize:16,fontWeight:700,color:accent||T.text,fontFamily:font.mono,lineHeight:1}}>{value}</div>
  </div>
);
const Badge = ({children,type="green"}) => {
  const m={green:[T.greenLight,T.green],red:[T.redLight,T.red],amber:[T.amberLight,T.amber],purple:[T.purpleLight,T.purple],blue:[T.blueLight,T.blue]};
  const [bg,fg]=m[type];
  return <span style={{display:"inline-flex",alignItems:"center",gap:4,padding:"4px 12px",borderRadius:99,background:bg,color:fg,fontSize:11,fontWeight:600,fontFamily:font.sans,border:`1px solid ${fg}22`}}>{children}</span>;
};
const Slider = ({label,min,max,step,value,onChange,unit=""}) => {
  const fill = ((value-min)/(max-min))*100;
  return (
    <div style={{display:"flex",alignItems:"center",gap:14,marginBottom:10}}>
      <span style={{fontSize:12,color:T.textSub,minWidth:155,fontFamily:font.sans,fontWeight:500}}>{label}</span>
      <input type="range" min={min} max={max} step={step} value={value} onChange={e=>onChange(Number(e.target.value))} style={{flex:1,maxWidth:220,"--fill":`${fill}%`}}/>
      <span style={{fontSize:13,fontWeight:700,color:T.text,minWidth:78,fontFamily:font.mono,background:T.surfaceAlt,padding:"4px 10px",borderRadius:8,border:`1px solid ${T.border}`,textAlign:"center"}}>{value}{unit}</span>
    </div>
  );
};
const Seg = ({options,value,onChange}) => (
  <div style={{display:"inline-flex",borderRadius:10,overflow:"hidden",background:T.surfaceAlt,border:`1px solid ${T.border}`,padding:2}}>
    {options.map(o=>(
      <button key={o} className="seg-btn" onClick={()=>onChange(o)} style={{padding:"6px 16px",border:"none",borderRadius:8,fontSize:12,fontWeight:600,background:value===o?T.surface:"transparent",color:value===o?T.blue:T.textSub,boxShadow:value===o?"var(--shadow-sm)":"none"}}>{o}</button>
    ))}
  </div>
);
const Card = ({children,style,accent}) => (
  <div className="card-hover" style={{background:T.surface,border:`1px solid ${T.border}`,borderRadius:14,padding:"18px 20px",boxShadow:"var(--shadow-sm)",borderLeft:accent?`4px solid ${accent}`:undefined,...style}}>{children}</div>
);
const SectionLabel = ({children}) => (
  <div style={{fontSize:10,color:T.textMuted,textTransform:"uppercase",letterSpacing:"0.1em",marginBottom:8,marginTop:18,fontFamily:font.mono,fontWeight:600}}>{children}</div>
);
const WavePanel = ({id,height=160,label,note}) => (
  <div style={{marginBottom:14}}>
    {label&&<div style={{display:"flex",alignItems:"baseline",gap:10,marginBottom:6}}>
      <span style={{fontSize:11,color:T.textSub,textTransform:"uppercase",letterSpacing:"0.08em",fontFamily:font.mono,fontWeight:600}}>{label}</span>
      {note&&<span style={{fontSize:10,color:T.textMuted,fontFamily:font.sans}}>— {note}</span>}
    </div>}
    <canvas id={id} className="wave-canvas" style={{width:"100%",height,display:"block"}}/>
  </div>
);
const NavBtn = ({dir,onClick,label}) => (
  <button className="nav-btn" onClick={onClick} style={{display:"flex",alignItems:"center",gap:8,padding:"8px 18px",borderRadius:10,color:T.textSub,fontSize:12,fontWeight:600,fontFamily:font.sans}}>
    {dir==="prev"&&"←"} {label} {dir==="next"&&"→"}
  </button>
);

// ═══════════════════════════════════════════════════════════════════
// TAB 1 — ANALOG SIGNAL
// ═══════════════════════════════════════════════════════════════════
const AnalogTab = ({pipeline, st, dispatch, onTabChange}) => {
  const {analogSig, bits} = pipeline;
  const {sigFreq} = st;
  const raf = useRef();

  const draw = useCallback(()=>{
    const c1 = document.getElementById("cAnalog");
    if(c1&&analogSig){
      const r=setupCanvas(c1); if(!r)return;
      const {ctx,W,H}=r; drawBg(ctx,W,H);
      // Draw bit boundaries
      const spb = Math.floor(analogSig.length / Math.max(bits.length,1));
      ctx.strokeStyle=T.border; ctx.lineWidth=0.5;
      for(let i=1;i<bits.length;i++){const x=i*spb/analogSig.length*W;ctx.beginPath();ctx.moveTo(x,0);ctx.lineTo(x,H);ctx.stroke();}
      drawWave(ctx,analogSig,T.cyan,W,H,-1.2,1.2,2);
      // Label first few bits
      ctx.fillStyle="rgba(148,163,184,0.7)"; ctx.font=`9px ${font.mono}`;
      for(let i=0;i<Math.min(bits.length,20);i++){
        const x=(i+0.5)*spb/analogSig.length*W;
        ctx.fillText(bits[i],x-3,10);
      }
    }
  },[analogSig,bits]);

  useEffect(()=>{raf.current=requestAnimationFrame(draw);return()=>cancelAnimationFrame(raf.current);},[draw]);

  return (
    <div>
      <Card style={{marginBottom:16}}>
        <div style={{fontSize:12,color:T.textSub,marginBottom:12,fontFamily:font.sans}}>
          The message <b style={{fontFamily:font.mono,color:T.text}}>"{st.message}"</b> is converted to an analog signal.
          <br/><br/>
          <b>Logic:</b> Each character is mapped to 8-bit ASCII. This digital sequence forms a square wave, which is then passed through an analog low-pass filter (RC circuit simulation) to create the smooth, continuously varying analog waveform below.
        </div>
        <Slider label="Signal frequency (Hz)" min={100} max={2000} step={50} value={sigFreq} onChange={v=>dispatch({type:"set",key:"sigFreq",value:v})} unit=" Hz"/>
      </Card>
      <div style={{display:"flex",gap:8,flexWrap:"wrap",marginBottom:14}}>
        <Metric label="Bits from message" value={bits.length} accent={T.blue}/>
        <Metric label="Data Rate" value={`${sigFreq} bps`}/>
      </div>
      <WavePanel id="cAnalog" height={180} label="Continuous Analog Waveform" note="smoothed band-limited signal · bit values shown above"/>
      <div style={{display:"flex",justifyContent:"flex-end",marginTop:16}}>
        <NavBtn dir="next" label="Next: PCM" onClick={()=>onTabChange(1)}/>
      </div>
    </div>
  );
};

// ═══════════════════════════════════════════════════════════════════
// TAB 2 — PCM (SAMPLING, QUANTISATION, ENCODING)
// Input: analog signal from Stage 1
// ═══════════════════════════════════════════════════════════════════
const PCMTab = ({pipeline, st, dispatch, onTabChange}) => {
  const {analogSig, quantisedSig, sampledData} = pipeline;
  const {fs, sigFreq, bits: bitDepth} = st;
  const raf = useRef();
  const stepSize = 2/(Math.pow(2,bitDepth)-1);

  const draw = useCallback(()=>{
    const src = sampledData ? sampledData.recon : analogSig;
    // Sampling
    const c2 = document.getElementById("cSampled");
    if(c2&&sampledData&&analogSig){
      const {sampIdx,sampVals,recon} = sampledData;
      const r=setupCanvas(c2); if(!r)return;
      const {ctx,W,H}=r; drawBg(ctx,W,H);
      drawWave(ctx,recon,T.teal+"99",W,H,-1.2,1.2,1.5);
      drawWave(ctx,analogSig,T.cyan,W,H,-1.2,1.2,1.5);
      const N=analogSig.length;
      for(let i=0;i<sampIdx.length;i++){
        const x=sampIdx[i]/N*W, y=H/2-sampVals[i]/2.4*H;
        ctx.strokeStyle=T.amber;ctx.lineWidth=1.5;ctx.beginPath();ctx.moveTo(x,H/2);ctx.lineTo(x,y);ctx.stroke();
        ctx.fillStyle=T.amber;ctx.beginPath();ctx.arc(x,y,3,0,Math.PI*2);ctx.fill();
      }
    }
    // Quantisation — show sampled ZOH signal as input, quantized as output
    const c1=document.getElementById("cQuant");
    const reconSig = sampledData ? sampledData.recon : analogSig;
    if(c1&&reconSig&&quantisedSig){
      const r=setupCanvas(c1); if(!r)return;
      const {ctx,W,H}=r;

      const levels = Math.pow(2, bitDepth);
      const ymin = -1.3, ymax = 1.3, yR = ymax - ymin;
      const toY = v => H - (v - ymin) / yR * H;

      // Background
      ctx.fillStyle=T.canvasBg; ctx.fillRect(0,0,W,H);

      // Draw quantization level grid lines (up to 32 levels)
      if (levels <= 32) {
        for (let i = 0; i < levels; i++) {
          const levelVal = (i / (levels - 1)) * 2 - 1;
          const y = toY(levelVal);
          ctx.strokeStyle = T.purple + "40";
          ctx.lineWidth = 1;
          ctx.setLineDash([3, 5]);
          ctx.beginPath(); ctx.moveTo(0, y); ctx.lineTo(W, y); ctx.stroke();
          // Label on the right
          ctx.fillStyle = T.purple + "AA";
          ctx.font = `bold 9px ${font.mono}`;
          ctx.fillText(`${i}`, W - 16, y - 3);
        }
        ctx.setLineDash([]);
      }

      // Zero line
      ctx.strokeStyle = T.canvasGridMid; ctx.lineWidth = 1;
      ctx.beginPath(); ctx.moveTo(0, toY(0)); ctx.lineTo(W, toY(0)); ctx.stroke();

      // Draw sampled ZOH reconstruction (blue, thin) — this is the INPUT to quantization
      ctx.beginPath(); ctx.strokeStyle = T.blue; ctx.lineWidth = 1.5;
      for (let i = 0; i < reconSig.length; i++) {
        const x = i / reconSig.length * W, y = toY(reconSig[i]);
        i === 0 ? ctx.moveTo(x, y) : ctx.lineTo(x, y);
      }
      ctx.stroke();

      // Draw quantized staircase (teal, thick) — this is the OUTPUT
      ctx.beginPath(); ctx.strokeStyle = T.teal; ctx.lineWidth = 2.5;
      for (let i = 0; i < quantisedSig.length; i++) {
        const x = i / quantisedSig.length * W, y = toY(quantisedSig[i]);
        i === 0 ? ctx.moveTo(x, y) : ctx.lineTo(x, y);
      }
      ctx.stroke();

      // Highlight quantization error as filled area between input and output
      ctx.fillStyle = T.amber + "25";
      ctx.beginPath();
      for (let i = 0; i < reconSig.length; i++) {
        const x = i / reconSig.length * W;
        i === 0 ? ctx.moveTo(x, toY(reconSig[i])) : ctx.lineTo(x, toY(reconSig[i]));
      }
      for (let i = reconSig.length - 1; i >= 0; i--) {
        const x = i / reconSig.length * W;
        ctx.lineTo(x, toY(quantisedSig[i]));
      }
      ctx.closePath(); ctx.fill();
    }
    // Encoding
    const grid=document.getElementById("bitGrid");
    if(grid&&sampledData&&sampledData.sampVals){
      const { sampVals } = sampledData;
      const maxS=Math.min(32,sampVals.length), bpp=Math.min(bitDepth,8);
      grid.innerHTML="";
      for(let i=0;i<maxS;i++){
        const s = sampVals[i];
        const levels = Math.pow(2, bitDepth);
        let normalized = (s + 1) / 2;
        let cl = Math.round(normalized * (levels - 1));
        if(cl < 0) cl = 0;
        if(cl >= levels) cl = levels - 1;
        const bin=cl.toString(2).padStart(bpp,"0");
        for(let b=0;b<bin.length;b++){
          const el=document.createElement("div"),one=bin[b]==="1";
          el.textContent=bin[b];
          el.style.cssText=`width:19px;height:21px;display:flex;align-items:center;justify-content:center;border-radius:4px;font-size:11px;font-family:${font.mono};font-weight:500;border:1px solid ${one?T.blue+"55":T.border};background:${one?T.blueLight:T.surfaceAlt};color:${one?T.blue:T.textMuted}`;
          grid.appendChild(el);
        }
        if(i<maxS-1){const sp=document.createElement("div");sp.style.width="3px";grid.appendChild(sp);}
      }
    }
  },[analogSig,quantisedSig,sampledData,bitDepth,stepSize]);

  useEffect(()=>{raf.current=requestAnimationFrame(draw);return()=>cancelAnimationFrame(raf.current);},[draw]);

  const aliasing = sigFreq > fs/2;
  const nyquist = fs/2;

  return (
    <div>
      <Card style={{marginBottom:16}}>
        <div style={{fontSize:12,color:T.textSub,marginBottom:12,fontFamily:font.sans}}>
          <b>Step 1: Sampling</b> — The analog signal is sampled at your chosen rate.
        </div>
        <Slider label="Sampling frequency (Hz)" min={200} max={10000} step={100} value={fs} onChange={v=>dispatch({type:"set",key:"fs",value:v})} unit=" Hz"/>
        <div style={{display:"flex",gap:8,flexWrap:"wrap",marginTop:10}}>
          <Metric label="Nyquist ratio" value={`${(fs/(2*sigFreq)).toFixed(2)}×`} accent={aliasing?T.red:T.green}/>
          <Metric label="Nyquist limit" value={`${nyquist} Hz`}/>
          <Metric label="Status" value={aliasing?<Badge type="red">Aliasing!</Badge>:<Badge type="green">OK</Badge>}/>
        </div>
      </Card>
      <WavePanel id="cSampled" height={140} label="Sampled signal" note="cyan = original · amber = samples · teal = reconstructed"/>
      
      <Card style={{marginTop:16,marginBottom:16}}>
        <div style={{fontSize:12,color:T.textSub,marginBottom:12,fontFamily:font.sans}}>
          <b>Step 2: Quantisation</b> — The sampled signal is mapped to {Math.pow(2,bitDepth).toLocaleString()} discrete levels.
        </div>
        <Slider label="Bit depth (Encoding)" min={1} max={16} step={1} value={bitDepth} onChange={v=>dispatch({type:"set",key:"bits",value:v})} unit=" bits"/>
        <div style={{display:"flex",gap:8,flexWrap:"wrap",marginTop:10}}>
          <Metric label="Bit depth" value={`${bitDepth} bits`}/>
          <Metric label="SQNR" value={`${(6.02*bitDepth+1.76).toFixed(1)} dB`} accent={T.blue}/>
          <Metric label="Step size" value={(2/(Math.pow(2,bitDepth)-1)).toFixed(5)}/>
        </div>
      </Card>
      <WavePanel id="cQuant" height={200} label="Quantisation" note="blue = analog input · teal = quantized staircase · amber fill = quantization error"/>
      
      <SectionLabel>Step 3: Encoding (Binary bitstream — first 32 samples)</SectionLabel>
      <div id="bitGrid" style={{display:"flex",flexWrap:"wrap",gap:2,marginBottom:8}}/>
      
      <div style={{display:"flex",justifyContent:"space-between",marginTop:16}}>
        <NavBtn dir="prev" label="Back: Analog Signal" onClick={()=>onTabChange(0)}/>
        <NavBtn dir="next" label="Next: Modulation" onClick={()=>onTabChange(2)}/>
      </div>
    </div>
  );
};

// ═══════════════════════════════════════════════════════════════════
// TAB 3 — MODULATION
// Input: bits from message, quantised signal from Stage 2
// ═══════════════════════════════════════════════════════════════════
const ModTab = ({pipeline, st, dispatch, onTabChange}) => {
  const {bits, modulatedSig, quantisedSig} = pipeline;
  const {modType} = st;
  const raf = useRef();

  const draw = useCallback(()=>{
    const c1=document.getElementById("cBB");
    if(c1&&quantisedSig){
      const r=setupCanvas(c1); if(!r)return;
      const {ctx,W,H}=r;
      const levels = Math.pow(2, st.bits);
      const ymin = -1.3, ymax = 1.3, yR = ymax - ymin;
      const toY = v => H - (v - ymin) / yR * H;

      // Background
      ctx.fillStyle=T.canvasBg; ctx.fillRect(0,0,W,H);

      // Draw quantization level grid lines (up to 16 levels for clarity)
      if (levels <= 16) {
        for (let i = 0; i < levels; i++) {
          const levelVal = (i / (levels - 1)) * 2 - 1;
          const y = toY(levelVal);
          ctx.strokeStyle = T.purple + "30";
          ctx.lineWidth = 1;
          ctx.setLineDash([3, 5]);
          ctx.beginPath(); ctx.moveTo(0, y); ctx.lineTo(W, y); ctx.stroke();
        }
        ctx.setLineDash([]);
      }

      // Zero line
      ctx.strokeStyle = T.canvasGridMid; ctx.lineWidth = 0.75;
      ctx.beginPath(); ctx.moveTo(0, toY(0)); ctx.lineTo(W, toY(0)); ctx.stroke();

      // Draw quantized signal
      ctx.beginPath(); ctx.strokeStyle = T.amber; ctx.lineWidth = 2;
      for (let i = 0; i < quantisedSig.length; i++) {
        const x = i / quantisedSig.length * W, y = toY(quantisedSig[i]);
        i === 0 ? ctx.moveTo(x, y) : ctx.lineTo(x, y);
      }
      ctx.stroke();
    }
    const c2=document.getElementById("cModOut");
    if(c2&&modulatedSig){
      const r=setupCanvas(c2); if(!r)return;
      const {ctx,W,H}=r; drawBg(ctx,W,H);
      drawWave(ctx,modulatedSig,T.blue,W,H,-1.3,1.3,1.6);
      const spb=Math.floor(modulatedSig.length/Math.max(bits.length,1));
      if(modType==="PSK"){
        ctx.strokeStyle=T.red+"88";ctx.lineWidth=1;ctx.setLineDash([2,3]);
        for(let i=1;i<bits.length;i++) if(bits[i]!==bits[i-1]){const x=i*spb/modulatedSig.length*W;ctx.beginPath();ctx.moveTo(x,0);ctx.lineTo(x,H);ctx.stroke();}
        ctx.setLineDash([]);
      }
      if(modType==="FSK"){
        ctx.fillStyle=T.blue+"10";ctx.fillRect(0,0,W,H*0.46);
        ctx.fillStyle=T.teal+"0D";ctx.fillRect(0,H*0.54,W,H*0.46);
        ctx.fillStyle=T.blue+"88";ctx.font=`10px ${font.mono}`;ctx.fillText("f_hi",5,13);
        ctx.fillStyle=T.teal+"88";ctx.fillText("f_lo",5,H-5);
      }
      // Bit boundary markers
      ctx.strokeStyle=T.borderStrong+"88";ctx.lineWidth=0.5;ctx.setLineDash([1,3]);
      for(let i=1;i<bits.length;i++){const x=i*spb/modulatedSig.length*W;ctx.beginPath();ctx.moveTo(x,0);ctx.lineTo(x,H);ctx.stroke();}
      ctx.setLineDash([]);
    }
    // Constellation
    const cC=document.getElementById("cConst");
    if(cC){
      cC.width=170;cC.height=170;
      const ctx=cC.getContext("2d"),W=170,H=170;
      ctx.fillStyle=T.canvasBg;ctx.fillRect(0,0,W,H);
      ctx.strokeStyle=T.canvasGrid;ctx.lineWidth=0.5;
      ctx.beginPath();ctx.moveTo(W/2,0);ctx.lineTo(W/2,H);ctx.stroke();
      ctx.beginPath();ctx.moveTo(0,H/2);ctx.lineTo(W,H/2);ctx.stroke();
      ctx.fillStyle=T.textMuted;ctx.font=`9px ${font.mono}`;
      ctx.fillText("I",W-10,H/2-5);ctx.fillText("Q",W/2+5,11);
      const pts=modType==="ASK"?[{x:.12,y:0,c:T.teal,l:"0"},{x:1,y:0,c:T.amber,l:"1"}]
        :modType==="FSK"?[{x:.7,y:.5,c:T.blue,l:"1"},{x:.7,y:-.5,c:T.amber,l:"0"}]
        :[{x:1,y:0,c:T.amber,l:"1"},{x:-1,y:0,c:T.blue,l:"0"}];
      pts.forEach(p=>{
        ctx.fillStyle=p.c+"2A";ctx.beginPath();ctx.arc(W/2+p.x*W*.38,H/2-p.y*H*.38,13,0,Math.PI*2);ctx.fill();
        ctx.fillStyle=p.c;ctx.beginPath();ctx.arc(W/2+p.x*W*.38,H/2-p.y*H*.38,5,0,Math.PI*2);ctx.fill();
        ctx.fillStyle=T.textSub;ctx.font=`bold 10px ${font.mono}`;ctx.fillText(p.l,W/2+p.x*W*.38+10,H/2-p.y*H*.38+4);
      });
    }
  },[bits,modulatedSig,quantisedSig,modType,st.bits]);

  useEffect(()=>{raf.current=requestAnimationFrame(draw);return()=>cancelAnimationFrame(raf.current);},[draw]);

  const formulas={ASK:"A(t) = bit × sin(2πfct)",FSK:"f(t) = fc + bit × Δf",PSK:"φ(t) = bit × π (BPSK)"};
  return (
    <div>
      <Card style={{marginBottom:16}}>
        <div style={{fontSize:12,color:T.textSub,marginBottom:12,fontFamily:font.sans}}>
          The quantised signal from Stage 2 is modulated onto a carrier. Choose a scheme — the same message bits drive all three.
        </div>
        <div style={{display:"flex",gap:16,flexWrap:"wrap",alignItems:"center",marginBottom:16}}>
          <div style={{display:"flex",alignItems:"center",gap:10}}>
            <span style={{fontSize:12,color:T.textSub,fontFamily:font.sans}}>Scheme</span>
            <Seg options={["ASK","FSK","PSK"]} value={modType} onChange={v=>dispatch({type:"set",key:"modType",value:v})}/>
          </div>
          <code style={{fontSize:11,color:T.textSub,fontFamily:font.mono,background:T.surfaceAlt,padding:"3px 10px",borderRadius:6,border:`1px solid ${T.border}`}}>{formulas[modType]}</code>
        </div>
        <div style={{display:"flex",flexDirection:"column"}}>
          <div><Slider label="Carrier Freq (fc)" min={2} max={16} step={1} value={st.fc} onChange={v=>dispatch({type:"set",key:"fc",value:v})} unit=" Hz"/></div>
          {modType === "ASK" && <div><Slider label="ASK '0' Amplitude" min={0} max={1} step={0.05} value={st.askA0} onChange={v=>dispatch({type:"set",key:"askA0",value:v})} unit=""/></div>}
          {modType === "FSK" && <div><Slider label="FSK Deviation (Δf)" min={1} max={6} step={0.5} value={st.fskDf} onChange={v=>dispatch({type:"set",key:"fskDf",value:v})} unit=" Hz"/></div>}
        </div>
      </Card>
      <WavePanel id="cBB" height={140} label="Quantised input signal" note={`from Stage 2 — ${Math.pow(2,st.bits)} levels (${st.bits}-bit)`}/>
      <WavePanel id="cModOut" height={160} label="Modulated output" note={modType==="PSK"?"red dashed = phase flip":modType==="FSK"?"f_hi / f_lo bands shown":"amplitude keying"}/>
      <div style={{display:"flex",gap:16,alignItems:"flex-start",marginTop:4}}>
        <div>
          <SectionLabel>IQ Constellation</SectionLabel>
          <canvas id="cConst" style={{borderRadius:9,border:`1px solid ${T.border}`}}/>
        </div>
        <div style={{flex:1,padding:"24px 0 0"}}>
          <div style={{fontSize:12,color:T.textSub,fontFamily:font.sans,lineHeight:1.9}}>
            <b style={{color:T.text}}>{bits.length}</b> bits from your message are modulated.<br/>
            Each bit maps to one symbol on the carrier wave.
          </div>
        </div>
      </div>
      <div style={{display:"flex",justifyContent:"space-between",marginTop:16}}>
        <NavBtn dir="prev" label="Back: PCM" onClick={()=>onTabChange(1)}/>
        <NavBtn dir="next" label="Next: Noise" onClick={()=>onTabChange(3)}/>
      </div>
    </div>
  );
};

// ═══════════════════════════════════════════════════════════════════
// TAB 4 — NOISE
// Input: modulated signal from Stage 3
// ═══════════════════════════════════════════════════════════════════
const NoiseTab = ({pipeline, st, dispatch, onTabChange}) => {
  const {modulatedSig, noisySig} = pipeline;
  const {noisePower} = st;
  const [simResult, setSimResult] = useState(null);
  const raf = useRef();

  const draw = useCallback(()=>{
    [["cModClean",modulatedSig,T.blue,-1.3,1.3,1.5],["cModNoisy",noisySig,T.red,-2.5,2.5,1]].forEach(([id,data,col,mn,mx,lw])=>{
      const c=document.getElementById(id); if(!c||!data)return;
      const r=setupCanvas(c); if(!r)return;
      const {ctx,W,H}=r; drawBg(ctx,W,H); drawWave(ctx,data,col,W,H,mn,mx,lw);
    });
    const cE=document.getElementById("cEye");
    if(cE&&noisySig){
      const r=setupCanvas(cE); if(!r)return;
      const {ctx,W,H}=r; drawBg(ctx,W,H);
      const sl=Math.max(8,Math.floor(noisySig.length/Math.max(pipeline.bits.length,1))*2);
      for(let s=0;s+sl<noisySig.length;s+=sl) drawWave(ctx,noisySig.slice(s,s+sl),T.teal+"55",W,H,-2,2,1);
    }
    const cB=document.getElementById("cBER");
    if(cB){
      const r=setupCanvas(cB); if(!r)return;
      const {ctx,W,H}=r; drawBg(ctx,W,H);
      const mn=1e-6,mx=0.5,lMn=Math.log10(mn),lMx=Math.log10(mx);
      ctx.strokeStyle=T.canvasGrid;ctx.lineWidth=0.5;
      [5,10,15,20,25].forEach(db=>{const x=db/30*W;ctx.beginPath();ctx.moveTo(x,0);ctx.lineTo(x,H);ctx.stroke();ctx.fillStyle=T.textMuted;ctx.font=`9px ${font.mono}`;ctx.fillText(db,x-6,H-3);});
      [0.1,0.01,0.001,0.0001].forEach(b=>{const y=H-(Math.log10(b)-lMn)/(lMx-lMn)*H;ctx.beginPath();ctx.moveTo(0,y);ctx.lineTo(W,y);ctx.stroke();});
      ctx.beginPath();ctx.strokeStyle=T.teal;ctx.lineWidth=2.2;
      for(let db=0;db<=30;db+=0.5){const b=berBPSK(db),x=db/30*W,y=H-(Math.log10(Math.max(b,mn))-lMn)/(lMx-lMn)*H;db===0?ctx.moveTo(x,y):ctx.lineTo(x,y);}
      ctx.stroke();
      const cb=berBPSK(noisePower),cx=noisePower/30*W,cy=H-(Math.log10(Math.max(cb,mn))-lMn)/(lMx-lMn)*H;
      ctx.fillStyle=T.amber;ctx.beginPath();ctx.arc(cx,cy,5.5,0,Math.PI*2);ctx.fill();
      ctx.strokeStyle=T.amber+"55";ctx.lineWidth=1;ctx.setLineDash([2,3]);ctx.beginPath();ctx.moveTo(cx,0);ctx.lineTo(cx,H);ctx.stroke();ctx.setLineDash([]);
      if(simResult!==null){const sy=H-(Math.log10(Math.max(simResult,mn))-lMn)/(lMx-lMn)*H;ctx.fillStyle=T.red;ctx.beginPath();ctx.arc(cx,sy,5.5,0,Math.PI*2);ctx.fill();}
      ctx.fillStyle=T.textMuted;ctx.font=`9px ${font.mono}`;ctx.fillText("BER",4,11);ctx.fillText("0dB",2,H-3);
    }
  },[modulatedSig,noisySig,noisePower,simResult,pipeline.bits]);

  useEffect(()=>{raf.current=requestAnimationFrame(draw);return()=>cancelAnimationFrame(raf.current);},[draw]);

  const runSim=()=>{
    const snrL=Math.pow(10,noisePower/10),ns=1/Math.sqrt(snrL);let err=0;
    for(let i=0;i<1000;i++){const b=Math.random()>.5?1:-1;if((b+ns*boxMuller())*b<0)err++;}
    setSimResult(err/1000);
  };
  const ber=berBPSK(noisePower);
  return (
    <div>
      <Card style={{marginBottom:16}}>
        <div style={{fontSize:12,color:T.textSub,marginBottom:12,fontFamily:font.sans}}>
          AWGN noise is added to the modulated signal from Stage 3. Drag SNR to see how noise degrades your message signal — and watch the eye diagram close.
        </div>
        <Slider label="SNR" min={0} max={30} step={1} value={noisePower} onChange={v=>dispatch({type:"set",key:"noisePower",value:v})} unit=" dB"/>
      </Card>
      <div style={{display:"flex",gap:8,flexWrap:"wrap",marginBottom:14}}>
        <Metric label="SNR" value={`${noisePower} dB`}/>
        <Metric label="BER (BPSK)" value={ber<0.001?ber.toExponential(2):ber.toFixed(4)} accent={ber>.01?T.red:T.green}/>
        <Metric label="Noise σ" value={(1/Math.sqrt(Math.pow(10,noisePower/10))).toFixed(3)}/>
        {simResult!==null&&<Metric label="Empirical BER" value={simResult.toFixed(4)} accent={T.red}/>}
      </div>
      <WavePanel id="cModClean" height={120} label="Modulated signal" note="from Stage 3"/>
      <WavePanel id="cModNoisy" height={120} label="After AWGN noise"/>
      <WavePanel id="cEye" height={160} label="Eye diagram — overlaid symbol periods"/>
      <div style={{display:"grid",gridTemplateColumns:"1fr auto",gap:16,marginTop:8,alignItems:"start"}}>
        <WavePanel id="cBER" height={180} label="BER vs SNR" note="teal = BPSK theory · amber = current · red = simulation"/>
        <div style={{paddingTop:20}}>
          <button className="sbtn" onClick={runSim} style={{padding:"9px 16px",border:`1px solid ${T.blue}66`,borderRadius:8,background:T.blueLight,color:T.blue,cursor:"pointer",fontSize:12,fontWeight:600,fontFamily:font.sans,whiteSpace:"nowrap",transition:"all .13s"}}>Run 1000-bit sim →</button>
          {simResult!==null&&<div style={{marginTop:12,fontSize:12,fontFamily:font.mono,lineHeight:2,color:T.textSub,background:T.surfaceAlt,borderRadius:8,padding:"10px 12px",border:`1px solid ${T.border}`}}>
            Errors: <b style={{color:T.red}}>{Math.round(simResult*1000)}</b><br/>
            Empirical: <b style={{color:T.red}}>{simResult.toFixed(4)}</b><br/>
            Theory: <b style={{color:T.teal}}>{ber.toFixed(4)}</b>
          </div>}
        </div>
      </div>
      <div style={{display:"flex",justifyContent:"space-between",marginTop:16}}>
        <NavBtn dir="prev" label="Back: Modulation" onClick={()=>onTabChange(2)}/>
        <NavBtn dir="next" label="Next: Error Correction" onClick={()=>onTabChange(3)}/>
      </div>
    </div>
  );
};

// ═══════════════════════════════════════════════════════════════════
// TAB 5 — ERROR CORRECTION
// Input: bits from the message, corrupted by noise stage
// ═══════════════════════════════════════════════════════════════════
const ECTab = ({pipeline, st, dispatch, onTabChange}) => {
  const {bits, message} = pipeline;
  const {codingScheme, errorsPerCW} = st;

  const BitRow = ({bits:bts,label,parity=[],errors=[]}) => (
    <div style={{display:"flex",alignItems:"center",gap:8,marginBottom:5}}>
      <span style={{fontSize:10,color:T.textMuted,width:66,textAlign:"right",flexShrink:0,textTransform:"uppercase",letterSpacing:"0.07em",fontFamily:font.mono}}>{label}</span>
      <div style={{display:"flex",gap:2,flexWrap:"wrap"}}>
        {bts.map((b,i)=>{
          let bg=b?T.blueLight:T.surfaceAlt,color=b?T.blue:T.textMuted,border=`1px solid ${b?T.blue+"44":T.border}`;
          if(parity.includes(i)){bg=T.purpleLight;color=T.purple;border=`1px solid ${T.purple}55`;}
          if(errors.includes(i)){bg=T.redLight;color=T.red;border=`1px solid ${T.red}66`;}
          return <div key={i} style={{width:25,height:25,display:"flex",alignItems:"center",justifyContent:"center",borderRadius:5,fontSize:12,fontFamily:font.mono,fontWeight:600,background:bg,color,border,transition:"all .15s"}}>{b}</div>;
        })}
      </div>
    </div>
  );

  const renderHamming = () => {
    // Encode every character in the message, not just first 3
    const chars = message.split("");
    let decodedMessage = "";
    
    const elements = chars.map((ch,ci)=>{
      const byte=ch.charCodeAt(0);
      // Encode both nibbles for full byte fidelity
      const nibbles=[
        [(byte>>7)&1,(byte>>6)&1,(byte>>5)&1,(byte>>4)&1],
        [(byte>>3)&1,(byte>>2)&1,(byte>>1)&1,(byte>>0)&1],
      ];
      let reconstructedByte = 0;
      
      const nibbleViews = nibbles.map((nibble,ni)=>{
        const cw=hammingEncode(nibble);
        const {received,errorPositions}=injectErrors(cw,errorsPerCW);
        const {corrected,errPos}=hammingDecode(received);
        const correctedNibble=corrected.slice(0,4);
        const decodedByte=nibble.reduce((a,b,i)=>a|(b<<(3-i)),0);
        const correctedVal=correctedNibble.reduce((a,b,i)=>a|(b<<(3-i)),0);
        reconstructedByte |= (correctedVal << (ni===0?4:0));
        return (
          <div key={ni} style={{marginBottom:ni===0?12:0,paddingBottom:ni===0?12:0,borderBottom:ni===0?`1px solid ${T.border}`:"none"}}>
            <div style={{fontSize:10,color:T.textMuted,fontFamily:font.mono,marginBottom:8}}>
              {ni===0?"High":"Low"} nibble: <b style={{color:T.amber}}>{nibble.join("")}</b>
            </div>
            <BitRow bits={cw} label="encoded" parity={[4,5,6]}/>
            <BitRow bits={received} label="received" errors={errorPositions}/>
            <BitRow bits={corrected} label="corrected" parity={[4,5,6]} errors={errPos>=0?[errPos]:[]}/>
            <div style={{marginTop:8,display:"flex",gap:6,flexWrap:"wrap",alignItems:"center"}}>
              {errorsPerCW===0&&<Badge type="green">No errors injected</Badge>}
              {errPos>=0&&errorsPerCW===1&&<Badge type="green">✓ Corrected bit {errPos+1}</Badge>}
              {errorsPerCW>1&&<Badge type="amber">⚠ Multiple errors</Badge>}
              {decodedByte!==correctedVal?
                <Badge type="red">Nibble changed: {decodedByte} → {correctedVal}</Badge>:
                errorsPerCW>0?<Badge type="green">Nibble intact after correction</Badge>:null}
            </div>
          </div>
        );
      });
      
      const isPrintable = reconstructedByte >= 32 && reconstructedByte <= 126;
      const decodedChar = isPrintable ? String.fromCharCode(reconstructedByte) : "";
      decodedMessage += decodedChar;

      return (
        <Card key={ci} style={{marginBottom:12}}>
          <div style={{display:"flex",alignItems:"center",gap:10,marginBottom:10}}>
            <span style={{fontSize:14,fontWeight:700,fontFamily:font.mono,color:T.text,background:T.blueLight,padding:"3px 10px",borderRadius:6}}>{ch}</span>
            <span style={{fontSize:11,color:T.textSub,fontFamily:font.mono}}>ASCII 0x{byte.toString(16).toUpperCase().padStart(2,"0")} = {byte.toString(2).padStart(8,"0")}</span>
            <span style={{fontSize:14,fontWeight:700,fontFamily:font.mono,color:byte===reconstructedByte?T.green:T.red,background:byte===reconstructedByte?T.greenLight:T.redLight,padding:"3px 10px",borderRadius:6,marginLeft:"auto"}}>→ {decodedChar}</span>
          </div>
          {nibbleViews}
        </Card>
      );
    });

    return (
      <>
        <Card style={{marginBottom:16}}>
          <div style={{fontSize:12,color:T.textSub,marginBottom:6,fontFamily:font.sans}}>Final Output Message:</div>
          <div style={{fontSize:18,fontWeight:700,fontFamily:font.mono,color:message===decodedMessage?T.green:T.red}}>{decodedMessage}</div>
        </Card>
        {elements}
      </>
    );
  };

  const renderCRC = () => {
    const msgBytes=message.split("").map(c=>c.charCodeAt(0));
    
    // Simulate error in message if errorsPerCW > 0
    const receivedBytes = [...msgBytes];
    if (errorsPerCW > 0) {
       for(let i=0; i<Math.min(errorsPerCW, receivedBytes.length); i++) {
          receivedBytes[i] ^= (1 << (Math.floor(Math.random() * 8))); // flip a random bit in this byte
       }
    }
    
    const cs=crc8(msgBytes);
    const eb=crc8(receivedBytes);
    const ok=eb===cs && message === receivedBytes.map(b => String.fromCharCode(b)).join("");
    
    const decodedMessage = receivedBytes.map(b => (b >= 32 && b <= 126) ? String.fromCharCode(b) : "").join("");

    return (
      <>
      <Card style={{marginBottom:16}}>
        <div style={{fontSize:12,color:T.textSub,marginBottom:6,fontFamily:font.sans}}>Final Output Message:</div>
        <div style={{fontSize:18,fontWeight:700,fontFamily:font.mono,color:message===decodedMessage?T.green:T.red}}>{decodedMessage}</div>
      </Card>
      <Card>
        <div style={{fontSize:12,color:T.textSub,marginBottom:12,fontFamily:font.sans}}>
          CRC-8 checksum for the full message <b style={{fontFamily:font.mono,color:T.text}}>"{message}"</b>:
        </div>
        <div style={{fontFamily:font.mono,fontSize:12,lineHeight:2.2,color:T.textSub}}>
          <div><span style={{fontSize:9,color:T.textMuted,textTransform:"uppercase",letterSpacing:"0.07em",display:"inline-block",width:160}}>Message bytes</span>
            {msgBytes.map((b,i)=><span key={i} style={{color:T.blue,marginRight:6,background:T.blueLight,padding:"0 6px",borderRadius:4}}>0x{b.toString(16).padStart(2,"0").toUpperCase()}</span>)}
          </div>
          <div><span style={{fontSize:9,color:T.textMuted,textTransform:"uppercase",letterSpacing:"0.07em",display:"inline-block",width:160}}>Original CRC</span>
            <span style={{color:T.amber,background:T.amberLight,padding:"0 6px",borderRadius:4}}>0x{cs.toString(16).padStart(2,"0").toUpperCase()}</span>
          </div>
          <div><span style={{fontSize:9,color:T.textMuted,textTransform:"uppercase",letterSpacing:"0.07em",display:"inline-block",width:160}}>Received MSG bytes</span>
            {receivedBytes.map((b,i)=><span key={i} style={{color:b===msgBytes[i]?T.blue:T.red,marginRight:6,background:b===msgBytes[i]?T.blueLight:T.redLight,padding:"0 6px",borderRadius:4}}>0x{b.toString(16).padStart(2,"0").toUpperCase()}</span>)}
          </div>
          <div><span style={{fontSize:9,color:T.textMuted,textTransform:"uppercase",letterSpacing:"0.07em",display:"inline-block",width:160}}>Received CRC</span>
            <span style={{color:ok?T.green:T.red,background:ok?T.greenLight:T.redLight,padding:"0 6px",borderRadius:4}}>0x{eb.toString(16).padStart(2,"0").toUpperCase()}</span>
          </div>
        </div>
        <div style={{marginTop:12}}>{ok?<Badge type="green">✓ CRC OK — no errors</Badge>:<Badge type="red">✗ CRC mismatch — error detected</Badge>}</div>
      </Card>
      </>
    );
  };

  return (
    <div>
      <Card style={{marginBottom:16}}>
        <div style={{fontSize:12,color:T.textSub,marginBottom:12,fontFamily:font.sans}}>
          The {bits.length}-bit stream for <b style={{fontFamily:font.mono,color:T.text}}>"{message}"</b> is protected with error-correcting codes before transmission, then decoded at the receiver.
        </div>
        <div style={{display:"flex",gap:16,flexWrap:"wrap",alignItems:"center",marginBottom:10}}>
          <div style={{display:"flex",alignItems:"center",gap:10}}>
            <span style={{fontSize:12,color:T.textSub,fontFamily:font.sans}}>Scheme</span>
            <Seg options={["hamming","crc8"]} value={codingScheme} onChange={v=>dispatch({type:"set",key:"codingScheme",value:v})}/>
          </div>
        </div>
        <Slider label="Errors per codeword" min={0} max={3} step={1} value={errorsPerCW} onChange={v=>dispatch({type:"set",key:"errorsPerCW",value:v})}/>
      </Card>
      {codingScheme==="hamming"&&(
        <div style={{marginBottom:10,fontSize:11,color:T.textMuted,fontFamily:font.sans,lineHeight:1.7}}>
          <span style={{color:T.purple,fontWeight:700}}>■</span> purple = parity bits &nbsp;·&nbsp;
          <span style={{color:T.red,fontWeight:700}}>■</span> red = injected error &nbsp;·&nbsp;
          Each character is split into two 4-bit nibbles, each encoded as a Hamming(7,4) codeword.
        </div>
      )}
      {codingScheme==="hamming"?renderHamming():renderCRC()}
      <div style={{display:"flex",justifyContent:"flex-start",marginTop:16}}>
        <NavBtn dir="prev" label="Back: Noise" onClick={()=>onTabChange(3)}/>
      </div>
    </div>
  );
};

// ═══════════════════════════════════════════════════════════════════
// PIPELINE HEADER
// ═══════════════════════════════════════════════════════════════════
const StepperNav = ({st, pipeline, activeTab, onTabChange}) => {
  const aliasing = st.sigFreq > st.fs/2;
  const ber = berBPSK(st.noisePower);
  const steps = [
    {name:"Analog",icon:"〜",metric:`${st.sigFreq} Hz`},
    {name:"PCM",icon:"⊞",metric:`${st.fs}Hz · ${st.bits}b`,warn:aliasing},
    {name:"Modulate",icon:"∿",metric:st.modType},
    {name:"Noise",icon:"⚡",metric:`${st.noisePower} dB`},
    {name:"Decode",icon:"✓",metric:ber<0.001?"BER < 0.001":`BER ${ber.toFixed(3)}`},
  ];
  return (
    <div style={{display:"flex",alignItems:"center",justifyContent:"center",padding:"10px 0",gap:0}}>
      {steps.map((s,i)=>{
        const active=i===activeTab, done=i<activeTab;
        return (
          <div key={i} style={{display:"flex",alignItems:"center",flexShrink:0}} className="step-node">
            <div onClick={()=>onTabChange(i)} style={{display:"flex",flexDirection:"column",alignItems:"center",gap:4,cursor:"pointer",minWidth:72,padding:"4px 6px"}}>
              <div className="step-circle" style={{
                width:32,height:32,borderRadius:"50%",display:"flex",alignItems:"center",justifyContent:"center",
                fontSize:active?14:12,fontWeight:700,fontFamily:font.mono,
                background:active?T.blue:done?T.green+"18":T.surfaceAlt,
                color:active?"#fff":done?T.green:T.textMuted,
                border:`2px solid ${active?T.blue:done?T.green+"44":T.border}`,
                boxShadow:active?"0 0 0 4px rgba(59,130,246,0.15)":"none",
                transition:"all 0.2s ease"
              }}>{done?"✓":i+1}</div>
              <span className="step-label" style={{fontSize:10,fontWeight:600,color:active?T.blue:done?T.green:T.textMuted,fontFamily:font.sans,whiteSpace:"nowrap"}}>{s.name}</span>
              <span className="step-metric" style={{fontSize:9,fontWeight:500,color:s.warn?T.red:active?T.blue:T.textMuted,fontFamily:font.mono}}>{s.metric}</span>
            </div>
            {i<steps.length-1&&<div style={{width:40,height:2,background:i<activeTab?T.green+"44":T.border,borderRadius:1,flexShrink:0,transition:"background 0.3s"}}/>}
          </div>
        );
      })}
    </div>
  );
};

// ═══════════════════════════════════════════════════════════════════
// APP ROOT
// ═══════════════════════════════════════════════════════════════════

export default function App() {
  const [tab, setTab] = useState(0);
  const [st, setSt] = useState({
    message:"HELLO",
    sigFreq:800, fs:6400, bits:8,
    modType:"PSK", fc:8, askA0:0.15, fskDf:3, noisePower:12,
    codingScheme:"hamming", errorsPerCW:1,
  });

  const dispatch = useCallback(action => setSt(s => {
    if(action.type==="set") return {...s,[action.key]:action.value};
    return s;
  }),[]);

  const pipeline = useMemo(()=>{
    const message = st.message || "HELLO";
    const bits = msgToBits(message);
    const SPB = 48;
    const analogSig = bitsToAnalog(bits, SPB);
    const sampledData = sampleSignal(analogSig, st.fs, st.sigFreq, SPB);
    const quantisedSig = quantise(sampledData.recon, st.bits);
    const modulatedSig = modulate(bits, st.modType, SPB, st.fc, st.askA0, st.fskDf);
    const noisySig = addAWGN(modulatedSig, st.noisePower);
    return {message, bits, analogSig, sampledData, quantisedSig, modulatedSig, noisySig};
  },[st.message, st.sigFreq, st.fs, st.bits, st.modType, st.fc, st.askA0, st.fskDf, st.noisePower]);

  const setTab_ = useCallback(i => setTab(Math.max(0,Math.min(4,i))),[]);

  return (
    <div style={{maxWidth:1100,margin:"0 auto",minHeight:"100vh",display:"flex",flexDirection:"column",fontFamily:font.sans}}>
      {/* Gradient accent line */}
      <div style={{height:3,background:"linear-gradient(90deg, #3B82F6, #8B5CF6, #14B8A6)",flexShrink:0}}/>
      
      {/* Header */}
      <div style={{background:T.surface,borderBottom:`1px solid ${T.border}`,padding:"14px 24px",flexShrink:0}}>
        <div style={{display:"flex",alignItems:"center",gap:14,flexWrap:"wrap",marginBottom:8}}>
          <div style={{display:"flex",alignItems:"center",gap:10}}>
            {/* Logo */}
            <div style={{fontSize: 22, fontWeight: 800, fontFamily: "'Inter',system-ui,sans-serif", color: "#3B82F6", letterSpacing: "-0.5px", paddingRight: 10}}>
              Digital Comms Lab
            </div>
            <Badge type="blue">Pipeline</Badge>
          </div>
          <div style={{display:"flex",alignItems:"center",gap:10,marginLeft:"auto"}}>
            <span style={{fontSize:11,color:T.textMuted,fontFamily:font.mono,textTransform:"uppercase",letterSpacing:"0.08em"}}>Message</span>
            <input
              className="msg-input"
              value={st.message}
              onChange={e=>dispatch({type:"set",key:"message",value:e.target.value.slice(0,16)||"A"})}
              style={{padding:"7px 14px",borderRadius:99,background:T.surfaceAlt,color:T.text,fontFamily:font.mono,fontSize:14,width:180,fontWeight:600}}
            />
            <Badge type="purple">{pipeline.bits.length} bits</Badge>
          </div>
        </div>
        <StepperNav st={st} pipeline={pipeline} activeTab={tab} onTabChange={setTab_}/>
      </div>

      {/* Tab content */}
      <div key={tab} className="tab-content" style={{flex:1,padding:"20px 24px",background:T.bg}}>
        {tab===0&&<AnalogTab pipeline={pipeline} st={st} dispatch={dispatch} onTabChange={setTab_}/>}
        {tab===1&&<PCMTab pipeline={pipeline} st={st} dispatch={dispatch} onTabChange={setTab_}/>}
        {tab===2&&<ModTab pipeline={pipeline} st={st} dispatch={dispatch} onTabChange={setTab_}/>}
        {tab===3&&<NoiseTab pipeline={pipeline} st={st} dispatch={dispatch} onTabChange={setTab_}/>}
        {tab===4&&<ECTab pipeline={pipeline} st={st} dispatch={dispatch} onTabChange={setTab_}/>}
      </div>
    </div>
  );
}
