// Recipes are reviewed server configuration. Callers supply named text values,
// never JavaScript, selectors, destinations, or provider options.
import {fail} from './policy.mjs';
import {hasHtmlChallenge} from './source-challenge.mjs';
const object=x=>x&&typeof x==='object'&&!Array.isArray(x);
const name=x=>typeof x==='string'&&/^[a-zA-Z][a-zA-Z0-9_]{0,63}$/.test(x);
const selector=x=>typeof x==='string'&&x.length>0&&x.length<=512;
const actions=new Set(['click','fill','select','press','wait','scroll']);
export function recipeInput(input,profile){
 if(input===undefined)return undefined;
 if(profile.execution!=='browser'||!object(input)||Object.keys(input).some(k=>!['recipe','values'].includes(k))||!name(input.recipe)||!Object.hasOwn(profile.browserRecipes??{},input.recipe))fail('browser_recipe_rejected');
 const recipe=profile.browserRecipes[input.recipe];validateRecipe(recipe);
 const values=input.values??{};
 const required=new Set(recipe.steps.filter(s=>s.valueFrom).map(s=>s.valueFrom));
 if(!object(values)||Object.keys(values).some(k=>!required.has(k))||[...required].some(k=>!Object.hasOwn(values,k)||typeof values[k]!=='string'||values[k].length>4096)||Buffer.byteLength(JSON.stringify(values))>Math.min(profile.maxInputBytes,32768))fail('browser_values_rejected');
 return {recipe:input.recipe,values:Object.fromEntries(Object.entries(values).sort(([a],[b])=>a.localeCompare(b)))};
}
export function validateRecipe(recipe){
 if(!object(recipe)||Object.keys(recipe).some(k=>!['steps','extract','screenshot'].includes(k))||!Array.isArray(recipe.steps)||recipe.steps.length>20)fail('browser_recipe_configuration',500);
 for(const s of recipe.steps){
  if(!object(s)||Object.keys(s).some(k=>!['action','selector','value','valueFrom','state'].includes(k))||!actions.has(s.action)||!selector(s.selector))fail('browser_recipe_configuration',500);
  if(['fill','select'].includes(s.action)){
   if((s.value!==undefined)===(s.valueFrom!==undefined)||s.value!==undefined&&(typeof s.value!=='string'||s.value.length>4096)||s.valueFrom!==undefined&&!name(s.valueFrom))fail('browser_recipe_configuration',500);
  }else if(s.valueFrom!==undefined||s.value!==undefined&&s.action!=='press')fail('browser_recipe_configuration',500);
  if(s.action==='press'&&!['Enter','Tab','Escape','ArrowDown','ArrowUp'].includes(s.value))fail('browser_recipe_configuration',500);
  if(s.state!==undefined&&(s.action!=='wait'||!['visible','hidden','attached','detached'].includes(s.state)))fail('browser_recipe_configuration',500);
 }
 if(recipe.extract!==undefined){
  if(!object(recipe.extract)||Object.keys(recipe.extract).length>20)fail('browser_recipe_configuration',500);
  for(const [key,field]of Object.entries(recipe.extract))if(!name(key)||!object(field)||Object.keys(field).some(k=>!['selector','attribute','all'].includes(k))||!selector(field.selector)||field.attribute!==undefined&&(typeof field.attribute!=='string'||!/^[a-zA-Z][a-zA-Z0-9_-]{0,63}$/.test(field.attribute))||field.all!==undefined&&typeof field.all!=='boolean')fail('browser_recipe_configuration',500);
 }
 if(recipe.screenshot!==undefined&&recipe.screenshot!==false&&recipe.screenshot!=='viewport'&&!selector(recipe.screenshot))fail('browser_recipe_configuration',500);
}
export async function runRecipe(page,recipe,values,progress,{status,onCheckpoint}={}){
 if(status!==undefined){
  if([401,403].includes(status))fail('source_denied');
  if(status===429)fail('browser_capture_failed');
  if(hasHtmlChallenge({status,headers:{'content-type':'text/html'},body:Buffer.from(await page.content())}))fail('source_challenge');
 }
 for(const [index,step]of recipe.steps.entries()){
  if(onCheckpoint)await onCheckpoint();
  progress.step=index;
  // Any action may trigger JavaScript/network effects; never replay it on a
  // different provider after a timeout, denial, or lost acknowledgement.
  if(step.action!=='wait')progress.actionsStarted=true;
  const locator=page.locator(step.selector),value=step.valueFrom?values[step.valueFrom]:step.value;
  switch(step.action){
   case 'click':await locator.click();break;
   case 'fill':await locator.fill(value);break;
   case 'select':await locator.selectOption(value);break;
   case 'press':await locator.press(value);break;
   case 'wait':try{await locator.waitFor({state:step.state??'visible'});}catch(e){if(!onCheckpoint||!await onCheckpoint())throw e;await locator.waitFor({state:step.state??'visible'});}break;
   case 'scroll':await locator.scrollIntoViewIfNeeded();break;
  }
  progress.completed=index+1;
  if(onCheckpoint&&['click','press'].includes(step.action))await onCheckpoint({waitForChallenge:true});
 }
}
export async function extractRecipe(page,recipe){
 const extracted={};
 for(const [key,field]of Object.entries(recipe.extract??{})){
  const locator=page.locator(field.selector),count=await locator.count();
  if(count>100)fail('browser_extraction_limit');
  const values=[];
  for(let i=0;i<Math.min(count,field.all?100:1);i++){
   const item=locator.nth(i),value=field.attribute?await item.getAttribute(field.attribute):await item.textContent();
   if(value!==null&&Buffer.byteLength(value)>65536)fail('browser_extraction_limit');
   values.push(value);
  }
  extracted[key]=field.all?values:values[0]??null;
 }
 return extracted;
}
