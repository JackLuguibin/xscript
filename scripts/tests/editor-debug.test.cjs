const test = require('node:test');
const assert = require('node:assert/strict');
const {XScriptDebugger} = require('../../android/app/src/main/assets/tools/editor-debug.js');
const {EditorModel} = require('../../android/app/src/main/assets/tools/editor-model.js');
const tick = () => new Promise(r => setImmediate(r));

test('initialized event can precede initialize response; attach never waits on configurationDone', async () => {
  const commands = [];
  const client = new XScriptDebugger(async (method, path, body) => {
    if (path !== '/debug/request') return {ok:true};
    commands.push(body.command);
    if (body.command === 'initialize') {
      client.receive({type:'event',event:'initialized'});
      assert.deepEqual(commands, ['initialize']);
    }
    if (body.command !== 'attach') queueMicrotask(() => client.receive({type:'response',request_seq:body.seq,success:true,body:{}}));
  });
  client.loop = () => {};
  await client.toggle('__init__.py', 3, 'demo');
  await client.start('demo', '/data/projects/demo');
  await tick();
  assert.deepEqual(commands, ['initialize','attach','setBreakpoints','configurationDone']);
  await client.close();
});

test('paused frame fetches scopes and variables; external source is never opened', async () => {
  const opened = [], groups = [], commands = [];
  const responses = {stackTrace:{stackFrames:[{id:7,line:3,source:{path:'/system/runtime.py'}}]},scopes:{scopes:[{name:'Locals',variablesReference:9}]},variables:{variables:[{name:'counter',value:'42'}]}};
  const client = new XScriptDebugger(async (_, path, body) => {
    if (path !== '/debug/request') return {};
    commands.push(body.command);
    queueMicrotask(() => client.receive({type:'response',request_seq:body.seq,success:true,body:responses[body.command]}));
  }, {source:(...args) => opened.push(args), variables:g => groups.push(g)});
  client.active = true; client.remoteRoot = '/data/projects/demo';
  client.receive({type:'event',event:'stopped',body:{threadId:1,reason:'breakpoint'}});
  await tick();
  assert.deepEqual(commands, ['stackTrace','scopes','variables']);
  assert.deepEqual(opened, []);
  assert.equal(groups[0][0].variables[0].value, '42');
  assert.equal(client.relative('/data/projects/demo/../secret.py'), null);
  assert.equal(client.relative('/data/projects/demo2/file.py'), null);
  assert.equal(client.relative('/data/projects/demo/mod/file.py'), 'mod/file.py');
  await client.close();
});

test('late session replies are ignored and outstanding requests are rejected on close', async () => {
  const client = new XScriptDebugger(async () => ({})); client.active = true;
  const epoch = client.epoch;
  const pending = client.request('threads');
  const rejected = assert.rejects(pending, /关闭/);
  await client.close(); await rejected;
  client.receive({type:'event',event:'stopped',body:{threadId:99}}, epoch);
  assert.equal(client.threadId, null);
});

test('debug saves drafts and refuses changes made while saving', async () => {
  const calls = [];
  const model = new EditorModel(async (method, path) => {calls.push(path); if(method === 'PUT') model.edit(doc,'newer'); return {};});
  model.project = 'demo';
  const doc = {project:'demo',path:'__init__.py',content:'changed',saved:'old'};
  model.documents.set(model.key(doc.path),doc);
  await assert.rejects(model.run('debug'), /内容已变化/);
  assert.equal(calls.some(p => p.endsWith('/debug')),false);
});

test('transport EOF reports finished only when runtime has stopped; buffered responses are processed first', async () => {
  for (const running of [false, true]) {
    const states = [], paths = [];
    const client = new XScriptDebugger(async (_, path) => {
      paths.push(path);
      if (path.startsWith('/debug/messages')) return {messages:[{id:1,message:{type:'response',request_seq:1,success:true,body:{delivered:true}}}],next:1,connected:false};
      if (path === '/status') return {running};
      return {};
    }, {state: state => states.push(state)});
    client.active = true; client.cursor = 0;
    const response = client.request('threads');
    await client.loop(client.epoch);
    assert.deepEqual(await response, {delivered:true});
    assert.deepEqual(states, [running ? '调试连接已断开' : '已结束']);
    assert.equal(client.active, false);
    assert.equal(paths.includes('/status'), true);
  }
});

test('runtime status response after session replacement cannot close the new session', async () => {
  let resolveStatus;
  const states = [];
  const client = new XScriptDebugger(async (_, path) => {
    if (path.startsWith('/debug/messages')) return {messages:[],next:0,connected:false};
    if (path === '/status') return new Promise(resolve => {resolveStatus = resolve;});
    return {};
  }, {state: state => states.push(state)});
  client.active = true; client.cursor = 0;
  const loop = client.loop(client.epoch);
  await tick();
  await client.close(false); client.active = true;
  resolveStatus({running:false});
  await loop;
  assert.equal(client.active, true);
  assert.deepEqual(states, []);
  await client.close(false);
});

test('detach sends non-terminating DAP disconnect and awaits its response before deleting transport', async () => {
  const calls = []; let detach;
  const client = new XScriptDebugger(async (method, path, body) => {
    calls.push({method,path,body});
    if (path === '/debug/request') detach = body;
    return {};
  });
  client.active = true; client.transportConnected = true; client.attachSent = true;
  const close = client.close();
  assert.equal(calls.length, 1);
  assert.equal(detach.command, 'disconnect');
  assert.deepEqual(detach.arguments, {terminateDebuggee:false});
  client.receive({type:'event',event:'terminated'});
  assert.equal(client.active, true, 'terminated during detach must leave reader alive for response');
  client.receive({type:'response',request_seq:detach.seq,success:true,body:{}});
  await close;
  assert.deepEqual(calls.map(c => [c.method,c.path]), [['POST','/debug/request'],['DELETE','/debug']]);
  assert.equal(client.active, false);
});

test('passive close never sends disconnect or DELETE even for attached transport', async () => {
  const calls = [];
  const client = new XScriptDebugger(async (...args) => {calls.push(args); return {};});
  client.active = true; client.transportConnected = true; client.attachSent = true;
  await client.close(false);
  assert.deepEqual(calls, []);
  assert.equal(client.transportConnected, false);
});
