import test from 'node:test';
import assert from 'node:assert/strict';
import registry from './fixtures/protection.json' with {type:'json'};
import {lookupProtectionKnowledge as lookup} from '../src/protection-knowledge.mjs';

const lookupProtectionKnowledge=(context,now)=>lookup(context,now,registry);

test('reviewed experiment records retain failed trials, scope, evidence and measured cost',()=>{
 assert.equal(registry.schema_version,1);
 assert.equal(new Set(registry.experiments.map(item=>item.id)).size,registry.experiments.length);
 for(const item of registry.experiments){
  assert.equal(item.review_state,'reviewed');
  assert.ok(+new Date(item.review_after)>+new Date(item.observed_at));
  assert.match(item.evidence.sha256,/^[a-f\d]{64}$/);assert.match(item.context.engine_sha256,/^[a-f\d]{64}$/);
  assert.equal(item.result.qualification,'failed');assert.equal(item.result.accepted_records,0);assert.equal(item.result.credits_per_accepted_record,null);
  assert.ok(item.result.trials>0);assert.ok(item.limitations.length>0);
 }
});

test('evidence lookup is project, source and endpoint scoped; stale or changed context never grants action',()=>{
 const item=registry.experiments[0],context={project:item.project,source:item.source,endpoint_class:item.endpoint_class,...item.context};
 const [fresh]=lookupProtectionKnowledge(context,'2026-10-28');
 assert.equal(fresh.freshness,'current');assert.equal(fresh.same_tested_context,true);assert.equal(fresh.automatic_action_allowed,false);
 assert.equal(lookupProtectionKnowledge({...context,project:'other-project'},'2026-10-28').length,0);
 assert.equal(lookupProtectionKnowledge({...context,endpoint_class:'search'},'2026-10-28').length,0);
 assert.equal(lookupProtectionKnowledge({...context,engine_version:'0.2.6'},'2026-10-28')[0].same_tested_context,false);
 assert.equal(lookupProtectionKnowledge({...context,country:'AE'},'2026-10-28')[0].same_tested_context,false);
 assert.equal(lookupProtectionKnowledge(context,'2026-11-04')[0].freshness,'needs_review');
 assert.equal(lookupProtectionKnowledge(context,'2026-10-26')[0].freshness,'not_yet_observed');
 fresh.result.qualification='passed';
 assert.equal(lookupProtectionKnowledge(context,'2026-10-28')[0].result.qualification,'failed');
 assert.deepEqual(lookupProtectionKnowledge({}),[]);
});
