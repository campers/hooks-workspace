import { parseArgs } from 'node:util';
import { observe, observationEvents } from '../runtime/observer.js';
import { dispatch } from '../runtime/dispatcher.js';
try {
  const { values } = parseArgs({ options: { project: { type: 'string' }, provider: { type: 'string' }, registry: { type: 'string' } } });
  if (!values.project || (values.provider !== 'codex' && values.provider !== 'claude')) throw new Error('Specify --project and --provider codex|claude');
  let raw = '';
  for await (const chunk of process.stdin) { raw += chunk; if (Buffer.byteLength(raw) > 1024 * 1024) throw new Error('Hook input too large'); }
  const input = JSON.parse(raw);
  if (observationEvents[values.provider].includes(input.hook_event_name)) { observe(values.project,values.provider,input,values.registry); console.log('{}'); }
  else console.log(JSON.stringify(await dispatch(values.project, values.provider, input, values.registry)));
} catch (error) {
  console.error(`Hooks workspace failed open: ${error instanceof Error ? error.message : String(error)}`);
  console.log('{}');
}
