import { fetchApi } from '@libs/fetch';
import { Filters } from '@libs/filterInputs';
import { Plugin } from '@/types/plugin';
import { Cheerio, CheerioAPI, load as parseHTML } from 'cheerio';
import { AnyNode } from 'domhandler';
import { defaultCover } from '@libs/defaultCover';
import { NovelStatus } from '@libs/novelStatus';
import dayjs from 'dayjs';
import { storage } from '@libs/storage';

const includesAny = (str: string, keywords: string[]) =>
  new RegExp(keywords.join('|')).test(str);

type MadaraOptions = {
  useNewChapterEndpoint?: boolean;
  lang?: string;
  orderBy?: string;
  versionIncrements?: number;
  customJs?: string;
  hasLocked?: boolean;
  listLockedChapters?: boolean;
};

/** A coin-locked row kept in the chapter list, with the id the site uses for it. */
type LockedChapterRow = Plugin.ChapterItem & {
  chapterId: string | null;
};

/** One row of the series chapter list, as returned by the ajax endpoint. */
type SeriesChapterRow = {
  text: string;
  release: string;
  coin: string | null;
  chapterId: string | null;
  premium: boolean;
  path: string | null;
};

/**
 * Minimum length of the reading body below which a gated page is considered
 * locked. Free chapters carry thousands of characters; the gate notice is a
 * single sentence, and an entitled page would carry the prose next to a
 * (hidden) gate block.
 */
const MIN_PROSE_LENGTH = 200;

export type MadaraMetadata = {
  id: string;
  sourceSite: string;
  sourceName: string;
  options?: MadaraOptions;
  filters?: Filters;
};

export class MadaraPlugin implements Plugin.PluginBase {
  id: string;
  name: string;
  icon: string;
  site: string;
  version: string;
  options?: MadaraOptions;
  filters?: Filters | undefined;

  hideLocked = storage.get('hideLocked');
  pluginSettings?: Filters;

  constructor(metadata: MadaraMetadata) {
    this.id = metadata.id;
    this.name = metadata.sourceName;
    this.icon = `multisrc/madara/${metadata.id.toLowerCase()}/icon.png`;
    this.site = metadata.sourceSite;
    const versionIncrements = metadata.options?.versionIncrements || 0;
    this.version = `2.2.${versionIncrements}`;
    this.options = metadata.options;
    this.filters = metadata.filters;

    if (this.options?.hasLocked) {
      this.pluginSettings = {
        hideLocked: {
          value: '',
          label: 'Hide locked chapters',
          type: 'Switch',
        },
      };
    }
  }

  translateDragontea(text: Cheerio<AnyNode>): Cheerio<AnyNode> {
    if (this.id !== 'dragontea') return text;

    const $ = parseHTML(
      text
        .html()
        ?.replace('\n', '')
        .replace(/<br\s*\/?>/g, '\n') || '',
    );
    const reverseAlpha = 'zyxwvutsrqponmlkjihgfedcbaZYXWVUTSRQPONMLKJIHGFEDCBA';
    const forwardAlpha = 'abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ';

    text.html($.html());
    text
      .find('*')
      .addBack()
      .contents()
      .filter((_, el) => el.nodeType === 3)
      .each((_, el) => {
        const $el = $(el);
        const translated = $el
          .text()
          .normalize('NFD')
          .split('')
          .map(char => {
            const base = char.normalize('NFC');
            const idx = forwardAlpha.indexOf(base);
            return idx >= 0
              ? reverseAlpha[idx] + char.slice(base.length)
              : char;
          })
          .join('');
        $el.replaceWith(translated.replace('\n', '<br>'));
      });

    return text;
  }

  getHostname(url: string): string {
    url = url.split('/')[2];
    const url_parts = url.split('.');
    url_parts.pop(); // remove TLD
    return url_parts.join('.');
  }

  async getCheerio(url: string, search: boolean): Promise<CheerioAPI> {
    const r = await fetchApi(url);
    if (!r.ok && search != true)
      throw new Error(
        'Could not reach site (' + r.status + ') try to open in webview.',
      );
    const $ = parseHTML(await r.text());
    const title = $('title').text().trim();
    if (
      this.getHostname(url) != this.getHostname(r.url) ||
      title == 'Bot Verification' ||
      title == 'You are being redirected...' ||
      title == 'Un instant...' ||
      title == 'Just a moment...' ||
      title == 'Redirecting...'
    )
      throw new Error('Captcha error, please open in webview');
    return $;
  }

