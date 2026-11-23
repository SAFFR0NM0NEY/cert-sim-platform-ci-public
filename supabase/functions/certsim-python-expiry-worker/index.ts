import { createHandler } from './worker.ts';
Deno.serve(createHandler(key => Deno.env.get(key)));
