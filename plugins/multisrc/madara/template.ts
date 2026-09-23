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
  includeLockedChapters?: boolean;
};

/**
 * A coin-locked chapter the listing links as `#`, remembered by the path this
 * plugin rebuilt for it so `parseChapter` can tell whether the fetched page
 * really is the chapter the URL claims to be.
 */
type RebuiltLockedChapter = {
  rows: { id: string | null; name: string }[];
  coins: string | null;
  unlock: string | null;
};

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

  /**
   * Rebuilt coin-locked chapters from the last `parseNovel`, keyed by their
   * normalized path. Best-effort: it only exists after `parseNovel` has run in
   * this session, and is never required to detect a locked page.
   */
  rebuiltLockedChapters = new Map<string, RebuiltLockedChapter>();

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
    loadedCheerio('.wp-manga-chapter').each((chapterIndex, element) => {
      let chapterName = loadedCheerio(element).find('a').text().trim();
      const locked = element.attribs['class'].includes('premium-block');
      if (locked) {
        chapterName = '🔒 ' + chapterName;
      }

      let releaseDate = loadedCheerio(element)
        .find('span.chapter-release-date')
        .text()
        .trim();

      if (releaseDate) {
        releaseDate = this.parseData(releaseDate);
      } else {
        releaseDate = dayjs().format('LL');
      }

      let chapterUrl = loadedCheerio(element).find('a').attr('href') || '';

      // Coin-locked chapters link to "#" because their body is gated
      // server-side, but the site still serves them at the same
      // /chapter-<number>/ path as free chapters, so rebuild that path from
      // the chapter number to keep them in the list.
      const rebuiltLocked =
        locked &&
        this.options?.includeLockedChapters &&
        (!chapterUrl || chapterUrl == '#');
      const unlockText = rebuiltLocked
        ? loadedCheerio(element).find('span.chapter-release-date').text().trim()
        : '';
      if (rebuiltLocked) {
        chapterUrl = this.getLockedChapterPath(novelPath, chapterName);
        // The row only shows a countdown ("Unlocked in N weeks") or "TBA",
        // never a publication date, so report no release time.
        releaseDate = '';
      }

      if (chapterUrl && chapterUrl != '#' && !(locked && this.hideLocked)) {
        const path = chapterUrl.replace(/https?:\/\/.*?\//, '');
        if (rebuiltLocked) {
          this.rememberLockedChapter(
            path,
            element.attribs['class'] || '',
            chapterName,
            unlockText,
          );
        }
        chapters.push({
          name: chapterName,
          path,
          releaseTime: releaseDate || null,
          chapterNumber: totalChapters - chapterIndex,
        });
      }
    });

    novel.chapters = chapters.reverse();
    return novel;
  }

  /**
   * Locked chapters are linked as `#`, but their permalink is derivable from
   * the novel path and the number the listing shows: `chapter-<n>/`.
   *
   * The listing's anchor text is not uniform: `Chapter 250  - (End of the Side
   * Stories)` and `Chapter 239 - SS-IV. (AU)` drop the title suffix, `Chapter
   * 27.2` becomes `chapter-27-2`, while a non-ASCII token directly after the
   * number (`Chapter 176 🔞`) is part of the site's own slug and must be
   * kept (`chapter-176-%F0%9F%94%9E`). A ` - ` separator means title, not slug.
   */
  getLockedChapterPath(novelPath: string, chapterName: string): string {
    const name = chapterName.replace(/^🔒\s*/, '');
    const match = name.match(/^(?:chapter|ch\.?)\s*(\d+(?:\.\d+)?)([\s\S]*)$/i);
    if (!match) return '';
    const number = match[1].replace('.', '-');
    const token = (match[2] || '').trim().split(/\s+/)[0] || '';
    const suffix =
      token && token.charCodeAt(0) > 0x7f
        ? '-' + encodeURIComponent(token)
        : '';
    const path = novelPath.endsWith('/') ? novelPath : novelPath + '/';
    return path + 'chapter-' + number + suffix + '/';
  }

  /**
   * Paths are compared without a scheme/host, query, fragment or trailing
   * slash so `parseNovel` and `parseChapter` agree on the same key.
   */
  chapterKey(path: string): string {
    const clean = path
      .replace(/^https?:\/\/[^/]+\//, '')
      .replace(/[?#].*$/, '')
      .replace(/^\/+|\/+$/g, '');
    try {
      return decodeURI(clean).toLowerCase();
    } catch (error) {
      return clean.toLowerCase();
    }
  }

  /**
   * Keeps the listing details `parseChapter` cannot see on a locked page: the
   * chapter's own post id (to detect a derived URL that lands on a different
   * chapter) and the unlock countdown, which only exists in the listing row.
   */
  rememberLockedChapter(
    path: string,
    className: string,
    chapterName: string,
    unlockText: string,
  ) {
    if (!path) return;
    const key = this.chapterKey(path);
    const entry = this.rebuiltLockedChapters.get(key) || {
      rows: [],
      coins: null,
      unlock: null,
    };
    entry.rows.push({
      id: className.match(/data-chapter-(\d+)/)?.[1] || null,
      name: chapterName,
    });
    entry.coins = entry.coins || className.match(/coin-(\d+)/)?.[1] || null;
    if (!entry.unlock && unlockText) {
      const countdown = unlockText.match(/unlock(?:ed|s)?\s+in\s+(.+)/i);
      if (countdown)
        entry.unlock = `it unlocks for free in ${countdown[1].trim()}`;
      else if (/^tba$/i.test(unlockText))
        entry.unlock = 'its free-unlock date is TBA';
    }
    this.rebuiltLockedChapters.set(key, entry);
  }

  async parseChapter(chapterPath: string): Promise<string> {
    const loadedCheerio = await this.getCheerio(this.site + chapterPath, false);

    if (this.options?.includeLockedChapters) {
      const readingContent = loadedCheerio('.reading-content');
      const currentChapter = loadedCheerio('#wp-manga-current-chap');
      const pageId = currentChapter.attr('data-id') || '';
      const rebuilt = this.rebuiltLockedChapters.get(
        this.chapterKey(chapterPath),
      );

      // A rebuilt locked URL can land on the series page when the chapter's
      // slug does not match its number. Never return blank content for it.
      if (readingContent.length === 0 || currentChapter.length === 0) {
        throw new Error(
          `Could not load this chapter: ${this.site}${chapterPath} did not return a chapter page. If it is a locked chapter, the source may keep it under a different URL; open it from the series page on the site.`,
        );
      }

      // Two chapters can share a number (the source keeps one of them under a
      // suffixed slug), in which case the derived URL serves the other one.
      // Say so instead of presenting the wrong chapter as this one.
      if (rebuilt && pageId && rebuilt.rows.length > 0) {
        const match = rebuilt.rows.find(row => row.id === pageId);
        if (!match) {
          const actual =
            rebuilt.rows.length === 1 ? rebuilt.rows[0].name : null;
          throw new Error(
            `This URL resolves to a different chapter${actual ? ` (${actual})` : ''} on ${this.name}, not to the chapter it was listed as. The source serves both under the same number; unlock it from the series page on the site.`,
          );
        }
      }

      const lockNotice = readingContent
        .find('.content-blocked, .premium-block')
        .first();
      if (
        lockNotice.length > 0 ||
        /chapter is locked/i.test(readingContent.text())
      ) {
        const pageCoins = (lockNotice.attr('class') || '').match(
          /coin-(\d+)/,
        )?.[1];
        const coins = pageCoins || rebuilt?.coins;
        const details = [
          coins ? `it costs ${coins} coins` : null,
          rebuilt?.unlock || null,
        ].filter(Boolean);
        // When two listed chapters share a number the source serves this URL
        // for exactly one of them; name it so the notice is not misleading.
        const servedAs =
          rebuilt && rebuilt.rows.length > 1 && pageId
            ? rebuilt.rows.find(row => row.id === pageId)?.name
            : null;
        throw new Error(
          `This chapter is locked on ${this.name}${
            details.length ? `: ${details.join(', ')}` : ''
          }${
            servedAs ? ` (the source serves this URL as "${servedAs}")` : ''
          }. Its text is only available after unlocking it with a site account.`,
        );
      }
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
