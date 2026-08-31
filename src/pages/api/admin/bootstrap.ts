export const prerender = false;

import type { APIRoute } from 'astro';
import { bootstrapAdminUser, type BootstrapOptions } from '../../../server/auth/bootstrap';
import { timingSafeEqual } from '../../../server/lib/timing-safe';

/**
 * Server-only administrative bootstrap endpoint.
 * Requires explicit 'x-bootstrap-secret' authorization header on every request.
 */
export const POST: APIRoute = async ({ request, locals }) => {
  const runtimeEnv = (locals as any)?.runtime?.env || {};
  const expectedSecret =
    runtimeEnv.BOOTSTRAP_SECRET_KEY ||
    (typeof process !== 'undefined' ? process.env.BOOTSTRAP_SECRET_KEY : undefined);

  if (!expectedSecret) {
    return new Response(
      JSON.stringify({
        success: false,
        status: 'CONFIG_ERROR',
        error: 'BOOTSTRAP_SECRET_KEY is not configured on the server.',
      }),
      {
        status: 500,
        headers: { 'Content-Type': 'application/json' },
      }
    );
  }

  const providedSecret =
    request.headers.get('x-bootstrap-key') ||
    request.headers.get('x-bootstrap-secret');

  if (!providedSecret || !(await timingSafeEqual(providedSecret, expectedSecret))) {
    return new Response(
      JSON.stringify({
        success: false,
        status: 'UNAUTHORIZED',
        error: 'Unauthorized: missing or invalid x-bootstrap-key header.',
      }),
      {
        status: 401,
        headers: { 'Content-Type': 'application/json' },
      }
    );
  }

  let bodyOptions: BootstrapOptions = {};
  try {
    const text = await request.text();
    if (text && text.trim().length > 0) {
      bodyOptions = JSON.parse(text);
    }
  } catch {
    return new Response(
      JSON.stringify({
        success: false,
        status: 'BAD_REQUEST',
        error: 'Invalid JSON request payload.',
      }),
      {
        status: 400,
        headers: { 'Content-Type': 'application/json' },
      }
    );
  }

  try {
    const result = await bootstrapAdminUser(bodyOptions, runtimeEnv);

    let statusCode = 200;
    if (result.status === 'ALREADY_INITIALIZED' || result.status === 'CONFIG_ERROR') {
      statusCode = 400;
    } else if (result.status === 'FAILED') {
      statusCode = 500;
    }

    return new Response(JSON.stringify(result), {
      status: statusCode,
      headers: { 'Content-Type': 'application/json' },
    });
  } catch (err: any) {
    return new Response(
      JSON.stringify({
        success: false,
        status: 'FAILED',
        error: err.message || 'Unexpected server error during bootstrap execution.',
      }),
      {
        status: 500,
        headers: { 'Content-Type': 'application/json' },
      }
    );
  }
};
