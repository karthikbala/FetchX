import {spawn} from 'node:child_process';
import {once} from 'node:events';
const port='4330';
const base='http://127.0.0.1:'+port;
const server=spawn(process.execPath,['node_modules/wrangler/bin/wrangler.js','pages','dev','dist','--ip','127.0.0.1','--port',port,'--log-level','error','--show-interactive-dev-session=false'],{stdio:'inherit'});
const environment={...process.env,TEST_BASE_URL:base,TEST_OUTPUT_DIR:process.env.TEST_OUTPUT_DIR||'.local/browser-reports'};
try{
 let ready=false;
 for(let attempt=0;attempt<120;attempt++){
  try{const response=await fetch(base);if(response.ok){ready=true;break;}}catch{}
  if(server.exitCode!==null)throw new Error('Static preview failed to start.');
  await new Promise(resolve=>setTimeout(resolve,250));
 }
 if(!ready)throw new Error('Static preview did not become ready.');
 for(const script of ['site-check.mjs','form-check.mjs']){
  const child=spawn(process.execPath,['tests/ui/'+script],{env:environment,stdio:'inherit'});
  const [code]=await once(child,'exit');if(code!==0)throw new Error(script+' failed.');
 }
}finally{server.kill('SIGTERM');}
