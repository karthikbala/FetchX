import {handleControlMail,type ControlMailEnv} from '../../src/server/control-mail';

export const onRequest:PagesFunction<ControlMailEnv>=context=>handleControlMail(context.request,context.env);
