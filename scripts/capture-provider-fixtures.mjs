// Manual CLI capture. No agent model access: requests go to a rejecting loopback endpoint.
import { spawn } from 'node:child_process';
import { createServer } from 'node:http';
import { createInterface } from 'node:readline';
import { mkdtemp, mkdir, readFile, writeFile, rm, realpath } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { resolve, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';

const workspaceRoot = fileURLToPath(new URL('../', import.meta.url));
const output = fileURLToPath(new URL('../server/fixtures/providers/', import.meta.url));
const root = await mkdtemp(join(tmpdir(), 'hook-provider-fixtures-'));
let project = join(root, 'project');
let canonicalRoot = root;
const codexHome = join(root, 'codex-home');
const claudeHome = join(root, 'claude-home');
const captures = new Map();
const children = new Set();
let modelRequests = 0;
const endpoint = createServer((req, res) => {
  if (req.method === 'POST') modelRequests++;
  req.resume();
  res.writeHead(400, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify({ error: { type: 'invalid_request_error', message: 'Fixture endpoint does not run models' } }));
});
const inheritedKeys = new Set(['PATH', 'HOME', 'TMPDIR', 'LANG', 'LC_ALL', 'TERM', 'SYSTEMROOT', 'COMSPEC', 'PATHEXT']);
const baseEnv = Object.fromEntries(Object.entries(process.env).filter(([key]) => inheritedKeys.has(key)));

function run(executable, args, env, timeoutMs = 25000) {
  return new Promise((accept, reject) => {
    const child = spawn(executable, args, { cwd: project, env, stdio: ['ignore', 'pipe', 'pipe'] });
    children.add(child);
    let stdout = '', stderr = '';
    child.stdout.on('data', chunk => { stdout += chunk; });
    child.stderr.on('data', chunk => { stderr += chunk; });
    const timer = setTimeout(() => { child.kill('SIGTERM'); reject(new Error(`${executable} fixture capture timed out`)); }, timeoutMs);
    child.on('error', error => { clearTimeout(timer); reject(error); });
    child.on('close', code => { clearTimeout(timer); children.delete(child); accept({ code, stdout, stderr }); });
  });
}
function hookList(env) {
  return new Promise((accept, reject) => {
    const child = spawn('codex', ['app-server', '--stdio'], { cwd: project, env, stdio: ['pipe', 'pipe', 'pipe'] });
    children.add(child);
    const lines = createInterface({ input: child.stdout });
    let finished = false;
    const finish = (error, result) => {
      if (finished) return;
      finished = true; clearTimeout(timer); lines.close(); child.kill('SIGTERM');
      if (error) reject(error); else accept(result);
    };
    const timer = setTimeout(() => finish(new Error('Codex discovery timed out')), 20000);
    child.on('error', error => finish(error));
    child.on('close', () => { children.delete(child); finish(new Error('Codex discovery closed')); });
    child.stdin.on('error', error => finish(error));
    // Drain diagnostic output; raw stderr can include local configuration paths.
    child.stderr.resume();
    const send = message => child.stdin.write(JSON.stringify(message) + '\n');
    lines.on('line', line => {
      try {
        const message = JSON.parse(line);
        if (message.error) return finish(new Error('Codex rejected fixture discovery'));
        if (message.id === 1) { send({ method: 'initialized' }); send({ id: 2, method: 'hooks/list', params: { cwds: [project] } }); }
        if (message.id === 2) finish(null, message.result);
      } catch (error) { finish(error); }
    });
    send({ id: 1, method: 'initialize', params: { clientInfo: { name: 'hook_fixture_capture', version: '1' }, capabilities: { experimentalApi: true } } });
  });
}
const ids = new Map();
function sanitize(value) {
  if (Array.isArray(value)) return value.map(sanitize);
  if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, sanitize(item)]));
  if (typeof value !== 'string') return value;
  let result = value.replaceAll(canonicalRoot, '/fixture').replaceAll(resolve(root), '/fixture').replaceAll(root, '/fixture');
  result = result.replace(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi, id => {
    if (!ids.has(id)) ids.set(id, `fixture-id-${ids.size + 1}`);
    return ids.get(id);
  });
  return result;
}
async function jsonLines(path) { return (await readFile(path, 'utf8')).trim().split('\n').filter(Boolean).map(line => JSON.parse(line)); }

