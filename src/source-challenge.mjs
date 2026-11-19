import {classifyProtection} from './protection.mjs';
// One bounded classifier for fallback, diagnostics and route health. Commented
// support text is not a challenge; actual challenge markers remain authoritative,
// including on 404 pages. Preserve raw-text elements so a literal <!-- in script
// or textarea content cannot hide a later real CAPTCHA form.
const COMMENTS_AND_RAW_TEXT=/<(script|style|title|textarea|xmp|iframe|noembed|noframes)\b[^>]*>[\s\S]*?(?:<\/\1\s*>|$)|<plaintext\b[^>]*>[\s\S]*$|<!--(?:>|->|[\s\S]*?(?:--!?>|$))/gi;
// Generic bot-manager interstitial markers (vendor-neutral wording, titles that
// are the whole document title, and known challenge delivery hosts).
const CHALLENGE=/(?:<title>\s*(?:robot check|bot or not\??|just a moment\.{0,3}|attention required!?(?:\s*\|[^<]*)?|pardon our interruption|are you a (?:human|robot)\??)\s*<\/title|<title>\s*robot check|action=["'][^"']*validateCaptcha|verify (?:that )?you are (?:a )?human|verify (?:that )?you(?:'|’)?re not a robot|verify (?:that )?you are not a robot|human or a bot|automated access to amazon|\/\/(?:geo\.)?captcha-delivery\.com\/|\/cdn-cgi\/challenge-platform\/h\/[bg]\/orchestrate\/)/i;

export function hasHtmlChallenge(response={}){
 const contentType=Object.entries(response.headers??{}).find(([name])=>name.toLowerCase()==='content-type')?.[1]??'';
 if(!/text\/html/i.test(contentType))return false;
 const prefix=Buffer.isBuffer(response.body)?response.body.subarray(0,12000).toString()
  :typeof response.body==='string'?response.body.slice(0,12000):'';
 const uncommented=prefix.replace(COMMENTS_AND_RAW_TEXT,token=>token.startsWith('<!--')?'':token);
 return CHALLENGE.test(uncommented);
}

// Public outcome helper: a challenge page wins over its HTTP status (a 429 or
// 403 interstitial is reported as source_challenge) and names the vendor when
// the passive protection classifier can attribute it.
export function sourceChallenge({status=null,headers={},body=null,url}={}){
 const view=classifyProtection({status,headers,body},{main_document:true,url});
 if(!hasHtmlChallenge({headers,body})&&view.kind!=='challenge')return null;
 return {vendor:view.kind==='challenge'?view.vendor:'unknown',http_status:Number.isInteger(status)?status:null};
}
