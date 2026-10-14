const {test} = require('node:test');
const assert = require('node:assert/strict');
const {EditorModel} = require('../../android/app/src/main/assets/tools/editor-model.js');

function fixture() {
  const calls = [];
  const projects = {demo: {'__init__.py':'print(1)', 'utils.py':'old'}};
  const api = async (method, url, body) => {
    calls.push({method, url, body});
    if (url === '/projects') return {projects:Object.keys(projects)};
    const match = /^\/projects\/([^/]+)(\/[^?]*)?(?:\?(.*))?$/.exec(url);
    const name = decodeURIComponent(match[1]), sub = match[2] || '', q = new URLSearchParams(match[3]);
    if (!sub && method === 'POST') {projects[name] ||= {'__init__.py':''}; return {ok:true};}
    if (sub === '/files' && method === 'GET') return {files:Object.keys(projects[name]).map(path=>({path}))};
    if (sub === '/files' && method === 'PUT') {projects[name][body.path] = body.content; return {ok:true};}
    if (sub === '/file' && method === 'GET') return {content:projects[name][q.get('path')],encoding:'utf-8'};
    if (sub === '/file' && method === 'DELETE') {delete projects[name][q.get('path')]; return {ok:true};}
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
