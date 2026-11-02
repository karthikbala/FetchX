// Never project arbitrary exception properties/messages into caller diagnostics.
// Codes are a reviewed set of runtime/DNS/TLS/PostgreSQL identifiers only.
const CODES=new Set(['ENOTFOUND','ENODATA','ESERVFAIL','EREFUSED','ETIMEOUT','EAI_AGAIN','ECANCELLED','ECONNREFUSED','ECONNRESET','ETIMEDOUT','EHOSTUNREACH','ENETUNREACH','EPIPE','EFORMERR','EBADRESP','ENONAME','ERR_TLS_CERT_ALTNAME_INVALID','CERT_HAS_EXPIRED','CERT_NOT_YET_VALID','DEPTH_ZERO_SELF_SIGNED_CERT','SELF_SIGNED_CERT_IN_CHAIN','UNABLE_TO_VERIFY_LEAF_SIGNATURE','UNABLE_TO_GET_ISSUER_CERT_LOCALLY','ERR_SSL_WRONG_VERSION_NUMBER','ERR_SSL_TLSV1_ALERT_PROTOCOL_VERSION','23502','23503','23505','23514','22P02','42P01','42703','42601','42501','40001','40P01','53300','53400','57P01','57P02','57P03','08001','08003','08006','08P01','57014']);
const CLASSES=new Set(['Error','TypeError','RangeError','SyntaxError','GatewayError','AbortError','TimeoutError']);
// Copy reviewed protocol tokens only, never a provider's free-form explanation.
const SQUID_ERRORS=new Set(['ERR_ACCESS_DENIED','ERR_CACHE_ACCESS_DENIED','ERR_CONNECT_FAIL','ERR_DNS_FAIL','ERR_READ_ERROR','ERR_WRITE_ERROR','ERR_SOCKET_FAILURE','ERR_SECURE_CONNECT_FAIL','ERR_CANNOT_FORWARD']);
export function safeProxyReason(value){return SQUID_ERRORS.has(value)?value:null;}
export function proxyConnectEvidence(error){
 if(!['proxy_connect_rejected','provider_account_rejected'].includes(error?.code))return {};
 const status=error.provider_status,reason=safeProxyReason(error.provider_reason);
 return {failure_code:error.code,...(Number.isInteger(status)&&status>=100&&status<=599?{provider_status:status}:{}),...(reason?{provider_reason:reason}:{}),...(error.proxy_connected===true&&error.proxy_request_dispatched===true?{transport_phase:'proxy_connect',proxy_connected:true,proxy_request_dispatched:true,...(error.source_request_dispatched===false?{source_request_dispatched:false}:{})}:{})};
}
function safeDns(details){
 if(!details||typeof details!=='object')return undefined;
 return {attempts:(Array.isArray(details.attempts)?details.attempts:[]).slice(0,3).map(a=>({resolver_id:typeof a?.resolver_id==='string'&&/^[A-Za-z0-9_.:-]{1,160}$/.test(a.resolver_id)?a.resolver_id:'unknown',code:safeCauseCode({code:a?.code}),rcode:Number.isInteger(a?.rcode)&&a.rcode>=0&&a.rcode<=15?a.rcode:null,extended_dns_errors:(Array.isArray(a?.extended_dns_errors)?a.extended_dns_errors:[]).filter(n=>Number.isInteger(n)&&n>=0&&n<=65535).slice(0,16),...proxyConnectEvidence({...a,code:a?.failure_code})}))};
}
export function safeCauseCode(error){
 for(const candidate of [error?.cause_code,error?.code,error?.cause?.code])if(CODES.has(candidate))return candidate;
 return null;
}
export function proxyRefusedBeforeConnect(error){
 return error?.code==='proxy_connect_refused'&&error?.proxy_connected===false&&error?.proxy_request_dispatched===false&&safeCauseCode(error)==='ECONNREFUSED';
}
export function safeFailure(error,stage,{dispatched=false}={}){
 const dns=safeDns(error?.dns_diagnostics);
 return {stage,cause_code:safeCauseCode(error),error_class:CLASSES.has(error?.name)?error.name:'Error',request_dispatched:dispatched,...proxyConnectEvidence(error),...(proxyRefusedBeforeConnect(error)?{transport_phase:'proxy_tcp_connect',proxy_connected:false,proxy_request_dispatched:false}:{}),...(dns?{dns}:{})};
}
