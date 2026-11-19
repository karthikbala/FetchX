import {fail} from './policy.mjs';

export function cloakBrowserLicenseKey(tier){
 if(tier.entitlement==='unlicensed')return undefined;
 const key=typeof tier.licenseKey==='string'?tier.licenseKey.trim():'';
 if(!key)fail('browser_entitlement_unavailable',503);
 return key;
}

// Use only inside a capture worker after verifying its pinned executable. The
// local override bypasses the SDK's download and interactive free-key flow.
export async function pinnedCloakBrowser(tier,cacheDir){
 const licenseKey=cloakBrowserLicenseKey(tier);
 if(!tier.executablePath||!cacheDir)fail('browser_tier_unavailable',503);
 Object.assign(process.env,{CLOAKBROWSER_BINARY_PATH:tier.executablePath,CLOAKBROWSER_AUTO_UPDATE:'false',CLOAKBROWSER_LICENSE_KEY:'',CLOAKBROWSER_CACHE_DIR:cacheDir});
 delete process.env.CLOAKBROWSER_LICENSE_STATUS_FILE;
 // 0.7 expects the current licensed browser. Retain upstream's 0.6.x
 // compatibility only for an explicitly unlicensed, already installed build.
 const sdk=licenseKey?await import('cloakbrowser'):await import('cloakbrowser-legacy');
 return {sdk,licenseKey};
}
