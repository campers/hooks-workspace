import { parseArgs } from 'node:util';
import { resolve } from 'node:path';
export interface WorkspaceOptions {
    projects: string[];
    discover: boolean;
    port: number;
    dev: boolean;
    registry?: string;
    repositoryMap?: string;
}
export function parseOptions(args: string[], appRoot: string, cwd = process.cwd()): WorkspaceOptions {
    const { values } = parseArgs({ args, options: {
            registry: { type: 'string' }, project: { type: 'string', multiple: true }, port: { type: 'string', default: '4317' }, dev: { type: 'boolean', default: false }, demo: { type: 'boolean' }, 'no-discovery': { type: 'boolean' }, 'repository-map': { type: 'string' },
        } });
    const port = Number(values.port);
    if (!Number.isInteger(port) || port < 1 || port > 65535)
        throw new Error('--port must be an integer from 1 to 65535');
    if (values.demo && values.project?.length)
        throw new Error('--demo cannot be combined with --project');
    const projects = values.demo ? [resolve(appRoot, 'examples/demo')] : [...new Set((values.project ?? []).map(p => resolve(cwd, p)))];
    if (values.registry && projects.length !== 1 && values.registry.startsWith('/'))
        throw new Error('An absolute --registry requires exactly one --project; use a relative registry for multiple projects');
    return { projects, discover: !values.demo && !values['no-discovery'], registry: values.registry, repositoryMap: values['repository-map'] ? resolve(cwd, values['repository-map']) : undefined, port, dev: values.dev };
}
