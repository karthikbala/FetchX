import {handlePilot,type PilotEnv} from '../../src/server/pilot';
export const onRequest: PagesFunction<PilotEnv> = context => handlePilot(context.request,context.env,context);
