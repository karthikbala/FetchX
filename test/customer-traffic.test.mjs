import test from 'node:test';
import assert from 'node:assert/strict';
import {residentialTrafficCharge,residentialTrafficReservation,finishResidentialTrafficCharge} from '../src/customer-traffic.mjs';

test('residential customer prices preserve exact nanodollars and cap authorized bytes',()=>{
 for(const [bytes,cost]of [[0,'0.000000000'],[1,'0.000000002'],[17,'0.000000034'],[499,'0.000000998'],[501,'0.000001002'],[1000000000,'2.000000000'],[Number.MAX_SAFE_INTEGER,'18014398.509481982']]){
  const measured=residentialTrafficCharge({status:'measured',bytes});
  assert.equal(measured.cost_usd,cost);assert.equal(measured.metered_bytes,bytes);assert.equal(measured.billable_bytes,bytes);assert.equal(measured.bytes_per_gb,1e9);assert.equal(measured.rate_usd_per_gb,2);assert.equal(measured.basis,'bidirectional_proxy_bytes');
 }
 assert.deepEqual(residentialTrafficCharge({status:'measured',bytes:99,maxBillableBytes:7}),{currency:'USD',rate_usd_per_gb:2,bytes_per_gb:1e9,basis:'bidirectional_proxy_bytes',status:'measured',metered_bytes:99,billable_bytes:7,cost_usd:'0.000000014'});
 for(const bytes of [null,undefined,-1,0.5,NaN,Infinity,Number.MAX_SAFE_INTEGER+1])assert.throws(()=>residentialTrafficCharge({status:'measured',bytes}),TypeError);
 assert.throws(()=>residentialTrafficCharge({status:'measured',bytes:1,maxBillableBytes:-1}),TypeError);
 assert.throws(()=>residentialTrafficCharge({status:'invented'}),TypeError);
 for(const status of ['pending','unknown']){const value=residentialTrafficCharge({status});assert.equal(value.cost_usd,null);assert.equal(value.billable_bytes,null);assert.equal(value.metered_bytes,null);}
 assert.equal(residentialTrafficCharge({status:'no_traffic'}).cost_usd,'0.000000000');
});

test('customer reservations round the upper bound once and completion preserves admission',()=>{
 for(const [bytes,micro]of [[0,0],[1,1],[499,1],[500,1],[501,2],[24576,50]]){const reserved=residentialTrafficReservation(bytes);assert.equal(reserved.max_estimated_micro_usd,micro);assert.equal(reserved.max_cost_usd,residentialTrafficCharge({status:'measured',bytes}).cost_usd);}
 const pending=residentialTrafficCharge({status:'pending'});
 for(const flags of [{unknown:true},{partial:true},{bytes:null},{bytes:-1},{bytes:0.2},{bytes:Number.MAX_SAFE_INTEGER+1}])assert.equal(finishResidentialTrafficCharge(pending,{dispatched:true,bytes:9,...flags}).status,'unknown');
 assert.equal(finishResidentialTrafficCharge(pending,{dispatched:false,unknown:true}).cost_usd,'0.000000000');
 assert.equal(finishResidentialTrafficCharge(null,{dispatched:true,bytes:7}),null);
 const old={...pending,rate_usd_per_gb:1};assert.equal(finishResidentialTrafficCharge(old,{dispatched:true,bytes:7}).cost_usd,'0.000000007');
});
