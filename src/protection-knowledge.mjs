// Reviewed repository evidence, not automatic policy. No provider dispatches,
// mutable runtime learning or cross-project evidence sharing happen here.
import registry from '../knowledge/protection-experiments.json' with {type:'json'};

const contextKeys=['engine','engine_version','engine_sha256','proxy_class','country','session','stealth'];
export function lookupProtectionKnowledge(context,now=new Date(),records=registry){
 if(!context||!['project','source','endpoint_class'].every(key=>typeof context[key]==='string'&&context[key]))return [];
 const at=+new Date(now);if(!Number.isFinite(at))throw Error('knowledge_time_invalid');
 return records.experiments.filter(item=>item.project===context.project&&item.source===context.source&&item.endpoint_class===context.endpoint_class)
  .map(item=>({
   ...structuredClone(item),
   same_tested_context:contextKeys.every(key=>context[key]!==undefined&&context[key]===item.context[key]),
   freshness:at<+new Date(item.observed_at)?'not_yet_observed':at>+new Date(item.review_after)?'needs_review':'current',
   automatic_action_allowed:false,
  }));
}
