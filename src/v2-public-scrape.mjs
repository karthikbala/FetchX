import {randomUUID} from 'node:crypto';
import {load} from 'cheerio';
import TurndownService from 'turndown';
import {gfm} from 'turndown-plugin-gfm';
import {sha} from './crypto.mjs';
import {GatewayError,ID,fail} from './policy.mjs';
import {publicOperationErrorCode,publicOperationErrorMessage} from './v2-public-fetch.mjs';
import {PublicRenderGateway} from './v2-public-render.mjs';

export const SCRAPE_PATH='/v2/scrape';
const IDEMPOTENCY_HEADER='x-idempotency-key';
const FORMATS=['markdown','html','rawHtml','links'];
// Firecrawl's Python SDK adds these defaults when any scrape option is set.
const PYTHON_SDK_DEFAULTS={mobile:false,removeBase64Images:true,fastMode:false,blockAds:true,maxAge:14400000,storeInCache:true};
const SCRAPE_FIELDS=['url','formats','onlyMainContent','waitFor','timeout','origin','integration',...Object.keys(PYTHON_SDK_DEFAULTS)];
const INPUT_LIMIT=1048576;
const TEXT_OUTPUT_LIMIT=2*INPUT_LIMIT;
const URL_OUTPUT_LIMIT=256*1024;
const plain=value=>value!==null&&typeof value==='object'&&!Array.isArray(value);
const exact=(value,keys)=>plain(value)&&Object.keys(value).every(key=>keys.includes(key));
const validKey=value=>typeof value==='string'&&ID.test(value);
const integer=(value,min,max)=>Number.isSafeInteger(value)&&value>=min&&value<=max;

export function isPublicScrapeRequest(req){
 return req.method==='POST'&&req.url.split('?')[0]===SCRAPE_PATH;
}

export function setScrapeRequestKey(req,reply){
 const key=req.headers[IDEMPOTENCY_HEADER]??randomUUID();
 if(validKey(key)){
  req.scrapeKey=key;
  reply.header(IDEMPOTENCY_HEADER,key);
 }
}

