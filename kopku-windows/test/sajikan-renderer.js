// Server statis renderer untuk uji asap Chromium (header COOP/COEP seperti app://). Pakai: node test/sajikan-renderer.js <renderer> <port>
const http=require('http'),fs=require('fs'),path=require('path');
const root=process.argv[2], port=+process.argv[3];
const types={'.html':'text/html','.js':'application/javascript','.wasm':'application/wasm','.css':'text/css','.ttf':'font/ttf','.png':'image/png','.json':'application/json','.ico':'image/x-icon'};
http.createServer((req,res)=>{let p=decodeURIComponent(req.url.split('?')[0]); if(p==='/')p='/index.html'; let f=path.join(root,p); if(!f.startsWith(root)||!fs.existsSync(f)||fs.statSync(f).isDirectory()) f=path.join(root,'index.html');
res.writeHead(200,{'Content-Type':types[path.extname(f)]||'application/octet-stream','Cross-Origin-Opener-Policy':'same-origin','Cross-Origin-Embedder-Policy':'require-corp'}); fs.createReadStream(f).pipe(res);}).listen(port,()=>console.log('ok',port));
