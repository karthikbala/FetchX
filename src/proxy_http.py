"""Private child transport. Reads validated request/config from stdin; emits JSON only."""
import sys,json,base64

class ResponseTooLarge(Exception):
    pass

def error_code(error):
    # A broken dependency/configuration must never buy a fallback request.
    from curl_cffi.requests.exceptions import ConnectionError, ProxyError, Timeout, SSLError, InvalidURL, InvalidSchema, InvalidHeader, ImpersonateError
    if isinstance(error, ResponseTooLarge):return 'response_too_large'
    if isinstance(error, SSLError):return 'tls_verification_failed'
    if isinstance(error, (InvalidURL, InvalidSchema, InvalidHeader, ImpersonateError, ValueError, TypeError, KeyError)):return 'transport_request_invalid'
    if isinstance(error, (ConnectionError, ProxyError, Timeout)):return 'proxy_connect_failed'
    return 'transport_failed'

def main():
    try:
        from curl_cffi.requests import Session
    except ImportError:
        print(json.dumps({'error':'transport_unavailable','received_bytes':0}))
        return 1
    x=json.load(sys.stdin)
    total=0; parts=[]; status=None; headers=[]
    try:
        with Session(impersonate='chrome136',trust_env=False) as s:
            with s.stream(x['method'],x['url'],headers=x['headers'],
                          data=base64.b64decode(x['body'],validate=True) if x.get('body') else None,
                          proxy=x['proxy'],timeout=x['timeout'],allow_redirects=False,verify=True) as r:
                status=r.status_code; headers=list(r.headers.multi_items())
                for part in r.iter_content(chunk_size=65536):
                    total+=len(part)
                    if total>x['maxBytes']:raise ResponseTooLarge()
                    parts.append(part)
                print(json.dumps({'status':status,'headers':headers,'body_base64':base64.b64encode(b''.join(parts)).decode(),'received_bytes':total}))
    except Exception as e:
        code=error_code(e)
        from curl_cffi.requests.exceptions import Timeout
        if x.get('metered') and isinstance(e,Timeout):code='transport_outcome_unknown'
        if status is not None and code=='proxy_connect_failed':code='source_body_incomplete'
        print(json.dumps({'error':code,'status':status,'headers':headers,'received_bytes':total}))
        return 1
    return 0
try:sys.exit(main())
except Exception as e:
    # Never expose curl's exception text: it can contain credentials, proxy IPs or source query.
    print(json.dumps({'error':'transport_failed','received_bytes':0}))
    sys.exit(1)