function sourceURL(raw){
 if(typeof raw!=='string'||raw.length>12000||/[\s\u0000-\u001f\u007f\\#]/u.test(raw))fail('destination_rejected');
 let url;
 try{url=new URL(raw);}catch{fail('destination_rejected');}
 const path=raw.match(/^https:\/\/[^/?#]+([^?#]*)/i)?.[1];
 if(path===undefined||(path||'/')!==url.pathname||url.port||url.username||url.password||url.href.length>12000)fail('destination_rejected');
 return url.href;
}

function normalize(raw){
 if(!exact(raw,SCRAPE_FIELDS)||typeof raw.url!=='string')fail('request_invalid');
 for(const [field,value] of Object.entries(PYTHON_SDK_DEFAULTS)){
  if(Object.hasOwn(raw,field)&&raw[field]!==value)fail('request_invalid');
 }
 for(const field of ['origin','integration']){
  const value=raw[field];
  if(value!==undefined&&(typeof value!=='string'||value.length>256||/[\u0000-\u001f\u007f]/u.test(value)))fail('request_invalid');
 }
 const formats=raw.formats===undefined?['markdown']:raw.formats;
 if(!Array.isArray(formats)||formats.length<1||formats.length>FORMATS.length)fail('scrape_formats_unsupported');
 const types=formats.map(format=>exact(format,['type'])?format.type:format);
 if(types.some(format=>!FORMATS.includes(format)))fail('scrape_formats_unsupported');
 if(raw.onlyMainContent!==undefined&&typeof raw.onlyMainContent!=='boolean')fail('request_invalid');
 if(raw.waitFor!==undefined&&!integer(raw.waitFor,0,2000))fail('browser_wait_ceiling_rejected');
 if(raw.timeout!==undefined&&!integer(raw.timeout,1000,300000))fail('scrape_timeout_invalid');
 return {url:sourceURL(raw.url),formats:FORMATS.filter(format=>types.includes(format)),onlyMainContent:raw.onlyMainContent??true,waitFor:raw.waitFor??0,timeout:raw.timeout??null};
}

function reviewedRoute(config,project){
 const projects=config.v2?.scrape?.projects;
 if(projects===undefined)fail('scrape_unavailable',403);
 if(!plain(projects))fail('scrape_configuration_invalid',503);
 if(!Object.hasOwn(projects,project))fail('scrape_unavailable',403);
 const entry=projects[project];
 if(!exact(entry,['access_profile','proxy','max_estimated_micro_usd']))fail('scrape_configuration_invalid',503);
 const {access_profile:ref,proxy,max_estimated_micro_usd:ceiling}=entry;
 if(!exact(ref,['id','version'])||!validKey(ref.id)||!integer(ref.version,1,Number.MAX_SAFE_INTEGER)||
  !exact(proxy,['class','country'])||!['direct','datacenter','residential'].includes(proxy.class)||
  (proxy.class==='direct'?proxy.country!==null:typeof proxy.country!=='string'||!/^[A-Z]{2}$/.test(proxy.country))||
  ceiling!==undefined&&!integer(ceiling,0,Number.MAX_SAFE_INTEGER))fail('scrape_configuration_invalid',503);
 return entry;
}

const discarded='script,style,noscript,template,iframe,frame,object,embed,svg,math,canvas,form,button,input,select,textarea,audio,video,[hidden],[aria-hidden="true"]';
const boilerplate='nav,footer,aside,[role="navigation"],[role="contentinfo"],[role="banner"],[role="complementary"]';
const tags=new Set('a abbr article b blockquote br caption cite code dd del details div dl dt em figcaption figure h1 h2 h3 h4 h5 h6 header hr i img kbd li main mark nav ol p pre s samp section small span strong sub summary sup table tbody td tfoot th thead tr u ul var footer aside'.split(' '));
const tagAttributes={
 a:['href','title'],img:['src','alt','title'],ol:['start'],li:['value'],
 th:['colspan','rowspan','scope'],td:['colspan','rowspan']
};

function safeURL(value,base){
 if(!value||value.length>2048)return;
 try{
  const url=new URL(value,base);
  if(['http:','https:'].includes(url.protocol)&&!url.username&&!url.password&&url.href.length<=2048)return url.href;
 }catch{}
}

function boundTree(root){
 const queue=[root];
 const comments=[];
 let count=0;
 for(let depth=0;queue.length;depth++){
  if(depth>128)fail('scrape_content_limit',422);
  const level=queue.length;
  for(let i=0;i<level;i++){
   const children=queue[i].children??[];
   if(children.length>2048)fail('scrape_content_limit',422);
   count+=children.length;
   if(count>40000)fail('scrape_content_limit',422);
   for(const child of children){
    if(child.type==='comment')comments.push(child);
    queue.push(child);
   }
  }
  queue.splice(0,level);
 }
 return comments;
}

function cleanDocument($,onlyMainContent,base){
 $(discarded).remove();
 const body=$('body');
 let region=body;
 if(onlyMainContent){
  $(boilerplate).remove();
  const main=body.find('main,[role="main"]').first();
  if(main.length)region=main;
  else body.find('header').filter((_,node)=>!$(node).closest('article').length).remove();
 }
 let urlBytes=0;
 // Work from leaves upward so unwrapped elements keep their sanitized children.
 for(const node of region.find('*').toArray().reverse()){
  const element=$(node);
  if(!tags.has(node.name)){
   element.replaceWith(element.contents());
   continue;
  }
  const attributes={};
  for(const name of tagAttributes[node.name]??[]){
   let value=node.attribs[name];
   if(value===undefined)continue;
   if(name==='href'||name==='src'){
    value=safeURL(value,base);
    if(value===undefined)continue;
    urlBytes+=Buffer.byteLength(value);
    if(urlBytes>URL_OUTPUT_LIMIT)fail('scrape_content_limit',422);
   }else if(name==='colspan'||name==='rowspan'){
    if(!/^\d{1,3}$/.test(value))continue;
   }else if(name==='start'||name==='value'){
    if(!/^-?\d{1,6}$/.test(value))continue;
   }else{
    value=value.slice(0,2048);
   }
   attributes[name]=value;
  }
  node.attribs=attributes;
 }
 return region;
}

const markdown=new TurndownService({headingStyle:'atx',bulletListMarker:'-',codeBlockStyle:'fenced'}).use(gfm);
// GFM pipe tables cannot represent merged cells or captions. Keep these
// sanitized tables as HTML, including empty tables the GFM rule cannot parse.
markdown.addRule('complexTable',{
 filter:node=>node.nodeName==='TABLE'&&(!node.rows.length||node.querySelector('caption,[colspan],[rowspan],table')),
 replacement:(_content,node)=>'\n\n'+node.outerHTML+'\n\n'
});
markdown.addRule('escapedTableCell',{
 filter:['th','td'],
 replacement:(content,node)=>(node.previousSibling?' ':'| ')+content.replace(/\|/g,'\\|').replace(/\s*\n\s*/g,' ')+' |'
});
const metaText=value=>value?.replace(/\s+/gu,' ').trim().slice(0,2048)||undefined;

export function scrapeDocument(input,capture){
 const rawHtml=capture.text;
 if(typeof rawHtml!=='string'||typeof capture.final_url!=='string')fail('scrape_capture_unavailable',409);
 if(Buffer.byteLength(rawHtml)>INPUT_LIMIT)fail('scrape_content_limit',422);
 const $=load(rawHtml);
 const comments=boundTree($.root()[0]);
 const metadata={sourceURL:input.url,url:capture.final_url,statusCode:capture.status};
 const title=metaText($('head title').first().text())??metaText($('head meta[property="og:title"]').first().attr('content'));
 const description=metaText($('head meta[name="description" i]').first().attr('content'))??metaText($('head meta[property="og:description"]').first().attr('content'));
 const language=metaText($('html').attr('lang'))??metaText(capture.headers['content-language']);
 const contentType=metaText(capture.headers['content-type']??capture.content_type);
 if(title)metadata.title=title;
 if(description)metadata.description=description;
 if(language)metadata.language=language;
 if(contentType)metadata.contentType=contentType;
 const data={metadata};
 if(input.formats.includes('rawHtml'))data.rawHtml=rawHtml;
 if(input.formats.some(format=>format!=='rawHtml')){
  $(comments).remove();
  const region=cleanDocument($,input.onlyMainContent,capture.final_url);
  if(input.formats.includes('links'))data.links=[...new Set(region.find('a[href]').toArray().map(node=>node.attribs.href))].slice(0,1024);
  if(input.formats.includes('html')||input.formats.includes('markdown')){
   const html=region.html()??'';
   if(Buffer.byteLength(html)>TEXT_OUTPUT_LIMIT)fail('scrape_content_limit',422);
   if(input.formats.includes('html'))data.html=html;
   if(input.formats.includes('markdown')){
    data.markdown=markdown.turndown(html);
    if(Buffer.byteLength(data.markdown)>TEXT_OUTPUT_LIMIT)fail('scrape_content_limit',422);
   }
  }
 }
 return data;
}

const messages={
 request_invalid:'Send a URL and supported scrape options.',
 destination_rejected:'Use a public HTTPS URL allowed by this project’s scrape profile.',
 scrape_formats_unsupported:'Choose markdown, html, rawHtml or links.',
 scrape_timeout_invalid:'Supply a timeout from 1000 through 300000 milliseconds.',
 browser_wait_ceiling_rejected:'The requested wait exceeds the browser access profile limit.',
 scrape_unavailable:'Scrape is unavailable for this project.',
 scrape_configuration_invalid:'The project’s scrape configuration is unavailable.',
 scrape_running:'The original scrape is still running. Replay its request with the same X-Idempotency-Key.',
 scrape_outcome_unknown:'The original scrape outcome is uncertain. Recover with the same X-Idempotency-Key.',
 scrape_capture_unavailable:'The rendered capture is unavailable.',
 scrape_content_limit:'The rendered page exceeded a scrape content limit.',
 scrape_conversion_failed:'The rendered page could not be converted.'
};
export function publicScrapeFailure(error){
 const code=error instanceof GatewayError?publicOperationErrorCode(error.code):
  error?.validation||[400,413,415].includes(error?.statusCode)?'request_invalid':'internal_error';
 return {success:false,code,error:Object.hasOwn(messages,code)?messages[code]:publicOperationErrorMessage(code)};
}

function rejectCapture(render){
 const code=render.error.code;
 if(code==='source_not_found')fail(code,404);
 if(['source_challenge','source_forbidden','destination_rejected'].includes(code))fail(code,403);
 if(code==='source_rate_limited')fail(code,429);
 if(code==='operation_incomplete')fail('scrape_capture_unavailable',409);
 fail(code,422);
}

export function registerPublicScrape(app){
 const browser=new PublicRenderGateway(app.v2,{kind:'public_scrape_request_v1',namespace:'public-scrape'});
 app.decorateRequest('scrapeKey',null);
 app.post(SCRAPE_PATH,{bodyLimit:96*1024},async req=>{
  const key=req.scrapeKey;
  if(!key)fail('idempotency_key_required');
  const input=normalize(req.body),identity={keyId:req.apiKeyId};
  app.v2.controlCredits.keyId(req.project,identity);
  let operation;
  try{
   operation=await browser.capture(req.project,key,sha(JSON.stringify(input)),()=>({
    ...reviewedRoute(app.v2.config,req.project),url:input.url,wait_ms:input.waitFor
   }),identity,{timeoutMs:input.timeout??undefined});
  }catch(error){
   if(error instanceof GatewayError&&error.status!==502)throw error;
   fail('scrape_outcome_unknown',409);
  }
  if(['reserved','running'].includes(operation.state))fail('scrape_running',409);
  if(operation.state==='unknown')fail('scrape_outcome_unknown',409);
  let render;
  try{render=await browser.respond(req.project,key,operation,{recoveryUrl:null,documentOnly:true});}
  catch{fail('scrape_capture_unavailable',409);}
  if(!render.success)rejectCapture(render);
  let data;
  try{data=scrapeDocument(input,render.data);}
  catch(error){
   if(error instanceof GatewayError)throw error;
   fail('scrape_conversion_failed',422);
  }
  return {success:true,data};
 });
}
