// Generic CAPTCHA handling for v2 renders (auto mode). Runs inside the browser
// worker against the live page. It only reads public widget attributes, writes
// one solver token into the widget's own response field, and then uses the
// widget's declared callback or its own form. No solver key, no caller
// scripts, no fabricated cookies. Unsupported widgets are reported, not guessed.
export const GENERIC_CAPTCHA_TYPES=Object.freeze(['turnstile','recaptcha_v2']);
const SITE_KEY=/^[A-Za-z0-9_-]{10,200}$/;

// Returns {type, site_key, invisible, callback} for the first supported widget
// in the main frame, or null.
export async function detectCaptcha(page){
 const found=await page.evaluate(()=>{
  const attr=(el,name)=>el?.getAttribute?.(name)??null;
  const turnstile=document.querySelector('.cf-turnstile[data-sitekey]')||
   [...document.querySelectorAll('[data-sitekey]')].find(el=>el.querySelector('input[name="cf-turnstile-response"]')||el.closest('form')?.querySelector('input[name="cf-turnstile-response"]'));
  if(turnstile)return {type:'turnstile',site_key:attr(turnstile,'data-sitekey'),invisible:false,callback:attr(turnstile,'data-callback')};
  const recaptcha=document.querySelector('.g-recaptcha[data-sitekey]');
  if(recaptcha)return {type:'recaptcha_v2',site_key:attr(recaptcha,'data-sitekey'),invisible:attr(recaptcha,'data-size')==='invisible',callback:attr(recaptcha,'data-callback')};
  const anchor=[...document.querySelectorAll('iframe[src]')].map(f=>{try{return new URL(f.src);}catch{return null;}})
   .find(u=>u&&['www.google.com','www.recaptcha.net'].includes(u.hostname)&&u.pathname==='/recaptcha/api2/anchor');
  if(anchor)return {type:'recaptcha_v2',site_key:anchor.searchParams.get('k'),invisible:anchor.searchParams.get('size')==='invisible',callback:null};
  return null;
 });
 if(!found||!SITE_KEY.test(found.site_key??''))return null;
 return {...found,callback:typeof found.callback==='string'&&/^[A-Za-z_$][\w$.]{0,100}$/.test(found.callback)?found.callback:null};
}

// Writes the token and hands it to the page the way the widget would.
export async function applyCaptchaToken(page,found,token){
 return page.evaluate(({type,callback,token})=>{
  const names=type==='turnstile'?['cf-turnstile-response']:['g-recaptcha-response'];
  const fields=[...document.querySelectorAll(names.map(n=>`textarea[name="${n}"],input[name="${n}"]`).join(','))];
  for(const field of fields){field.value=token;field.dispatchEvent(new Event('input',{bubbles:true}));field.dispatchEvent(new Event('change',{bubbles:true}));}
  if(callback){
   const fn=callback.split('.').reduce((value,part)=>value?.[part],window);
   if(typeof fn==='function'){fn(token);return 'callback';}
  }
  const form=fields.map(f=>f.closest('form')).find(Boolean);
  if(form){if(typeof form.requestSubmit==='function')form.requestSubmit();else form.submit();return 'form';}
  return fields.length?'field_only':'no_field';
 },{type:found.type,callback:found.callback,token});
}

// Detect, solve through the parent (hooks.captcha), apply, and wait for the
// page to move on. Returns a summary; never throws.
export async function solvePageCaptcha(page,hooks,{deadline,settleMs=0}){
 const remaining=()=>Math.max(0,deadline-Date.now());
 let found;
 try{found=await detectCaptcha(page);}catch{return null;}
 if(!found)return null;
 const summary={type:found.type,outcome:'solving'};
 if(remaining()<20000){summary.outcome='captcha_deadline';return summary;}
 try{
  const userAgent=await page.evaluate(()=>navigator.userAgent);
  const answer=await hooks.captcha({type:found.type,website_url:page.url(),site_key:found.site_key,invisible:found.invisible,user_agent:userAgent});
  if(typeof answer?.token!=='string'||answer.token.length<20)throw Object.assign(new Error(),{code:'captcha_solution_invalid'});
  summary.submitted_via=await applyCaptchaToken(page,found,answer.token);
  summary.outcome='submitted';
  await page.waitForLoadState('domcontentloaded',{timeout:Math.min(15000,remaining())}).catch(()=>{});
  await page.waitForTimeout(Math.min(Math.max(settleMs,1500),remaining()));
  summary.outcome=await detectCaptcha(page).then(again=>again?'still_challenged':'passed').catch(()=>'unverified');
 }catch(e){summary.outcome=/^captcha_[a-z_]{1,60}$/.test(e?.code??'')?e.code:'captcha_failed';}
 return summary;
}
