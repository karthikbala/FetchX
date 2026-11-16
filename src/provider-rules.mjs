// Provider routing rules are data, not code: which provider must not be used
// for which destination hosts. Reviewed defaults ship in
// provider-rules-defaults.mjs; operators add or override rules through
// config.providerRules (and later the admin portal). Rules only ever remove a
// provider from consideration; they never add routes or bypass profiles.
import defaults from './provider-rules-defaults.mjs';
import {fail,GatewayError} from './policy.mjs';

export const RULE_PROVIDERS=Object.freeze(['oxylabs','scrapedo','evomi','dataimpulse']);
const ID=/^[a-z0-9][a-z0-9._-]{0,63}$/,HOST=/^(?=.{1,253}$)[a-z0-9-]+(?:\.[a-z0-9-]+)+$/,SUFFIX=/^\.[a-z0-9-]+(?:\.[a-z0-9-]+)*$/;
const cache=new WeakMap();

function validRule(rule){
 if(!rule||typeof rule!=='object'||Array.isArray(rule))return false;
 if(Object.keys(rule).some(k=>!['id','provider','match','action','reason','evidence','enabled'].includes(k)))return false;
 if(!ID.test(rule.id??'')||!RULE_PROVIDERS.includes(rule.provider)||rule.action!=='exclude')return false;
 if(typeof rule.reason!=='string'||!rule.reason||rule.reason.length>300)return false;
 if(rule.enabled!==undefined&&typeof rule.enabled!=='boolean')return false;
 const m=rule.match;if(!m||typeof m!=='object'||Array.isArray(m)||Object.keys(m).length!==1)return false;
 if(m.host!==undefined)return typeof m.host==='string'&&HOST.test(m.host);
 if(m.hostSuffix!==undefined)return typeof m.hostSuffix==='string'&&SUFFIX.test(m.hostSuffix);
 return false;
}
// Effective rules: shipped defaults, then config rules. A config rule with the
// same id replaces the default (for example {"id":"oxylabs-gov",...,"enabled":false}).
export function providerRules(config){
 if(config&&cache.has(config))return cache.get(config);
 const extra=config?.providerRules??[];
 if(!Array.isArray(extra)||extra.length>500)fail('provider_rules_invalid',500);
 const byId=new Map();
 for(const rule of [...defaults.rules,...extra]){if(!validRule(rule))fail('provider_rules_invalid',500);byId.set(rule.id,rule);}
 const rules=Object.freeze([...byId.values()].map(r=>Object.freeze(structuredClone(r))));
 if(config)cache.set(config,rules);
 return rules;
}
export const validateProviderRules=config=>{providerRules(config);};
export function hostMatches(match,host){
 const h=String(host).toLowerCase().replace(/\.$/,'');
 return match.host!==undefined?h===match.host:h.endsWith(match.hostSuffix)||h===match.hostSuffix.slice(1);
}
// The first enabled rule that excludes this provider for this host, or null.
export function providerRule(config,provider,host){
 return providerRules(config).find(r=>r.enabled!==false&&r.provider===provider&&hostMatches(r.match,host))??null;
}
export function assertProviderAllowed(config,provider,host){
 const rule=providerRule(config,provider,host);if(!rule)return;
 const e=new GatewayError('provider_host_excluded',409);e.details={provider,rule:rule.id,host:String(host).toLowerCase()};throw e;
}
