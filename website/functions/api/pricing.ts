import { handlePricing } from '../../src/server/pricing';
export const onRequest: PagesFunction = context => handlePricing(context.request);
