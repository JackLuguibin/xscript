const {test} = require('node:test');
const assert = require('node:assert/strict');
const {EditorModel} = require('../../android/app/src/main/assets/tools/editor-model.js');

function fixture() {
  const calls = [];
  const projects = {demo: {'__init__.py':'print(1)', 'utils.py':'old'}}, dirs = {};
  const api = async (method, url, body) => {
    calls.push({method, url, body});
    if (url === '/projects') return {projects:Object.keys(projects)};
    const match = /^\/projects\/([^/]+)(\/[^?]*)?(?:\?(.*))?$/.exec(url);
    const name = decodeURIComponent(match[1]), sub = match[2] || '', q = new URLSearchParams(match[3]);
    if (!sub && method === 'POST') {projects[name] ||= {'__init__.py':''}; return {ok:true};}
    if (sub === '/files' && method === 'GET') return {files:Object.keys(projects[name]).map(path=>({path})),dirs:[...(dirs[name]||[])]};
    if (sub === '/files' && method === 'PUT') {
      if (body.create && body.path in projects[name]) throw new Error('文件已存在: '+body.path);
      projects[name][body.path] = body.content; return {ok:true};
    }
    if (sub === '/dir' && method === 'POST') {(dirs[name] ||= new Set()).add(body.path); return {ok:true,path:body.path};}
    if (sub === '/file' && method === 'GET') return {content:projects[name][q.get('path')],encoding:'utf-8'};
    if (sub === '/file' && method === 'DELETE') {
      if (!(q.get('path') in projects[name])) throw new Error('文件不存在: '+q.get('path'));
      delete projects[name][q.get('path')]; return {ok:true};
    }
    return {ok:true};
  };
  const model = new EditorModel(api); model.project = 'demo';
  return {model, api, calls, projects};
}
test('run saves every dirty file of the selected project before starting', async()=>{
  const {model,calls,projects}=fixture();
  const main=await model.open('__init__.py'), util=await model.open('utils.py');
  model.edit(main,'from . import utils');model.edit(util,'value=42');
  await model.run();
  assert.equal(projects.demo['utils.py'],'value=42');
  assert.deepEqual(calls.slice(-3).map(c=>[c.method,c.url]),[['PUT','/projects/demo/files'],['PUT','/projects/demo/files'],['POST','/projects/demo/run']]);
  assert.equal(model.unsaved().length,0);
  // the run reply may list permissions the phone is missing: the status line says so
  assert.deepEqual(EditorModel.runMessage('demo',{ok:true}),{text:'已请求运行 demo',warn:false,a11y:false,fix:null,fixes:[]});
  const both=EditorModel.runMessage('demo',{ok:true,missing:[{label:'悬浮窗权限',where:''},{label:'无障碍',where:'__init__.py:4'}]});
  assert.deepEqual([both.text,both.warn,both.a11y,both.fix.label,both.fix.button],
    ['已请求运行 demo · 手机上还缺：悬浮窗权限、无障碍（__init__.py:4），相关操作会失败，请在手机上的小程序详情页开启',true,true,'无障碍','打开手机无障碍设置']);
  // the one-tap fix: accessibility first, else the first permission it can open; the accessibility code matches the 节点 panel's
  const {EditorNodes}=require('../../android/app/src/main/assets/tools/editor-nodes.js');
  assert.equal(both.fix.code,EditorNodes.A11Y_CODE);
  const overlay=EditorModel.runMessage('demo',{missing:[{label:'未知',where:''},{label:'悬浮窗权限',where:'a.py:2'}]});
  assert.deepEqual([overlay.a11y,overlay.fix.label,overlay.fix.button,overlay.fix.code],[false,'悬浮窗权限','打开手机悬浮窗设置','from xscript.android import permission\n_result = permission.request(permission.OVERLAY, 1)']);
  assert.match(EditorModel.runMessage('demo',{missing:[{label:'通知使用权'}]}).fix.code,/permission\.NOTIFICATION_LISTENER, 1\)$/);
  assert.match(EditorModel.runMessage('demo',{missing:[{label:'文件访问权限'}]}).fix.code,/permission\.MANAGE_EXTERNAL_STORAGE, 1\)$/);
  const cap=EditorModel.runMessage('demo',{missing:[{label:'图色权限（截图）'}]}).fix;
  assert.deepEqual([cap.capture,cap.code,cap.button],[true,undefined,'在手机上授权截图']);
  assert.equal(EditorModel.runMessage('demo',{missing:[{label:'未知'}]}).fix,null);
  // all fixes in order (accessibility first, no repeats, unknown labels dropped) for the 下一项 button
  assert.deepEqual(EditorModel.runMessage('demo',{missing:[{label:'通知使用权'},{label:'未知'},{label:'无障碍'},{label:'通知使用权'},{label:'图色权限（截图）'}]}).fixes.map(f=>f.label),['无障碍','通知使用权','图色权限（截图）']);
  assert.deepEqual(EditorModel.runMessage('demo',{missing:[{label:'未知'}]}).fixes,[]);
  assert.equal(EditorModel.fixDone('已打开。',2),'已打开。 还有 2 项，点「下一项」继续');
  assert.equal(EditorModel.fixDone('已打开。',0),'已打开。 开启后点「再运行一次」');
  for(const f of Object.values(EditorModel.PERM_FIX)) assert.ok(f.button&&f.opened&&f.where);
  // same table as protocol/permission-fix.json (shared with VS Code and PyCharm)
  const shared=JSON.parse(require('node:fs').readFileSync(require('node:path').resolve(__dirname,'../../protocol/permission-fix.json'),'utf8')).permissions;
  assert.deepEqual(Object.keys(EditorModel.PERM_FIX).sort(),shared.map(e=>e.label).sort());
  for(const e of shared){
    const f=EditorModel.PERM_FIX[e.label];
    // the warning names the permission with the shared label
    assert.equal(e.zh.name,e.label);
    assert.match(EditorModel.runMessage('demo',{missing:[{label:e.label,where:''}]}).text,new RegExp('手机上还缺：'+e.label.replace(/[()（）]/g,'\\$&')+'，'));
    assert.deepEqual([f.button,f.opened,f.on,f.where],[e.zh.button,e.zh.opened,e.zh.on,e.zh.where],e.label);
    if(e.permission) assert.equal(f.code,'from xscript.android import permission\n_result = permission.request(permission.'+e.permission+', 1)');
    else assert.deepEqual([e.captureRequest,f.capture,f.code],[true,true,undefined]);
  }
});
test('failed save blocks execution and retains unsaved content', async()=>{
  const {model,api,calls}=fixture();const doc=await model.open('__init__.py');model.edit(doc,'changed');
  model.api=(m,u,b)=>m==='PUT'?Promise.reject(new Error('disk full')):api(m,u,b);
  await assert.rejects(model.run(),/disk full/);assert.equal(model.dirty(doc),true);
  assert.equal(calls.some(c=>c.url.endsWith('/run')),false);
});
test('typing during an in-flight save retains the newer unsaved revision', async()=>{
  const {model,api}=fixture();const doc=await model.open('__init__.py');model.edit(doc,'revision 1');
  let release;model.api=(m,u,b)=>m==='PUT'?new Promise(resolve=>{release=()=>api(m,u,b).then(resolve);}):api(m,u,b);
  const run=model.run();model.edit(doc,'revision 2');release();
  await assert.rejects(run,/再次运行/);assert.equal(doc.saved,'revision 1');assert.equal(doc.content,'revision 2');assert.equal(model.dirty(doc),true);
});
test('switching projects keeps drafts and only saves the selected project', async()=>{
  const {model,projects}=fixture();const doc=await model.open('__init__.py');model.edit(doc,'draft');
  await model.createProject('另一个工程');await model.run();
  assert.equal(projects.demo['__init__.py'],'print(1)');assert.equal(model.dirty(doc),true);
  model.project='demo';assert.equal(await model.open('__init__.py'),doc);
});
test('path traversal and overwriting a file during create are rejected', async()=>{
  const {model}=fixture();
  for(const path of ['../outside.py','/outside.py','a/../outside.py','a//b.py','.']) await assert.rejects(model.createFile(path),/工程目录/);
  await assert.rejects(model.createFile('__init__.py'),/已存在/);
  await model.createFile('res/中文.json');assert.equal((await model.open('res/中文.json')).content,'');
});
test('entry point deletion and binary edits are rejected', async()=>{
  const {model,api}=fixture();await assert.rejects(model.remove(await model.open('__init__.py')),/入口/);
  model.api=(m,u,b)=>u.includes('image.png')?Promise.resolve({content:'iVBOR',encoding:'base64'}):api(m,u,b);
  const doc=await model.open('image.png');assert.throws(()=>model.edit(doc,'text'),/二进制/);await assert.rejects(model.save(doc),/二进制/);
});
test('concurrent file loads do not overwrite an edited cached document', async()=>{
  const {model}=fixture();const responses=[];model.api=()=>new Promise(resolve=>responses.push(resolve));
  const first=model.open('utils.py'),second=model.open('utils.py');responses[0]({content:'old'});
  const doc=await first;model.edit(doc,'draft');responses[1]({content:'stale'});
  assert.equal(await second,doc);assert.equal(doc.content,'draft');
});
test('missing selection and duplicate projects fail without mutation', async()=>{
  const {model,projects}=fixture();await assert.rejects(model.createProject('demo'),/已存在/);
  for(const name of ['../bad','with space','9start']) await assert.rejects(model.createProject(name),/工程名/);
  model.project='';await assert.rejects(model.run(),/选择工程/);assert.deepEqual(Object.keys(projects),['demo']);
});
test('created file is immediately editable and savable with create-only semantics', async()=>{
  const {model,calls,projects}=fixture();
  const doc=await model.createFile(' lib/helpers.py ');
  assert.equal(doc.path,'lib/helpers.py');assert.equal(model.dirty(doc),false);
  const put=calls.find(c=>c.method==='PUT');assert.equal(put.body.create,true);
  model.edit(doc,'X = 1\n');await model.save(doc);assert.equal(projects.demo['lib/helpers.py'],'X = 1\n');
  assert.equal(await model.open('lib/helpers.py'),doc);
  for(const bad of ['.hidden.py','__pycache__/x.py','a\\..\\b.py']) await assert.rejects(model.createFile(bad));
});
test('create file surfaces a device-side duplicate (race) without overwriting', async()=>{
  const {model,projects}=fixture();const original=model.listTree.bind(model);
  model.listTree=async()=>({files:[],dirs:[]});
  await assert.rejects(model.createFile('utils.py'),/已存在/);assert.equal(projects.demo['utils.py'],'old');
  model.listTree=original;
});
test('folders can be created, are listed, and duplicates are rejected', async()=>{
  const {model}=fixture();
  assert.equal(await model.createFolder('res/data/'),'res/data');
  assert.deepEqual((await model.listTree()).dirs,['res/data']);
  await assert.rejects(model.createFolder('res/data'),/已存在/);
  await assert.rejects(model.createFolder('../x'),/工程目录/);
  await assert.rejects(model.createFolder('utils.py'),/已存在/);
});
test('deleting a file drops its document, and an already-missing file is tolerated', async()=>{
  const {model,projects}=fixture();const doc=await model.open('utils.py');model.edit(doc,'draft');
  await model.remove(doc);assert.equal('utils.py' in projects.demo,false);
  assert.equal(model.documents.has('demo:utils.py'),false);assert.equal(model.unsaved().length,0);
  const ghost={project:'demo',path:'gone.py',content:'',saved:'',binary:false};model.documents.set('demo:gone.py',ghost);
  await model.remove(ghost);assert.equal(model.documents.has('demo:gone.py'),false);
  model.api=()=>Promise.reject(new Error('disk busy'));const util=await (async()=>{const d={project:'demo',path:'x.py',content:'',saved:'',binary:false};model.documents.set('demo:x.py',d);return d;})();
  await assert.rejects(model.remove(util),/disk busy/);assert.equal(model.documents.has('demo:x.py'),true);
});
test('buildTree nests files, keeps empty folders, sorts folders before files', ()=>{
  const tree=EditorModel.buildTree(
    [{path:'__init__.py'},{path:'zeta.py'},{path:'lib/b.py'},{path:'lib/a.py'},{path:'lib/sub/deep.py'},{path:'Alpha.txt'}],
    ['assets','assets/empty','lib','lib/sub','res/img']);
  const shape=n=>n.children.map(c=>c.type==='dir'?{[c.name+'/']:shape(c)}:c.name);
  assert.deepEqual(shape(tree),[
    {'assets/':[{'empty/':[]}]},
    {'lib/':[{'sub/':['deep.py']},'a.py','b.py']},
    {'res/':[{'img/':[]}]},
    '__init__.py','Alpha.txt','zeta.py']);
  const lib=tree.children.find(c=>c.name==='lib');assert.equal(lib.path,'lib');assert.equal(lib.children[0].path,'lib/sub');
  assert.equal(lib.children[0].children[0].path,'lib/sub/deep.py');
});
test('buildTree tolerates missing dirs, string entries, trailing slashes and duplicates', ()=>{
  const tree=EditorModel.buildTree(['a/b/c.py','a/b/c.py'],['a/','x/']);
  assert.deepEqual(EditorModel.visibleRows(tree,new Set(['a','a/b'])).map(r=>[r.node.path,r.depth,r.node.type]),
    [['a',0,'dir'],['a/b',1,'dir'],['a/b/c.py',2,'file'],['x',0,'dir']]);
  assert.deepEqual(EditorModel.buildTree().children,[]);
});
test('visibleRows hides children of collapsed folders and flags empty folders', ()=>{
  const tree=EditorModel.buildTree([{path:'main.py'},{path:'pkg/m.py'}],['pkg','empty']);
  const collapsed=EditorModel.visibleRows(tree,new Set());
  assert.deepEqual(collapsed.map(r=>r.node.path),['empty','pkg','main.py']);
  assert.equal(collapsed[0].empty,true);assert.equal(collapsed[1].empty,false);assert.equal(collapsed[1].expanded,false);
  const open=EditorModel.visibleRows(tree,new Set(['pkg','gone/folder']));
  assert.deepEqual(open.map(r=>[r.node.path,r.depth,r.expanded]),[['empty',0,false],['pkg',0,true],['pkg/m.py',1,false],['main.py',0,false]]);
});
test('ancestors and folderOf drive auto-expand and new-item defaults', ()=>{
  assert.deepEqual(EditorModel.ancestors('a/b/c.py'),['a','a/b']);
  assert.deepEqual(EditorModel.ancestors('__init__.py'),[]);
  assert.equal(EditorModel.folderOf({type:'dir',path:'lib/sub'}),'lib/sub');
  assert.equal(EditorModel.folderOf({type:'file',path:'lib/sub/x.py'}),'lib/sub');
  assert.equal(EditorModel.folderOf({type:'file',path:'main.py'}),'');
  assert.equal(EditorModel.folderOf(null),'');
});
test('explorer keyboard navigation follows VS Code conventions', ()=>{
  const tree=EditorModel.buildTree([{path:'main.py'},{path:'pkg/a.py'},{path:'pkg/sub/b.py'}],['pkg','pkg/sub','empty']);
  const rows=open=>EditorModel.visibleRows(tree,new Set(open));
  let r=rows([]);
  assert.deepEqual(r.map(x=>x.node.path),['empty','pkg','main.py']);
  assert.deepEqual(EditorModel.navigate(r,'empty','ArrowDown'),{focus:'pkg'});
  assert.deepEqual(EditorModel.navigate(r,'empty','ArrowUp'),{focus:'empty'});
  assert.deepEqual(EditorModel.navigate(r,'main.py','ArrowDown'),{focus:'main.py'});
  assert.deepEqual(EditorModel.navigate(r,'pkg','ArrowRight'),{focus:'pkg',expand:'pkg'});
  assert.deepEqual(EditorModel.navigate(r,'empty','Home'),{focus:'empty'});
  assert.deepEqual(EditorModel.navigate(r,'empty','End'),{focus:'main.py'});
  r=rows(['pkg']);
  assert.deepEqual(EditorModel.navigate(r,'pkg','ArrowRight'),{focus:'pkg/sub'});
  assert.deepEqual(EditorModel.navigate(r,'pkg','ArrowLeft'),{focus:'pkg',collapse:'pkg'});
  assert.deepEqual(EditorModel.navigate(r,'pkg/a.py','ArrowLeft'),{focus:'pkg'});
  assert.deepEqual(EditorModel.navigate(r,'pkg/sub','ArrowLeft'),{focus:'pkg'});
  assert.deepEqual(EditorModel.navigate(r,'pkg/a.py','Enter'),{focus:'pkg/a.py',open:'pkg/a.py'});
  assert.deepEqual(EditorModel.navigate(r,'pkg/sub',' '),{focus:'pkg/sub',expand:'pkg/sub'});
  assert.deepEqual(EditorModel.navigate(r,'pkg','Enter'),{focus:'pkg',collapse:'pkg'});
  assert.deepEqual(EditorModel.navigate(r,'empty','ArrowRight'),{focus:'empty',expand:'empty'});
  assert.deepEqual(EditorModel.navigate(rows(['empty']),'empty','ArrowRight'),{focus:'empty'});
  assert.deepEqual(EditorModel.navigate(r,'main.py','ArrowLeft'),{focus:'main.py'});
  assert.deepEqual(EditorModel.navigate(r,'gone.py','ArrowDown'),{focus:'empty'});
  assert.deepEqual(EditorModel.navigate(r,'main.py','x'),{});
  assert.deepEqual(EditorModel.navigate([],'a','ArrowDown'),{});
});

