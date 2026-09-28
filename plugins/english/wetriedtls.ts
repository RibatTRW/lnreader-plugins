import { fetchText } from '@libs/fetch';
import { Plugin } from '@/types/plugin';
import { NovelStatus } from '@libs/novelStatus';
import { Filters, FilterTypes } from '@libs/filterInputs';

const API = 'https://api.wetriedtls.com';

/**
 * Build the catalog browse URL for a page. The API honors the `status`
 * query param (Ongoing / Completed / Dropped / Canceled) but ignores
 * `tags` and `sort` params, so status is the only exposed filter.
 * 'all' (or empty) means no status filtering.
 */
function catalogUrl(pageNo: number, status?: string): string {
  let url = API + '/query?adult=true&query_string=&page=' + pageNo;
  const s = (status || '').trim();
  if (s && s !== 'all') url += '&status=' + encodeURIComponent(s);
  return url;
}
const SITE = 'https://wetriedtls.com';

type NovelCard = {
  slug: string;
  title: string;
  cover: string;
};

type NovelDetails = {
  id: number;
  name: string;
  author: string;
  genres: string[];
  status: string;
  cover: string;
  summary: string;
};

type ChapterInfo = {
  slug: string;
  name: string;
  number: number;
  publishedAt: string;
  /** True for chapters behind the site's paywall (from the /paid endpoint). */
  locked: boolean;
};

function safeJson(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return undefined;
  }
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null;
}

function str(v: unknown): string {
  return typeof v === 'string' ? v : '';
}

