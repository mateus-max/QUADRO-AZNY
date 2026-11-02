const FIREBASE_DB = "https://quadro-azny-default-rtdb.firebaseio.com";

function esc(value = "") {
  return String(value).replace(/[&<>"']/g, ch => ({
    "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;"
  }[ch]));
}
function absoluteMediaUrl(value) {
  try {
    const url = new URL(value);
    return url.protocol === "https:" ? url.href : "";
  } catch { return ""; }
}
function pageHtml({ id, caption, type, mediaUrl, createdAt }) {
  const title = "Publicação da Direção — Remote Work Board";
  const description = (caption || "Veja esta publicação partilhada pela Direção no Remote Work Board.")
    .replace(/\s+/g, " ").trim().slice(0, 240);
  const canonical = "https://remote.work.board.apsanlda.com/p/" + encodeURIComponent(id);
  const image = type === "image" ? mediaUrl : "";
  const video = type === "video" ? mediaUrl : "";
  const date = createdAt ? new Date(Number(createdAt)).toISOString() : "";
  const tags = [
    '<meta property="og:type" content="article">',
    '<meta property="og:site_name" content="Remote Work Board">',
    '<meta property="og:title" content="' + esc(title) + '">',
    '<meta property="og:description" content="' + esc(description) + '">',
    '<meta property="og:url" content="' + esc(canonical) + '">',
    image ? '<meta property="og:image" content="' + esc(image) + '">' : "",
    image ? '<meta property="og:image:secure_url" content="' + esc(image) + '">' : "",
    image ? '<meta property="og:image:alt" content="' + esc(description.slice(0, 120)) + '">' : "",
    video ? '<meta property="og:video" content="' + esc(video) + '">' : "",
    video ? '<meta property="og:video:secure_url" content="' + esc(video) + '">' : "",
    video ? '<meta property="og:video:type" content="video/mp4">' : "",
    date ? '<meta property="article:published_time" content="' + esc(date) + '">' : "",
    '<meta name="twitter:card" content="' + (image ? "summary_large_image" : "summary") + '">',
    '<meta name="twitter:title" content="' + esc(title) + '">',
    '<meta name="twitter:description" content="' + esc(description) + '">',
    image ? '<meta name="twitter:image" content="' + esc(image) + '">' : ""
  ].filter(Boolean).join("\n");
  const destination = "https://remote.work.board.apsanlda.com/publicacoes.html#post-" + encodeURIComponent(id);
  return '<!doctype html><html lang="pt"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>' +
    esc(title) + '</title>' + tags + '<link rel="canonical" href="' + esc(canonical) +
    '"><meta http-equiv="refresh" content="0;url=' + esc(destination) +
    '"><script>location.replace(' + JSON.stringify(destination) + ')</script></head><body><p>A abrir a publicação... <a href="' +
    esc(destination) + '">Continuar</a></p></body></html>';
}

export default {
  async fetch(request) {
    const url = new URL(request.url);
    const match = url.pathname.match(/^\/p\/([A-Za-z0-9_-]{1,160})\/?$/);
    if (!match) return new Response("Not found", { status: 404 });
    const id = match[1];
    try {
      const response = await fetch(FIREBASE_DB + "/publications/" + encodeURIComponent(id) + ".json", {
        headers: { "Accept": "application/json" },
        cf: { cacheTtl: 30, cacheEverything: true }
      });
      if (!response.ok) return new Response("Publication unavailable", { status: 502 });
      const post = await response.json();
      if (!post || !post.url || !["image", "video", "audio"].includes(post.type)) {
        return new Response("Publication not found", { status: 404 });
      }
      const mediaUrl = absoluteMediaUrl(post.url);
      if (!mediaUrl) return new Response("Invalid publication media", { status: 404 });
      return new Response(pageHtml({
        id, caption: post.caption || "", type: post.type,
        mediaUrl, createdAt: post.createdAt || 0
      }), {
        headers: {
          "Content-Type": "text/html; charset=utf-8",
          "Cache-Control": "public, max-age=60, s-maxage=300",
          "X-Content-Type-Options": "nosniff"
        }
      });
    } catch {
      return new Response("Could not load publication", { status: 503 });
    }
  }
};
