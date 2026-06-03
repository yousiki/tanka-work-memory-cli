/**
 * Work Memory business API — wraps the /link/workmemory/auth/* endpoints.
 * Connects directly to the -api domain (same base URL as file upload),
 * auth via token header, no gateway signing.
 *
 * Only project + session endpoints are included (worklog/report are web-only).
 */
import type { AxiosInstance } from 'axios';

import type {
  CreateProjectRequest,
  CreateProjectResponse,
  FileBrowseRequest,
  PageParams,
  SyncRequest,
  SyncResponse,
} from './types';

const P = '/link/workmemory/auth';

// ─── Project management ──────────────────────────────────────────────

export function createProject(
  client: AxiosInstance,
  data: CreateProjectRequest,
) {
  return client
    .post<CreateProjectResponse>(`${P}/project/save`, data)
    .then((r) => r.data);
}

export function joinProject(client: AxiosInstance, projectId: string) {
  return client
    .post<Record<string, never>>(`${P}/project/join`, { projectId })
    .then((r) => r.data);
}

export function listProjects(client: AxiosInstance, params: PageParams = {}) {
  return client
    .get(`${P}/project/list`, { params: { pageSize: 100, ...params } })
    .then((r) => r.data);
}

export function leaveProject(client: AxiosInstance, projectId: string) {
  return client.post(`${P}/project/leave`, { projectId }).then((r) => r.data);
}

// ─── Batch sync ─────────────────────────────────────────────────────

export function syncProject(
  client: AxiosInstance,
  projectId: string,
  data: Omit<SyncRequest, 'projectId'>,
) {
  return client
    .post<SyncResponse>(`${P}/sync`, { projectId, ...data })
    .then((r) => r.data);
}

// ─── Data browsing ──────────────────────────────────────────────────

export function listProjectFiles(
  client: AxiosInstance,
  data: FileBrowseRequest,
) {
  return client
    .post(`${P}/file/page`, { pageSize: 500, ...data })
    .then((r) => r.data);
}

// ─── Deletion ───────────────────────────────────────────────────────

export function deleteMyProjectData(client: AxiosInstance, projectId: string) {
  return client
    .post(`${P}/project/del-mine`, { projectId })
    .then((r) => r.data);
}

export function deleteAllMine(client: AxiosInstance) {
  return client.post(`${P}/del-all-mine`).then((r) => r.data);
}