/** Decode a handful of HTML entities; the site uses a small set. */
function decodeEntities(s: string): string {
  return s
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#0?39;/g, "'")
    .replace(/&rsquo;|&lsquo;/g, "'")
    .replace(/&rdquo;|&ldquo;/g, '"')
    .replace(/&mdash;/g, '—')
    .replace(/&#(\d+);/g, (_, n) => String.fromCharCode(parseInt(n, 10)));
}

/** Strip tags, collapse whitespace. */
function stripHtml(html: string): string {
  return decodeEntities(html.replace(/<[^>]+>/g, ' '))
    .replace(/[ \t\xa0]+/g, ' ')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

/**
 * Next.js app-router pages embed their data in
 *   self.__next_f.push([1,"<escaped payload>"])</script>
 * scripts. Decode every payload into one searchable text blob.
 * The closing tag match tolerates an optional semicolon / whitespace
 * (some Next.js versions emit `);</script>`), so chunks are never
 * silently skipped due to formatting.
 */
function extractFlightText(html: string): string {
  const re = /self\.__next_f\.push\(\[1,"([\s\S]*?)"\]\)\s*;?\s*<\/script>/g;
  let out = '';
  let m: RegExpExecArray | null;
  while ((m = re.exec(html)) !== null) {
    try {
      out += JSON.parse('"' + m[1] + '"');
    } catch {
      /* skip malformed chunk */
    }
  }
  return out;
}

/**
 * Slice a JS string by UTF-8 byte offsets (the flight protocol's `T<hex>`
 * length prefix counts UTF-8 bytes of the row payload, not UTF-16 chars).
 */
function sliceUtf8Bytes(s: string, start: number, byteLen: number): string {
  let bytes = 0;
  let i = start;
  while (i < s.length && bytes < byteLen) {
    const code = s.charCodeAt(i);
    if (code >= 0xd800 && code <= 0xdbff && i + 1 < s.length) {
      const next = s.charCodeAt(i + 1);
      if (next >= 0xdc00 && next <= 0xdfff) {
        i += 2;
        bytes += 4;
        continue;
      }
    }
    bytes += code < 0x80 ? 1 : code < 0x800 ? 2 : 3;
    i++;
  }
  return s.slice(start, i);
}

/** Inner text of one <p>...</p> block, tags stripped. */
function paragraphText(p: string): string {
  return decodeEntities(p.replace(/<[^>]+>/g, '')).trim();
}

/** Lowercase and drop everything but letters and digits, for loose matching. */
function normalizeText(s: string): string {
  return s
    .toLowerCase()
    .replace(
      /[\s\u2000-\u2bff\u3000-\u303f\uff01-\uff0f!-/:-@[-`{-~\xa0-\xbf]+/g,
      '',
    );
}

/**
 * True when a block is the site's repeated series / chapter title header,
 * e.g. `◈ Series Name`, `Chapter 12: Title`, `Series<br>Chapter 12`. The
 * titles come from the chapter page itself, so this needs no state from
 * parseNovel. A block only counts when nothing but known titles (plus a
 * bare "Chapter N") is left after removing them, so a genuine bold line
 * such as a POV label or scene header is never stripped.
 */
function isTitleRepeat(p: string, knownTitles: string[]): boolean {
  let rest = normalizeText(paragraphText(p.replace(/<br\s*\/?>/gi, ' ')));
  if (!rest) return false;
  const titles = knownTitles
    .map(normalizeText)
    .filter(t => t.length > 0)
    .sort((a, b) => b.length - a.length);
  let removed = false;
  for (const t of titles) {
    if (rest.indexOf(t) !== -1) {
      rest = rest.split(t).join('');
      removed = true;
    }
  }
  rest = rest.replace(/(?:volume|vol|chapter|ch|episode|ep)\d+/g, '');
  // Catalog titles often omit a leading article the header keeps.
  return removed && /^(?:the|an?)?$/.test(rest);
}

/**
 * Translator / editor credits and the "Discord:" / "Ko-Fi:" lines that sit
 * in the chapter header next to the banner are site chrome, not story
 * content. Covers `Translator: X`, `Editors: A, B`, `Translator/Editor: X`
 * and `[Translator – X]`. Narrow on purpose: it must start with a role
 * word followed by a separator, so ordinary prose never matches.
 */
function isCreditLine(p: string): boolean {
  const t = paragraphText(p);
  return (
    /^\[?\s*(?:(?:translat(?:or|ors|ion)|editors?|proofreaders?|typesetters?|tlc?|qc)\s*[/&,]?\s*)+\s*(?:[:\]–—-]|by\b)/i.test(
      t,
    ) || /^(?:discord|ko-?fi|patreon)\s*:/i.test(t)
  );
}

/** A block that is nothing but bold text, e.g. a header line. */
function isBoldOnly(p: string): boolean {
  const inner = p
    .replace(/<\/?(?:p|span)\b[^>]*>/gi, '')
    .replace(/<br\s*\/?>/gi, '')
    .trim();
  return /^<(strong|b)\b[^>]*>[\s\S]*<\/\1>$/i.test(inner);
}

/** A divider row (`──────` or a horizontal rule) in the chapter header. */
function isDivider(p: string): boolean {
  if (/<hr[\s>/]/i.test(p) && !paragraphText(p)) return true;
  return /^[─━—–_=~-]{3,}$/.test(paragraphText(p).replace(/\s+/g, ''));
}

function isPromoParagraph(p: string): boolean {
  // A block that carries an illustration is content, never promo — even
  // when it has no text of its own (e.g. <p><div><img></div></p>).
  if (/<img[\s>]/i.test(p)) return false;
  const t = paragraphText(p).toLowerCase();
  if (!t || t === '= = =') return true;
  if (/we\s*tried\s*translations/.test(t) || /^we\s*tried\s*tls$/.test(t))
    return true;
  if (t.indexOf('dsc.gg') !== -1 || /join (our|the) discord/.test(t))
    return true;
  return false;
}

/**
 * Decode the HTML entities that can appear inside an attribute value —
 * decimal (&#106;), hex (&#x6A;) and the named entities that can smuggle a
 * scheme past a prefix check (&colon;) — so the scheme test sees what the
 * reader will actually navigate to.
 */
function decodeAttrEntities(s: string): string {
  return s
    .replace(/&#x([0-9a-f]+);?/gi, (_m, h: string) =>
      String.fromCharCode(parseInt(h, 16)),
    )
    .replace(/&#(\d+);?/g, (_m, n: string) =>
      String.fromCharCode(parseInt(n, 10)),
    )
    .replace(/&colon;?/gi, ':')
    .replace(/&tab;?/gi, '\t')
    .replace(/&newline;?/gi, '\n');
}

/** True for URLs that would execute script when followed from the reader. */
function isScriptUrl(url: string): boolean {
  // Browsers ignore whitespace and control characters inside a scheme.
  const norm = decodeAttrEntities(url)
    .split('')
    .filter(ch => ch.charCodeAt(0) > 0x20 && ch.charCodeAt(0) !== 0x7f)
    .join('')
    .replace(/\s+/g, '');
  return /^(javascript|vbscript):/i.test(norm);
}

const UNSAFE_TAGS =
  'script|iframe|object|embed|form|input|textarea|select|button|style|link|meta|base|noscript';

/**
 * Strip anything that could execute code from chapter HTML before it
 * reaches the reader, which renders it unsanitized: dangerous elements,
 * event handler attributes (<img onerror=...>) and script URLs in any
 * link-like attribute, including SVG's xlink:href. Everything else is
 * preserved as-is.
 */
function sanitizeHtml(html: string): string {
  return html
    .replace(
      new RegExp('<(' + UNSAFE_TAGS + ')[\\s>/][\\s\\S]*?</\\1\\s*>', 'gi'),
      '',
    )
    .replace(new RegExp('</?(?:' + UNSAFE_TAGS + ')\\b[^>]*>', 'gi'), '')
    .replace(/[\s/]on[a-z]+\s*=\s*("[^"]*"|'[^']*'|[^\s"'=<>`]+)/gi, '')
    .replace(
      /\s(?:xlink:)?(?:href|src|action|formaction)\s*=\s*("[^"]*"|'[^']*'|[^\s"'=<>`]+)/gi,
      (m, val: string) =>
        isScriptUrl(val.replace(/^['"]|['"]$/g, '')) ? '' : m,
    );
}

const VOID_TAGS =
  /^(area|base|br|col|embed|hr|img|input|link|meta|param|source|track|wbr)$/i;

/**
 * Split chapter HTML into its top-level nodes in document order: each
 * element (with everything nested in it, so lists, tables, blockquotes and
 * divs stay intact) or run of loose text becomes one block. An unclosed
 * <p> is ended by the next <p>, as an HTML parser would.
 */
function splitBlocks(html: string): string[] {
  const blocks: string[] = [];
  const tagRe = /<(\/?)([a-z][a-z0-9]*)\b[^>]*?(\/?)>/gi;
  let depth = 0;
  let openName = '';
  let blockStart = 0;
  let m: RegExpExecArray | null;
  const push = (from: number, to: number) => {
    const b = html.slice(from, to).trim();
    if (b) blocks.push(b);
  };
  while ((m = tagRe.exec(html)) !== null) {
    const closing = m[1] === '/';
    const name = m[2].toLowerCase();
    const selfClosed = m[3] === '/' || VOID_TAGS.test(name);
    if (depth === 0) {
      // A stray close tag, or a <br> / <wbr> inside loose text, is not a block.
      if (closing || /^(br|wbr)$/.test(name)) continue;
      push(blockStart, m.index); // loose text before this element
      blockStart = m.index;
      if (selfClosed) {
        push(blockStart, m.index + m[0].length);
        blockStart = m.index + m[0].length;
      } else {
        depth = 1;
        openName = name;
      }
    } else if (!closing && name === 'p' && depth === 1 && openName === 'p') {
      push(blockStart, m.index); // unclosed <p>: end it, start a new one
      blockStart = m.index;
    } else if (!selfClosed) {
      depth += closing ? -1 : 1;
      if (depth === 0) {
        push(blockStart, m.index + m[0].length);
        blockStart = m.index + m[0].length;
      }
    }
  }
  push(blockStart, html.length);
  return blocks;
}

/** Parse the /query API response (catalog + search share the shape). */
function parseQueryResults(jsonText: string): {
  items: NovelCard[];
  lastPage: number;
} {
  const root = safeJson(jsonText);
  const items: NovelCard[] = [];
  let lastPage = 1;
  if (isRecord(root)) {
    const meta = root.meta;
    if (isRecord(meta) && typeof meta.last_page === 'number')
      lastPage = meta.last_page;
    const data = Array.isArray(root.data) ? root.data : [];
    for (const it of data) {
      if (!isRecord(it)) continue;
      if (it.series_type && it.series_type !== 'Novel') continue;
      const slug = str(it.series_slug).trim();
      const title = str(it.title).trim();
      if (!slug || !title) continue;
      items.push({
        slug,
        title: decodeEntities(title),
        cover: str(it.thumbnail),
      });
    }
  }
  return { items, lastPage };
}

/** Parse the /series/{slug} API response. */
function parseSeriesDetail(jsonText: string): NovelDetails | null {
  const s = safeJson(jsonText);
  if (!isRecord(s) || typeof s.id !== 'number') return null;
  const tags = Array.isArray(s.tags) ? s.tags : [];
  return {
    id: s.id,
    name: decodeEntities(str(s.title)),
    author: decodeEntities(str(s.author)),
    genres: tags
      .map(t => (isRecord(t) ? decodeEntities(str(t.name)) : ''))
      .filter(g => g.length > 0),
    status: str(s.status),
    cover: str(s.thumbnail),
    summary: stripHtml(str(s.description)),
  };
}

/**
 * Parse one page of the /chapters/{seriesId} API response.
 * Pass locked=true for pages from the /paid endpoint.
 */
function parseChapterList(
  jsonText: string,
  locked = false,
): { items: ChapterInfo[]; lastPage: number } {
  // fetchText returns '' for a failed request. That must never read as a
  // valid empty page, or parseNovel would take a failed fetch for the end
  // of the list and present a truncated chapter list as complete.
  const root = safeJson(jsonText);
  if (!isRecord(root) || !Array.isArray(root.data))
    throw new Error('Failed to load the chapter list (unexpected response)');
  const meta = root.meta;
  if (!isRecord(meta) || typeof meta.last_page !== 'number')
    throw new Error('Failed to load the chapter list (no pagination info)');
  const items: ChapterInfo[] = [];
  for (const c of root.data) {
    const slug = isRecord(c) ? str(c.chapter_slug).trim() : '';
    const name = isRecord(c) ? str(c.chapter_name).trim() : '';
    if (!isRecord(c) || !slug || !name)
      throw new Error('Failed to load the chapter list (malformed chapter)');
    const title = str(c.chapter_title).trim();
    const idx = parseFloat(str(c.index));
    items.push({
      slug,
      name: title ? name + ': ' + decodeEntities(title) : name,
      number: isNaN(idx) ? 0 : idx,
      publishedAt: str(c.created_at),
      locked,
    });
  }
  return { items, lastPage: meta.last_page };
}

/**
 * The display name for a chapter in the app. Locked (paywalled) chapters
 * get a lock prefix so readers can see which ones are premium before
 * tapping them. LNReader sorts by chapterNumber, so the prefix never
 * affects chapter order.
 */
function chapterDisplayName(c: ChapterInfo): string {
  return c.locked ? '🔒 ' + c.name : c.name;
}

function proxiedImageUrl(url: string, width: number): string {
  const bare = url.replace(/^https?:\/\//i, '');
  return (
    'https://images.weserv.nl/?url=' +
    encodeURIComponent(bare) +
    '&w=' +
    width +
    '&q=80&output=webp'
  );
}

function shrinkIllustrations(html: string): string {
  return html.replace(
    /<img\b([^>]*?)\bsrc="(https?:\/\/media\.reaperscans\.net\/[^"]+)"([^>]*?)>/gi,
    (_m, pre, src, post) =>
      '<img' + pre + ' src="' + proxiedImageUrl(src, 800) + '"' + post + '>',
  );
}

/**
 * Covers are served straight from the site's CDN. Routing them through an
 * image proxy cannot carry a fallback in a single URL field, so a blocked
 * or down proxy would break every cover while the CDN still works.
 * Non-URL values pass through.
 */
function coverUrl(thumbnail: string): string {
  return (thumbnail || '').trim();
}

/**
 * The series title, chapter name and chapter title recorded in the chapter
 * page's own data, used to recognise the repeated title header.
 */
function pageTitles(flight: string): string[] {
  const titles: string[] = [];
  const add = (re: RegExp) => {
    const m = re.exec(flight);
    if (!m) return;
    try {
      titles.push(decodeEntities(JSON.parse('"' + m[1] + '"')));
    } catch {
      /* ignore an unreadable title */
    }
  };
  add(/"series":\{[^}]*?"title":"((?:[^"\\]|\\.)*)"/);
  add(/"chapter_name":"((?:[^"\\]|\\.)*)"/);
  add(/"chapter_title":"((?:[^"\\]|\\.)*)"/);
  return titles;
}

