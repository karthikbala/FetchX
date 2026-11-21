import { handleStatus } from '../../src/server/status';
export const onRequest: PagesFunction<{ DB: D1Database }> = context => handleStatus(context.request, context.env, context);