test('movedPath remaps a file, a folder and everything inside it', ()=>{
  assert.equal(EditorModel.movedPath('a.py','a.py','b.py'),'b.py');
  assert.equal(EditorModel.movedPath('lib/x/y.py','lib','pkg/lib'),'pkg/lib/x/y.py');
  assert.equal(EditorModel.movedPath('lib','lib','pkg'),'pkg');
  assert.equal(EditorModel.movedPath('library/a.py','lib','pkg'),'library/a.py','prefix of a sibling name is untouched');
  assert.equal(EditorModel.movedPath('other.py','lib','pkg'),'other.py');
});
test('move rejects the entry point and moving a folder into itself before calling the device', async()=>{
  const {model, calls} = fixture();
  await assert.rejects(model.move('__init__.py','main.py'),/入口/);
  await assert.rejects(model.move('lib','lib/sub'),/自己/);
  await assert.rejects(model.move('utils.py','../x.py'),/工程目录内/);
  assert.equal(await model.move('utils.py','utils.py'),'utils.py','no-op');
  assert.equal(calls.filter(c=>c.url.endsWith('/move')).length,0);
});

test('createProject sends the template id; listTemplates tolerates older devices', async()=>{
  const {model,calls}=fixture();
  await model.createProject('tpl_demo','ocr');
  assert.deepEqual(calls.at(-2),{method:'POST',url:'/projects/tpl_demo',body:{template:'ocr'}});
  await model.createProject('plain');
  assert.deepEqual(calls.at(-2).body,{});
  const old=new EditorModel(async()=>{throw new Error('404');});
  assert.deepEqual(await old.listTemplates(),{templates:[],default:''});
  const ok=new EditorModel(async()=>({templates:[{id:'empty',label:'空'}],default:'empty'}));
  assert.equal((await ok.listTemplates()).templates[0].id,'empty');
});

