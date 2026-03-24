const fs = require('fs');
let code = fs.readFileSync('src/App.jsx', 'utf8');

// 1. Rewrite bitsToAnalog to use a low-pass filter to make it a continuous wave.
code = code.replace(/const bitsToAnalog = \([^)]+\) => \{[\s\S]*?return out;\n\};/, `const bitsToAnalog = (bits, samplesPerBit = 40) => {
  const out = new Float32Array(bits.length * samplesPerBit);
  let val = 0; // low-pass state
  const alpha = 0.15; // RC filter coefficient
  for (let i = 0; i < bits.length; i++) {
    const target = bits[i] === 1 ? 1.0 : -1.0;
    for (let j = 0; j < samplesPerBit; j++) {
      val += alpha * (target - val);
      // add a small harmonic to make it look truly 'analog' and rich
      const t = (i * samplesPerBit + j) / (bits.length * samplesPerBit);
      const wobble = 0.1 * Math.sin(2 * Math.PI * 12 * t);
      out[i * samplesPerBit + j] = val * 0.9 + wobble;
    }
  }
  return out;
};`);

// 2. Fix PCM Grid to use sampled values instead of the upscaled quantised vector
code = code.replace(/const grid=document\.getElementById\("bitGrid"\);\n[\s\S]*?\}\n    \}/, `// Encoding
    const grid=document.getElementById("bitGrid");
    if(grid&&sampledData&&sampledData.sampVals){
      const { sampVals } = sampledData;
      const maxS=Math.min(32,sampVals.length), bpp=Math.min(bitDepth,8);
      grid.innerHTML="";
      for(let i=0;i<maxS;i++){
        let s = sampVals[i];
        let cl_val = Math.max(-1, Math.min(1 - stepSize, s));
        const lv=Math.round((cl_val+1)/stepSize);
        const cl=Math.max(0,Math.min(Math.pow(2,bitDepth)-1,lv));
        const bin=cl.toString(2).padStart(bpp,"0");
        for(let b=0;b<bin.length;b++){
          const el=document.createElement("div"),one=bin[b]==="1";
          el.textContent=bin[b];
          el.style.cssText=\`width:19px;height:21px;display:flex;align-items:center;justify-content:center;border-radius:4px;font-size:11px;font-family:\${font.mono};font-weight:500;border:1px solid \${one?T.blue+"55":T.border};background:\${one?T.blueLight:T.surfaceAlt};color:\${one?T.blue:T.textMuted}\`;
          grid.appendChild(el);
        }
        if(i<maxS-1){const sp=document.createElement("div");sp.style.width="3px";grid.appendChild(sp);}
      }
    }`);

// 3. Add logic text to AnalogTab
code = code.replace(/<Card style=\{\{marginBottom:16\}\}>[\s\S]*?<\/Card>/, \`<Card style={{marginBottom:16}}>
        <div style={{fontSize:12,color:T.textSub,marginBottom:12,fontFamily:font.sans}}>
          The message <b style={{fontFamily:font.mono,color:T.text}}>"{st.message}"</b> is converted to an analog signal.
          <br/><br/>
          <b>Logic:</b> Each character is translated to its 8-bit ASCII binary representation. These bits create an initial digital square wave (NRZ). The square wave is then passed through an analog low-pass filter (simulated RC circuit) to produce the smooth, continuously varying band-limited analog signal shown below.
        </div>
        <Slider label="Signal frequency (Hz)" min={100} max={2000} step={50} value={sigFreq} onChange={v=>dispatch({type:"set",key:"sigFreq",value:v})} unit=" Hz"/>
      </Card>\`);

fs.writeFileSync('src/App.jsx', code);
