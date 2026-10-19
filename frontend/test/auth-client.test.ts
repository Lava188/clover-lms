import { afterEach, describe, it, expect, vi } from 'vitest';
import axios, {
  AxiosError,
  AxiosHeaders,
  type InternalAxiosRequestConfig,
  type AxiosResponse,
} from 'axios';
import { createAuthClient } from '../src/features/auth/auth-client';
import {
  AuthError,
  ROLE_POLICIES,
  canUseAdminCms,
  canUseStudentWebsite,
  type AuthUser,
  type LoginResponse,
} from '../src/features/auth/auth.types';

const student: AuthUser = {
  id: 'student-1',
  fullName: 'Student',
  email: 'student@example.com',
  role: 'STUDENT',
  isActive: true,
};
const credentials = {
  email: ' STUDENT@EXAMPLE.COM ',
  password: '  keep password spaces  ',
};
afterEach(() => vi.unstubAllGlobals());
const result = (token = 'access-one', user = student): LoginResponse => ({
  accessToken: token,
  tokenType: 'Bearer',
  expiresIn: 900,
  user,
});
function reply(
  config: InternalAxiosRequestConfig,
  status: number,
  data: unknown,
): AxiosResponse {
  const response = {
    status,
    statusText: String(status),
    data,
    headers: new AxiosHeaders(),
    config,
  };
  if (status >= 400)
    throw new AxiosError(
      'Backend error',
      'ERR_BAD_RESPONSE',
      config,
      undefined,
      response,
    );
  return response;
}
type Handler = (
  config: InternalAxiosRequestConfig,
) => AxiosResponse | Promise<AxiosResponse>;
function harness(
  allowedRoles = ROLE_POLICIES.STUDENT_ONLY as readonly AuthUser['role'][],
) {
  let handler: Handler = (config) => reply(config, 200, result());
  const calls: {
    url: string | undefined;
    method: string | undefined;
    token: unknown;
    credentials: boolean | undefined;
    body: unknown;
  }[] = [];
  const api = axios.create({
    baseURL: 'http://localhost:3000/api',
    adapter: async (config) => {
      calls.push({
        url: config.url,
        method: config.method,
        token: config.headers.get('Authorization'),
        credentials: config.withCredentials,
        body: config.data,
      });
      return handler(config);
    },
  });
  const auth = createAuthClient(api, {
    apiBaseUrl: api.defaults.baseURL!,
    pageOrigin: 'http://localhost:5173',
    allowedRoles,
  });
  return {
    api,
    auth,
    calls,
    handle: (next: Handler) => {
      handler = next;
    },
  };
}
function gate() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

