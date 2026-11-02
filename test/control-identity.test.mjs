import test from 'node:test';
import assert from 'node:assert/strict';
import {createHash,randomUUID} from 'node:crypto';
import {ControlIdentity,initControlIdentity} from '../src/control-identity.mjs';
import {createControlMail} from '../src/control-mail.mjs';
import {Store} from '../src/store.mjs';
import {initControlCredits} from '../src/control-credits.mjs';

const scopes=['fetch:read','fetch:write','usage:read','profiles:read'];
function config(){return {projects:{},v2:{accessProfiles:{'synthetic@1':{id:'synthetic',version:1}}},controlPlane:{enabled:true,bridgeSecret:'test-only-bridge-secret-32-bytes-long',projectTemplate:{id:'synthetic',v2_access_profiles:['synthetic@1'],v2_entitlement:{mode:'metered',max_daily_operations:10}},creditPolicy:{reviewed:true,version:'test-v1',trialCredits:12,weights:{direct:1},maxEstimatedMicroUsdPerOperation:0}}};}
const expectCode=(error,code)=>error?.code===code;

test('identity configuration and input validation reject unapproved grants before database use',async()=>{
 const identity=new ControlIdentity({store:{},config:config(),mail:{configured:false}});
 assert.equal(identity.mailConfigured,false);
 await assert.rejects(identity.requestCode({email:'test@example.com',ip:'127.0.0.1'}),e=>expectCode(e,'mail_unavailable'));
 await assert.rejects(identity.requestCode({email:'test@example.com\r\nBcc: victim@example.com',ip:'127.0.0.1'}),e=>expectCode(e,'email_invalid'));
 await assert.rejects(identity.createProject(randomUUID(),{name:'Test',v2_access_profiles:['private@1']}),e=>expectCode(e,'project_invalid'));
 await assert.rejects(identity.createKey(randomUUID(),`cp_${randomUUID()}`,{name:'Test',scopes:['admin']}),e=>expectCode(e,'key_scopes_invalid'));
 await assert.rejects(identity.createKey(randomUUID(),`cp_${randomUUID()}`,{name:'Test',scopes:['fetch:read','fetch:read']}),e=>expectCode(e,'key_scopes_invalid'));
 const changed=config();changed.controlPlane.projectTemplate.tokenHash='not-an-approved-field';
 assert.throws(()=>new ControlIdentity({store:{},config:changed}).template(),e=>expectCode(e,'project_template_configuration'));
 const reordered=config();reordered.controlPlane.projectTemplate={v2_entitlement:{max_daily_operations:10,mode:'metered'},v2_access_profiles:['synthetic@1'],id:'synthetic'};
 assert.equal(identity.template().hash,new ControlIdentity({store:{},config:reordered}).template().hash);
 assert.deepEqual(identity.template().policy.profiles,[]);
 assert.ok(!Object.hasOwn(identity.template().policy,'tokenHash'));
});

test('Gmail transport refreshes OAuth, encodes a safe MIME message, and never retries uncertain sends',async()=>{
 const settings={controlPlane:{mail:{transport:'gmail',from:'verify@example.com',clientId:'client-id',clientSecret:'client-secret',refreshToken:'refresh-secret'}}},calls=[];
 const fetchImpl=async(url,input)=>{calls.push({url,input});return calls.length===1?{ok:true,json:async()=>({access_token:'access-secret'})}:{ok:true,json:async()=>({id:'sent-synthetic'})};};
 const mail=createControlMail(settings,{fetchImpl});assert.equal(mail.configured,true);
 await mail.sendCode({email:'user@example.com',code:'01234567',challenge_id:randomUUID(),expires_at:'2026-11-02T12:00:00Z'});
 assert.equal(calls.length,2);assert.equal(calls[0].url,'https://oauth2.googleapis.com/token');assert.equal(calls[0].input.body.get('grant_type'),'refresh_token');
 assert.equal(calls[1].url,'https://gmail.googleapis.com/gmail/v1/users/me/messages/send');assert.equal(calls[1].input.headers.authorization,'Bearer access-secret');
 const mime=Buffer.from(JSON.parse(calls[1].input.body).raw,'base64url').toString();
 assert.match(mime,/From: verify@example\.com\r\nTo: user@example\.com\r\n/);
 const decoded=Buffer.from(mime.split('\r\n\r\n')[1].replace(/\s/g,''),'base64').toString();assert.match(decoded,/01234567/);
 assert.ok(!mime.includes('client-secret'));assert.ok(!mime.includes('refresh-secret'));
 let attempts=0;
 const uncertain=createControlMail(settings,{fetchImpl:async()=>{attempts++;if(attempts===1)return {ok:true,json:async()=>({access_token:'temporary'})};throw Error('sensitive provider response');}});
 await assert.rejects(uncertain.sendCode({email:'user@example.com',code:'12345678',challenge_id:randomUUID(),expires_at:new Date()}),{message:'mail_delivery_uncertain'});assert.equal(attempts,2);
 await assert.rejects(mail.sendCode({email:'user@example.com\r\nBcc: other@example.com',code:'12345678',challenge_id:randomUUID(),expires_at:new Date()}),{message:'mail_input_invalid'});assert.equal(calls.length,2);
 assert.equal(createControlMail({controlPlane:{mail:{...settings.controlPlane.mail,transport:'unapproved'}}}).configured,false);
});

