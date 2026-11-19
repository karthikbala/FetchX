import test from 'node:test';
import assert from 'node:assert/strict';
import {Store} from '../src/store.mjs';
import {siteHost,siteOutcome,routeState,recordSiteOutcome,siteRoutes,siteKnowledgeOverview,forgetSite,seedFromProbe} from '../src/site-knowledge.mjs';

const enabled=!!process.env.TEST_DATABASE_URL;
const html={'content-type':'text/html'};

test('site host keeps only a normalized host name',()=>{
 assert.equal(siteHost('https://Shop.Example.com./path?q=secret#x'),'shop.example.com');
 assert.equal(siteHost(new URL('http://a.example.org:8443/')),'a.example.org');
 for(const bad of ['not a url','https://localhost/','https://127.0.0.1/',null,undefined])assert.equal(siteHost(bad),null);
});

test('outcome classification separates site evidence from everything else',()=>{
 assert.equal(siteOutcome({state:'completed',status:200,headers:html,body:'<html>ok</html>'}),'success');
 assert.equal(siteOutcome({state:'completed',status:302}),'success');
 assert.equal(siteOutcome({state:'completed',status:200,headers:html,body:'<title>Robot Check</title>'}),'blocked','a 200 challenge page is not success');
 assert.equal(siteOutcome({state:'failed',status:403}),'blocked');
 assert.equal(siteOutcome({state:'failed',error:'source_challenge'}),'blocked');
 assert.equal(siteOutcome({state:'completed',challenge:true,status:200}),'blocked');
 assert.equal(siteOutcome({state:'failed',status:429}),'rate_limited');
 assert.equal(siteOutcome({state:'failed',error:'source_timeout'}),'unreachable');
 // Says nothing about reaching the site: uncertain, internal, quota, provider faults, 404/500.
 for(const input of [{state:'unknown',status:200},{state:'failed',error:'operation_internal_error'},{state:'failed',error:'client_quota_exhausted'},
  {state:'failed',error:'proxy_connect_rejected'},{state:'failed',error:'proxy_connect_failed'},{state:'completed',status:404},{state:'completed',status:500},{}])
  assert.equal(siteOutcome(input),null,JSON.stringify(input));
});

test('route state ages, demotes and cools down',()=>{
 const now=Date.parse('2026-11-19T00:00:00Z'),day=86400000;
 assert.equal(routeState({last_success_at:new Date(now-day),consecutive_failures:0},now),'proven');
 assert.equal(routeState({last_success_at:new Date(now-8*day),consecutive_failures:0},now),'stale');
 assert.equal(routeState({last_success_at:new Date(now-day),consecutive_failures:2},now),'failing');
 assert.equal(routeState({last_success_at:new Date(now-day),consecutive_failures:0,retry_not_before:new Date(now+1000)},now),'cooling');
 assert.equal(routeState({consecutive_failures:1},now),'failing');
 assert.equal(routeState({last_success_at:new Date(now-2*day),consecutive_failures:0},now,{siteKnowledge:{freshMs:day}}),'stale');
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

test('browser engines are separate routes; invalid input is ignored',{skip:!enabled},()=>fixture(async store=>{
 const db=store.pool,host='https://app.example.net/';
 await recordSiteOutcome(db,{host,execution:'browser',route:res,engine:'camoufox',outcome:'blocked'});
 await recordSiteOutcome(db,{host,execution:'browser',route:res,engine:'cloakbrowser',outcome:'success'});
 const routes=await siteRoutes(db,host,{execution:'browser'});
 assert.deepEqual(routes.map(r=>[r.engine,r.state]).sort(),[['camoufox','failing'],['cloakbrowser','proven']]);
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
