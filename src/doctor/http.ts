export interface HttpProbeRequest {
  url: string;
  headers: Record<string, string>;
  timeoutMs: number;
}

export interface HttpProbeResult {
  ok: boolean;
  /** HTTP status, or null when the request never got one (DNS failure, refused connection, timeout). */
  status: number | null;
  /** Transport-level error message, or null when a response arrived. Never contains a request header value. */
  error: string | null;
}

/**
 * The seam the provider-reachability checks use. **No test in this repository ever supplies `fetchProbe`**:
 * TeamCity and Bitbucket Server are not reachable from the development machine (§33 lists them as work-network
 * systems), so every test injects a stub and the real one is exercised for the first time by the §29.6
 * first-contact runbook.
 */
export type HttpProbe = (request: HttpProbeRequest) => Promise<HttpProbeResult>;

export const fetchProbe: HttpProbe = async (request) => {
  const controller = new AbortController();
  const timer = setTimeout(() => {
    controller.abort();
  }, request.timeoutMs);
  try {
    const response = await fetch(request.url, { headers: request.headers, signal: controller.signal, redirect: 'manual' });
    return { ok: response.ok, status: response.status, error: null };
  } catch (error) {
    return { ok: false, status: null, error: error instanceof Error ? error.message : String(error) };
  } finally {
    clearTimeout(timer);
  }
};
