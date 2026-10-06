// Actual CLI hook transport with an owned, scripted loopback model API.
// No remote models, credentials, user settings, or external projects are used.
import { readSessions, readTranscript } from '../server/sessions.ts';
import { observationEvents } from '../runtime/observer.ts';
import { spawn } from 'node:child_process';
import { createServer } from 'node:http';
import { mkdtemp, mkdir, writeFile, readFile, rm, realpath } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
const root = await realpath(await mkdtemp(join(tmpdir(),'native-hook-smoke-')));
const workspace = fileURLToPath(new URL('../',import.meta.url));
const children = new Set();
const feedbackEvidence = {};
const rounds = { codex:0, claude:0 };
let provider = 'claude'; let project;
const quote = value => "'" + value.replaceAll("'", "'\\''") + "'";
function run(executable,args,env) {
  return new Promise((accept,reject)=>{
    const child=spawn(executable,args,{cwd:project,env,stdio:['ignore','pipe','pipe']});children.add(child);
    let stdout='',stderr='';const timer=setTimeout(()=>{child.kill('SIGKILL');reject(new Error(`${executable} timeout: ${stderr.slice(-2000)}`));},45000);
    child.stdout.on('data',chunk=>stdout+=chunk);child.stderr.on('data',chunk=>stderr+=chunk);
    child.on('error',error=>{clearTimeout(timer);reject(error)});
    child.on('close',code=>{clearTimeout(timer);children.delete(child);accept({code,stdout,stderr})});
  });
}
const endpoint=createServer(async(req,res)=>{
  let raw='';for await(const chunk of req)raw+=chunk;
  if(req.url?.includes('count_tokens')){res.writeHead(200,{'Content-Type':'application/json'}).end('{"input_tokens":100}');return;}
  if(req.method!=='POST'){res.writeHead(200,{'Content-Type':'application/json'}).end('{}');return;}
  const body=JSON.parse(raw);const round=++rounds[provider];
  if (round===3) {
    const messages = provider==='codex' ? (body.input??[]).filter(item=>item.type==='function_call_output') : (body.messages??[]).filter(item=>item.role==='user');
    const visible = JSON.stringify(messages);
    feedbackEvidence[provider]={feedbackPresent:visible.includes('Fixture post-tool feedback'),originalOutputPresent:visible.includes('ORIGINAL_TOOL_OUTPUT')};
  }
  if(round>8){res.writeHead(400).end('{"error":{"type":"invalid_request_error","message":"Fixture request limit"}}');return;}
  const command=`${quote(process.execPath)} -e ${quote(`require('node:fs').writeFileSync(${JSON.stringify(join(project,round===1?'denied-sentinel':'allowed-sentinel'))},'fixture');console.log('ORIGINAL_TOOL_OUTPUT')`)}`;
  res.writeHead(200,{'Content-Type':'text/event-stream','Cache-Control':'no-cache'});
  const emit=(type,value)=>res.write(`event: ${type}\ndata: ${JSON.stringify({type,...value})}\n\n`);
  if(provider==='claude'){
    const tool=round<=2;const content=tool?{type:'tool_use',id:`tool_${round}`,name:'Bash',input:{command}}:{type:'text',text:'Fixture completed.'};
    emit('message_start',{message:{id:`msg_${round}`,type:'message',role:'assistant',model:body.model,content:[],stop_reason:null,stop_sequence:null,usage:{input_tokens:0,output_tokens:0}}});
    emit('content_block_start',{index:0,content_block:tool?{...content,input:{}}:{type:'text',text:''}});
    emit('content_block_delta',{index:0,delta:tool?{type:'input_json_delta',partial_json:JSON.stringify(content.input)}:{type:'text_delta',text:content.text}});
    emit('content_block_stop',{index:0});emit('message_delta',{delta:{stop_reason:tool?'tool_use':'end_turn',stop_sequence:null},usage:{output_tokens:0}});emit('message_stop',{});
  }else{
    const tool=round<=2;const functions=(body.tools??[]).flatMap(item=>item.tools??[item]);
    const name=functions.find(item=>item.name==='exec_command')?.name??functions.find(item=>item.name==='shell')?.name;
    if(tool&&!name){res.end();throw new Error(`No shell tool: ${JSON.stringify(functions.map(item=>item.name))}`)}
    const item=tool?{type:'function_call',id:`fc_${round}`,call_id:`call_${round}`,name,arguments:JSON.stringify(name==='shell'?{command:['sh','-c',command]}:{cmd:command,yield_time_ms:1000,max_output_tokens:1000})}:{type:'message',id:`msg_${round}`,role:'assistant',status:'completed',content:[{type:'output_text',text:'Fixture completed.',annotations:[]}]};
    const response={id:`resp_${round}`,object:'response',created_at:Math.floor(Date.now()/1000),status:'in_progress',model:body.model,output:[],usage:null};
    emit('response.created',{response});emit('response.in_progress',{response});
    emit('response.output_item.added',{output_index:0,item:tool?{...item,arguments:''}:{...item,content:[]}});
    if(tool){emit('response.function_call_arguments.delta',{item_id:item.id,output_index:0,delta:item.arguments});emit('response.function_call_arguments.done',{item_id:item.id,output_index:0,arguments:item.arguments});}
    else{emit('response.content_part.added',{item_id:item.id,output_index:0,content_index:0,part:{type:'output_text',text:'',annotations:[]}});emit('response.output_text.delta',{item_id:item.id,output_index:0,content_index:0,delta:'Fixture completed.'});emit('response.output_text.done',{item_id:item.id,output_index:0,content_index:0,text:'Fixture completed.'});emit('response.content_part.done',{item_id:item.id,output_index:0,content_index:0,part:item.content[0]});}
    emit('response.output_item.done',{output_index:0,item});emit('response.completed',{response:{...response,status:'completed',output:[item],usage:{input_tokens:0,output_tokens:0,total_tokens:0,input_tokens_details:{cached_tokens:0},output_tokens_details:{reasoning_tokens:0}}}});
  }
  res.end();
});
const envBase=Object.fromEntries(Object.entries(process.env).filter(([key])=>['PATH','HOME','TMPDIR','LANG','LC_ALL','TERM'].includes(key)));
const results=[];
try{
  await new Promise(done=>endpoint.listen(0,'127.0.0.1',done));const url=`http://127.0.0.1:${endpoint.address().port}`;
  for(provider of ['claude','codex']){
    project=join(root,provider+'-project');await mkdir(join(project,'.hooks-workspace'),{recursive:true});await mkdir(join(project,'.claude'));await mkdir(join(project,'.codex'));
    const home=join(root,provider+'-home');await mkdir(home);
    const events=['SessionStart','UserPromptSubmit','PreToolUse','PostToolUse','Stop'];
    await writeFile(join(project,'.hooks-workspace/registry.yaml'),JSON.stringify({managementVersion:1,hooks:events.map(event=>({id:event,event,order:10,stage:'blocker',source:'stage.cjs',canBlock:true,failurePolicy:'fail-open',enabled:{mode:'always'},managed:{enabled:true,blocking:true,dependsOn:[]},resultFormat:'neutral'}))}));
    await writeFile(join(project,'stage.cjs'),`let raw='';process.stdin.on('data',c=>raw+=c);process.stdin.on('end',()=>{const input=JSON.parse(raw);require('node:fs').appendFileSync('native-inputs.jsonl',JSON.stringify(input)+'\\n');let effects=[];let outcome='passed';if(input.hook_event_name==='PreToolUse'&&JSON.stringify(input.tool_input).includes('denied-sentinel')){effects=[{action:'denyTool',message:'Fixture denial'}];outcome='failed'}else if(input.hook_event_name==='Stop'&&!input.stop_hook_active){effects=[{action:'continueStop',message:'Fixture continuation once'}];outcome='failed'}else if(input.hook_event_name==='PostToolUse'){effects=[{action:'feedback',message:'Fixture post-tool feedback'}];outcome='failed'}console.log(JSON.stringify({outcome,effects}));});`);
    const command=[process.execPath,fileURLToPath(import.meta.resolve('tsx/cli')),join(workspace,'scripts/dispatch-hook.ts'),'--project',project,'--provider',provider].map(quote).join(' ');
    const configEvents=[...events,...observationEvents[provider]];
    const config={hooks:Object.fromEntries(configEvents.map(event=>[event,[{hooks:[{type:'command',command,timeout:30}]}]]))};
    await writeFile(join(project,'.codex/hooks.json'),JSON.stringify(config));await writeFile(join(project,'.claude/settings.json'),JSON.stringify(config));
    let result;
    if(provider==='claude')result=await run('claude',['-p','Run the fixture commands, then finish.','--model','claude-sonnet-4-6','--output-format','stream-json','--verbose','--setting-sources','project','--strict-mcp-config','--mcp-config','{"mcpServers":{}}','--tools','Bash','--allowedTools','Bash','--permission-mode','default','--max-budget-usd','0.01'],{...envBase,CLAUDE_CONFIG_DIR:home,ANTHROPIC_BASE_URL:url,ANTHROPIC_API_KEY:'fixture-no-remote-auth',CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC:'1'});
    else{
      await writeFile(join(home,'config.toml'),`model="fixture-model"\nmodel_provider="fixture"\n[model_providers.fixture]\nname="Fixture"\nbase_url="${url}/v1"\nwire_api="responses"\nrequires_openai_auth=false\n[projects.${JSON.stringify(project)}]\ntrust_level="trusted"\n`);
      result=await run('codex',['exec','--json','--skip-git-repo-check','--dangerously-bypass-hook-trust','--sandbox','workspace-write','-C',project,'Run the fixture commands, then finish.'],{...envBase,CODEX_HOME:home});
    }
    assert.equal(result.code,0,`${provider} CLI error: ${result.stderr.slice(-2000)} ${result.stdout.slice(-2000)}`);
    const inputs=(await readFile(join(project,'native-inputs.jsonl'),'utf8')).trim().split('\n').map(line=>JSON.parse(line));
    assert.deepEqual(new Set(inputs.map(row=>row.hook_event_name)),new Set(events));
    await assert.rejects(readFile(join(project,'denied-sentinel')));
    assert.equal(await readFile(join(project,'allowed-sentinel'),'utf8'),'fixture');
    assert.ok(inputs.filter(row=>row.hook_event_name==='Stop').length>=2,'Stop continuation must request a further model turn');
    const ledger=(await readFile(join(project,'.hooks-workspace/state/event-ledger',new Date().toISOString().slice(0,10)+'.jsonl'),'utf8')).trim().split('\n').map(line=>JSON.parse(line));
    assert.ok(ledger.some(row=>row.kind==='observed'&&row.hookEventName==='SessionEnd'), `${provider}: native SessionEnd must record context`);
    const previousHomes = { CODEX_HOME: process.env.CODEX_HOME, CLAUDE_CONFIG_DIR: process.env.CLAUDE_CONFIG_DIR };
    let discovery;
    try {
      process.env.CODEX_HOME = home; process.env.CLAUDE_CONFIG_DIR = home;
      const sessions = await readSessions(provider,project);
      const session = sessions.find(s => s.sessionId === inputs[0].session_id);
      assert.ok(session, `${provider}: saved native session must appear in all-project discovery`);
      const transcript = await readTranscript(provider,session.sessionId,project);
      assert.ok(JSON.stringify(transcript).includes('ORIGINAL_TOOL_OUTPUT'), `${provider}: persisted transcript must contain the tool result`);
      discovery = { sessionFound:true, cwd:session.cwd, transcriptRead:true };
    } finally { for (const [key,value] of Object.entries(previousHomes)) { if (value === undefined) delete process.env[key]; else process.env[key] = value; } }
    const version = (await run(provider,['--version'],envBase)).stdout.trim();
    assert.equal(feedbackEvidence[provider]?.feedbackPresent,true,'PostToolUse feedback must reach the next model request');
    if(provider==='claude')assert.equal(feedbackEvidence[provider]?.originalOutputPresent,true,'Claude retains the original tool result');
    results.push({provider,configEvents,observedEvents:[...new Set(ledger.filter(row=>row.kind==='observed').map(row=>row.hookEventName))],discovery,postToolEvidence:feedbackEvidence[provider],version,permissionMode:provider==='claude'?'default':'workspace-write sandbox',codexHookTrustBypassed:provider==='codex',transport:'native CLI command hooks',model:'scripted loopback SSE; no remote model',rounds:rounds[provider],deniedSentinelAbsent:true,allowedSentinelPresent:true,inputs,ledger});
    console.log(`${provider}: ${configEvents.length}-event configuration accepted; five native stage events, denied/allowed side effects and Stop continuation verified (${rounds[provider]} scripted model requests).`);
  }
  const identifiers=new Map();
  const sanitize=value=>{
    if(typeof value==='string')return value.replaceAll(root,'/fixture').replaceAll(workspace,'/fixture/workspace/').replaceAll(process.execPath,'/fixture/node').replace(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi,id=>{if(!identifiers.has(id))identifiers.set(id,`fixture-id-${identifiers.size+1}`);return identifiers.get(id)}).replace(/\/fixture\/claude-home\/projects\/[^/]+\//g,'/fixture/claude-home/projects/fixture-project/');
    if(Array.isArray(value))return value.map(sanitize);if(value&&typeof value==='object')return Object.fromEntries(Object.entries(value).map(([key,item])=>[key,sanitize(item)]));return value;
  };
  const text=JSON.stringify(sanitize(results),null,2)+'\n';assert.ok(!/\/Users\//.test(text));
  await writeFile(join(workspace,'server/fixtures/providers/native-lifecycle.json'),text);
  await writeFile(join(workspace,'server/fixtures/providers/native-lifecycle-provenance.json'),JSON.stringify({schemaVersion:1,capturedAt:new Date().toISOString(),evidence:'Actual CLIs and native command hooks with a scripted loopback model API',remoteModelRequests:0,scope:['SessionStart','UserPromptSubmit','PreToolUse','PostToolUse','Stop','SessionEnd'],assertions:['full eight-event Codex and ten-event Claude configurations accepted','denied sentinel absent','allowed sentinel present','PostToolUse observed','Stop continuation caused another model request','SessionEnd context recorded','saved session appears in catalog','persisted transcript contains completed tool output'],codexHookTrustBypassedInOwnedFixture:true,claudePermissionMode:'default; Bash explicitly permitted only in disposable project',sanitization:['Temporary roots and executable paths replaced','Identifiers mapped consistently','Encoded transcript project path removed'],fileDigests:{'native-lifecycle.json':createHash('sha256').update(text).digest('hex')}},null,2)+'\n');
}finally{for(const child of children)child.kill('SIGKILL');await new Promise(done=>endpoint.close(done));await rm(root,{recursive:true,force:true});}