test('saving res/ui/<name>.ui.json writes the generated page and module (shared generator)', async () => {
  const {model, projects} = fixture();
  const F = require('../../android/app/src/main/assets/tools/ui-form.js');
  const spec = F.newSpec('设置'); spec.fields.push({kind: 'text', id: 'name', label: '名称', default: 'a'});
  projects.demo['res/ui/main.ui.json'] = '';
  const doc = await model.open('res/ui/main.ui.json'); model.edit(doc, F.serializeSpec(spec));
  await model.save(doc);
  assert.deepEqual(doc.generated, {files: ['res/ui/main.html', 'ui_main.py'], error: ''});
  assert.equal(projects.demo['res/ui/main.html'], F.outputs(spec, 'main')['res/ui/main.html']);
  assert.match(projects.demo['ui_main.py'], /def show\(/);
  // an open, unedited tab of a generated file is refreshed; one with edits is never overwritten
  const page = await model.open('res/ui/main.html'); const mod = await model.open('ui_main.py'); model.edit(mod, '# mine');
  spec.title = '新标题'; model.edit(doc, F.serializeSpec(spec)); await model.save(doc);
  assert.match(page.content, /新标题/); assert.equal(page.saved, page.content);
  assert.equal(mod.content, '# mine'); assert.deepEqual(doc.generated.files, ['res/ui/main.html']);
});

test('an invalid or non-form spec generates nothing; nested projects keep their prefix', async () => {
  const {model, projects} = fixture();
  projects.demo['res/ui/bad.ui.json'] = '';
  const bad = await model.open('res/ui/bad.ui.json');
  model.edit(bad, '{"fields":[{"kind":"text","id":"class","label":"x"}]}'); await model.save(bad);
  assert.equal(bad.generated.files.length, 0); assert.match(bad.generated.error, /Python identifier/);
  model.edit(bad, '{oops'); await model.save(bad); assert.match(bad.generated.error, /JSON/);
  assert.ok(!('res/ui/bad.html' in projects.demo));
  projects.demo['sub/res/ui/f.ui.json'] = '';
  const nested = await model.open('sub/res/ui/f.ui.json'); model.edit(nested, '{"title":"t","fields":[]}'); await model.save(nested);
  assert.deepEqual(nested.generated.files, ['sub/res/ui/f.html', 'sub/ui_f.py']);
  const plain = await model.open('utils.py'); model.edit(plain, 'x = 1'); await model.save(plain);
  assert.equal(plain.generated, null);
});
test('pythonSources: every .py file for the symbol table, unsaved editor content wins, other files skipped', async () => {
  const {model, projects, calls} = fixture();
  projects.demo['pkg/a.py'] = 'A = 1\n'; projects.demo['readme.txt'] = 'x';
  const doc = await model.open('utils.py'); model.edit(doc, 'def f(): pass\n');
  calls.length = 0;
  const files = await model.pythonSources();
  assert.deepEqual(files, [{path: '__init__.py', content: 'print(1)'}, {path: 'pkg/a.py', content: 'A = 1\n'}, {path: 'utils.py', content: 'def f(): pass\n'}]);
  assert.equal(calls.filter(c => c.url.includes('/file?')).length, 2, 'open documents are not fetched again');
  assert.equal(model.documents.has(model.key('pkg/a.py', 'demo')), false, 'reading for the index does not open tabs');
});
