import test from 'node:test';
import assert from 'node:assert/strict';
import {Store} from '../src/store.mjs';
import {siteHost,routeState,recordSiteOutcome,siteRoutes,siteKnowledgeOverview,forgetSite,seedFromProbe} from '../src/site-knowledge.mjs';

const enabled=!!process.env.TEST_DATABASE_URL;
const html={'content-type':'text/html'};

test('site host keeps only a normalized host name',()=>{
 assert.equal(siteHost('https://Shop.Example.com./path?q=secret#x'),'shop.example.com');
 assert.equal(siteHost(new URL('http://a.example.org:8443/')),'a.example.org');
 for(const bad of ['not a url','https://localhost/','https://127.0.0.1/',null,undefined])assert.equal(siteHost(bad),null);
});


test('route state ages, demotes and cools down',()=>{
 const now=Date.parse('2026-11-19T00:00:00Z'),day=86400000;
 assert.equal(routeState({last_success_at:new Date(now-day),consecutive_failures:0},now),'proven');
 assert.equal(routeState({last_success_at:new Date(now-8*day),consecutive_failures:0},now),'stale');
 assert.equal(routeState({last_success_at:new Date(now-day),consecutive_failures:2},now),'failing');
 assert.equal(routeState({last_success_at:new Date(now-day),consecutive_failures:0,retry_not_before:new Date(now+1000)},now),'cooling');
 assert.equal(routeState({consecutive_failures:1},now),'failing');
 assert.equal(routeState({last_success_at:new Date(now-2*day),consecutive_failures:0},now,{siteKnowledge:{freshMs:day}}),'stale');
 const residentialBrowser={execution:'browser',proxy_class:'residential',last_success_at:new Date(now-day)};
 assert.equal(routeState({...residentialBrowser,consecutive_failures:5},now),'proven','a residential browser route is judged on six draws');
 assert.equal(routeState({...residentialBrowser,consecutive_failures:6},now),'failing');
 assert.equal(routeState({...residentialBrowser,execution:'http',consecutive_failures:2},now),'failing','residential HTTP keeps the default');
});

async function fixture(run){
 const store=new Store(process.env.TEST_DATABASE_URL);await store.init();
 await store.pool.query('TRUNCATE site_routes');
 try{await run(store);}finally{await store.pool.query('TRUNCATE site_routes');await store.close();}
}
const dc={class:'datacenter',provider:'oxylabs',country:'US'},res={class:'residential',provider:'evomi',country:'US'};

test('outcomes learn per route, shared by host, with no URL stored',{skip:!enabled},()=>fixture(async store=>{
 const db=store.pool;
 assert.equal(await recordSiteOutcome(db,{host:'https://shop.example.com/cart?token=secret',execution:'http',route:res,outcome:'success',credits:3}),true);
 await recordSiteOutcome(db,{host:'https://shop.example.com/other',execution:'http',route:res,outcome:'success',credits:5});
 await recordSiteOutcome(db,{host:'https://shop.example.com/',execution:'http',route:dc,outcome:'blocked'});
 const routes=await siteRoutes(db,'shop.example.com');
 assert.equal(routes.length,2);
 const r=routes.find(x=>x.proxy_class==='residential'),d=routes.find(x=>x.proxy_class==='datacenter');
 assert.equal(r.state,'proven');assert.equal(r.successes,2);assert.equal(r.average_success_credits,4);
 assert.equal(d.state,'failing');assert.equal(d.consecutive_failures,1);assert.equal(d.retry_not_before,null,'one failure does not cool a route');
 const dump=JSON.stringify((await db.query('SELECT * FROM site_routes')).rows);
 assert.ok(!dump.includes('secret')&&!dump.includes('/cart'),'only the host is stored');
}));

test('two consecutive failures cool a route; success recovers; rate limits never count as failures',{skip:!enabled},()=>fixture(async store=>{
 const db=store.pool,host='https://news.example.org/';
 await recordSiteOutcome(db,{host,execution:'http',route:dc,outcome:'success'});
 await recordSiteOutcome(db,{host,execution:'http',route:dc,outcome:'blocked'});
 await recordSiteOutcome(db,{host,execution:'http',route:dc,outcome:'blocked'});
 let [row]=await siteRoutes(db,host);assert.equal(row.state,'cooling');assert.ok(row.retry_not_before);
 await recordSiteOutcome(db,{host,execution:'http',route:dc,outcome:'success'});
 [row]=await siteRoutes(db,host);assert.equal(row.state,'proven');assert.equal(row.consecutive_failures,0);
 await recordSiteOutcome(db,{host,execution:'http',route:dc,outcome:'rate_limited',retryAfterSeconds:30});
 [row]=await siteRoutes(db,host);assert.equal(row.failures,2,'429 is pacing, not a failure');assert.equal(row.state,'cooling');
 const wait=+new Date(row.retry_not_before)-Date.now();assert.ok(wait>20000&&wait<=31000,String(wait));
}));

