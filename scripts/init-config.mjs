import {mkdir,writeFile,access,chmod} from 'node:fs/promises';
import {resolve,join} from 'node:path';
import {randomBytes,createHash} from 'node:crypto';
const root=resolve(process.argv[2]??'local');
if(!/^[a-zA-Z0-9_./-]+$/.test(root))throw Error('Use a setup path containing letters, digits, slashes, dots, underscores or hyphens.');
try{await access(root);throw Error('Setup directory already exists; refusing to overwrite it.');}catch(e){if(e.code!=='ENOENT')throw e;}
for(const dir of [root,join(root,'secrets'),join(root,'browser')])await mkdir(dir,{recursive:true,mode:0o700});
// Browser and seccomp files must be readable by the unprivileged service.
await chmod(join(root,'browser'),0o755);
await mkdir(join(root,'browser','free'),{recursive:true,mode:0o755});
const token=randomBytes(32).toString('hex'),dbPassword=randomBytes(24).toString('hex');
const profile={hosts:['example.com'],paths:['^/$'],methods:['GET'],headers:['accept'],country:'US',maxConcurrent:1,maxRequests:4,maxInputBytes:8192,maxResponseBytes:1024*1024,maxBytes:16*1024*1024,ttlSeconds:180,minIntervalMs:1000,maxFallbackCredits:0,maxAttemptBytes:4*1024*1024,maxResidentialBytes:16*1024*1024};
const providers=Object.fromEntries(['evomi','dataimpulse'].map(name=>{const prefix=name.toUpperCase(),username=process.env[prefix+'_USERNAME']??'',password=process.env[prefix+'_PASSWORD']??'';return [name,{enabled:!!username&&!!password,username,password,maxTotalBytes:32*1024*1024,microUsdPerGB:1000000}];}));
const config={release:'fetchx-0.2.0',defaultRouting:'residential-v1',artifactDir:'/data/artifacts',artifactKey:randomBytes(32).toString('hex'),proxies:[],maxDailyFallbackCredits:0,jobs:{enabled:true,maxQueued:100},projects:{demo:{tokenHash:createHash('sha256').update(token).digest('hex'),profiles:['example.http','example.browser'],maxQueuedJobs:20,maxDailyResidentialBytes:32*1024*1024}},residential:{maxDailyBytes:32*1024*1024,maxTotalBytes:64*1024*1024,providers},browser:{maxConcurrent:1},sourceProfiles:{'example.http':profile,'example.browser':{...profile,execution:'browser',readySelector:'body',maxBrowserRequests:20,browserRecipes:{capture:{steps:[],extract:{title:{selector:'title'}},screenshot:'viewport'}}}}};
await writeFile(join(root,'secrets/gateway.json'),JSON.stringify(config,null,2)+'\n',{mode:0o600,flag:'wx'});
await writeFile(join(root,'secrets/client.token'),token+'\n',{mode:0o600,flag:'wx'});
await writeFile(join(root,'compose.env'),`FETCHX_HOME=${root}\nFETCHX_DB_PASSWORD=${dbPassword}\n`,{mode:0o600,flag:'wx'});
console.log('FetchX configuration created. Add credentials and review profiles/budgets in '+join(root,'secrets/gateway.json')+'. No provider requests were made.');