describe('typed auth and memory-only state', () => {
  it('reuses a binding and refuses conflicting auth contexts on the same Axios instance', () => {
    const h = harness();
    const options = {
      apiBaseUrl: 'http://localhost:3000/api',
      pageOrigin: 'http://localhost:5173',
      allowedRoles: ROLE_POLICIES.STUDENT_ONLY,
    };
    expect(createAuthClient(h.api, options)).toBe(h.auth);
    expect(() =>
      createAuthClient(h.api, { ...options, allowedRoles: ROLE_POLICIES.CMS }),
    ).toThrow(AuthError);
  });
  it('logs in, normalizes email only and attaches Bearer without exposing tokens in state', async () => {
    const h = harness();
    await expect(h.auth.login(credentials)).resolves.toEqual(student);
    expect(JSON.parse(h.calls[0].body as string)).toEqual({
      email: 'student@example.com',
      password: credentials.password,
    });
    expect(h.calls[0].credentials).toBe(true);
    expect(h.calls[0].token).toBeUndefined();
    expect(h.auth.getState()).toEqual({
      status: 'authenticated',
      user: student,
    });
    h.handle((config) => reply(config, 200, { ok: true }));
    await h.api.get('/private');
    expect(h.calls.at(-1)?.token).toBe('Bearer access-one');
    expect(h.calls.at(-1)?.credentials).toBe(false);
    expect(h.api.defaults.headers.common.Authorization).toBeUndefined();
    expect(JSON.stringify(h.auth.getState())).not.toContain('access-one');
  });

  it('does not log or persist credentials/tokens to browser storage', async () => {
    const storage = vi.spyOn(Storage.prototype, 'setItem');
    const log = vi.spyOn(console, 'log');
    const h = harness();
    await h.auth.login(credentials);
    await h.auth.refreshSession();
    await h.auth.logout();
    expect(storage).not.toHaveBeenCalled();
    expect(log).not.toHaveBeenCalled();
  });

  it('fails login safely without attempting refresh', async () => {
    const h = harness();
    h.handle((config) =>
      reply(config, 401, {
        message: credentials.password,
        passwordHash: 'server-secret',
      }),
    );
    await expect(h.auth.login(credentials)).rejects.toMatchObject({
      name: 'AuthError',
      status: 401,
    });
    expect(h.calls).toHaveLength(1);
    expect(h.auth.getState().status).toBe('unauthenticated');
    try {
      await h.auth.login(credentials);
    } catch (error) {
      expect(error).toBeInstanceOf(AuthError);
      expect(JSON.stringify(error)).not.toContain(credentials.password);
      expect(error).not.toHaveProperty('config');
    }
  });

  it('rejects invalid input and malformed/unexpected-role responses', async () => {
    const h = harness();
    await expect(
      h.auth.login({ ...credentials, email: 'invalid' }),
    ).rejects.toMatchObject({ status: 400 });
    expect(h.calls).toHaveLength(0);
    h.handle((config) =>
      reply(config, 200, { ...result(), user: { ...student, role: 'OWNER' } }),
    );
    await expect(h.auth.login(credentials)).rejects.toMatchObject({
      code: 'INVALID_RESPONSE',
    });
    expect(h.auth.getState().user).toBeNull();
  });

  it('strips internal server fields from safe User state', async () => {
    const h = harness();
    h.handle((config) =>
      reply(config, 200, {
        ...result(),
        user: {
          ...student,
          passwordHash: 'secret',
          refreshTokenHash: 'digest',
        },
      }),
    );
    await h.auth.login(credentials);
    expect(h.auth.getState().user).toEqual(student);
    expect(Object.isFrozen(h.auth.getState().user)).toBe(true);
  });
});

