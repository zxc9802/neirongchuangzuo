import fs from 'node:fs';
import path from 'node:path';
import http from 'node:http';
import crypto from 'node:crypto';
import {ensureBrowser, openBrowser, selectComposition, renderMedia} from '@remotion/renderer';
export async function renderEffectVideo({template, output, source, edit, duration=6, previewScenes, onProgress=()=>{}}) {
  const token=crypto.randomBytes(24).toString('hex'), files=new Map();
  const bundle=path.resolve('.motion-bundle');
  if (!fs.existsSync(path.join(bundle,'index.html'))) throw new Error('请先运行 npm run motion:bundle');
  for(const asset of template.assets) files.set(`/${token}/${asset.id}`,asset.url);
  if(source)files.set(`/${token}/source`,source);
  const server=http.createServer((req,res)=>{
    const url=new URL(req.url,'http://localhost');
    if(!['GET','HEAD'].includes(req.method)){res.writeHead(405).end();return;}
    let file=files.get(url.pathname);
    if(!file){
      const relative=url.pathname==='/'?'index.html':url.pathname.slice(1);
      if(!/^[a-zA-Z0-9_.-]+$/.test(relative)){res.writeHead(404).end();return;}
      file=path.join(bundle,relative);
    }
    if(!fs.existsSync(file)||!fs.statSync(file).isFile()){res.writeHead(404).end();return;}
    const size=fs.statSync(file).size, m=req.headers.range?.match(/^bytes=(\d+)-(\d*)$/);
    const start=m?Number(m[1]):0,end=m?.[2]?Math.min(Number(m[2]),size-1):size-1;
    if(start>end||start>=size){res.writeHead(416).end();return;}
    const mime={'.js':'text/javascript','.html':'text/html','.css':'text/css','.png':'image/png','.jpg':'image/jpeg','.mp4':'video/mp4'}[path.extname(file)]||'application/octet-stream';
    res.writeHead(m?206:200,{'Content-Type':mime,'Content-Length':end-start+1,'Accept-Ranges':'bytes','Access-Control-Allow-Origin':'*',...(m?{'Content-Range':`bytes ${start}-${end}/${size}`}:{})});
    if(req.method==='HEAD'){res.end();return;}
    const stream=fs.createReadStream(file,{start,end});stream.on('error',()=>res.destroy());res.on('close',()=>stream.destroy());stream.pipe(res);
  });
  await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
  const origin=`http://127.0.0.1:${server.address().port}`;
  let browser;
  try {
    const browserExecutable=process.env.REMOTION_BROWSER_EXECUTABLE||undefined;
    await ensureBrowser({browserExecutable,logLevel:'error'});
    browser=await openBrowser('chrome',{browserExecutable,logLevel:'error'});
    const newPage=browser.newPage.bind(browser);
    browser.newPage=async options=>{
      const page=await newPage(options),client=page._client();
      // Generated code may access only this job's loopback asset server, never the app or the internet.
      await client.send('Fetch.enable',{patterns:[{urlPattern:'*'}]});
      client.on('Fetch.requestPaused',event=>{
        const url=event.request.url;
        const allowed=url.startsWith(origin+'/')||url.startsWith('data:')||url==='about:blank';
        void client.send(allowed?'Fetch.continueRequest':'Fetch.failRequest',{requestId:event.requestId,...(allowed?{}:{errorReason:'BlockedByClient'})}).catch(()=>{});
      });
      return page;
    };
    const resolved={...template,assets:template.assets.map(a=>({...a,url:`${origin}/${token}/${a.id}`}))};
    const inputProps=source?{...edit,duration,sourceUrl:`${origin}/${token}/source`,effectTemplate:resolved}:{template:resolved,...(previewScenes?{scenes:previewScenes}:{})};
    const composition=await selectComposition({serveUrl:origin,id:source?'DigitalHumanMotion':'LibraryEffect',inputProps,puppeteerInstance:browser,logLevel:'error'});
    await renderMedia({composition,serveUrl:origin,inputProps,outputLocation:output,codec:'h264',crf:20,pixelFormat:'yuv420p',colorSpace:'bt709',muted:true,puppeteerInstance:browser,concurrency:1,logLevel:'error',timeoutInMilliseconds:20000,onProgress:({progress})=>onProgress(Math.floor(progress*100))});
  } finally {if(browser)await browser.close({silent:true});server.closeAllConnections();await new Promise(resolve=>server.close(resolve));}
}