test('durable email verification, session lifecycle, projects and scoped keys remain isolated',{skip:!process.env.TEST_DATABASE_URL},async()=>{
 assert.match(new URL(process.env.TEST_DATABASE_URL).pathname,/^\/gateway_test_[A-Za-z0-9_]+$/);
 const store=new Store(process.env.TEST_DATABASE_URL);await store.init();await initControlIdentity(store.pool);await initControlCredits(store.pool);
 await store.pool.query('TRUNCATE control_users,control_codes,control_rates,control_credit_accounts CASCADE');
 const settings=config(),sent=[],mail={configured:true,sendCode:async value=>{sent.push(value);}},identity=new ControlIdentity({store,config:settings,mail});
 const request=async(email,ip='127.0.0.1')=>identity.requestCode({email,ip});
 const verify=async(email,challenge,code=sent.at(-1).code,ip='127.0.0.1')=>identity.verifyCode({email,challenge_id:challenge.challenge_id,code,ip});
 try{
  const challenge=await request('User@Example.com');assert.deepEqual(Object.keys(challenge).sort(),['accepted','challenge_id','expires_in']);assert.equal(challenge.accepted,true);
  assert.match(sent[0].code,/^\d{8}$/);assert.equal(sent[0].email,'user@example.com');
  const stored=(await store.pool.query('SELECT * FROM control_codes WHERE id=$1',[challenge.challenge_id])).rows[0];assert.notEqual(stored.code_hash,sent[0].code);assert.ok(!JSON.stringify(stored).includes('user@example.com'));
  const originalCode=sent[0].code,wrong=originalCode==='00000000'?'11111111':'00000000';
  await assert.rejects(verify('user@example.com',challenge,wrong),e=>expectCode(e,'verification_invalid'));
  assert.equal((await store.pool.query('SELECT attempts FROM control_codes WHERE id=$1',[challenge.challenge_id])).rows[0].attempts,1);
  const race=await Promise.allSettled([verify('user@example.com',challenge,originalCode),verify('user@example.com',challenge,originalCode)]);assert.equal(race.filter(r=>r.status==='fulfilled').length,1);assert.equal(race.filter(r=>r.status==='rejected'&&r.reason.code==='verification_invalid').length,1);
  const login=race.find(r=>r.status==='fulfilled').value;assert.match(login.session.token,/^fxs_[A-Za-z0-9_-]{43}$/);assert.equal(login.user.email,'user@example.com');
  await assert.rejects(verify('user@example.com',challenge,originalCode),e=>expectCode(e,'verification_invalid'));
  assert.deepEqual(await identity.projects(login.user.id),[]);
  const restart=new ControlIdentity({store,config:config(),mail});assert.equal((await restart.session(login.session.token)).user.id,login.user.id);
  const first=await identity.createProject(login.user.id,{name:'First'}),second=await identity.createProject(login.user.id,{name:'Second'});assert.match(first.id,/^cp_/);assert.notEqual(first.id,second.id);
  const accounts=(await store.pool.query('SELECT * FROM control_credit_accounts WHERE project=ANY($1::text[])',[ [first.id,second.id] ])).rows;
  assert.equal(accounts.length,2);
  const {ControlCredits}=await import('../src/control-credits.mjs'),credits=new ControlCredits({store,config:settings});
  const firstUsage=await credits.usage(first.id),secondUsage=await credits.usage(second.id);
  assert.equal(firstUsage.granted,12);assert.equal(firstUsage.available,12);assert.equal(secondUsage.granted,0);assert.equal(secondUsage.available,0);
  const otherChallenge=await request('other@example.com','127.0.0.2'),other=await verify('other@example.com',otherChallenge,sent.at(-1).code,'127.0.0.2');
  await assert.rejects(identity.requireProject(other.user.id,first.id),e=>expectCode(e,'project_not_found'));
  await assert.rejects(identity.keys(other.user.id,first.id),e=>expectCode(e,'project_not_found'));
  const key=await identity.createKey(login.user.id,first.id,{name:'Server',scopes});assert.match(key.token,/^fxk_[A-Za-z0-9_-]{43}$/);
  const authenticated=await restart.authenticateKey(key.token);assert.equal(authenticated.project,first.id);assert.equal(authenticated.key_id,key.id);assert.deepEqual(authenticated.scopes,[...scopes].sort());
  assert.ok(restart.config.projects[first.id]);assert.ok(!Object.hasOwn(restart.config.projects[first.id],'tokenHash'));
  const listed=await identity.keys(login.user.id,first.id);assert.equal(listed.length,1);assert.ok(!JSON.stringify(listed).includes(key.token));assert.ok(!JSON.stringify(listed).includes('token_hash'));
  assert.equal(await identity.isCredential('Bearer '+key.token),true);assert.equal(await identity.isCredential(login.session.token),true);assert.equal(await identity.isCredential('source-guest-token'),false);
  await assert.rejects(identity.rotateKey(other.user.id,first.id,key.id),e=>expectCode(e,'project_not_found'));
  const rotations=await Promise.allSettled([identity.rotateKey(login.user.id,first.id,key.id),identity.rotateKey(login.user.id,first.id,key.id)]);assert.equal(rotations.filter(r=>r.status==='fulfilled').length,1);assert.equal(rotations.filter(r=>r.status==='rejected'&&r.reason.code==='key_revoked').length,1);
  const rotated=rotations.find(r=>r.status==='fulfilled').value;await assert.rejects(identity.authenticateKey(key.token),e=>expectCode(e,'unauthorized'));assert.equal((await identity.authenticateKey(rotated.token)).key_id,rotated.id);
  await identity.revokeKey(login.user.id,first.id,rotated.id);await assert.rejects(restart.authenticateKey(rotated.token),e=>expectCode(e,'unauthorized'));assert.equal(await identity.isCredential(rotated.token),true);
  await identity.revokeSession(login.session.token);await assert.rejects(restart.session(login.session.token),e=>expectCode(e,'unauthorized'));
  const expired=await request('expired@example.com','127.0.0.3');await store.pool.query("UPDATE control_codes SET expires_at=clock_timestamp()-interval '1 second' WHERE id=$1",[expired.challenge_id]);await assert.rejects(verify('expired@example.com',expired,sent.at(-1).code,'127.0.0.3'),e=>expectCode(e,'verification_invalid'));
  const brute=await request('brute@example.com','127.0.0.4'),right=sent.at(-1).code,bad=right==='00000000'?'11111111':'00000000';for(let n=0;n<5;n++)await assert.rejects(verify('brute@example.com',brute,bad,'127.0.0.4'),e=>expectCode(e,'verification_invalid'));await assert.rejects(verify('brute@example.com',brute,right,'127.0.0.4'),e=>expectCode(e,'verification_invalid'));
  const replaced=await request('replace@example.com','127.0.0.5'),oldCode=sent.at(-1).code;await request('replace@example.com','127.0.0.5');await assert.rejects(verify('replace@example.com',replaced,oldCode,'127.0.0.5'),e=>expectCode(e,'verification_invalid'));
  for(let n=0;n<3;n++)await request('rate@example.com','127.0.0.6');await assert.rejects(new ControlIdentity({store,config:settings,mail}).requestCode({email:'rate@example.com',ip:'127.0.0.6'}),e=>expectCode(e,'rate_limited'));
  const retryChallenge=await request('user@example.com','127.0.0.7'),retry=await verify('user@example.com',retryChallenge,sent.at(-1).code,'127.0.0.7');assert.equal(retry.user.id,login.user.id);
  await store.pool.query("UPDATE control_sessions SET expires_at=clock_timestamp()-interval '1 second' WHERE token_hash=$1",[createHash('sha256').update(retry.session.token).digest('hex')]);await assert.rejects(identity.session(retry.session.token),e=>expectCode(e,'unauthorized'));
  const failMail=new ControlIdentity({store,config:settings,mail:{configured:true,sendCode:async()=>{throw Error('provider detail');}}});const accepted=await failMail.requestCode({email:'failure@example.com',ip:'127.0.0.8'});assert.equal(accepted.accepted,true);assert.ok((await store.pool.query('SELECT consumed_at FROM control_codes WHERE id=$1',[accepted.challenge_id])).rows[0].consumed_at);
  const policyKey=await identity.createKey(login.user.id,first.id,{name:'Policy',scopes:['fetch:read']});settings.controlPlane.projectTemplate.v2_entitlement.max_daily_operations=1;await assert.rejects(identity.authenticateKey(policyKey.token),e=>expectCode(e,'project_template_changed'));await assert.rejects(identity.requireProject(login.user.id,first.id),e=>expectCode(e,'project_template_changed'));
  const secrets=[login.session.token,key.token,rotated.token,policyKey.token];const persisted=JSON.stringify((await store.pool.query('SELECT * FROM control_sessions')).rows)+JSON.stringify((await store.pool.query('SELECT * FROM control_keys')).rows);for(const secret of secrets)assert.ok(!persisted.includes(secret));
 }finally{await store.pool.query('TRUNCATE control_users,control_codes,control_rates,control_credit_accounts CASCADE');await store.close();}
});