type ChapterContentResult =
  | { status: 'ok'; html: string }
  | { status: 'premium' | 'notfound' | 'empty' };

/**
 * Extract the chapter body from a chapter page's HTML.
 *
 * The page is a Next.js app-router page: the chapter record carries
 * `"chapter_content":"$<rowId>"` and the body HTML lives in the flight
 * row `<rowId>:T<hex>,` that follows, where <hex> is the exact UTF-8 byte
 * length of the payload. Slicing by that byte count is required — a
 * "next row" lookahead overshoots into flight metadata and corrupts the
 * HTML. Returns the cleaned HTML, or a non-ok status for locked /
 * missing / unparseable chapters.
 */
function parseChapterContent(html: string): ChapterContentResult {
  if (/this chapter is premium!/i.test(html)) return { status: 'premium' };
  // Only the real <title> element counts for the 404 check: Next.js flight
  // data always embeds a notFound template containing similar wording.
  const title = /<title[^>]*>([\s\S]*?)<\/title>/i.exec(html);
  if (title && /^\s*404/i.test(title[1])) return { status: 'notfound' };

  const flight = extractFlightText(html);
  // chapter_content is either a flight-row reference ("$<rowId>") or the
  // chapter HTML inline (gallery/illustration chapters). The value is a
  // JSON string, so internal quotes arrive escaped.
  const contentM = /"chapter_content":"((?:[^"\\]|\\.)*)"/.exec(flight);
  if (!contentM) return { status: 'empty' };
  let raw: string;
  try {
    raw = JSON.parse('"' + contentM[1] + '"');
  } catch {
    return { status: 'empty' };
  }

  let payload: string;
  const rowRef = /^\$([0-9a-z]{1,4})$/.exec(raw);
  if (rowRef) {
    // The row looks like `<rowId>:T<hex>,<payload>` where <hex> is the exact
    // UTF-8 byte length of the payload. Respecting it is the only reliable
    // end boundary: flight metadata follows the payload on the same line,
    // so a "next row" lookahead overshoots.
    const rowRe = new RegExp(
      '\\n' +
        rowRef[1].replace(/[.*+?^${}()|[\]\\]/g, '\\$&') +
        ':T([0-9a-f]+),',
    );
    const row = rowRe.exec(flight);
    if (!row) return { status: 'empty' };
    const byteLen = parseInt(row[1], 16);
    if (!(byteLen > 0)) return { status: 'empty' };
    const payloadStart = row.index + row[0].length;
    payload = sliceUtf8Bytes(flight, payloadStart, byteLen);
  } else if (/^\s*</.test(raw)) {
    payload = raw;
  } else {
    return { status: 'empty' };
  }
  if (!payload) return { status: 'empty' };

  // Paragraph breaks inside the payload are literal \r\n / \n sequences.
  const body = payload
    .replace(/\\r\\n/g, '\n')
    .replace(/\\n/g, '\n')
    .replace(/\\r/g, '\n')
    .trim();
  if (!body) return { status: 'empty' };

  // Split into top-level blocks in document order and trim the site's
  // promo header / footer (banner, credits, title repeats, discord plug)
  // from the edges. Blocks the parser does not recognize (lists, tables,
  // blockquotes) are kept whole: dropping them would lose chapter text.
  const blocks = splitBlocks(body);
  if (blocks.length === 0) return { status: 'empty' };
  const titles = pageTitles(flight);
  const isEdgeJunk = (p: string) =>
    isPromoParagraph(p) ||
    isCreditLine(p) ||
    isDivider(p) ||
    isTitleRepeat(p, titles);
  let start = 0;
  let end = blocks.length;
  // The site's header is a bold series / chapter title followed by a divider
  // row, and those lines do not always match the catalog title exactly. A
  // bold-only lead-in directly followed by a divider is header; a bold line
  // without one is kept as content.
  for (;;) {
    while (start < end && isEdgeJunk(blocks[start])) start++;
    let divider = -1;
    for (let i = start; i < Math.min(end, start + 8) && divider < 0; i++) {
      if (isDivider(blocks[i])) divider = i;
    }
    let header = divider >= 0;
    for (let i = start; header && i < divider; i++) {
      header = isEdgeJunk(blocks[i]) || isBoldOnly(blocks[i]);
    }
    if (!header) break;
    start = divider + 1;
  }
  while (end > start && isEdgeJunk(blocks[end - 1])) end--;
  const cleaned = blocks.slice(start, end).join('\n');
  // An image-only chapter (illustrations with no text) is still content.
  if (!paragraphText(cleaned) && !/<img[\s>]/i.test(cleaned))
    return { status: 'empty' };
  return { status: 'ok', html: sanitizeHtml(shrinkIllustrations(cleaned)) };
}