  parseNovels(loadedCheerio: CheerioAPI): Plugin.NovelItem[] {
    const novels: Plugin.NovelItem[] = [];

    loadedCheerio('.manga-title-badges').remove();

    loadedCheerio('.page-item-detail, .c-tabs-item__content').each(
      (index, element) => {
        const novelName = loadedCheerio(element)
          .find('.post-title')
          .text()
          .trim();
        const novelUrl =
          loadedCheerio(element).find('.post-title').find('a').attr('href') ||
          '';
        if (!novelName || !novelUrl) return;
        const image = loadedCheerio(element).find('img');
        const novelCover =
          image.attr('data-src') ||
          image.attr('src') ||
          image.attr('data-lazy-srcset') ||
          defaultCover;
        const novel: Plugin.NovelItem = {
          name: novelName,
          cover: novelCover,
          path: novelUrl.replace(/https?:\/\/.*?\//, ''),
        };
        novels.push(novel);
      },
    );

    return novels;
  }

  async popularNovels(
    pageNo: number,
    {
      filters,
      showLatestNovels,
    }: Plugin.PopularNovelsOptions<typeof this.filters>,
  ): Promise<Plugin.NovelItem[]> {
    let url = this.site + '/page/' + pageNo + '/?s=&post_type=wp-manga';
    if (!filters) filters = this.filters || {};
    if (showLatestNovels) url += '&m_orderby=latest';
    for (const key in filters) {
      if (typeof filters[key].value === 'object')
        for (const value of filters[key].value as string[])
          url += `&${key}=${value}`;
      else if (filters[key].value) url += `&${key}=${filters[key].value}`;
    }
    const loadedCheerio = await this.getCheerio(url, pageNo != 1);
    return this.parseNovels(loadedCheerio);
  }

  async parseNovel(novelPath: string): Promise<Plugin.SourceNovel> {
    let loadedCheerio = await this.getCheerio(this.site + novelPath, false);

    loadedCheerio('.manga-title-badges, #manga-title span').remove();
    const novel: Plugin.SourceNovel = {
      path: novelPath,
      name:
        loadedCheerio('.post-title h1').text().trim() ||
        loadedCheerio('#manga-title h1').text().trim() ||
        loadedCheerio('.manga-title').text().trim() ||
        '',
    };

    novel.cover =
      loadedCheerio('.summary_image > a > img').attr('data-lazy-src') ||
      loadedCheerio('.summary_image > a > img').attr('data-src') ||
      loadedCheerio('.summary_image > a > img').attr('src') ||
      defaultCover;

    loadedCheerio('.post-content_item, .post-content').each(function () {
      const detailName = loadedCheerio(this).find('h5').text().trim();
      const detail =
        loadedCheerio(this).find('.summary-content') ||
        loadedCheerio(this).find('.summary_content');

      switch (detailName) {
        case 'Genre(s)':
        case 'Genre':
        case 'Tags(s)':
        case 'Tag(s)':
        case 'Tags':
        case 'Género(s)':
        case 'Kategori':
        case 'التصنيفات':
          if (novel.genres)
            novel.genres +=
              ', ' +
              detail
                .find('a')
                .map((i, el) => loadedCheerio(el).text())
                .get()
                .join(', ');
          else
            novel.genres = detail
              .find('a')
              .map((i, el) => loadedCheerio(el).text())
              .get()
              .join(', ');
          break;
        case 'Author(s)':
        case 'Author':
        case 'Autor(es)':
        case 'المؤلف':
        case 'المؤلف (ين)':
          novel.author = detail.text().trim();
          break;
        case 'Translator(s)':
        case 'Translator':
        case 'Translators':
          if (!novel.author) novel.author = detail.text().trim();
          break;
        case 'Status':
        case 'Novel':
        case 'Estado':
        case 'Durum':
          novel.status =
            detail.text().trim().includes('OnGoing') ||
            detail.text().trim().includes('مستمرة')
              ? NovelStatus.Ongoing
              : NovelStatus.Completed;
          break;
        case 'Artist(s)':
          novel.artist = detail.text().trim();
          break;
      }
    });

    // Checks for "Madara NovelHub" version
    {
      if (!novel.genres)
        novel.genres = loadedCheerio('.genres-content').text().trim();
      if (!novel.status)
        novel.status = loadedCheerio('.manga-status')
          .text()
          .trim()
          .includes('OnGoing')
          ? NovelStatus.Ongoing
          : NovelStatus.Completed;
      if (!novel.author)
        novel.author = loadedCheerio('.manga-author a').text().trim();
      if (!novel.rating)
        novel.rating = parseFloat(
          loadedCheerio('.post-rating span').text().trim(),
        );
    }

    if (!novel.author)
      novel.author = loadedCheerio('.manga-authors').text().trim();

    loadedCheerio('div.summary__content .code-block,script,noscript').remove();
    novel.summary =
      this.translateDragontea(loadedCheerio('div.summary__content'))
        .text()
        .trim() ||
      loadedCheerio('#tab-manga-about').text().trim() ||
      loadedCheerio('.post-content_item h5:contains("Summary")')
        .next()
        .find('span')
        .map((i, el) => loadedCheerio(el).text())
        .get()
        .join('\n\n')
        .trim() ||
      loadedCheerio('.post-content_item h5:contains("Summary")')
        .next()
        .find('p')
        .map((i, el) => loadedCheerio(el).text())
        .get()
        .join('\n\n')
        .trim() ||
      loadedCheerio('.manga-summary p')
        .map((i, el) => loadedCheerio(el).text())
        .get()
        .join('\n\n')
        .trim() ||
      loadedCheerio('.manga-excerpt p')
        .map((i, el) => loadedCheerio(el).text())
        .get()
        .join('\n\n')
        .trim();
    const chapters: Plugin.ChapterItem[] = [];
    let html = '';

    if (this.options?.useNewChapterEndpoint) {
      html = await fetchApi(this.site + novelPath + 'ajax/chapters/', {
        method: 'POST',
        referrer: this.site + novelPath,
      }).then((res: Response) => res.text());

      const $firstPage = parseHTML(html);
      const pageLinks = $firstPage('.pagination a[data-page]');
      if (pageLinks.length > 0) {
        const maxPage = Math.max(
          ...pageLinks
            .map((_, el) =>
              parseInt($firstPage(el).attr('data-page') || '1', 10),
            )
            .get(),
        );
        const lastHref = pageLinks.last().attr('href') || '';
        const queryIndex = lastHref.indexOf('?');
        if (queryIndex !== -1) {
          const queryTemplate = lastHref.slice(queryIndex).replace(/\d+$/, '');
          for (let page = 2; page <= maxPage; page++) {
            const pageHtml = await fetchApi(
              this.site + novelPath + 'ajax/chapters/' + queryTemplate + page,
              { method: 'POST', referrer: this.site + novelPath },
            ).then((res: Response) => res.text());
            if (pageHtml && pageHtml !== '0') html += pageHtml;
          }
        }
      }
    } else {
      const novelId =
        loadedCheerio('.rating-post-id').attr('value') ||
        loadedCheerio('#manga-chapters-holder').attr('data-id') ||
        '';

      const formData = new FormData();
      formData.append('action', 'manga_get_chapters');
      formData.append('manga', novelId);

      html = await fetchApi(this.site + 'wp-admin/admin-ajax.php', {
        method: 'POST',
        body: formData,
      }).then((res: Response) => res.text());
    }

    if (html !== '0') {
      loadedCheerio = parseHTML(html);
    }

    const totalChapters = loadedCheerio('.wp-manga-chapter').length;
    const listLocked = Boolean(this.options?.listLockedChapters);
    const lockedRows: LockedChapterRow[] = [];
    const freePaths = new Set<string>();
    loadedCheerio('.wp-manga-chapter').each((chapterIndex, element) => {
      const chapterLink = loadedCheerio(element).find('a');
      const chapterText = chapterLink.text().trim();
      let chapterName = chapterText;
      const locked = element.attribs['class'].includes('premium-block');
      if (locked) {
        chapterName = '🔒 ' + chapterName;
      }

      const releaseText = loadedCheerio(element)
        .find('span.chapter-release-date')
        .text()
        .trim();

      let releaseDate = releaseText
        ? this.parseData(releaseText)
        : dayjs().format('LL');

      // Locked rows count down to becoming free ("Unlocked in 4 weeks") or
      // say "TBA" instead of carrying a release date, so parseData's backwards
      // subtraction would claim a past date. Only sources that opt in to
      // listing their locked chapters take this path.
      if (locked && listLocked) {
        releaseDate = this.parseUnlockDate(releaseText);
      }

      const chapterUrl = chapterLink.attr('href') || '';

      // Coin-locked rows link to "#" because their body is server-gated behind
      // login + coins. Rebuild their /chapter-<n>/ URL so the reader's prev/next
      // steps through them instead of silently skipping them, and label the
      // price + unlock state in the name.
      if (locked && listLocked && (!chapterUrl || chapterUrl === '#')) {
        if (this.hideLocked) return;
        const path = this.deriveLockedChapterPath(novelPath, chapterText);
        if (!path) return;
        const row: LockedChapterRow = {
          name:
            chapterName +
            this.describeLockedState(element.attribs['class'], releaseText),
          path,
          releaseTime: releaseDate,
          chapterNumber: totalChapters - chapterIndex,
          chapterId:
            (element.attribs['class'].match(/data-chapter-(\d+)/) || [])[1] ||
            null,
        };
        chapters.push(row);
        lockedRows.push(row);
        return;
      }

      if (chapterUrl && chapterUrl != '#' && !(locked && this.hideLocked)) {
        const path = chapterUrl.replace(/https?:\/\/.*?\//, '');
        if (!locked) freePaths.add(this.canonicalPath(path));
        chapters.push({
          name: chapterName,
          path,
          releaseTime: releaseDate || null,
          chapterNumber: totalChapters - chapterIndex,
        });
      }
    });

    // A rebuilt URL can collide with another row (duplicate chapter numbers)
    // or - in principle - with a free chapter's real URL. Drop the rows that
    // would not be the page the site actually serves there, so a locked entry
    // can never resolve to different prose than its name claims.
    if (listLocked && lockedRows.length > 0) {
      const drop = await this.findUnresolvableLockedRows(lockedRows, freePaths);
      if (drop.size > 0) {
        const kept = chapters.filter(chapter => !drop.has(chapter));
        chapters.length = 0;
        chapters.push(...kept);
      }
    }

    novel.chapters = chapters.reverse();
    return novel;
  }

  /**
   * Coin-locked rows have no href ("#"), so the chapter number in their title
   * is the only route to them: the site serves them at <series>/chapter-<n>/.
   * Verified against the real hrefs of 3289 free rows on the live site, where
   * 3271 match this rule exactly and the remaining 18 differ only by
   * percent-encoding case (or carry a WordPress `_1` duplicate suffix).
   *
   * A non-ASCII token directly after the number belongs to the post slug
   * ("Chapter 176 🔞" -> chapter-176-%F0%9F%94%9E); a " - title" suffix does
   * not ("Chapter 242 - 🔞" -> chapter-242). Dotted numbers become dashes
   * ("Chapter 27.2" -> chapter-27-2). Returns null when the title carries no
   * chapter number, so such a row is skipped rather than guessed.
   */
  deriveLockedChapterPath(
    novelPath: string,
    chapterText: string,
  ): string | null {
    const chapterNumber = chapterText.match(/chapter\s*([0-9]+(?:\.[0-9]+)?)/i);
    if (!chapterNumber) return null;

    const rest = chapterText
      .slice((chapterNumber.index || 0) + chapterNumber[0].length)
      .replace(/^\s+/, '');
    const codePoint = rest.codePointAt(0);
    const slugSuffix =
      codePoint && codePoint > 0x7f
        ? '-' + encodeURIComponent(String.fromCodePoint(codePoint))
        : '';

    return `${novelPath.replace(/\/?$/, '/')}chapter-${chapterNumber[1].replace(
      '.',
      '-',
    )}${slugSuffix}/`;
  }

  /** Compare chapter paths ignoring the trailing slash and percent-encoding case. */
  canonicalPath(path: string): string {
    return path
      .replace(/\/$/, '')
      .replace(/%[0-9a-f]{2}/gi, match => match.toUpperCase());
  }

  /**
   * "Unlocked in 4 weeks" names the date the chapter becomes free; "TBA" has
   * no date at all. Returns a YYYY-MM-DD date or null, never the literal "LL"
   * that dayjs().format('LL') produces without the localizedFormat plugin.
   */
  parseUnlockDate(releaseText: string): string | null {
    const match = releaseText.match(
      /unlocked\s+in\s+(\d+)\s*(hour|day|week|month|year)/i,
    );
    if (!match) return null;

    const amount = parseInt(match[1], 10);
    const unit = match[2].toLowerCase();

    if (unit.startsWith('hour'))
      return dayjs().add(amount, 'hour').format('YYYY-MM-DD');
    if (unit.startsWith('day'))
      return dayjs().add(amount, 'day').format('YYYY-MM-DD');
    if (unit.startsWith('week'))
      return dayjs().add(amount, 'week').format('YYYY-MM-DD');
    if (unit.startsWith('month'))
      return dayjs().add(amount, 'month').format('YYYY-MM-DD');
    return dayjs().add(amount, 'year').format('YYYY-MM-DD');
  }

  /** Label a locked row with its coin price and unlock state. */
  describeLockedState(rowClass: string, releaseText: string): string {
    const price = rowClass.match(/coin-(\d+)/)?.[1];
    const countdown = releaseText.match(
      /unlocked\s+in\s+(\d+)\s*(hour|day|week|month|year)/i,
    );
    let state = 'locked';
    if (/^tba$/i.test(releaseText)) {
      state = 'TBA';
    } else if (countdown) {
      const amount = parseInt(countdown[1], 10);
      state = `${amount} ${countdown[2].toLowerCase()}${amount === 1 ? '' : 's'}`;
    }
    if (!price) return ` (${state})`;
    return ` (${price} coins, ${state})`;
  }

  /**
   * Read the series chapter list and return its rows, including the locked ones
   * that carry no href. Used to identify the exact post a gated page belongs to
   * (id, title, price, unlock countdown).
   */
  async fetchSeriesChapterRows(
    novelPath: string,
  ): Promise<SeriesChapterRow[] | null> {
    try {
      const html = await fetchApi(this.site + novelPath + 'ajax/chapters/', {
        method: 'POST',
        referrer: this.site + novelPath,
      }).then((res: Response) => res.text());
      const loadedCheerio = parseHTML(html);
      const rows: SeriesChapterRow[] = [];
      loadedCheerio('.wp-manga-chapter').each((_, element) => {
        const rowClass = element.attribs['class'] || '';
        const premium = rowClass.includes('premium-block');
        const text = loadedCheerio(element).find('a').text().trim();
        const href = loadedCheerio(element).find('a').attr('href') || '';
        const path =
          premium || !href || href === '#'
            ? this.deriveLockedChapterPath(novelPath, text)
            : href.replace(/https?:\/\/.*?\//, '');
        rows.push({
          text,
          release:
            loadedCheerio(element)
              .find('span.chapter-release-date')
              .text()
              .trim() ||
            loadedCheerio(element)
              .find('span.chapter-release-date a.c-new-tag')
              .attr('title') ||
            '',
          coin: rowClass.match(/coin-(\d+)/)?.[1] || null,
          chapterId: rowClass.match(/data-chapter-(\d+)/)?.[1] || null,
          premium,
          path,
        });
      });
      return rows;
    } catch {
      return null;
    }
  }

  /**
   * A rebuilt URL that belongs to more than one row (duplicate chapter
   * numbers) or to a free chapter is not safe to list as-is. Ask the site which
   * post the URL really serves and keep only the row that owns it; when the
   * answer cannot be obtained, drop the rows rather than list a wrong URL.
   */
  async findUnresolvableLockedRows(
    rows: LockedChapterRow[],
    freePaths: Set<string>,
  ): Promise<Set<Plugin.ChapterItem>> {
    const drop = new Set<Plugin.ChapterItem>();
    const byPath = new Map<string, LockedChapterRow[]>();
    for (const row of rows) {
      const key = this.canonicalPath(row.path);
      const group = byPath.get(key);
      if (group) group.push(row);
      else byPath.set(key, [row]);
    }

    for (const [path, group] of byPath) {
      if (freePaths.has(path)) {
        group.forEach(row => drop.add(row));
        continue;
      }
      if (group.length === 1) continue;

      const novelPath = group[0].path.replace(/chapter-[^/]+\/?$/i, '');
      const seriesRows = await this.fetchSeriesChapterRows(novelPath);
      const ownerId = seriesRows
        ?.map(row =>
          row.chapterId && row.path && this.canonicalPath(row.path) === path
            ? row.chapterId
            : null,
        )
        .find(id => id);
      group.forEach(row => {
        if (!ownerId || row.chapterId !== ownerId) drop.add(row);
      });
    }

    return drop;
  }

  /**
   * Locked chapter pages answer HTTP 200 but replace the body with a lock
   * notice, and a rebuilt URL that does not exist renders the series page with
   * HTTP 200. Return an honest message (price, unlock schedule, which post the
   * address really serves) instead of the empty string the normal content
   * selectors would return.
   */
  async describeLockedChapter(
    loadedCheerio: CheerioAPI,
    chapterPath: string,
  ): Promise<string | null> {
    const gate = loadedCheerio(
      '.reading-content .content-blocked, .reading-content .premium-block',
    );

    if (gate.length > 0) {
      // An entitled page keeps the (hidden) gate block next to the prose, so
      // only call a page locked when the reading body has no prose of its own.
      const prose = loadedCheerio(
        '.reading-content .text-left, .reading-content .text-right',
      )
        .clone()
        .find('.content-blocked, .premium-block')
        .remove()
        .end()
        .text()
        .replace(/\s+/g, ' ')
        .trim();
      if (prose.length < MIN_PROSE_LENGTH) {
        return await this.lockedChapterNotice(loadedCheerio, chapterPath, gate);
      }
    }

    if (
      loadedCheerio('.reading-content').length === 0 ||
      loadedCheerio('#wp-manga-current-chap').length === 0
    ) {
      return `<p>🔒 This chapter could not be loaded from ${this.name}.</p><p>The site has no readable page at this address - it may be locked, renamed, or moved. Open the chapter on ${this.name} to check it.</p>`;
    }

    return null;
  }

  /** Build the locked-chapter message shown in the reader. */
  async lockedChapterNotice(
    loadedCheerio: CheerioAPI,
    chapterPath: string,
    gate: Cheerio<AnyNode>,
  ): Promise<string> {
    const pageId =
      loadedCheerio('#wp-manga-current-chap').attr('data-id') || '';
    const gatePrice =
      gate
        .first()
        .attr('class')
        ?.match(/coin-(\d+)/)?.[1] || null;

    const novelPath = chapterPath.replace(/chapter-[^/]+\/?$/i, '');
    let rowText = '';
    let releaseText = '';
    let price = gatePrice;
    let resolvesTo = '';

    if (pageId && novelPath && novelPath !== chapterPath) {
      const seriesRows = await this.fetchSeriesChapterRows(novelPath);
      if (seriesRows) {
        const canonical = this.canonicalPath(chapterPath);
        const listedRows = seriesRows.filter(
          row => row.path && this.canonicalPath(row.path) === canonical,
        );
        const pageRow =
          seriesRows.find(row => row.chapterId === pageId) || listedRows[0];
        if (pageRow) {
          rowText = pageRow.text;
          releaseText = pageRow.release;
          price = pageRow.coin || price;
        }
        // Only warn about a mismatched post when the rows listed for this path
        // carry ids of their own (free rows have no id in the markup).
        const listedIds = listedRows.map(row => row.chapterId).filter(Boolean);
        if (pageRow && listedIds.length > 0 && !listedIds.includes(pageId)) {
          resolvesTo = pageRow.text;
        }
      }
    }

    let notice = `<p>🔒 This chapter is locked on ${this.name}.</p>`;
    if (price) {
      notice += `<p>${rowText || 'It'} costs ${price} coins to unlock.</p>`;
    } else if (rowText) {
      notice += `<p>${rowText} is locked.</p>`;
    }
    if (/^tba$/i.test(releaseText)) {
      notice += '<p>Its free-unlock date is TBA.</p>';
    } else if (
      /unlocked\s+in\s+\d+\s*(hour|day|week|month|year)/i.test(releaseText)
    ) {
      notice += `<p>It unlocks for free ${releaseText
        .replace(/^unlocked\s+in/i, 'in')
        .toLowerCase()}.</p>`;
    } else if (releaseText) {
      notice += `<p>The site lists this chapter as released (${releaseText}) but still serves it locked.</p>`;
    } else if (rowText) {
      notice +=
        '<p>The site lists this chapter as released but still serves it locked.</p>';
    }
    if (resolvesTo) {
      notice += `<p>Note: this address currently serves "${resolvesTo}" on the site.</p>`;
    }
    notice += `<p>${this.name} releases locked chapters for free on a schedule; this chapter will read normally once it is free.</p>`;
    return notice;
  }

  async parseChapter(chapterPath: string): Promise<string> {
    const loadedCheerio = await this.getCheerio(this.site + chapterPath, false);

    if (this.options?.listLockedChapters) {
      const lockedNotice = await this.describeLockedChapter(
        loadedCheerio,
        chapterPath,
      );
      if (lockedNotice) return lockedNotice;
    }

    const chapterText =
      loadedCheerio('.text-left') ||
      loadedCheerio('.text-right') ||
      loadedCheerio('.entry-content') ||
      loadedCheerio('.c-blog-post > div > div:nth-child(2)');

    if (this.options?.customJs) {
      try {
        // CustomJS HERE
      } catch (error) {
        console.error('Error executing customJs:', error);
        throw error;
      }
    }

    return this.translateDragontea(chapterText).html() || '';
  }

  async searchNovels(
    searchTerm: string,
    pageNo?: number | undefined,
  ): Promise<Plugin.NovelItem[]> {
    const url =
      this.site +
      '/page/' +
      pageNo +
      '/?s=' +
      encodeURIComponent(searchTerm) +
      '&post_type=wp-manga';
    const loadedCheerio = await this.getCheerio(url, true);
    return this.parseNovels(loadedCheerio);
  }

  parseData = (date: string) => {
    let dayJSDate = dayjs(); // today
    const timeAgo = date.match(/\d+/)?.[0] || '';
    const timeAgoInt = parseInt(timeAgo, 10);

    if (!timeAgo) return date; // there is no number!

    if (includesAny(date, ['detik', 'segundo', 'second', 'วินาที'])) {
      dayJSDate = dayJSDate.subtract(timeAgoInt, 'second'); // go back N seconds
    } else if (
      includesAny(date, [
        'menit',
        'dakika',
        'min',
        'minute',
        'minuto',
        'นาที',
        'دقائق',
      ])
    ) {
      dayJSDate = dayJSDate.subtract(timeAgoInt, 'minute'); // go back N minute
    } else if (
      includesAny(date, [
        'jam',
        'saat',
        'heure',
        'hora',
        'hour',
        'ชั่วโมง',
        'giờ',
        'ore',
        'ساعة',
        '小时',
      ])
    ) {
      dayJSDate = dayJSDate.subtract(timeAgoInt, 'hours'); // go back N hours
    } else if (
      includesAny(date, [
        'hari',
        'gün',
        'jour',
        'día',
        'dia',
        'day',
        'วัน',
        'ngày',
        'giorni',
        'أيام',
        '天',
      ])
    ) {
      dayJSDate = dayJSDate.subtract(timeAgoInt, 'days'); // go back N days
    } else if (includesAny(date, ['week', 'semana'])) {
      dayJSDate = dayJSDate.subtract(timeAgoInt, 'week'); // go back N a week
    } else if (includesAny(date, ['month', 'mes'])) {
      dayJSDate = dayJSDate.subtract(timeAgoInt, 'month'); // go back N months
    } else if (includesAny(date, ['year', 'año'])) {
      dayJSDate = dayJSDate.subtract(timeAgoInt, 'year'); // go back N years
    } else {
      if (dayjs(date).format('LL') !== 'Invalid Date') {
        return dayjs(date).format('LL');
      }
      return date;
    }

    return dayJSDate.format('LL');
  };
}
