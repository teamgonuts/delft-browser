// Deterministic Delft-style phrase splitter for Dutch sentences.
// Rules (approved in Milestone 1):
//   * a sentence of WHOLE_MAX words or fewer stays whole (and so does a longer one with no cut point below)
//   * longer sentences split at commas, colons and semicolons first (the mark stays at the end of the piece)
//   * a piece longer than CLAUSE_MAX words splits before a subordinating word: dat, die, zodra, omdat, terwijl, ...
//   * a piece still longer than PIECE_MAX words splits before a preposition or at a noun-phrase boundary
//     (noun followed by de/het/een), preferring a cut just after a past participle ("... gesloten | met ...")
//   * never make a piece shorter than MIN_PIECE words unless it is a comma-delimited tail ("schrijft het ziekenhuis.")
// Thresholds were fitted to the 18 approved Parool splits (test/splitter.test.mjs).
const Splitter = (() => {
  const WHOLE_MAX = 13;
  const CLAUSE_MAX = 13;
  const PIECE_MAX = 16;
  const MIN_PIECE = 3;
  const CLAUSE_WORDS = new Set(["dat", "die", "zodra", "omdat", "terwijl", "waardoor", "waarbij", "waarin", "waarmee", "hoewel", "nadat", "voordat", "sinds", "tenzij", "zodat", "wanneer", "als", "maar", "want", "of"]);
  // "Strong" prepositions open a phrase a learner can say on its own; "weak" ones bind tightly to the noun before them.
  const STRONG_PREP = new Set(["in", "op", "met", "bij", "over", "voor", "door", "uit", "tussen", "onder", "tegen", "zonder", "volgens", "tijdens", "na"]);
  const WEAK_PREP = new Set(["van", "naar", "tot", "om", "aan", "te"]);
  const ARTICLES = new Set(["de", "het", "een"]);
  const NOT_NOUN = new Set([...STRONG_PREP, ...WEAK_PREP, ...ARTICLES, "en", "of", "maar", "dat", "die", "deze", "dit", "niet", "ook", "nog", "al", "er", "zeer", "heel"]);
  const AUX = /^(heeft|hebben|is|zijn|wordt|worden|werd|werden|zou|zouden|kan|kunnen|moet|moeten|zal|zullen|te)$/;
  const PARTICIPLE = /^(ge|be|ver|ont|her)[a-z]+(d|t|en)$/;

  const words = (s) => s.trim().split(/\s+/).filter(Boolean);
  const wc = (s) => words(s).length;

  // Split at commas, keeping the comma with the preceding piece. Commas inside quotes still count:
  // the Delft lines break there too.
  function splitCommas(s) {
    const parts = s.split(/(?<=[,:;][’”"']?)\s+/); // commas, colons and semicolons all end a piece
    return parts.map((p) => p.trim()).filter(Boolean);
  }

  // Split before the first clause word that leaves both halves >= MIN_PIECE words; prefer a split
  // that lands both halves under PIECE_MAX. Recurse on halves that are still too long.
  function splitClause(piece) {
    const w = words(piece);
    if (w.length <= CLAUSE_MAX) return [piece];
    let best = null;
    for (let i = MIN_PIECE; i <= w.length - MIN_PIECE; i++) {
      const tok = w[i].toLowerCase().replace(/^[^\p{L}]+/u, "");
      if (!CLAUSE_WORDS.has(tok)) continue;
      const score = Math.max(i, w.length - i); // balance: smaller max half wins
      if (!best || score < best.score) best = { i, score };
    }
    if (!best) return splitPreposition(piece);
    return [...splitClause(w.slice(0, best.i).join(" ")), ...splitClause(w.slice(best.i).join(" "))];
  }

  // Last resort for a long clause with no comma or conjunction: split before a strong preposition or at a
  // noun-phrase boundary, as close to the middle as possible, with a preference for cutting right after a
  // past participle so a verb cluster ends the piece.
  function splitPreposition(piece) {
    const w = words(piece);
    if (w.length <= PIECE_MAX) return [piece];
    let best = null;
    const mid = w.length / 2;
    const clean = (t) => t.toLowerCase().replace(/[^\p{L}\p{N}-]/gu, "");
    for (let i = MIN_PIECE; i <= w.length - MIN_PIECE; i++) {
      const tok = clean(w[i]); const prev = clean(w[i - 1]);
      if (AUX.test(prev) || /,$/.test(w[i - 1])) continue; // never cut a verb cluster from its object
      let score;
      if (STRONG_PREP.has(tok)) score = Math.abs(i - mid);
      else if (WEAK_PREP.has(tok)) score = Math.abs(i - mid) + 3;
      else if (ARTICLES.has(tok) && !NOT_NOUN.has(prev) && !PARTICIPLE.test(prev)) score = Math.abs(i - mid); // noun | article = NP boundary
      else continue;
      // a cut right after a past participle beats everything, and the last such cut wins so the whole verb
      // cluster of the main clause ends the first piece ("... deals te hebben gesloten | met ...")
      const prev2 = i >= 2 ? clean(w[i - 2]) : "";
      const isParticiple = PARTICIPLE.test(prev) && (prev.startsWith("ge") || AUX.test(prev2)); // "vertrouwen" after "het" is a noun
      if (isParticiple && i <= PIECE_MAX) score = -100 - i;
      if (!best || score < best.score) best = { i, score };
    }
    if (!best) return [piece];
    return [...splitPreposition(w.slice(0, best.i).join(" ")), ...splitPreposition(w.slice(best.i).join(" "))];
  }

  // Merge pieces that are too short into a neighbour, except a short comma tail at the end.
  function mergeShort(pieces) {
    const out = [];
    for (let k = 0; k < pieces.length; k++) {
      const p = pieces[k];
      const isLast = k === pieces.length - 1;
      if (wc(p) < MIN_PIECE && out.length && !(isLast && /,$/.test(out[out.length - 1]))) {
        out[out.length - 1] = out[out.length - 1] + " " + p;
      } else out.push(p);
    }
    // a too-short first piece joins the next one
    if (out.length > 1 && wc(out[0]) < MIN_PIECE) { out[1] = out[0] + " " + out[1]; out.shift(); }
    return out;
  }

  function split(sentence) {
    const s = sentence.replace(/\s+/g, " ").trim();
    if (!s || wc(s) <= WHOLE_MAX) return [s];
    let pieces = splitCommas(s).flatMap(splitClause);
    pieces = mergeShort(pieces);
    // sanity: pieces must reassemble to the sentence
    if (pieces.join(" ") !== s) return [s];
    return pieces;
  }

  return { split, WHOLE_MAX, CLAUSE_MAX, PIECE_MAX };
})();
if (typeof self !== "undefined") self.Splitter = Splitter;
if (typeof module !== "undefined") module.exports = Splitter;
