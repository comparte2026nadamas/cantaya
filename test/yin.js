const src=require('fs').readFileSync('../src/app.js','utf8');
const fn=src.slice(src.indexOf('function yin'), src.indexOf('class VoiceAnalyser'));
eval(fn);
const sr=48000;
for (const f of [110,220,330,440,660,880,990]) {
  const b=new Float32Array(2048); for(let i=0;i<2048;i++){ const t=i/sr; b[i]=0.5*Math.sin(2*Math.PI*f*t)+0.25*Math.sin(2*Math.PI*2*f*t)+0.1*Math.sin(2*Math.PI*3*f*t)+0.02*(Math.random()-.5);}
  const r=yin(b,sr); console.log(f, r && r.f.toFixed(1), r && r.clarity.toFixed(2));
}
