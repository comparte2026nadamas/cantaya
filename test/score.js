const src=require('fs').readFileSync('../src/app.js','utf8');
const clamp=(x,a=0,b=1)=>Math.max(a,Math.min(b,x));
eval(src.slice(src.indexOf('const mean ='), src.indexOf('function scoreMessage')).replace('class ScoreSession','globalThis.ScoreSession = class'));
function run(name, gen){ const s=new ScoreSession(); for(let i=0;i<3600;i++) s.push(gen(i)); console.log(name, JSON.stringify(s.result())); }
const melody=[60,62,64,65,67,65,64,62];
run('buen cantante', i=> (i%200)<140 ? {voiced:true,rms:0.1*(1+0.2*Math.sin(i/7)),midi: melody[Math.floor(i/10)%8] + (Math.random()-.5)*0.15} : {voiced:false,rms:0.005});
run('desafinado', i=> (i%200)<140 ? {voiced:true,rms:0.1*(0.3+Math.random()),midi: 60+Math.random()*10} : {voiced:false,rms:0.005});
run('hablando monotono', i=> (i%200)<100 ? {voiced:true,rms:0.1*(0.3+Math.random()),midi: Math.random()<.5?null:55+(Math.random()-.5)*0.8} : {voiced:false,rms:0.005});
run('callado', i=> ({voiced:false,rms:0.003}));
