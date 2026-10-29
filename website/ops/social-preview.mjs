import {chromium} from 'playwright';
const browser=await chromium.launch({headless:true});
const page=await browser.newPage({viewport:{width:1200,height:630},deviceScaleFactor:1});
await page.goto('http://127.0.0.1:4329/');await page.evaluate(()=>document.fonts.ready);
await page.evaluate(()=>{
 const brand=document.querySelector('.brand').outerHTML;
 const sculpture=document.querySelector('.data-sculpture').outerHTML;
 document.body.innerHTML=`<div class="social"><div class="social-copy">${brand}<div class="social-eyebrow">MANAGED WEB DATA</div><h1>The web data<br>your business needs.<br><em>Delivered.</em></h1><p>Your sources. Your fields. Your schedule.</p><div class="social-foot">fetch.headrun.ai<span>↗</span></div></div><div class="social-art">${sculpture}</div></div>`;
 const style=document.createElement('style');style.textContent=`html,body{width:1200px;height:630px;overflow:hidden}.social{height:630px;width:1200px;position:relative;padding:49px 55px;background:#111b16}.social-copy{position:relative;z-index:2}.social .brand{font-size:34px}.social-eyebrow{font:11px var(--mono);letter-spacing:2px;color:#b9d89d;margin-top:55px}.social h1{font-size:58px;line-height:1.13;letter-spacing:-3px;font-weight:550;margin-top:22px}.social h1 em{font-style:normal;color:#c7f36b}.social p{font-size:16px;color:#a3b1a4;margin-top:23px}.social-foot{border-top:1px solid #314136;padding-top:22px;margin-top:44px;width:1090px;font:14px var(--mono)}.social-foot span{float:right;color:#c7f36b;font-size:23px}.social-art{position:absolute;right:9px;top:35px;width:570px}.social-art .data-sculpture{width:570px}.social-art .sculpture-caption{display:none}*{animation:none!important;transition:none!important}`;document.head.append(style);
});
await page.screenshot({path:'public/brand/social.png'});await browser.close();
console.log('Created public/brand/social.png (1200 × 630).');
