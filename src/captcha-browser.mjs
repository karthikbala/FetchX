import {fail} from './policy.mjs';
// Only fixed DOM inspection/insertion code. No caller scripts or guessed
// callbacks, no fabricated clearance cookies, and no solver key in this process.
export async function observeCaptcha(page,status){
 const html=(await page.content()).slice(0,1000000);
 const type=/captcha-delivery\.com/i.test(html)?'datadome':/hcaptcha\.com|h-captcha-response/i.test(html)?'hcaptcha':/cf-turnstile-response|challenges\.cloudflare\.com\/turnstile/i.test(html)?'turnstile':/cf-chl-|challenge-platform|<title>\s*Just a moment/i.test(html)?'cloudflare_managed':/g-recaptcha-response|\/recaptcha\/api2\/anchor/i.test(html)?'recaptcha_v2':null;
 return {observed_type:type,attempted:false,outcome:status===429?'rate_limited':status===401?'authentication_required':type?'not_configured':'not_observed'};
}
export async function captchaObservation(page,handler,profile,status){
 if(handler?.summary.attempted)return handler.summary;
 const observed=await observeCaptcha(page,status).catch(()=>({observed_type:null,attempted:false,outcome:status===429?'rate_limited':status===401?'authentication_required':'observation_unavailable'}));
 return {...observed,...(profile?.captcha?{configured_type:profile.captcha.type,...(observed.outcome==='not_configured'&&observed.observed_type===profile.captcha.type?{outcome:'not_required'}:{})}:{})};
}
export async function inspectWidget(page,c){
 if(page.url()!==c.websiteURL)fail('captcha_identity_mismatch');
 const widget=page.locator(c.widgetSelector),field=page.locator(c.responseSelector);
 if(await widget.count()!==1||!await widget.isVisible()||await field.count()!==1)fail('captcha_widget_mismatch');
 const meta=await widget.evaluate(el=>({siteKey:el.getAttribute('data-sitekey'),frames:Array.from(el.querySelectorAll('iframe[src]')).slice(0,10).map(f=>f.src)}));
 let observed=false;
 if(c.type==='recaptcha_v2')observed=meta.frames.some(src=>{try{const u=new URL(src);return u.protocol==='https:'&&['www.google.com','www.recaptcha.net'].includes(u.hostname)&&u.pathname==='/recaptcha/api2/anchor'&&u.searchParams.get('k')===c.siteKey;}catch{return false;}});
 else observed=meta.siteKey===c.siteKey;
 if(!observed)fail('captcha_sitekey_mismatch');
 const valid=await field.evaluate((el,type)=>(el.tagName==='TEXTAREA'||el.tagName==='INPUT'&&el.type==='hidden')&&el.name===(type==='recaptcha_v2'?'g-recaptcha-response':'cf-turnstile-response'),c.type);
 if(!valid)fail('captcha_response_field_mismatch');
 // A configured/broken widget must not cause a paid guessing loop.
 let text=(await widget.innerText()).slice(0,8192).toLowerCase();
 for(const frame of page.frames()){
  let u;try{u=new URL(frame.url());}catch{continue;}
  if(c.type==='recaptcha_v2'&&['www.google.com','www.recaptcha.net'].includes(u.hostname)&&u.searchParams.get('k')===c.siteKey){
   const visible=(await frame.locator('body').innerText({timeout:2000}).catch(()=>'' )).slice(0,8192).toLowerCase();
   const warning='this site is exceeding recaptcha enterprise free quota.';
   if(visible.includes(warning)&&!(await frame.locator('[role="checkbox"]').isVisible()&&await frame.locator('[role="checkbox"]').isEnabled()))fail('captcha_widget_configuration');
   text+=' '+visible.replace(warning,'');
  }
 }
 if(/invalid site key|invalid domain|error for site owner|quota exceeded|quota has been exceeded|billing quota/.test(text))fail('captcha_widget_configuration');
 if(await page.locator(c.submitSelector).count()!==1)fail('captcha_submit_mismatch');
 return field;
}
export function captchaHandler(page,profile,progress,{solve,report,status=()=>null}={}){
 const c=profile.captcha,tokens=[];
 let used=false,summary={attempted:false,outcome:'not_observed'};
 const redact=value=>{let text=value;for(const token of tokens)text=text.split(token).join('[captcha-token-redacted]');return text;};
 const clear=async()=>{if(c)await page.locator(c.responseSelector).evaluateAll(elements=>{for(const el of elements){el.value='';el.textContent='';}}).catch(()=>{});};
 return {
  get summary(){return summary;},redact,clear,
  async check({waitForChallenge=false}={}){
   if(!c)return false;
   if([401,429].includes(status())){summary={attempted:false,outcome:status()===429?'rate_limited':'authentication_required'};return false;}
   const trigger=page.locator(c.triggerSelector);
   if(waitForChallenge)await trigger.waitFor({state:'visible',timeout:5000}).catch(()=>{});
   if(!await trigger.isVisible())return false;
   if(used){if(summary.outcome==='verified'&&await page.locator(c.successSelector).isVisible())return false;fail('captcha_repeated_challenge');}
   await page.locator(c.responseSelector).waitFor({state:'attached',timeout:5000});
   if(c.type==='recaptcha_v2')await page.locator(c.widgetSelector).locator('iframe[src*="/recaptcha/api2/anchor"]').first().waitFor({state:'attached',timeout:5000});
   await inspectWidget(page,c);
   if(await page.locator(c.successSelector).isVisible())fail('captcha_success_predicate_ambiguous');
   used=true;progress.actionsStarted=true;summary={type:c.type,attempted:true,outcome:'solving'};
   try{
    const answer=await solve({type:c.type,websiteURL:c.websiteURL,siteKey:c.siteKey,userAgent:await page.evaluate(()=>navigator.userAgent)});
    if(typeof answer.token!=='string'||answer.token.length<20)fail('captcha_solution_invalid');
    tokens.push(answer.token);summary={...summary,solver_id:answer.id,provider:answer.provider,cost_micro_usd:answer.cost_micro_usd,outcome:'token_received'};
    // The source can navigate while a human/remote solver works. Revalidate the
    // exact page, site key and field before exposing the one-time token.
    const field=await inspectWidget(page,c);
    if(await page.locator(c.successSelector).isVisible())fail('captcha_success_predicate_ambiguous');
    await field.evaluate((el,token)=>{el.value=token;el.dispatchEvent(new Event('input',{bubbles:true}));el.dispatchEvent(new Event('change',{bubbles:true}));},answer.token);
    await report('submitted');summary.outcome='submitted';
    await page.locator(c.submitSelector).click();
    await page.locator(c.successSelector).waitFor({state:'visible',timeout:15000});
    if([401,403,429].includes(status()))fail('captcha_source_rejected');
    summary.outcome='verified';await report('verified');return true;
   }catch(e){summary.outcome=summary.outcome==='submitted'?'source_unverified':e.code?.startsWith('captcha_')?e.code:'captcha_source_unverified';await report('unknown').catch(()=>{});fail(e.code?.startsWith('captcha_')?e.code:'captcha_source_unverified',502);}
   finally{await clear();}
  },
 };
}
