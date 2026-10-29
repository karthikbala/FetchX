import {purgeExpired} from '../src/server/pilot';
type RetentionEnv = Pick<CloudflareEnv,'DB'> & {PREVIEW_DB:D1Database};
export default {
 async scheduled(_event:ScheduledController,env:RetentionEnv) {
  const production=await purgeExpired(env.DB);
  const preview=await purgeExpired(env.PREVIEW_DB);
  console.log(JSON.stringify({event:'retention_complete',production,preview}));
 },
} satisfies ExportedHandler<RetentionEnv>;