describe('single-flight refresh and restore', () => {
  it('restores once from a cookie, including repeated initialization after completion', async () => {
    const h = harness();
    const pause = gate();
    h.handle(async (config) => {
      await pause.promise;
      return reply(config, 200, result('restored'));
    });
    const a = h.auth.restoreSession();
    const b = h.auth.restoreSession();
    expect(a).toBe(b);
    expect(h.auth.getState().status).toBe('initializing');
    await vi.waitFor(() => expect(h.calls).toHaveLength(1));
    pause.resolve();
    await expect(a).resolves.toEqual(student);
    await expect(b).resolves.toEqual(student);
    await h.auth.restoreSession();
    expect(h.calls).toHaveLength(1);
    expect(h.calls[0]).toMatchObject({
      url: '/auth/refresh',
      credentials: true,
    });
    expect(h.calls[0].token).toBeUndefined();
  });

  it('handles missing/expired refresh sessions as unauthenticated without retry loops', async () => {
    const h = harness();
    h.handle((config) => reply(config, 401, {}));
    await expect(h.auth.restoreSession()).resolves.toBeNull();
    expect(h.auth.getState().status).toBe('unauthenticated');
    await h.auth.restoreSession();
    expect(h.calls).toHaveLength(1);
  });

  it('two simultaneous expired GETs trigger one refresh then one retry each', async () => {
    const h = harness();
    await h.auth.login(credentials);
    const pause = gate();
    let refresh = 0;
    h.handle(async (config) => {
      if (config.url === '/auth/refresh') {
        refresh++;
        await pause.promise;
        return reply(config, 200, result('access-two'));
      }
      return reply(
        config,
        config.headers.get('Authorization') === 'Bearer access-two' ? 200 : 401,
        { ok: true },
      );
    });
    const requests = Promise.all([h.api.get('/first'), h.api.get('/second')]);
    await vi.waitFor(() => expect(refresh).toBe(1));
    pause.resolve();
    await requests;
    expect(refresh).toBe(1);
    expect(h.calls.filter((c) => c.url === '/first')).toHaveLength(2);
    expect(h.calls.filter((c) => c.url === '/second')).toHaveLength(2);
  });

  it('a late 401 from the old token reuses the newer token without another refresh', async () => {
    const h = harness();
    await h.auth.login(credentials);
    const late = gate();
    let refresh = 0;
    h.handle(async (config) => {
      if (config.url === '/auth/refresh') {
        refresh++;
        return reply(config, 200, result('access-two'));
      }
      if (config.headers.get('Authorization') === 'Bearer access-two')
        return reply(config, 200, {});
      if (config.url === '/late') await late.promise;
      return reply(config, 401, {});
    });
    const delayed = h.api.get('/late');
    await h.api.get('/early');
    late.resolve();
    await delayed;
    expect(refresh).toBe(1);
  });

  it('refresh failure clears state for all waiters and never refreshes the refresh endpoint', async () => {
    const h = harness();
    await h.auth.login(credentials);
    let refresh = 0;
    h.handle((config) => {
      if (config.url === '/auth/refresh') refresh++;
      return reply(config, 401, {});
    });
    const outcomes = await Promise.allSettled([
      h.api.get('/a'),
      h.api.get('/b'),
    ]);
    expect(outcomes.every((r) => r.status === 'rejected')).toBe(true);
    expect(refresh).toBe(1);
    expect(h.auth.getState().status).toBe('unauthenticated');
  });

  it('stops after one retry even when the retried GET also returns 401', async () => {
    const h = harness();
    await h.auth.login(credentials);
    h.handle((config) =>
      reply(
        config,
        config.url === '/auth/refresh' ? 200 : 401,
        config.url === '/auth/refresh' ? result('new-token') : {},
      ),
    );
    await expect(h.api.get('/private')).rejects.toMatchObject({ status: 401 });
    expect(h.calls.filter((c) => c.url === '/private')).toHaveLength(2);
    expect(h.calls.filter((c) => c.url === '/auth/refresh')).toHaveLength(1);
    expect(h.auth.getState().status).toBe('unauthenticated');
  });

  it('does not automatically refresh or replay an unsafe POST', async () => {
    const h = harness();
    await h.auth.login(credentials);
    h.handle((config) => reply(config, 401, {}));
    await expect(
      h.api.post('/future-business-action', { value: 1 }),
    ).rejects.toMatchObject({ status: 401 });
    expect(
      h.calls.filter((c) => c.url === '/future-business-action'),
    ).toHaveLength(1);
    expect(h.calls.filter((c) => c.url === '/auth/refresh')).toHaveLength(0);
  });
});

