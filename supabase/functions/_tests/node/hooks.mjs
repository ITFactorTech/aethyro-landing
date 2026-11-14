export async function resolve(specifier, context, next) {
  if (specifier === "https://deno.land/std@0.168.0/http/server.ts")
    return { shortCircuit: true, url: "data:text/javascript,export function serve(h){ globalThis.__handler = h; }" };
  if (specifier.startsWith("https://esm.sh/@supabase/supabase-js@"))
    return { shortCircuit: true, url: "data:text/javascript,export function createClient(){ return globalThis.__makeClient(); }" };
  return next(specifier, context);
}
