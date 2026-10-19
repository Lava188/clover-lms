import axios, {
  type AxiosInstance,
  type InternalAxiosRequestConfig,
} from 'axios';
import {
  AuthError,
  authUserSchema,
  hasRole,
  loginRequestSchema,
  loginResponseSchema,
  type AuthenticationState,
  type AuthUser,
  type LoginRequest,
  type UserRole,
} from './auth.types';

declare module 'axios' {
  interface InternalAxiosRequestConfig {
    _cloverEpoch?: number;
    _cloverVersion?: number;
    _cloverHadToken?: boolean;
    _cloverRetried?: boolean;
  }
}

interface AuthClientOptions {
  apiBaseUrl: string;
  pageOrigin: string;
  allowedRoles: readonly UserRole[];
}

export interface AuthClient {
  getState: () => AuthenticationState;
  subscribe: (listener: () => void) => () => void;
  login: (input: LoginRequest) => Promise<AuthUser>;
  logout: () => Promise<void>;
  refreshSession: () => Promise<AuthUser>;
  getCurrentUser: () => Promise<AuthUser>;
  restoreSession: () => Promise<AuthUser | null>;
}
const registered = new WeakMap<
  AxiosInstance,
  { signature: string; client: AuthClient }
>();

function safeError(error: unknown): AuthError {
  if (error instanceof AuthError) return error;
  const status = axios.isAxiosError(error) ? error.response?.status : undefined;
  const messages: Record<number, string> = {
    400: 'Invalid authentication input.',
    401: 'Invalid credentials or expired session.',
    403: 'Authentication is not permitted for this client.',
    429: 'Too many attempts. Please try again later.',
  };
  return new AuthError(
    status === 401 ? 'UNAUTHENTICATED' : 'AUTH_FAILED',
    (status && messages[status]) || 'Authentication service unavailable.',
    status,
  );
}

