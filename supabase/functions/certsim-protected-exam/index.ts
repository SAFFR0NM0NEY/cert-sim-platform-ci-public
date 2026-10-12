import { withSupabase } from "@supabase/server";
import { allowedOrigins, corsHeaders } from "./cors.ts";
import { SafeError } from "./errors.ts";
import { handleProtectedExam } from "./handler.ts";
import { errorResponse } from "./responses.ts";
const origins = allowedOrigins();
const authenticated = withSupabase(
  { auth: "user", cors: "disabled" },
  async (req, ctx) =>
    handleProtectedExam(req, { userClient: ctx.supabase, origins }),
);
export default {
  fetch: async (request: Request): Promise<Response> => {
    try {
      const headers = corsHeaders(request, origins);
      if (request.method === "OPTIONS") {
        return new Response(null, {
          status: 204,
          headers,
        });
      }
    } catch (error) {
      const safe = error instanceof SafeError
        ? error
        : new SafeError("origin_not_allowed");
      return errorResponse(safe, crypto.randomUUID());
    }
    const response = await authenticated(request);
    if (response.status === 401) {
      return errorResponse(
        new SafeError("unauthenticated"),
        crypto.randomUUID(),
        corsHeaders(request, origins),
      );
    }
    return response;
  },
};
