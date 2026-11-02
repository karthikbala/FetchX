const byId=id=>document.getElementById(id);
let token='';
const number=value=>typeof value==='number'&&Number.isFinite(value)?value:null;
const count=value=>number(value)===null?'—':value.toLocaleString();
const bytes=value=>{if(number(value)===null)return'Unknown';if(value===0)return'0 B';const units=['B','KB','MB','GB'];const power=Math.min(3,Math.floor(Math.log(value)/Math.log(1000)));return`${(value/1000**power).toLocaleString(undefined,{maximumFractionDigits:power?2:0})} ${units[power]}`;};
const dollars=value=>number(value)===null?'Unknown':new Intl.NumberFormat(undefined,{style:'currency',currency:'USD',minimumFractionDigits:4,maximumFractionDigits:4}).format(value/1e6);
async function read(path){
 const response=await fetch(path,{headers:{authorization:'Bearer '+token,accept:'application/json'},cache:'no-store',credentials:'omit',redirect:'error'});
 if(response.status===401)throw new Error('key');
 if(!response.ok)throw new Error('unavailable');
 return response.json();
}
function disconnect(){token='';byId('api-key').value='';byId('dashboard-view').hidden=true;byId('login-view').hidden=false;byId('operation-rows').replaceChildren();byId('login-error').hidden=true;byId('api-key').focus();}
function text(tag,value,className){const node=document.createElement(tag);node.textContent=value;if(className)node.className=className;return node;}
function renderOperations(operations){
 const rows=byId('operation-rows');rows.replaceChildren();byId('empty-state').hidden=operations.length>0;
 for(const op of operations){
  const row=document.createElement('tr'),identity=document.createElement('td');identity.append(text('div',op.id.slice(0,8)+'…','operation-name'),text('div',op.access_profile?.id??'Source profile','operation-profile'));row.append(identity);
  let label='In progress',type='pending';
  if(op.state==='unknown'){label='Unknown';type='unknown';}else if(op.state==='failed'||op.source_http_status>=400){label='Failed';type='failed';}else if(op.state==='completed'){label='Successful';type='ok';}
  const outcome=document.createElement('td');outcome.append(text('span',label,'outcome '+type));
  if(op.error){const detail=text('div',op.error.replaceAll('_',' '),'failure-detail');detail.title=[op.error,op.diagnostics?.stage,op.diagnostics?.failure?.cause_code].filter(Boolean).join(' · ');outcome.append(detail);}row.append(outcome);
  row.append(text('td',op.source_http_status===null?'—':String(op.source_http_status),op.source_http_status===null?'muted-value':''));
  const traffic=document.createElement('td');traffic.append(text('div',count(op.physical_requests)+' / '+bytes(op.encoded_bytes)));row.append(traffic);
  row.append(text('td',dollars(op.estimated_micro_usd),op.estimated_micro_usd===null?'muted-value':''));
  const timestamp=new Date(op.created_at),time=text('td',Number.isFinite(timestamp.getTime())?timestamp.toLocaleTimeString(undefined,{hour:'2-digit',minute:'2-digit'}):'—');time.title=Number.isFinite(timestamp.getTime())?timestamp.toLocaleString():'';row.append(time);rows.append(row);
 }
}
function renderUsage(usage){
 byId('project-label').textContent=usage.project;const o=usage.outcomes;
 byId('metric-success').textContent=count(o.source_successes);byId('metric-failed').textContent=count(o.source_failures+o.gateway_failures);byId('metric-unknown').textContent=count(o.unknown);byId('metric-bytes').textContent=bytes(o.encoded_bytes);
 const unmetered=usage.entitlement.mode==='unmetered';byId('plan-label').textContent=unmetered?'Unmetered client access':'Metered client access';byId('plan-description').textContent=unmetered?'No client request quota. Source safeguards and provider spending limits still apply.':`${count(usage.entitlement.max_daily_operations)} client operations per UTC day. Source safeguards and provider spending limits still apply.`;
 const groups=usage.by_key_and_state??[],knownEstimates=groups.filter(r=>number(r.estimated_micro_usd)!==null),unknownEstimates=groups.reduce((n,r)=>n+(number(r.unknown_estimate_operations)??0),0);byId('cost-estimate').textContent=knownEstimates.length?dollars(knownEstimates.reduce((n,r)=>n+r.estimated_micro_usd,0))+(unknownEstimates?' + unknown':''):'Unknown';
 const held=groups.reduce((n,r)=>n+(number(r.held_tunnel_bytes)??0),0);byId('reserved-traffic').textContent=bytes(held);const measured=groups.filter(r=>number(r.observed_tunnel_bytes)!==null);byId('tunnel-traffic').textContent=measured.length?bytes(measured.reduce((n,r)=>n+r.observed_tunnel_bytes,0)):'Not measured';
}
async function refresh(){
 byId('refresh-button').disabled=true;byId('dashboard-error').hidden=true;
 try{const[usage,recent]=await Promise.all([read('/v2/usage'),read('/v2/operations?limit=25')]);renderUsage(usage);renderOperations(recent.operations);byId('last-updated').textContent='Updated '+new Date().toLocaleTimeString(undefined,{hour:'2-digit',minute:'2-digit'});return true;}
 catch(error){if(error.message==='key'){disconnect();byId('login-error').textContent='That key was not accepted. Check your project key and try again.';byId('login-error').hidden=false;}else{byId('dashboard-error').textContent='FetchX could not load usage. Your last view is retained; try refreshing.';byId('dashboard-error').hidden=false;}return false;}
 finally{byId('refresh-button').disabled=false;}
}
byId('login-form').addEventListener('submit',async event=>{
 event.preventDefault();token=byId('api-key').value.trim().replace(/^Bearer\s+/i,'');byId('api-key').value='';byId('login-error').hidden=true;byId('login-button').disabled=true;
 try{if(await refresh()){byId('login-view').hidden=true;byId('dashboard-view').hidden=false;}else if(!byId('login-error').hidden){}else{token='';byId('login-error').textContent='FetchX is unavailable. Try connecting again shortly.';byId('login-error').hidden=false;}}
 finally{byId('login-button').disabled=false;}
});
byId('refresh-button').addEventListener('click',refresh);byId('signout-button').addEventListener('click',disconnect);window.addEventListener('pagehide',()=>{token='';byId('api-key').value='';});
