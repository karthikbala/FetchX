// Reviewed default provider rules, shipped with the gateway code. Operators
// add, replace (same id) or disable (enabled:false) them via config.providerRules.
export default Object.freeze({
 "version": 1,
 "rules": [
  {
   "id": "oxylabs-gov",
   "provider": "oxylabs",
   "match": {
    "hostSuffix": ".gov"
   },
   "action": "exclude",
   "reason": "Oxylabs refuses CONNECT to .gov destinations (HTTP 444), from every country tested.",
   "evidence": {
    "observed_at": "2026-11-16",
    "connect_status": 444,
    "hosts": [
     "myplace.cuyahogacounty.gov",
     "www.cuyahogacounty.gov",
     "www.usa.gov",
     "ohio.gov",
     "www.irs.gov",
     "www.clevelandohio.gov"
    ],
    "countries": [
     "US",
     "CA",
     "GB"
    ],
    "control": "example.com returned 200 through the same proxy"
   }
  }
 ]
});
