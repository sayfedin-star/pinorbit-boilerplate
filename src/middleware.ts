import { defineMiddleware } from 'astro:middleware';
import { dbClients } from './server/db/clients';
import { validateUserSession } from './server/auth/session';
import { ACTIVE_WORKSPACE_COOKIE } from './lib/workspaces';

export const onRequest = defineMiddleware(async (context, next) => {
  const runtimeEnv = (context.locals as { runtime?: { env?: Record<string, unknown> } })?.runtime?.env;

  const supabase = dbClients.getSchedulingSSR(
    {
      cookies: {
        get(key: string) { const c = context.cookies.get(key); return c?.value; },
        set(key: string, value: string, options?: Record<string, unknown>) {
          context.cookies.set(key, value, { path: '/', sameSite: 'lax', secure: true, ...options });
        },
        delete(key: string, options?: Record<string, unknown>) { context.cookies.delete(key, { path: '/', ...options }); },
      },
    },
    runtimeEnv as Record<string, any>
  );
  context.locals.supabase = supabase;

  const url = new URL(context.request.url);
  const pathname = url.pathname;

  const skipSession = pathname.startsWith('/api/internal/') || pathname.startsWith('/_astro') || pathname === '/favicon.svg';
  const session = skipSession
    ? { user: null, isAuthenticated: false, accessToken: undefined }
    : await validateUserSession(supabase);
  context.locals.user = session.user;
  context.locals.isAuthenticated = session.isAuthenticated;

  const workspaceCookie =
    context.cookies.get(ACTIVE_WORKSPACE_COOKIE)?.value ?? context.cookies.get('pinorbit_workspace_id')?.value;
  if (workspaceCookie) context.locals.activeWorkspaceId = workspaceCookie;

  const isPublicRoute =
    pathname === '/login' ||
    pathname.startsWith('/api/admin/bootstrap') ||
    pathname === '/api/internal/pinterest/ingest' ||
    pathname === '/api/internal/pinterest/daily-dispatch' ||
    pathname === '/api/internal/pinterest/cleanup-retention' ||
    pathname === '/api/internal/pinterest/dispatch-due-pin' ||
    pathname.startsWith('/api/auth') ||
    pathname.startsWith('/_astro') ||
    pathname === '/favicon.svg';
  if (isPublicRoute) return next();

  const isProtectedPath =
    pathname.startsWith('/dashboard') || pathname.startsWith('/analytics') || pathname.startsWith('/accounts') ||
    pathname.startsWith('/competitors') || pathname.startsWith('/imports') || pathname.startsWith('/boards') ||
    pathname.startsWith('/pins') || pathname.startsWith('/logs') || pathname.startsWith('/settings') ||
    pathname.startsWith('/audit') || pathname.startsWith('/schedules') || pathname.startsWith('/pinarchive');
  if (isProtectedPath && !session.isAuthenticated) {
    return context.redirect(`/login?redirect=${encodeURIComponent(pathname)}`);
  }
  return next();
});
