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
    // 新建工程 / 新建文件 / 新建文件夹 / 删除文件 against the device contract.
    await assert.rejects(model.createProject('rea_smoke'),/已存在/);
    await assert.rejects(api('POST','/projects/rea_smoke',{}),/已存在/);
    await assert.rejects(api('POST','/projects/'+encodeURIComponent('bad name'),{}),/工程名/);
    await assert.rejects(api('PUT',model.projectUrl()+'/files',{path:'utils.py',content:'x',create:true}),/已存在/);
    await assert.rejects(api('PUT','/projects/nope/files',{path:'a.py',content:'',create:true}),/不存在/);
    await assert.rejects(api('PUT',model.projectUrl()+'/files',{path:'../evil.py',content:'',create:true}),/invalid path/);
    const nested=await model.createFile('pkg/sub/mod.py');model.edit(nested,'Y = 2\n');await model.save(nested);
    assert.equal((await api('GET',model.projectUrl()+'/file?path=pkg/sub/mod.py')).content,'Y = 2\n');
    assert.equal(await model.createFolder('assets'),'assets');
    let tree=await model.listTree();assert(tree.dirs.includes('assets'));assert(tree.dirs.includes('pkg/sub'));
    await assert.rejects(api('DELETE',model.projectUrl()+'/file?path=__init__.py'),/入口/);
    await assert.rejects(api('DELETE',model.projectUrl()+'/file?path=pkg'),/非空/);
    {const tmp=await model.createFile('gone/a/b.py');await model.save(tmp);await model.createFile('gone/c.txt');
     const r=await model.removeFolder('gone',undefined,true);assert.equal(r.deleted,2);
     const t2=await model.listTree();assert(!t2.files.some(f=>f.path.startsWith('gone/')));assert(!t2.dirs.some(d=>d==='gone'||d.startsWith('gone/')));
     await assert.rejects(api('DELETE',model.projectUrl()+'/file?path=__init__.py&recursive=1'),/入口/);
     await assert.rejects(api('DELETE',model.projectUrl()+'/file?path=nope&recursive=1'),/不存在/);}
    await assert.rejects(api('DELETE',model.projectUrl()+'/file?path=missing.py'),/不存在/);
    // 重命名 / 移动 (POST /move): open documents follow, conflicts and bad paths are rejected.
    const mv=await model.open('pkg/sub/mod.py');model.edit(mv,'Y = 3\n');
    assert.equal(await model.move('pkg/sub/mod.py','pkg/sub/renamed.py'),'pkg/sub/renamed.py');
    assert.equal(mv.path,'pkg/sub/renamed.py');assert.equal(model.documents.get(model.key('pkg/sub/renamed.py')),mv);assert(model.dirty(mv));
    assert.equal((await api('GET',model.projectUrl()+'/file?path=pkg/sub/renamed.py')).content,'Y = 2\n');
    await model.move('pkg','lib/pkg');assert.equal(mv.path,'lib/pkg/sub/renamed.py');
    tree=await model.listTree();assert(tree.files.some(f=>f.path==='lib/pkg/sub/renamed.py'));assert(tree.dirs.includes('lib/pkg/sub'));assert.equal(tree.dirs.includes('pkg'),false);
    await assert.rejects(api('POST',model.projectUrl()+'/move',{from:'lib/pkg/sub/renamed.py',to:'utils.py'}),/已存在/);
    await assert.rejects(api('POST',model.projectUrl()+'/move',{from:'nope.py',to:'x.py'}),/不存在/);
    await assert.rejects(api('POST',model.projectUrl()+'/move',{from:'__init__.py',to:'main.py'}),/入口/);
    await assert.rejects(api('POST',model.projectUrl()+'/move',{from:'lib',to:'lib/inner'}),/自己/);
    await assert.rejects(api('POST',model.projectUrl()+'/move',{from:'utils.py',to:'../out.py'}),/invalid path/);
    await assert.rejects(api('POST','/projects/nope/move',{from:'a',to:'b'}),/不存在/);
    await model.move('lib/pkg','pkg');model.documents.delete(model.key(mv.path));
    await model.remove(nested);await model.removeFolder('assets');
    tree=await model.listTree();assert.equal(tree.files.some(f=>f.path==='pkg/sub/mod.py'),false);assert.equal(tree.dirs.includes('assets'),false);
    await model.createProject('第二个_工程');assert((await model.listProjects()).includes('第二个_工程'));
    assert.deepEqual((await model.listFiles()).map(f=>f.path),['__init__.py']);
    const tpl=await model.listTemplates();assert.equal(tpl.default,'empty');
    assert.deepEqual(tpl.templates.map(t=>t.id),['empty','hello','ascript','checkin','findImage','ocr','floatUi']);
    await model.createProject('tpl_hello','hello');const hello=await api('GET','/projects/tpl_hello/file?path=__init__.py');
    assert(!hello.content.includes('{{name}}'));
    await assert.rejects(api('POST','/projects/tpl_bad',{template:'nope'}),/模板/);
    assert.equal((await model.listProjects()).includes('tpl_bad'),false);
    for(const url of ['/tools/ui/editor.html','/tools/ui/editor.js','/tools/ui/editor-model.js','/tools/ui/editor-syntax.js','/tools/ui/editor-api.js','/tools/ui/editor-docs.js','/tools/ui/editor-complete.js','/tools/ui/editor-parse.js','/tools/ui/editor-check.js','/tools/ui/editor-symbols.js','/tools/ui/editor-assist.js','/tools/ui/editor-search.js','/tools/ui/editor-panels.js','/tools/ui/editor-nodes.js','/tools/ui/editor.css','/website/src/editor.html']){
      const r=await fetch(base+url);assert.equal(r.status,200,url);assert((await r.text()).length>0);
      // same caching as the device: a validator, revalidated each load; 304 without a body while it still matches
      const tag=r.headers.get('etag');assert.match(tag||'',/^"xs-/,url);assert.equal(r.headers.get('cache-control'),'no-cache',url);
      const again=await fetch(base+url,{headers:{'If-None-Match':tag}});assert.equal(again.status,304,url);assert.equal((await again.text()).length,0,url);
      assert.equal((await fetch(base+url,{headers:{'If-None-Match':'"xs-other"'}})).status,200,url);
    }
    // editor.html loads its scripts in one combo request: the files joined in the listed order, cached like the rest
    const html=await (await fetch(base+'/tools/ui/editor.html')).text();
    const combo=(html.match(/<script src="(\/tools\/ui\/combo\.js\?f=[^"]+)"/)||[])[1];assert.ok(combo,'editor.html uses combo.js');
    const names=combo.split('f=')[1].split(',');assert.ok(names.length>=15&&names[0]==='common.js'&&names.includes('editor.js'),names.join());
    const cr=await fetch(base+combo),body=await cr.text();assert.equal(cr.status,200);assert.match(cr.headers.get('content-type'),/javascript/);
    let at=-1;for(const n of names){const i=body.indexOf('/* ---- '+n+' ---- */');assert.ok(i>at,n+' in order');at=i;assert.ok(body.includes(await (await fetch(base+'/tools/ui/'+n)).text()),n+' whole');}
    assert.equal((await fetch(base+combo,{headers:{'If-None-Match':cr.headers.get('etag')}})).status,304);
    for(const bad of ['','../x.js','a.js,a.js','tools.css','sub/x.js','.hidden.js'])assert.equal((await fetch(base+'/tools/ui/combo.js?f='+encodeURIComponent(bad))).status,400,bad);
  } finally {
    child.kill();
  }
});
