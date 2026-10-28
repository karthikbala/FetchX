// One bounded classifier for fallback, diagnostics and route health. Commented
// support text is not a challenge; actual challenge markers remain authoritative,
// including on 404 pages. Preserve raw-text elements so a literal <!-- in script
// or textarea content cannot hide a later real CAPTCHA form.
const COMMENTS_AND_RAW_TEXT=/<(script|style|title|textarea|xmp|iframe|noembed|noframes)\b[^>]*>[\s\S]*?(?:<\/\1\s*>|$)|<plaintext\b[^>]*>[\s\S]*$|<!--(?:>|->|[\s\S]*?(?:--!?>|$))/gi;
const CHALLENGE=/(?:<title>\s*robot check|action=["'][^"']*validateCaptcha|verify (?:that )?you are (?:a )?human|automated access to amazon)/i;

export function hasHtmlChallenge(response={}){
 const contentType=Object.entries(response.headers??{}).find(([name])=>name.toLowerCase()==='content-type')?.[1]??'';
 if(!/text\/html/i.test(contentType))return false;
 const prefix=Buffer.isBuffer(response.body)?response.body.subarray(0,12000).toString()
  :typeof response.body==='string'?response.body.slice(0,12000):'';
 const uncommented=prefix.replace(COMMENTS_AND_RAW_TEXT,token=>token.startsWith('<!--')?'':token);
 return CHALLENGE.test(uncommented);
}