try {
  await mkdir(join(project, '.codex'), { recursive: true });
  await mkdir(join(project, '.claude'), { recursive: true });
  await mkdir(codexHome); await mkdir(claudeHome);
  project = await realpath(project);
  canonicalRoot = await realpath(root);
  await new Promise(done => endpoint.listen(0, '127.0.0.1', done));
  const address = endpoint.address();
  const url = `http://127.0.0.1:${address.port}`;
  await writeFile(join(codexHome, 'config.toml'), `model = "fixture-model"\nmodel_provider = "fixture"\n[model_providers.fixture]\nname = "Fixture"\nbase_url = "${url}/v1"\nwire_api = "responses"\nrequires_openai_auth = false\n[projects.${JSON.stringify(project)}]\ntrust_level = "trusted"\n`);
  const script = join(project, 'capture.cjs');
  await writeFile(script, `const fs=require('node:fs');let s='';process.stdin.on('data',c=>s+=c);process.stdin.on('end',()=>{const input=JSON.parse(s);fs.appendFileSync(process.env.FIXTURE_CAPTURE_FILE,JSON.stringify(input)+'\\n');const output=input.hook_event_name==='UserPromptSubmit'?{decision:'block',reason:'Fixture capture: reject before model request.'}:{hookSpecificOutput:{hookEventName:input.hook_event_name,additionalContext:'Fixture context.'}};console.log(JSON.stringify(output));});`);
  const config = { hooks: Object.fromEntries(['SessionStart', 'UserPromptSubmit'].map(event => [event, [{ hooks: [{ type: 'command', command: `${JSON.stringify(process.execPath)} ${JSON.stringify(script)}` }] }]])) };
  await writeFile(join(project, '.codex/hooks.json'), JSON.stringify(config));
  await writeFile(join(project, '.claude/settings.json'), JSON.stringify(config));
  const codexEnv = { ...baseEnv, CODEX_HOME: codexHome, FIXTURE_CAPTURE_FILE: join(root, 'codex-inputs.jsonl') };
  const claudeEnv = { ...baseEnv, CLAUDE_CONFIG_DIR: claudeHome, FIXTURE_CAPTURE_FILE: join(root, 'claude-inputs.jsonl'), ANTHROPIC_BASE_URL: url, ANTHROPIC_API_KEY: 'fixture-invalid-no-model-access', CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: '1' };
  const codexVersion = await run('codex', ['--version'], codexEnv);
  const claudeVersion = await run('claude', ['--version'], claudeEnv);
  captures.set('codex-discovery.json', await hookList(codexEnv));
  await writeFile(join(project, '.codex/hooks.json'), '{invalid');
  captures.set('codex-invalid-config.json', await hookList(codexEnv));
  await writeFile(join(project, '.codex/hooks.json'), JSON.stringify(config));
  const codex = await run('codex', ['exec', '--ephemeral', '--json', '--skip-git-repo-check', '--dangerously-bypass-hook-trust', '-C', project, 'Fixture prompt blocked before model access.'], codexEnv);
  assert.equal(codex.code, 0);
  const claude = await run('claude', ['-p', 'Fixture prompt blocked before model access.', '--output-format', 'stream-json', '--verbose', '--setting-sources', 'project', '--strict-mcp-config', '--mcp-config', '{"mcpServers":{}}', '--tools', '', '--permission-mode', 'default', '--no-session-persistence', '--max-budget-usd', '0.01'], claudeEnv);
  assert.equal(claude.code, 0);
  assert.equal(modelRequests, 0, 'A model request occurred; captures are not the intended blocked-prompt scenario');
  captures.set('codex-inputs.json', await jsonLines(join(root, 'codex-inputs.jsonl')));
  captures.set('claude-inputs.json', await jsonLines(join(root, 'claude-inputs.jsonl')));
  for (const name of ['codex-inputs.json', 'claude-inputs.json']) assert.deepEqual(captures.get(name).map(row => row.hook_event_name), ['SessionStart', 'UserPromptSubmit']);
  const codexEvents = codex.stdout.trim().split('\n').map(line => JSON.parse(line));
  const claudeEvents = claude.stdout.trim().split('\n').map(line => JSON.parse(line));
  captures.set('codex-blocked-turn.json', codexEvents);
  // Project only relevant event envelopes. Omit unrelated startup inventory and socket paths.
  captures.set('claude-blocked-turn.json', claudeEvents.filter(row => row.subtype !== 'init'));
  const final = claudeEvents.find(row => row.type === 'result');
  assert.equal(final.num_turns, 0); assert.equal(final.total_cost_usd, 0); assert.match(final.result, /blocked by hook/);
  // Exercise the implemented dispatcher through each real CLI, still before model access.
  await mkdir(join(project, '.hooks-workspace'));
  await writeFile(join(project, 'stage.cjs'), `let raw='';process.stdin.on('data',c=>raw+=c);process.stdin.on('end',()=>{const input=JSON.parse(raw);console.log(JSON.stringify({outcome:input.hook_event_name==='UserPromptSubmit'?'failed':'passed',effects:[{action:input.hook_event_name==='UserPromptSubmit'?'rejectPrompt':'context',message:'Dispatcher fixture.'}]}));});`);
  await writeFile(join(project, '.hooks-workspace/registry.yaml'), JSON.stringify({ managementVersion: 1, hooks: ['SessionStart','UserPromptSubmit'].map((event,index)=>({id:event,event,order:10,stage:'blocker',source:'stage.cjs',canBlock:true,failurePolicy:'fail-open',enabled:{mode:'always'},managed:{enabled:true,blocking:true,dependsOn:[]},resultFormat:'neutral'})) }));
  const quote = value => "'" + value.replaceAll("'", "'\\''") + "'";
  const configFor = provider => ({hooks:Object.fromEntries(['SessionStart','UserPromptSubmit'].map(event=>[event,[{hooks:[{type:'command',command:[process.execPath,fileURLToPath(import.meta.resolve('tsx/cli')),join(workspaceRoot,'scripts/dispatch-hook.ts'),'--project',project,'--provider',provider].map(quote).join(' ')}]}]]))});
  await writeFile(join(project, '.codex/hooks.json'), JSON.stringify(configFor('codex')));
  await writeFile(join(project, '.claude/settings.json'), JSON.stringify(configFor('claude')));
  const dispatcherCodex = await run('codex', ['exec','--ephemeral','--json','--skip-git-repo-check','--dangerously-bypass-hook-trust','-C',project,'Dispatcher fixture prompt.'], codexEnv);
  const dispatcherClaude = await run('claude', ['-p','Dispatcher fixture prompt.','--output-format','stream-json','--verbose','--setting-sources','project','--strict-mcp-config','--mcp-config','{"mcpServers":{}}','--tools','','--no-session-persistence','--max-budget-usd','0.01'], claudeEnv);
  assert.equal(dispatcherCodex.code, 0); assert.equal(dispatcherClaude.code, 0); assert.equal(modelRequests, 0);
  const ledger = await jsonLines(join(project,'.hooks-workspace/state/event-ledger',new Date().toISOString().slice(0,10)+'.jsonl'));
  for (const provider of ['codex','claude']) for (const event of ['SessionStart','UserPromptSubmit']) assert.ok(ledger.some(row=>row.provider===provider && row.hookName===event && row.kind==='completed' && row.decision===(event==='UserPromptSubmit'?'blocked':'passed')));
  captures.set('dispatcher-runs.json', ledger);
  captures.set('provenance.json', {
    schemaVersion: 1, capturedAt: new Date().toISOString(),
    binaries: { codex: codexVersion.stdout.trim(), claude: claudeVersion.stdout.trim() },
    transport: { codexDiscovery: 'app-server stdio hooks/list', codexExecution: 'exec --json', claudeExecution: '-p --output-format stream-json' },
    evidence: 'Real CLI discovery and command-hook execution with synthetic prompt and hook script',
    modelRequests, scope: ['SessionStart', 'UserPromptSubmit'], dispatcherVerified: true,
    codexTrustBypassedForExecution: true, codexTrustBypassedForDiscovery: false,
    claudeSettingSources: ['project'], cliExitCodes: { codex: codex.code, claude: claude.code },
    transformations: ['Temporary root replaced with /fixture', 'Executable path replaced with /fixture/node', 'UUIDs replaced with stable capture-local identifiers', 'Claude init inventory omitted', 'Raw stderr excluded'],
    sdkVersionsInspected: { '@openai/codex-sdk': '0.160.1', '@anthropic-ai/claude-agent-sdk': '0.3.291' },
    sdkVersionsSource: 'Published package types inspected on 2026-10-06; these captures use the listed CLI binaries',
  });
  // Validate the entire sanitized bundle before replacing any fixture.
  const rendered = new Map();
  for (const [name, value] of captures) {
    const content = JSON.stringify(sanitize(value), null, 2).replaceAll(process.execPath, '/fixture/node').replace(/\/fixture\/claude-home\/projects\/[^/]+\//g, '/fixture/claude-home/projects/fixture-project/') + '\n';
    assert.ok(!/\/Users\/|Bearer\s/i.test(content), 'Unredacted private or credential content');
    rendered.set(name, content);
  }
  const manifest = JSON.parse(rendered.get('provenance.json'));
  manifest.fileDigests = Object.fromEntries([...rendered].filter(([name]) => name !== 'provenance.json').map(([name, content]) => [name, createHash('sha256').update(content).digest('hex')]));
  rendered.set('provenance.json', JSON.stringify(manifest, null, 2) + '\n');
  await mkdir(output, { recursive: true });
  for (const [name, content] of rendered) await writeFile(join(output, name), content);
  console.log(`Captured ${captures.size} sanitized fixtures; zero model requests. Review fixture diffs before committing.`);
} finally {
  for (const child of children) child.kill('SIGTERM');
  await new Promise(done => endpoint.close(done));
  await rm(root, { recursive: true, force: true });
}
