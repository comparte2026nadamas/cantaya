const fs=require('fs');
const esbuild=require('./build/node_modules/esbuild');
// Compatibilidad con navegadores viejos (TVs con Android, celulares antiguos)
const TARGET=['chrome61','safari11','firefox60'];
const down=code=>esbuild.transformSync(code,{target:TARGET,minify:false,legalComments:'none'}).code;
const safe=s=>s.replace(/<\/script/gi,'<\\/script');
let html=fs.readFileSync('src/app.html','utf8');
const rep=(k,v)=>{ if(!html.includes(k)) throw new Error('missing '+k); html=html.split(k).join(safe(v)); };
rep('/*__QR__*/',fs.readFileSync('build/node_modules/qrcode-generator/qrcode.js','utf8'));
rep('/*__PEERJS__*/',down(fs.readFileSync('build/node_modules/peerjs/dist/peerjs.min.js','utf8').replace(/\/\/# sourceMappingURL=.*$/m,'')));
rep('/*__APP__*/',down(fs.readFileSync('src/app.js','utf8')));
fs.mkdirSync('dist',{recursive:true});
fs.writeFileSync('dist/index.html',html);
console.log('ok',(html.length/1024).toFixed(0)+'KB');