function mapStatus(s: string): string {
  if (s === 'Ongoing') return NovelStatus.Ongoing;
  if (s === 'Completed') return NovelStatus.Completed;
  if (s === 'Hiatus' || s === 'On Hiatus') return NovelStatus.OnHiatus;
  if (s === 'Cancelled' || s === 'Dropped') return NovelStatus.Cancelled;
  return NovelStatus.Unknown;
}

// --- Catalog filters ----------------------------------------------------
// The API honors `status` but ignores `tags` and `sort`, so the filter
// menu offers status only.
const STATUS_FILTER_OPTIONS = [
  { label: 'All', value: 'all' },
  { label: 'Ongoing', value: 'Ongoing' },
  { label: 'Completed', value: 'Completed' },
  { label: 'Dropped', value: 'Dropped' },
  { label: 'Canceled', value: 'Canceled' },
] as const;

/**
 * Pull a plain string value out of the app's filter payload, which may be
 * the raw string or a { type, value } wrapper object.
 */
function extractFilterValue(filters: unknown, key: string): string {
  if (!filters || typeof filters !== 'object') return '';
  const f = (filters as Record<string, unknown>)[key];
  if (f === null || f === undefined) return '';
  const v =
    typeof f === 'object' && 'value' in f ? (f as { value: unknown }).value : f;
  return typeof v === 'string' ? v : '';
}