describe('logout, role policy and isolation', () => {
  it('Web Locks serialize cookie operations across same-origin client instances', async () => {
    let queue = Promise.resolve();
    let running = 0;
    let maximum = 0;
    vi.stubGlobal('navigator', {
      locks: {
        request: (_name: string, work: () => Promise<unknown>) => {
          const next = queue.then(async () => {
            running++;
            maximum = Math.max(maximum, running);
            try {
              return await work();
            } finally {
              running--;
            }
          });
          queue = next.then(
            () => undefined,
            () => undefined,
          );
          return next;
        },
      },
    });
    const a = harness();
    const b = harness();
    let requests = 0;
    const pause = gate();
    const adapter: Handler = async (config) => {
      requests++;
      if (requests === 1) await pause.promise;
      return reply(config, 200, result(`access-${requests}`));
    };
    a.handle(adapter);
    b.handle(adapter);
    const pending = Promise.all([
      a.auth.refreshSession(),
      b.auth.refreshSession(),
    ]);
    await vi.waitFor(() => expect(requests).toBe(1));
    pause.resolve();
    await pending;
    expect(requests).toBe(2);
    expect(maximum).toBe(1);
  });

  it('network refresh errors clear auth and hide internal error details', async () => {
    const h = harness();
    await h.auth.login(credentials);
    h.handle(() => {
      throw new Error('internal secret with tokens');
    });
    await expect(h.auth.refreshSession()).rejects.toMatchObject({
      message: 'Authentication service unavailable.',
    });
    expect(h.auth.getState().user).toBeNull();
  });
  it('clears state and sends cookie-only logout without trying to restore afterward', async () => {
    const h = harness();
    await h.auth.login(credentials);
    await h.auth.logout();
    expect(h.auth.getState()).toEqual({
      status: 'unauthenticated',
      user: null,
    });
    expect(h.calls.at(-1)).toMatchObject({
      url: '/auth/logout',
      credentials: true,
    });
    expect(h.calls.at(-1)?.token).toBeUndefined();
    await expect(h.auth.getCurrentUser()).rejects.toMatchObject({
      status: 401,
    });
    expect(h.calls).toHaveLength(2);
  });

  it('clears local state even when server logout fails, while reporting failure', async () => {
    const h = harness();
    await h.auth.login(credentials);
    h.handle((config) => reply(config, 503, {}));
    await expect(h.auth.logout()).rejects.toBeInstanceOf(AuthError);
    expect(h.auth.getState().user).toBeNull();
  });

  it('does not resurrect auth after logout races an in-flight refresh', async () => {
    const h = harness();
    await h.auth.login(credentials);
    const pause = gate();
    h.handle(async (config) => {
      if (config.url === '/auth/refresh') {
        await pause.promise;
        return reply(config, 200, result('too-late'));
      }
      return reply(config, 204, undefined);
    });
    const refresh = h.auth.refreshSession();
    const failure = expect(refresh).rejects.toMatchObject({
      code: 'SESSION_CHANGED',
    });
    await vi.waitFor(() =>
      expect(h.calls.some((c) => c.url === '/auth/refresh')).toBe(true),
    );
    const logout = h.auth.logout();
    pause.resolve();
    await failure;
    await logout;
    expect(h.auth.getState().status).toBe('unauthenticated');
    expect(h.calls.at(-1)?.url).toBe('/auth/logout');
  });

  it('updates current User from me, without trusting JWT payload or caller role', async () => {
    const h = harness();
    await h.auth.login(credentials);
    h.handle((config) =>
      reply(config, 200, { ...student, fullName: 'Updated name' }),
    );
    expect((await h.auth.getCurrentUser()).fullName).toBe('Updated name');
    expect(h.calls.at(-1)).toMatchObject({
      url: '/auth/me',
      token: 'Bearer access-one',
    });
  });

  it('Student rejects CMS users, cleans their new session, and CMS can accept TEACHER', async () => {
    const teacher = { ...student, role: 'TEACHER' as const };
    const h = harness();
    h.handle((config) =>
      reply(
        config,
        config.url === '/auth/logout' ? 204 : 200,
        result('cms-token', teacher),
      ),
    );
    await expect(h.auth.login(credentials)).rejects.toMatchObject({
      code: 'ROLE_NOT_ALLOWED',
      status: 403,
    });
    expect(h.calls.at(-1)?.url).toBe('/auth/logout');
    expect(h.auth.getState().user).toBeNull();
    const cms = harness(ROLE_POLICIES.CMS);
    cms.handle((config) => reply(config, 200, result('cms-token', teacher)));
    await expect(cms.auth.login(credentials)).resolves.toEqual(teacher);
    expect(canUseStudentWebsite(teacher)).toBe(false);
    expect(canUseAdminCms(teacher)).toBe(true);
    expect(canUseStudentWebsite(student)).toBe(true);
    expect(canUseAdminCms(student)).toBe(false);
    expect(canUseAdminCms(null)).toBe(false);
    expect(canUseAdminCms({ ...student, role: 'ADMIN' })).toBe(true);
    expect(canUseStudentWebsite({ ...student, role: 'ADMIN' })).toBe(false);
    expect(canUseStudentWebsite({ ...student, isActive: false })).toBe(false);
  });

  it('rejects foreign origins, protocol-relative URLs, URL credentials and API-prefix overrides before sending', async () => {
    const h = harness();
    await h.auth.login(credentials);
    const before = h.calls.length;
    for (const url of [
      'https://evil.example/collect',
      '//evil.example/collect',
      'http://user:password@localhost:3000/api/private',
      'http://localhost:3000/outside',
    ]) {
      await expect(h.api.get(url)).rejects.toMatchObject({
        code: 'UNTRUSTED_TARGET',
      });
    }
    await expect(
      h.api.get('/private', { baseURL: 'https://evil.example' }),
    ).rejects.toMatchObject({ code: 'UNTRUSTED_TARGET' });
    expect(h.calls).toHaveLength(before);
  });
});
