import {handleControl,type ControlEnv} from '../../../src/server/control';
export const onRequest:PagesFunction<ControlEnv>=context=>handleControl(context.request,context.env);