class WeTriedTLS implements Plugin.PluginBase {
  id = 'wetriedtls';
  name = 'We Tried TLS';
  icon = 'src/en/wetriedtls/icon.png';
  site = SITE;
  version = '1.1.0';

  filters = {
    status: {
      type: FilterTypes.Picker,
      label: 'Status',
      value: 'all',
      options: STATUS_FILTER_OPTIONS,
    },
  } satisfies Filters;

  async popularNovels(
    pageNo: number,
    { filters }: Plugin.PopularNovelsOptions<typeof this.filters>,
  ): Promise<Plugin.NovelItem[]> {
    const status = extractFilterValue(filters, 'status');
    const page = parseQueryResults(await fetchText(catalogUrl(pageNo, status)));
    if (pageNo > page.lastPage) return [];
    return page.items.map(n => ({
      name: n.title,
      path: n.slug,
      cover: coverUrl(n.cover),
    }));
  }

  async parseNovel(novelPath: string): Promise<Plugin.SourceNovel> {
    const slug = novelPath.split('/').filter(Boolean).pop() || '';
    const detail = parseSeriesDetail(await fetchText(API + '/series/' + slug));
    if (!detail) throw new Error('Could not load novel details');

    // The chapter list is paginated (500 per page keeps it to ~2
    // requests even for the longest series). Free chapters come from
    // /chapters/{id} and paywalled chapters from /chapters/{id}/paid;
    // the two are merged so locked chapters show up with a lock prefix.
    // Opening a locked chapter shows a notice: it needs a paid
    // subscription on the website and cannot be read here.
    const all: ChapterInfo[] = [];
    let pageNo = 1;
    let lastPage = 1;
    do {
      const page = parseChapterList(
        await fetchText(
          API +
            '/chapters/' +
            detail.id +
            '?page=' +
            pageNo +
            '&perPage=500&order=asc',
        ),
      );
      lastPage = page.lastPage;
      for (const c of page.items) all.push(c);
      pageNo++;
    } while (pageNo <= lastPage);

    // Paid chapters are a bonus, not a requirement: if this endpoint
    // ever fails, the novel still loads with its free chapters.
    try {
      let paidPageNo = 1;
      let paidLastPage = 1;
      do {
        const page = parseChapterList(
          await fetchText(
            API +
              '/chapters/' +
              detail.id +
              '/paid?query=&page=' +
              paidPageNo +
              '&perPage=1000&order=asc',
          ),
          true,
        );
        paidLastPage = page.lastPage;
        for (const c of page.items) all.push(c);
        paidPageNo++;
      } while (paidPageNo <= paidLastPage);
    } catch {
      // ignore: free chapters are already collected above
    }

    const seen: Record<string, boolean> = {};
    const chapters: Plugin.ChapterItem[] = [];
    all
      .filter(c => {
        if (!c.slug || seen[c.slug]) return false;
        seen[c.slug] = true;
        return true;
      })
      .sort((a, b) => a.number - b.number)
      .forEach(c => {
        chapters.push({
          name: chapterDisplayName(c),
          path: slug + '/' + c.slug,
          releaseTime: c.publishedAt,
          chapterNumber: c.number,
        });
      });

    const novel: Plugin.SourceNovel = {
      path: novelPath,
      name: detail.name,
      status: mapStatus(detail.status),
    };
    if (detail.cover) novel.cover = coverUrl(detail.cover);
    if (detail.author) novel.author = detail.author;
    if (detail.genres.length) novel.genres = detail.genres.join(', ');
    if (detail.summary) novel.summary = detail.summary;
    novel.chapters = chapters;
    return novel;
  }

