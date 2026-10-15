const cdp=require('./cdp.cjs');
(async()=>{
 const base='http://127.0.0.1:19860';
 await fetch(base+'/projects/mob',{method:'POST',headers:{'Content-Type':'application/json'},body:'{}'});
 const b=await cdp.attach('http://127.0.0.1:9222');
 try{
  await b.goto('http://127.0.0.1:9860/tools/ui/editor.html?project=mob');
  await b.waitFor(()=>document.getElementById('editor').value.length>0);
  for(let i=0;i<2;i++){
  await b.eval(()=>{window.__ev=[];const A=window.EditorAssist;if(!window.__w){window.__w=1;const c=A.prototype.close;A.prototype.close=function(){window.__ev.push('close '+new Error().stack.split('\n').slice(2,5).map(x=>x.trim().replace(/http:\/\/[^ ]*\//,'')).join(' < '));return c.apply(this,arguments)};const o=A.prototype.open;A.prototype.open=function(x){const r=this.complete.suggest(this.box.value,this.box.selectionStart,x);window.__ev.push('open suggest='+(r?r.items.length:null)+' sel='+this.box.selectionStart+'/'+this.box.selectionEnd+' active='+this.active);return o.apply(this,arguments)};}
   const e=document.getElementById('editor');e.focus();const t='from xscript.android import action\nz = '+'1 + '.repeat(14);e.value=t;e.setSelectionRange(t.length,t.length);e.dispatchEvent(new Event('input'));});
  await b.insertText('action.cl');
  await new Promise(r=>setTimeout(r,600));
  console.log(i,JSON.stringify(await b.eval(()=>({ev:window.__ev,hidden:document.getElementById('complete').hidden})),null,1));
  }
 } finally {await b.close()}
})().catch(e=>{console.error(e);process.exit(1)});
