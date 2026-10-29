const root=document.documentElement;
const controls=[...document.querySelectorAll<HTMLButtonElement>('.motion-control')];
const reduced=matchMedia('(prefers-reduced-motion: reduce)');
try {if(sessionStorage.getItem('fetchx-motion')==='off')root.classList.add('motion-paused');}catch{}
function syncMotion(){
 if(reduced.matches)root.classList.add('motion-paused');
 const paused=root.classList.contains('motion-paused');
 controls.forEach(button=>{button.disabled=reduced.matches;button.setAttribute('aria-pressed',String(paused));button.setAttribute('aria-label',reduced.matches?'Reduced motion enabled':paused?'Play animation':'Pause animation');const text=button.querySelector('.motion-text');if(text)text.textContent=reduced.matches?'Reduced motion':paused?'Play animation':'Pause animation';});
}
controls.forEach(button=>button.addEventListener('click',()=>{root.classList.toggle('motion-paused');try{sessionStorage.setItem('fetchx-motion',root.classList.contains('motion-paused')?'off':'on');}catch{}syncMotion();}));
reduced.addEventListener('change',syncMotion);syncMotion();
const menu=document.querySelector<HTMLButtonElement>('.mobile-menu');
const nav=document.querySelector<HTMLElement>('#navigation');
function closeMenu(){nav?.classList.remove('is-open');menu?.setAttribute('aria-expanded','false');menu?.setAttribute('aria-label','Open navigation');}
menu?.addEventListener('click',()=>{const open=nav?.classList.toggle('is-open');menu.setAttribute('aria-expanded',String(open));menu.setAttribute('aria-label',open?'Close navigation':'Open navigation');});
nav?.querySelectorAll('a').forEach(a=>a.addEventListener('click',closeMenu));
document.addEventListener('keydown',e=>{if(e.key==='Escape'&&nav?.classList.contains('is-open')){closeMenu();menu?.focus();}});
document.addEventListener('click',e=>{if(!nav?.contains(e.target as Node)&&!menu?.contains(e.target as Node))closeMenu();});
