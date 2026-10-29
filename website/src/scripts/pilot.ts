import {validateSubmission, InputError} from '../lib/pilot-schema';
interface Turnstile {render(container:HTMLElement,options:Record<string,unknown>):string;reset(id:string):void;remove(id:string):void;}
declare global {interface Window {turnstile?:Turnstile}}
const form=document.querySelector<HTMLFormElement>('.pilot-form')!;
const first=form.querySelector<HTMLFieldSetElement>('[data-step="1"]')!;
const second=form.querySelector<HTMLFieldSetElement>('[data-step="2"]')!;
const error=form.querySelector<HTMLElement>('.form-error')!;
const result=document.querySelector<HTMLElement>('.form-result')!;
const progress=document.querySelector<HTMLElement>('.form-progress')!;
const verifyStatus=form.querySelector<HTMLElement>('.verification-status')!;
const submit=form.querySelector<HTMLButtonElement>('[type="submit"]')!;
const submitLabel=form.querySelector<HTMLElement>('[data-submit-label]')!;
const plans:Record<string,string>={pilot:'PILOT · FROM $99 ONCE',managed:'MANAGED · FROM $199 / MONTH',scale:'SCALE · FROM $999 / MONTH'};
const requestedPlan=new URLSearchParams(location.search).get('plan')||'pilot';
const plan=Object.hasOwn(plans,requestedPlan)?requestedPlan:'pilot';
form.querySelector('[data-offer]')!.textContent=`SELECTED OFFER: ${plans[plan]}`;
let requestId=crypto.randomUUID();let token='';let widgetId:string|undefined;let verificationLoading=false;let sending=false;let lastAttempt='';
function value(name:string){return (form.elements.namedItem(name) as HTMLInputElement|HTMLSelectElement|HTMLTextAreaElement).value.trim();}
function showError(message:string,field?:string){error.textContent=message;error.hidden=false;if(field){const target=form.elements.namedItem(field);if(target instanceof HTMLElement){if(first.contains(target))setStep(1,false);target.setAttribute('aria-invalid','true');target.focus();}}else error.scrollIntoView({block:'nearest'});}
function syncSubmit(){submit.disabled=sending||!token;submitLabel.textContent=sending?'Saving your request…':'Send pilot request';}
function clearToken(message='Please complete verification again.'){token='';verifyStatus.textContent=message;syncSubmit();}
function mountVerification(){
 if(widgetId!==undefined || verificationLoading)return;
 if(!form.dataset.sitekey){verifyStatus.textContent='This preview is awaiting form verification setup. Enquiries are not open yet.';return;}
 verificationLoading=true;
 const render=()=>{if(!window.turnstile){verificationLoading=false;clearToken('Verification could not load. Reload the page or use the email option below.');return;}
  widgetId=window.turnstile.render(document.querySelector<HTMLElement>('#pilot-turnstile')!,{
   sitekey:form.dataset.sitekey,action:'pilot',theme:'dark',size:'flexible',
   callback:(response:string)=>{token=response;verifyStatus.textContent='Verification complete.';syncSubmit();},
   'expired-callback':()=>clearToken('Verification expired. Please complete it again.'),
   'error-callback':()=>{clearToken('Verification could not be completed. Please retry or use email below.');return true;},
  });verificationLoading=false;
 };
 verifyStatus.textContent='Checking your browser…';
 if(window.turnstile){render();return;}
 const script=document.createElement('script');script.src='https://challenges.cloudflare.com/turnstile/v0/api.js?render=explicit';script.async=true;script.defer=true;
 script.addEventListener('load',render,{once:true});script.addEventListener('error',()=>{verificationLoading=false;clearToken('Verification could not load. Reload the page or use email below.');},{once:true});document.head.append(script);
}
function setStep(step:number,clearError=true){first.hidden=step!==1;first.disabled=step!==1;second.hidden=step!==2;second.disabled=step!==2;if(clearError)error.hidden=true;document.querySelectorAll<HTMLElement>('[data-progress]').forEach(p=>{p.classList.toggle('active',p.dataset.progress===String(step));if(p.dataset.progress===String(step))p.setAttribute('aria-current','step');else p.removeAttribute('aria-current');});const target=step===1?first:second;target.querySelector<HTMLElement>('input,textarea,select')?.focus({preventScroll:true});if(step===2)mountVerification();}
function validate(fieldset:HTMLFieldSetElement){for(const field of fieldset.querySelectorAll<HTMLInputElement|HTMLTextAreaElement|HTMLSelectElement>('input,textarea,select')){field.removeAttribute('aria-invalid');if(!field.checkValidity()){showError(field.validationMessage,field.name);field.reportValidity();return false;}}return true;}
form.querySelector('[data-next]')?.addEventListener('click',()=>{if(!validate(first))return;const urls=value('websites').split(/\n+/).map(u=>u.trim()).filter(Boolean);if(urls.length>3||urls.some(s=>{try{const u=new URL(s);return !['http:','https:'].includes(u.protocol)||!!u.username||!!u.password;}catch{return true;}})){showError('Please enter up to three valid http or https website URLs, one per line, without credentials.','websites');return;}setStep(2);});
form.querySelector('[data-back]')?.addEventListener('click',()=>{if(!sending)setStep(1);});
form.addEventListener('input',e=>{if(e.target instanceof HTMLElement)e.target.removeAttribute('aria-invalid');});
form.addEventListener('submit',async event=>{
 event.preventDefault();if(sending)return;if(second.hidden){form.querySelector<HTMLButtonElement>('[data-next]')?.click();return;}if(!validate(second))return;if(!token){showError('Please complete the verification above.');return;}
 const details={offer:plan,websites:value('websites').split(/\n+/).map(u=>u.trim()).filter(Boolean),fields:value('fields'),frequency:value('frequency'),volume:value('volume'),format:value('format'),name:value('name'),company:value('company'),email:value('email'),notes:value('notes'),website_confirm:value('website_confirm')};
 const fingerprint=JSON.stringify(details);if(lastAttempt&&lastAttempt!==fingerprint)requestId=crypto.randomUUID();
 const payload={...details,requestId,token};
 try{validateSubmission(payload);}catch(e){showError(e instanceof Error?e.message:'Please check your details.',e instanceof InputError?e.field:undefined);return;}
 sending=true;error.hidden=true;syncSubmit();lastAttempt=fingerprint;form.setAttribute('aria-busy','true');
 try{
  const response=await fetch('/api/pilot',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(payload),signal:AbortSignal.timeout(25_000)});
  const data: {ok?:boolean;reference?:string;message?:string;field?:string;error?:string}=await response.json();
  if(!response.ok||data.ok!==true||!data.reference){if(data.error==='request_conflict')requestId=crypto.randomUUID();showError(data.message||'We could not confirm receipt. Please retry or use the email option below.',data.field);return;}
  form.hidden=true;progress.hidden=true;document.querySelector<HTMLElement>('.form-fallback')!.hidden=true;result.hidden=false;result.querySelector('[data-reference]')!.textContent=data.reference;
  const followup=result.querySelector<HTMLAnchorElement>('[data-followup]')!;followup.href='mailto:sales@headrun.ai?subject='+encodeURIComponent('FetchX enquiry '+data.reference);
  result.focus();result.scrollIntoView({block:'center',behavior:matchMedia('(prefers-reduced-motion: reduce)').matches?'instant':'smooth'});form.reset();
 }catch{showError('We could not confirm receipt. Your details are still here. Please retry or email sales@headrun.ai.');}
 finally{sending=false;token='';syncSubmit();form.removeAttribute('aria-busy');if(widgetId!==undefined){if(form.hidden){window.turnstile?.remove(widgetId);widgetId=undefined;}else window.turnstile?.reset(widgetId);}}
});
