import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import handler from './api/explain.js';

try { process.loadEnvFile('.env.local'); }
catch (error) { if (error.code !== 'ENOENT') throw error; }

const files = new Map([
  ['/', ['index.html','text/html']],
  ['/style.css',['style.css','text/css']],
  ['/app.js',['app.js','text/javascript']],
  ['/data.js',['data.js','text/javascript']],
  ['/engine.js',['engine.js','text/javascript']],
  ['/REPORT.md',['REPORT.md','text/plain']],
  ['/forecast-study.js',['forecast-study.js','text/javascript']]
]);

const server = createServer(async (req,res) => {
  const send = (status,data) => {
    res.writeHead(status,{'Content-Type':'application/json; charset=utf-8'});
    res.end(JSON.stringify(data));
  };
  try {
    const path = new URL(req.url,'http://localhost').pathname;
    if (path === '/api/explain') {
      let body = '';
      for await (const chunk of req) {
        body += chunk;
        if (body.length > 4096) return send(413,{error:'Request too large.'});
      }
      try { req.body = body ? JSON.parse(body) : null; }
      catch { return send(400,{error:'Invalid JSON.'}); }
      return await handler(req,{status: code => ({json: data => send(code,data)})});
    }
    const file = files.get(path);
    if (!file) return send(404,{error:'Page not found.'});
    const content = await readFile(new URL(file[0],import.meta.url));
    res.writeHead(200,{'Content-Type':file[1] + '; charset=utf-8'});
    res.end(content);
  } catch {
    send(500,{error:'Request failed.'});
  }
});
server.listen(4173,'127.0.0.1', () => console.log('WattNest is running at http://127.0.0.1:4173'));
