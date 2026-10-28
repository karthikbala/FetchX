// Synthetic destination rules for policy regressions; never a deployment profile.
// Source owners retain validation. These profiles only bound transport capabilities.
const jioMartSlug='[a-z0-9][a-z0-9-]{0,298}-[1-9]\\d{0,19}';
const common={routingPolicy:'legacy',methods:['GET','HEAD','POST','OPTIONS'],headers:['accept','accept-language','content-type','user-agent','referer','origin','cookie','cache-control','pragma','channel','oms-apim-subscription-key','authorization','sec-fetch-dest','sec-fetch-mode','sec-fetch-site','sec-ch-ua','sec-ch-ua-mobile','sec-ch-ua-platform','x-requested-with','range','accept-encoding'],forwardBrowserHeaders:true,maxConcurrent:4,maxInputBytes:4*1024*1024,maxResponseBytes:16*1024*1024,maxRequests:2000,maxBytes:256*1024*1024,ttlSeconds:720,allowFallbackRestart:true,minIntervalMs:250,maxFallbackCredits:400,fallbackCountry:'in',fallbackMaxCost:1,fallbackSuper:false,sticky:true};
export const profiles={
 'fixture.croma.api':{...common,allowFallbackRestart:false,forwardBrowserHeaders:false,maxConcurrent:1,hosts:['source32.example','source31.example'],paths:['^/$','^/static/js/main\\.[a-f0-9]+\\.chunk\\.js$','^/catalog/v1/product/detail$','^/pricing-services/v2/price/national$','^/inventory/oms/v2/tms/details-pwa/$'],maxRequests:8,maxBytes:32*1024*1024,maxFallbackCredits:8,fallbackMaxCost:1,country:'IN'},
 'fixture.croma.browser':{...common,hosts:['source31.example','source32.example','source18.example','source27.example','source25.example','source15.example','source26.example'],country:'IN',guestAuth:[{host:'source18.example',method:'POST',path:'^/'}]},
 'fixture.reliance':{...common,hosts:['source10.example','source22.example','source12.example','source29.example','source4.example','cdn.jiostore.online','source3.example','source34.example','source15.example','source26.example'],country:'IN',guestAuth:[
  {host:'source10.example',method:'GET',path:'^/api/service/application/user/authentication/v1\\.0/session$'},
  {host:'source10.example',method:'GET',path:'^/api/service/application/cart/v1\\.0/(address|basic)$'},
  {host:'source10.example',method:'GET',path:'^/api/service/application/catalog/v1\\.0/products/[a-zA-Z0-9-]+/sizes/$'},
  {host:'source10.example',method:'GET',path:'^/api/service/application/logistics/v1\\.0/(pincode|localities/pincode)/[1-9]\\d{5}$'},
  {host:'source10.example',method:'GET',path:'^/api/service/application/configuration/v1\\.0/staff$',query:'^\\?order_incent=true$'},
  {host:'source10.example',method:'GET',path:'^/api/service/application/catalog/v1\\.0/product-grouping/$',query:'^\\?id=\\d+&slug=[a-zA-Z0-9-]+$'},
 ]},
 'fixture.flipkart':{...common,hosts:['source24.example','source6.example','source8.example','source7.example','source5.example','source9.example','source2.example','source2.example'],country:'IN',fallbackSuper:false},
 'fixture.jiomart':{...common,hosts:['source28.example','source16.example','source14.example','source23.example','source29.example','source15.example','source26.example'],country:'IN',fallbackSuper:false,guestAuth:[
  {host:'source28.example',method:'GET',path:'^/api/service/application/logistics/v1\\.0/pincode/[1-9]\\d{5}$'},
  {host:'source28.example',method:'GET',path:'^/api/service/application/logistics/v1\\.0/delivery-promise$'},
  {host:'source28.example',method:'GET',path:'^/api/service/application/configuration/v1\\.0/application$'},
  {host:'source28.example',method:'GET',path:'^/api/service/application/content/v1\\.0/(data-loader|tags|navigations)$'},
  {host:'source28.example',method:'GET',path:'^/api/service/application/cart/v1\\.0/basic$'},
  {host:'source28.example',method:'GET',path:'^/api/service/application/user/authentication/v1\\.0/session$'},
  {host:'source28.example',method:'GET',path:`^/api/service/application/catalog/v2\\.0/products/${jioMartSlug}/sizes$`},
  {host:'source28.example',method:'GET',path:`^/api/service/application/catalog/v2\\.0/products/${jioMartSlug}/sizes$`,query:'^\\?store_ids=[1-9]\\d{0,19}(?:%2C[1-9]\\d{0,19}){0,2}$'},
  {host:'source28.example',method:'GET',path:'^/api/service/application/theme/v2\\.0/[a-f0-9]{24}/preview$'},
  {host:'source28.example',method:'GET',path:'^/api/service/application/promotion/v1\\.0/available-promotions$',query:`^\\?page_size=50&slug=${jioMartSlug}$`},
  {host:'source28.example',method:'GET',path:'^/api/service/application/cart/v1\\.0/coupon$',query:`^\\?slug=${jioMartSlug}$`},
  {host:'source28.example',method:'GET',path:'^/api/service/application/cart/v1\\.0/detail$',query:'^\\?b=true&i=true$'},
  {host:'source28.example',method:'GET',path:'^/api/service/application/cart/v1\\.0/detail$',query:'^\\?area_code=[1-9]\\d{5}&b=true&i=true$'},
  {host:'source28.example',method:'GET',path:'^/api/service/application/content/v2\\.0/pages$',query:'^\\?page_size=50&tags=bankoffers(?:,|%2[Cc])bankoffer$'},
  {host:'source28.example',method:'GET',path:'^/api/service/application/cart/v1\\.0/address$',query:'^\\?checkout_mode=self$'},
 ]},
 'fixture.vijay':{...common,hosts:['source20.example','source19.example','source13.example','source0.example','source17.example','source11.example','x.nitrocommerce.ai','source15.example','source26.example','source30.example'],country:'IN'},
 'fixture.amazon':{...common,hosts:['source33.example','source21.example','source1.example'],country:'IN',amazonZipPlugin:true,maxResponseBytes:4*1024*1024},
};