// Install exactly once on the existing shared Axios instance. Tests pass their
// own isolated instance; production does not create another HTTP client.
export function createAuthClient(
  api: AxiosInstance,
  options: AuthClientOptions,
): AuthClient {
  const base = new URL(options.apiBaseUrl, options.pageOrigin);
  if (
    !['http:', 'https:'].includes(base.protocol) ||
    base.username ||
    base.password ||
    base.search ||
    base.hash
  ) {
    throw new AuthError('INVALID_CONFIG', 'Invalid API configuration.');
  }
  const prefix = base.pathname.replace(/\/$/, '');
  const signature = JSON.stringify([
    base.href,
    options.pageOrigin,
    [...options.allowedRoles].sort(),
  ]);
  const existing = registered.get(api);
  if (existing) {
    if (existing.signature !== signature)
      throw new AuthError(
        'INVALID_CONFIG',
        'The shared API client is already configured for another authentication context.',
      );
    return existing.client;
  }
  let state: AuthenticationState = Object.freeze({
    status: 'initializing',
    user: null,
  });
  let accessToken: string | null = null;
  let epoch = 0;
  let version = 0;
  let refreshPromise: Promise<AuthUser> | null = null;
  let restorePromise: Promise<AuthUser | null> | null = null;
  let restoreComplete = false;
  let mutation: Promise<unknown> | null = null;
  let logoutPromise: Promise<void> | null = null;
  const listeners = new Set<() => void>();
  const changed = () =>
    new AuthError(
      'SESSION_CHANGED',
      'Authentication changed while the request was running.',
    );
  const setState = (next: AuthenticationState) => {
    state = Object.freeze(next);
    for (const listener of listeners) listener();
  };
  const clear = () => {
    epoch++;
    version++;
    accessToken = null;
    setState({ status: 'unauthenticated', user: null });
  };
  const endpoint = (config: InternalAxiosRequestConfig): string => {
    const url = new URL(api.getUri(config), options.pageOrigin);
    if (
      url.origin !== base.origin ||
      url.username ||
      url.password ||
      !(url.pathname === prefix || url.pathname.startsWith(prefix + '/'))
    ) {
      throw new AuthError(
        'UNTRUSTED_TARGET',
        'The shared API client cannot send requests outside the configured API.',
      );
    }
    return url.pathname.slice(prefix.length).replace(/\/$/, '');
  };
  const cookieEndpoint = (path: string) =>
    ['/auth/login', '/auth/refresh', '/auth/logout'].includes(path);
  const cookieLock = <T>(work: () => Promise<T>): Promise<T> => {
    // Web Locks serialize cookie mutations across same-origin tabs when available.
    // The fallback still guarantees single-flight within this JS instance.
    if (typeof navigator !== 'undefined' && navigator.locks) {
      return navigator.locks.request(
        `clover-auth:${base.origin}${prefix}`,
        work,
      );
    }
    return work();
  };
  const postCookie = (path: string, data?: unknown) =>
    cookieLock(() => api.post<unknown>(path, data));

  api.interceptors.request.use((config) => {
    const path = endpoint(config); // Reject before any token/credentials are attached.
    config.withCredentials = cookieEndpoint(path);
    delete config.auth;
    config.headers.delete('Cookie'); // Only the browser may supply HttpOnly cookies.
    config._cloverEpoch = epoch;
    config._cloverVersion = version;
    config._cloverHadToken = !!accessToken && !cookieEndpoint(path);
    if (config._cloverHadToken)
      config.headers.set('Authorization', `Bearer ${accessToken}`);
    else config.headers.delete('Authorization');
    return config;
  });

  async function accept(
    data: unknown,
    expectedEpoch: number,
  ): Promise<AuthUser> {
    if (epoch !== expectedEpoch) throw changed();
    const parsed = loginResponseSchema.safeParse(data);
    if (!parsed.success)
      throw new AuthError(
        'INVALID_RESPONSE',
        'Invalid authentication response.',
      );
    const result = parsed.data;
    if (!hasRole(result.user, options.allowedRoles)) {
      // Revoke the newly created/restored cookie session for the wrong portal.
      await postCookie('/auth/logout');
      throw new AuthError(
        'ROLE_NOT_ALLOWED',
        'This account cannot access this application.',
        403,
      );
    }
    if (epoch !== expectedEpoch) throw changed();
    accessToken = result.accessToken;
    version++;
    const user = Object.freeze(result.user);
    setState({ status: 'authenticated', user });
    return user;
  }

  function refreshSession(): Promise<AuthUser> {
    if (mutation) return Promise.reject(changed());
    if (refreshPromise) return refreshPromise;
    const expectedEpoch = epoch;
    const pending = Promise.resolve().then(async () => {
      try {
        const response = await postCookie('/auth/refresh');
        return await accept(response.data, expectedEpoch);
      } catch (error) {
        if (epoch === expectedEpoch) clear();
        throw safeError(error);
      } finally {
        if (refreshPromise === pending) refreshPromise = null;
      }
    });
    refreshPromise = pending;
    return pending;
  }

  api.interceptors.response.use(
    (response) => {
      if (
        response.config._cloverHadToken &&
        response.config._cloverEpoch !== epoch
      )
        throw changed();
      return response;
    },
    async (error: unknown) => {
      if (
        !axios.isAxiosError(error) ||
        error.response?.status !== 401 ||
        !error.config
      )
        throw error;
      const config = error.config;
      if (cookieEndpoint(endpoint(config))) throw error; // Never recurse or refresh invalid login credentials.
      if (config._cloverEpoch !== epoch) throw changed();
      if (config._cloverRetried) {
        clear();
        throw safeError(error);
      }
      const safeMethod = ['get', 'head', 'options'].includes(
        (config.method ?? 'get').toLowerCase(),
      );
      if (!safeMethod || !config._cloverHadToken) throw safeError(error);
      if (config._cloverVersion === version) await refreshSession();
      if (config._cloverEpoch !== epoch || !accessToken) throw changed();
      config._cloverRetried = true;
      return api.request(config);
    },
  );

  function login(input: LoginRequest): Promise<AuthUser> {
    if (mutation) return Promise.reject(changed());
    const parsed = loginRequestSchema.safeParse(input);
    if (!parsed.success)
      return Promise.reject(
        new AuthError(
          'INVALID_INPUT',
          'A valid email and non-empty password are required.',
          400,
        ),
      );
    const previousRefresh = refreshPromise;
    clear();
    restoreComplete = true;
    const expectedEpoch = epoch;
    const pending = Promise.resolve().then(async () => {
      try {
        // Await old cookie writes before login so a late refresh cannot replace it.
        if (previousRefresh) await previousRefresh.catch(() => {});
        const response = await postCookie('/auth/login', parsed.data);
        return await accept(response.data, expectedEpoch);
      } catch (error) {
        if (epoch === expectedEpoch) clear();
        throw safeError(error);
      } finally {
        if (mutation === pending) mutation = null;
      }
    });
    mutation = pending;
    return pending;
  }

  function logout(): Promise<void> {
    if (logoutPromise) return logoutPromise;
    const previousMutation = mutation;
    const previousRefresh = refreshPromise;
    clear();
    restoreComplete = true;
    const pending = Promise.resolve().then(async () => {
      try {
        if (previousMutation) await previousMutation.catch(() => {});
        if (previousRefresh) await previousRefresh.catch(() => {});
        await postCookie('/auth/logout');
      } catch (error) {
        throw safeError(error);
      } finally {
        if (mutation === pending) mutation = null;
        if (logoutPromise === pending) logoutPromise = null;
      }
    });
    mutation = pending;
    logoutPromise = pending;
    return pending;
  }

  function restoreSession(): Promise<AuthUser | null> {
    if (restoreComplete) return Promise.resolve(state.user);
    if (restorePromise) return restorePromise;
    restorePromise = refreshSession()
      .catch(() => null)
      .finally(() => {
        restoreComplete = true;
        restorePromise = null;
      });
    return restorePromise;
  }

  async function getCurrentUser(): Promise<AuthUser> {
    if (!accessToken) {
      const user = await restoreSession();
      if (!user)
        throw new AuthError(
          'UNAUTHENTICATED',
          'Authentication is required.',
          401,
        );
    }
    const expectedEpoch = epoch;
    try {
      const response = await api.get<unknown>('/auth/me');
      if (epoch !== expectedEpoch) throw changed();
      const parsed = authUserSchema.safeParse(response.data);
      if (!parsed.success)
        throw new AuthError(
          'INVALID_RESPONSE',
          'Invalid current user response.',
        );
      if (!hasRole(parsed.data, options.allowedRoles)) {
        await logout();
        throw new AuthError(
          'ROLE_NOT_ALLOWED',
          'This account cannot access this application.',
          403,
        );
      }
      const user = Object.freeze(parsed.data);
      setState({ status: 'authenticated', user });
      return user;
    } catch (error) {
      if (epoch === expectedEpoch) clear();
      throw safeError(error);
    }
  }

  const client: AuthClient = {
    getState: () => state,
    subscribe: (listener: () => void) => {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    login,
    logout,
    refreshSession,
    getCurrentUser,
    restoreSession,
  };
  registered.set(api, { signature, client });
  return client;
}
