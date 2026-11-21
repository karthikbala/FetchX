// fetchx-enquiry-retention: FetchX's scheduled jobs on Cloudflare (wrangler.retention.jsonc).
//   15 2 * * *   purge expired enquiries
//   * * * * *    status monitor: read the API's GET /v1/status and record it for the /status page
import {purgeExpired} from '../src/server/pilot';
import {monitorStatus, STATUS_CRON, STATUS_URL} from '../src/server/status';
type ScheduledEnv = Pick<CloudflareEnv,'DB'> & {PREVIEW_DB:D1Database; STATUS_URL?:string};
export default {
 async scheduled(event:ScheduledController,env:ScheduledEnv) {
  if(event.cron===STATUS_CRON){
   const result=await monitorStatus([env.DB,env.PREVIEW_DB],env.STATUS_URL||STATUS_URL);
   if(!result.ok||result.recorded.includes('record_failed'))console.log(JSON.stringify({event:'status_check',...result}));
   return;
  }
  const production=await purgeExpired(env.DB);
  const preview=await purgeExpired(env.PREVIEW_DB);
  console.log(JSON.stringify({event:'retention_complete',production,preview}));
 },
} satisfies ExportedHandler<ScheduledEnv>;