  async parseChapter(chapterPath: string): Promise<string> {
    const result = parseChapterContent(
      await fetchText(SITE + '/series/' + chapterPath),
    );
    if (result.status === 'ok') return result.html;
    if (result.status === 'premium') {
      return (
        '<p><strong>This chapter is premium on We Tried TLS.</strong></p>' +
        '<p>It requires a paid subscription on the website and cannot be read here. ' +
        'Free chapters of this novel still work.</p>'
      );
    }
    if (result.status === 'notfound') {
      return (
        '<p><strong>This chapter is no longer available on We Tried TLS.</strong></p>' +
        '<p>It may have been removed or moved. Refresh the novel to update the chapter list.</p>'
      );
    }
    return (
      '<p><strong>Could not load this chapter.</strong></p>' +
      '<p>It may be temporarily unavailable on We Tried TLS.</p>'
    );
  }

  async searchNovels(
    searchTerm: string,
    pageNo: number,
  ): Promise<Plugin.NovelItem[]> {
    const page = parseQueryResults(
      await fetchText(
        API +
          '/query?adult=true&query_string=' +
          encodeURIComponent(searchTerm) +
          '&page=' +
          pageNo,
      ),
    );
    if (pageNo > page.lastPage) return [];
    return page.items.map(n => ({
      name: n.title,
      path: n.slug,
      cover: coverUrl(n.cover),
    }));
  }

  resolveUrl = (path: string, _isNovel?: boolean): string =>
    SITE + '/series/' + path;
}

export default new WeTriedTLS();
