import { SafeError } from "./errors.ts";
const HEADERS = "authorization, apikey, content-type, x-client-info";
const METHODS = "GET, POST, PUT, OPTIONS";
export function allowedOrigins(
  value = Deno.env.get("CERTSIM_ALLOWED_ORIGINS") ?? "",
): Set<string> {
  return new Set(value.split(",").map((v) => v.trim()).filter(Boolean));
}
export function corsHeaders(
  request: Request,
  allowed: Set<string>,
): HeadersInit {
  const origin = request.headers.get("origin");
  if (!origin) return {};
  if (!allowed.has(origin)) throw new SafeError("origin_not_allowed");
  return {
    "access-control-allow-origin": origin,
    "access-control-allow-headers": HEADERS,
    "access-control-allow-methods": METHODS,
    "vary": "Origin",
  };
}
