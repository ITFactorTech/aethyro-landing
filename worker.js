// Aethyro edge Worker: URL parity for the static site.
//
// Static assets are served by the platform for any path that is an exact file
// (/pricing.html, /app/chat.html, /sitemap.xml ...). This Worker only runs for
// paths that are NOT an exact file, and reproduces the behaviour the site has
// always had on its previous host, so no canonical URL, sitemap entry or
// backlink changes:
//
//   /            -> /index.html                       (200, no redirect)
//   /blog/       -> /blog/index.html                  (200)
//   /blog        -> 301 /blog/                        (a directory with an index)
//   /pricing     -> /pricing.html                     (200, no redirect)
//   /app/chat    -> /app/chat.html                    (200)
//   anything else -> /404.html with status 404
//
// Why not the platform's own html_handling? "auto-trailing-slash" (default)
// 307-redirects every *.html URL to an extensionless one, which contradicts the
// sitemap and every canonical tag; "none" turns off directory-index resolution.
// So html_handling is "none" and this file supplies the index/extensionless
// resolution. Headers from ./_headers are applied by the assets layer to the
// responses fetched here as well.

const NOT_FOUND = "/404.html";

async function fromAssets(env, request, pathname, forwardHeaders = true) {
  const target = new URL(request.url);
  target.pathname = pathname;
  // Conditional headers (If-None-Match ...) are forwarded when serving a real
  // page so a rewritten path ("/", "/pricing") still gets its 304. They are NOT
  // forwarded for the 404 page: a client revalidating a missing path with the
  // ETag of a different file would otherwise get an empty 404 body.
  return env.ASSETS.fetch(new Request(target.toString(), { method: request.method, headers: forwardHeaders ? request.headers : new Headers() }));
}

export default {
  async fetch(request, env) {
    if (request.method !== "GET" && request.method !== "HEAD") {
      return new Response("Method Not Allowed", { status: 405, headers: { Allow: "GET, HEAD" } });
    }

    const url = new URL(request.url);
    const path = url.pathname;

    // Directory index: "/" and "/dir/" -> ".../index.html"
    if (path.endsWith("/")) {
      const res = await fromAssets(env, request, path + "index.html");
      if (res.status !== 404) return res;
      return notFound(env, request);
    }

    // Extensionless page: "/pricing" -> "/pricing.html"
    const last = path.slice(path.lastIndexOf("/") + 1);
    if (!last.includes(".")) {
      const page = await fromAssets(env, request, path + ".html");
      if (page.status !== 404) return page;

      // A directory that has an index: "/blog" -> 301 "/blog/"
      const dirIndex = await fromAssets(env, request, path + "/index.html");
      if (dirIndex.status !== 404) {
        url.pathname = path + "/";
        return Response.redirect(url.toString(), 301);
      }
    }

    return notFound(env, request);
  },
};

async function notFound(env, request) {
  const res = await fromAssets(env, request, NOT_FOUND, false);
  // Keep the 404 page's headers; only the status differs.
  return new Response(request.method === "HEAD" ? null : res.body, {
    status: 404,
    headers: res.headers,
  });
}
