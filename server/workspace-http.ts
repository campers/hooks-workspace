import type { IncomingMessage, ServerResponse } from 'node:http';
import type { WorkspaceCatalogStore } from './catalog.js';
import { handleWorkspaceRequest } from './http.js';
import { createProviderMonitor } from './providers.js';
import { localRequest, handleCatalogRequest } from './catalog-http.js';
export function createWorkspaceHandler(catalog: WorkspaceCatalogStore, port: number, createMonitor = createProviderMonitor) {
    const monitorsByProject = new Map<string, {
        codex: ReturnType<typeof createProviderMonitor>;
        claude: ReturnType<typeof createProviderMonitor>;
    }>();
    return {
        handle(req: IncomingMessage, res: ServerResponse): boolean {
            if (!localRequest(req, port)) {
                res.writeHead(403).end('Local access only');
                return true;
            }
            if (handleCatalogRequest(req, res, port, catalog))
                return true;
            const url = new URL(req.url ?? '/', 'http://localhost');
            if (!['/api/workspace', '/api/management', '/api/provider-status', '/api/codex-status'].includes(url.pathname))
                return false;
            if (req.method === 'PATCH' && !url.searchParams.get('project')) {
                res.writeHead(400).end('Select a configuration checkout');
                return true;
            }
            const project = catalog.project(url.searchParams.get('project'));
            if (!project) {
                res.writeHead(404).end('Unknown checkout');
                return true;
            }
            let monitors = monitorsByProject.get(project.id);
            if (!monitors) {
                monitors = { codex: createMonitor(project.path, 'codex', catalog.registry(project)), claude: createMonitor(project.path, 'claude', catalog.registry(project)) };
                monitorsByProject.set(project.id, monitors);
                void Promise.all([monitors.codex.refresh(), monitors.claude.refresh()]);
            }
            return handleWorkspaceRequest(req, res, project.path, port, monitors.codex, { provider: 'codex', registry: catalog.registry(project), monitors, projectId: project.id });
        },
        close(): void { for (const m of monitorsByProject.values()) {
            m.codex.close();
            m.claude.close();
        } },
    };
}
