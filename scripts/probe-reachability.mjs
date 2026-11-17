// Operator command: probe how a destination host can be reached and print a
// reviewable proposal. Uses the gateway config's routes; prints no secrets.
// Usage: GATEWAY_CONFIG=/path/gateway.json node scripts/probe-reachability.mjs <host> [US,CA,GB,DE] [--include-excluded]
import {readFile} from 'node:fs/promises';
import {runProbe} from '../src/reachability.mjs';
const args=process.argv.slice(2),flags=new Set(args.filter(a=>a.startsWith('--'))),[host,countries='US,CA,GB,DE']=args.filter(a=>!a.startsWith('--'));
if(!host){console.error('usage: probe-reachability.mjs <host> [US,CA,GB,DE] [--include-excluded]');process.exit(2);}
const config=JSON.parse(await readFile(process.env.GATEWAY_CONFIG??'/run/secrets/gateway.json','utf8'));
const report=await runProbe(config,host.toLowerCase(),countries.split(',').map(c=>c.trim().toUpperCase()),{includeExcluded:flags.has('--include-excluded')});
console.log(JSON.stringify(report,null,1));
