/**
 * Axios HTTP client — single entry point for the business API.
 *
 * Shares the same base URL as upload/tanka-client.ts (via resolveBaseUrl(),
 * no separate gateway domain). Business endpoints live under
 * /link/workmemory/auth/* (no /open prefix — only the file-upload application
 * uses /open). Auth is a single `token` header (same as file upload, no
 * gateway signing). Response envelope is unwrapped (code/msg/data),
 * 401 → TokenExpiredError.
 */
import axios, {
  type AxiosInstance,
  type AxiosResponse,
  type InternalAxiosRequestConfig,
} from 'axios';

import type { Credentials } from '../config/config';
import { resolveBaseUrl, TokenExpiredError } from '../upload/tanka-client';
import type { ApiResponse } from './types';

// ─── Business errors ─────────────────────────────────────────────────

export class ApiError extends Error {
  constructor(
    public readonly code: number,
    message: string,
  ) {
    super(message);
    this.name = 'ApiError';
  }
}

// ─── Client factory ──────────────────────────────────────────────────

export function createApiClient(credentials: Credentials): AxiosInstance {
  const instance = axios.create({
    baseURL: resolveBaseUrl(credentials.env),
    timeout: 30_000,
    headers: { 'Content-Type': 'application/json' },
  });

  instance.interceptors.request.use((config: InternalAxiosRequestConfig) => {
    config.headers.set('token', credentials.token);
    return config;
  });

  instance.interceptors.response.use(
    (resp: AxiosResponse<ApiResponse>) => {
      const body = resp.data;
      if (body.code !== 0) {
        throw new ApiError(
          body.code,
          body.msg ?? `business error (code ${body.code})`,
        );
      }
      // biome-ignore lint/suspicious/noExplicitAny: after unwrapping the envelope, the data type is determined by the caller's generic parameter
      resp.data = body.data as any;
      return resp;
    },
    (error) => {
      if (axios.isAxiosError(error) && error.response?.status === 401) {
        throw new TokenExpiredError();
      }
      throw error;
    },
  );

  return instance;
}
