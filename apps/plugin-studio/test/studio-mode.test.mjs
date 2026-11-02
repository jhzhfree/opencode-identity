import {test} from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import vm from 'node:vm';

async function page(search='') {
  const html=await readFile(new URL('../public/index.html',import.meta.url),'utf8');
  const elements=new Map([...html.matchAll(/id="([^"]+)"/g)].map(([,id])=>[id,{
    value:'',dataset:{},hidden:true,textContent:'',innerHTML:'',listeners:{},
    addEventListener(name,fn){this.listeners[name]=fn;},querySelectorAll(){return [];},
  }]));
  const location={href:'http://localhost/'+search,search};
  const document={body:{dataset:{}},getElementById(id){assert.ok(elements.has(id),`missing DOM element ${id}`);return elements.get(id);}};
  const context=vm.createContext({document,location,URL,URLSearchParams,console,AbortController,setTimeout,clearTimeout,
    history:{replaceState(a,b,url){const next=new URL(url,location.href);location.href=next.href;location.search=next.search;}},
    fetch:()=>new Promise(()=>{}),
  });
  vm.runInContext(await readFile(new URL('../public/app.js',import.meta.url),'utf8'),context);
  return {elements,context,document,location};
}

test('Studio defaults to original workflow and switches modes without losing results',async()=>{
  const p=await page();
  assert.equal(p.document.body.dataset.pluginMode,'basic');
  p.elements.get('build-result').innerHTML='existing basic result';
  p.elements.get('akb-summary').textContent='existing AKB result';
  const mode=p.elements.get('plugin-mode');
  mode.value='akb';mode.listeners.change();
  assert.equal(p.document.body.dataset.pluginMode,'akb');
  assert.match(p.location.search,/mode=akb/);
  mode.value='basic';mode.listeners.change();
  assert.equal(p.elements.get('build-result').innerHTML,'existing basic result');
  assert.equal(p.elements.get('akb-summary').textContent,'existing AKB result');
  assert.equal(p.document.body.dataset.pluginMode,'basic');
});

test('restoring an AKB job selects AKB actions instead of rendering basic MCP steps',async()=>{
  const p=await page('?job=akb-job');
  p.context.fetch=async()=>({ok:true,text:async()=>JSON.stringify({id:'akb-job',state:'done',result:{target:'akb',workspace:'workspace',dataDir:'data',opencodeMajor:'2',serverUrl:'https://akb.example',agents:[{agentName:'build',uuid:'uuid'}]}})});
  assert.equal(await vm.runInContext('restoreFromQuery()',p.context),true);
  assert.equal(p.document.body.dataset.pluginMode,'akb');
  assert.equal(p.elements.get('akb-result').hidden,false);
  assert.equal(p.elements.get('akb-install-major').value,'2');
  assert.equal(p.elements.get('workspace').value,'workspace');
  assert.equal(p.elements.get('akb-download').href,'/api/download/akb-job');
  assert.equal(p.elements.get('step2').hidden,true);
});
