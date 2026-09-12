// Runs inside the article page. Returns {title, url, sentences[]}.
// Readability.js must be injected first (see sidepanel.js).
(() => {
  const clone = document.cloneNode(true);
  let title = document.title;
  let paragraphs = [];
  try {
    const article = new Readability(clone).parse();
    if (article && article.content && article.textContent.trim().length > 200) {
      title = article.title || title;
      // Take block-level text so paragraph boundaries survive (Readability's textContent glues blocks together).
      const doc = new DOMParser().parseFromString(article.content, "text/html");
      doc.querySelectorAll("figure, figcaption, aside, nav, time, script, style").forEach((n) => n.remove());
      const blocks = doc.querySelectorAll("p, h1, h2, h3, h4, li, blockquote");
      paragraphs = Array.from(blocks, (b) => ({ text: b.textContent, heading: /^H[1-4]$/.test(b.tagName) }));
    }
  } catch (e) { /* fall through to body text */ }
  if (!paragraphs.length && document.body) paragraphs = document.body.innerText.split(/\n+/).map((text) => ({ text, heading: false }));
  paragraphs = paragraphs.map((p) => ({ text: p.text.replace(/\s+/g, " ").trim(), heading: p.heading })).filter((p) => p.text.length > 0);

  const seg = typeof Intl !== "undefined" && Intl.Segmenter ? new Intl.Segmenter("nl", { granularity: "sentence" }) : null;
  const sentences = [];
  for (const p of paragraphs) {
    const parts = seg ? Array.from(seg.segment(p.text), (s) => s.segment) : p.text.split(/(?<=[.!?])\s+/);
    for (let s of parts) {
      s = s.trim();
      const words = s.split(" ").length;
      // Skip fragments (nav crumbs, bylines, captions).
      if (s.length < 12 || !/[a-zA-Z]/.test(s) || words < 3) continue;
      // Metadata lines ("Bron foto …", "Geschreven door … Leestijd 1 min") never end in a full stop; real
      // sentences do. Headings are allowed through without one.
      if (!p.heading && !/[.!?…"”')]$/.test(s)) continue;
      sentences.push(s);
    }
  }
  return { title, url: location.href, sentences };
})();
