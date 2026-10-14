/* Contract smoke test against the local device fixture, not an Android runtime. */
const {test} = require('node:test');
const assert = require('node:assert/strict');
const {spawn} = require('node:child_process');
const path = require('node:path');
const {EditorModel} = require('../../android/app/src/main/assets/tools/editor-model.js');

test('Web IDE native HTTP contract and packaged asset routes', {timeout:15000}, async()=>{
  const child=spawn(process.env.PYTHON || 'python3',['-u','-c',
    'import sys,threading;sys.path.insert(0,"scripts");from mock_device import serve;s=serve();print(s.server_address[1],flush=True);threading.Event().wait()'],
    {cwd:path.resolve(__dirname,'../..'),stdio:['ignore','pipe','pipe']});
  try {
    const port=await new Promise((resolve,reject)=>{
      let out='',err='';const timer=setTimeout(()=>reject(Error('Mock startup timed out: '+err)),5000);
      child.once('error',e=>{clearTimeout(timer);reject(e);});
      child.once('exit',code=>{clearTimeout(timer);reject(Error('Mock exited '+code+': '+err));});
      child.stderr.on('data',b=>{err+=b;});
      child.stdout.on('data',b=>{out+=b;if(out.includes('\n')){clearTimeout(timer);resolve(Number(out.trim()));}});
    });
    const base='http://127.0.0.1:'+port;
    const api=async(method,url,body)=>{
      const r=await fetch(base+url,{method,headers:{'Content-Type':'application/json'},body:body===undefined?undefined:JSON.stringify(body)});
      const data=await r.json();if(!r.ok)throw Error(data.error);return data;
    };
    const model=new EditorModel(api);await model.createProject('rea_smoke');
    const main=await model.open('__init__.py');model.edit(main,'from ascript.android import action\nprint("REA smoke")\n');
    const util=await model.createFile('utils.py');model.edit(util,'value = 42\n');
    await model.run();
    assert.equal((await api('GET','/status')).project,'rea_smoke');
    const saved=await api('GET',model.projectUrl()+'/file?path=__init__.py');assert.equal(saved.content,main.content);
    assert.equal((await api('GET',model.projectUrl()+'/file?path=utils.py')).content,'value = 42\n');
    const logs=await api('GET','/logs?since=0');assert(logs.entries.length>0);assert(logs.next>0);
    assert.deepEqual((await api('GET','/logs?since='+logs.next)).entries,[]);
    await model.stop();assert.equal((await api('GET','/status')).running,false);
    for(const url of ['/tools/ui/editor.html','/tools/ui/editor.js','/tools/ui/editor-model.js','/tools/ui/editor.css','/website/src/editor.html']){
      const r=await fetch(base+url);assert.equal(r.status,200,url);assert((await r.text()).length>0);
    }
  } finally {
    child.kill();
  }
});
