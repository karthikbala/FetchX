import {sampleSets,type SampleKey} from '../data/samples';
document.querySelectorAll<HTMLElement>('[data-sample-explorer]').forEach((root,index)=>{
 let selected:SampleKey='commerce';
 let format:'table'|'json'='table';
 const tabs=[...root.querySelectorAll<HTMLButtonElement>('[data-dataset]')];
 const table=root.querySelector<HTMLTableElement>('.sample-table')!;
 const json=root.querySelector<HTMLPreElement>('.sample-json')!;
 const region=root.querySelector<HTMLElement>('.sample-scroll')!;
 region.id=`sample-panel-${index}`;region.setAttribute('role','tabpanel');
 tabs.forEach((t,i)=>{t.id=`sample-tab-${index}-${i}`;t.setAttribute('aria-controls',region.id);});
 function render(){
  const set=sampleSets[selected];
  tabs.forEach(t=>{const active=t.dataset.dataset===selected;t.setAttribute('aria-selected',String(active));t.tabIndex=active?0:-1;if(active)region.setAttribute('aria-labelledby',t.id);});
  root.querySelector('.dataset-filename')!.textContent=set.filename;
  root.querySelector('.sample-description')!.textContent=set.description;
  root.querySelector('.field-count')!.textContent=String(set.columns.length);
  root.querySelector('.record-count')!.textContent=String(set.records.length);
  table.replaceChildren();
  const head=table.createTHead().insertRow();
  set.columns.forEach(([,label])=>{const th=document.createElement('th');th.scope='col';th.textContent=label;head.append(th);});
  const body=table.createTBody();
  set.records.forEach(record=>{const tr=body.insertRow();set.columns.forEach(([key])=>{const value=String((record as unknown as Record<string,string|number>)[key]);const td=tr.insertCell();if(key==='availability'||key==='status'||key==='milestone'){const badge=document.createElement('span');badge.className='status-pill';badge.textContent=value;td.append(badge);}else td.textContent=value;});});
  json.querySelector('code')!.textContent=JSON.stringify(set.records,null,2);
  table.hidden=format!=='table';json.hidden=format!=='json';
  root.querySelectorAll<HTMLButtonElement>('[data-format]').forEach(b=>b.setAttribute('aria-pressed',String(b.dataset.format===format)));
 }
 tabs.forEach((tab,i)=>{tab.addEventListener('click',()=>{selected=tab.dataset.dataset as SampleKey;render();});tab.addEventListener('keydown',e=>{let next=i;if(e.key==='ArrowRight')next=(i+1)%tabs.length;else if(e.key==='ArrowLeft')next=(i+tabs.length-1)%tabs.length;else if(e.key==='Home')next=0;else if(e.key==='End')next=tabs.length-1;else return;e.preventDefault();tabs[next].focus();tabs[next].click();});});
 root.querySelectorAll<HTMLButtonElement>('[data-format]').forEach(b=>b.addEventListener('click',()=>{format=b.dataset.format as typeof format;render();}));
 root.querySelector('.download-sample')?.addEventListener('click',()=>{
  const set=sampleSets[selected];
  const escape=(v:unknown)=>`"${String(v).replaceAll('"','""')}"`;
  const csv=[set.columns.map(([key])=>escape(key)).join(','),...set.records.map(r=>set.columns.map(([key])=>escape((r as unknown as Record<string,unknown>)[key])).join(','))].join('\r\n')+'\r\n';
  const url=URL.createObjectURL(new Blob([csv],{type:'text/csv;charset=utf-8;'}));
  const a=document.createElement('a');a.href=url;a.download=set.filename;document.body.append(a);a.click();a.remove();setTimeout(()=>URL.revokeObjectURL(url),1000);
 });
 const requested=new URLSearchParams(location.search).get('dataset');if(requested&&Object.hasOwn(sampleSets,requested))selected=requested as SampleKey;
 render();
});