test('cooldowns start short and double with each further failure, up to a cap',{skip:!enabled},()=>fixture(async store=>{
 const db=store.pool,host='https://flaky.example.net/';
 const wait=async()=>{const [row]=await siteRoutes(db,host);return (Date.parse(row.retry_not_before)-Date.now())/60000;};
 await recordSiteOutcome(db,{host,execution:'http',route:dc,outcome:'blocked'});
 assert.equal((await siteRoutes(db,host))[0].retry_not_before,null,'one block is not a pattern');
 await recordSiteOutcome(db,{host,execution:'http',route:dc,outcome:'blocked'});
 assert.ok(Math.abs(await wait()-15)<1,'15 minutes after two blocks');
 await recordSiteOutcome(db,{host,execution:'http',route:dc,outcome:'blocked'});
 assert.ok(Math.abs(await wait()-30)<1,'then 30');
 for(let i=0;i<10;i++)await recordSiteOutcome(db,{host,execution:'http',route:dc,outcome:'blocked'});
 assert.ok(Math.abs(await wait()-360)<1,'capped at 6 hours');
}));

test('a residential browser route cools only after six walls in a row, since each is a fresh exit IP',{skip:!enabled},()=>fixture(async store=>{
 const db=store.pool,host='https://guarded.example.com/';
 const state=async execution=>(await siteRoutes(db,host,{execution}))[0];
 for(let i=0;i<5;i++)await recordSiteOutcome(db,{host,execution:'browser',route:res,outcome:'blocked'});
 assert.equal((await state('browser')).retry_not_before,null,'five walls on fresh IPs');
 await recordSiteOutcome(db,{host,execution:'browser',route:res,outcome:'blocked'});
 const row=await state('browser');assert.equal(row.state,'cooling');
 assert.ok(Math.abs((Date.parse(row.retry_not_before)-Date.now())/60000-15)<1,'then the usual 15 minutes');
 for(let i=0;i<2;i++)await recordSiteOutcome(db,{host,execution:'http',route:res,outcome:'blocked'});
 assert.equal((await state('http')).state,'cooling','residential HTTP still cools after two');
 await recordSiteOutcome(db,{host,execution:'browser',route:dc,outcome:'blocked'});
 await recordSiteOutcome(db,{host,execution:'browser',route:dc,outcome:'blocked'});
 assert.ok((await siteRoutes(db,host,{execution:'browser'})).some(r=>r.proxy_class==='datacenter'&&r.state==='cooling'),'datacenter browser after two');
}));

test('each transport is its own route; invalid input is ignored',{skip:!enabled},()=>fixture(async store=>{
 const db=store.pool,host='https://app.example.net/';
 await recordSiteOutcome(db,{host,execution:'browser',route:res,outcome:'blocked'});
 await recordSiteOutcome(db,{host,execution:'http',route:res,outcome:'success'});
 const routes=await siteRoutes(db,host);
 assert.deepEqual(routes.map(r=>[r.execution,r.state]).sort(),[['browser','failing'],['http','proven']]);
 for(const bad of [{host:'https://localhost/',execution:'http',route:dc,outcome:'success'},{host,execution:'ftp',route:dc,outcome:'success'},
  {host,execution:'http',route:{class:'mobile'},outcome:'success'},{host,execution:'http',route:{...dc,country:'usa'},outcome:'success'},{host,execution:'http',route:dc,outcome:'maybe'}])
  assert.equal(await recordSiteOutcome(db,bad),false,JSON.stringify(bad));
 const overview=await siteKnowledgeOverview(db);
 assert.deepEqual(overview.map(x=>[x.host,x.routes,x.proven,x.failing]),[['app.example.net',2,1,1]]);
 assert.equal(await forgetSite(db,'app.example.net'),2);assert.deepEqual(await siteRoutes(db,host),[]);
}));

test('probe reports seed plain HTTP knowledge and skip provider faults',{skip:!enabled},()=>fixture(async store=>{
 const db=store.pool;
 const report={host:'gov.example.gov',cells:[
  {provider:'oxylabs',class:'datacenter',country:'US',result:'excluded_by_rule'},
  {provider:'evomi',class:'residential',country:'US',result:'ok'},
  {provider:'dataimpulse',class:'residential',country:'US',result:'provider_refused'},
  {provider:'evomi',class:'residential',country:'DE',result:'challenge'},
  {provider:'oxylabs',class:'datacenter',country:'DE',result:'proxy_failed'}]};
 assert.equal(await seedFromProbe(db,report),2);
 const routes=await siteRoutes(db,'gov.example.gov');
 assert.deepEqual(routes.map(r=>[r.execution,r.provider,r.country,r.state,r.last_evidence]).sort(),[['http','evomi','DE','failing','probe'],['http','evomi','US','proven','probe']]);
}));
