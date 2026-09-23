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

/**
 * Per-chapter access state for Madara sources that opt in to
 * `listLockedChapters`. `coin-locked` is a locked chapter the source gives no
 * schedule for; `scheduled` is a locked chapter whose listing carries an
 * unlock countdown or `TBA` (i.e. it unlocks for free at some point).
 */
export type MadaraChapterAccess =
  | { state: 'free' }
  | {
      state: 'coin-locked' | 'scheduled';
      coins: number | null;
      unlock: string | null;
      /** The source's own chapter id (`data-chapter-<id>`), when it exposes one. */
      id: string | null;
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
   * Access state of the chapters seen by the last `parseNovel` call, keyed by
   * their (normalized) path. Only used to carry listing-only details such as
   * the unlock countdown into `parseChapter`; the fetched page stays the
   * ground truth for whether a chapter is actually gated.
   */
  lockedChapterAccess = new Map<string, MadaraChapterAccess>();

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

  /**
   * Normalizes a chapter path or URL so `parseNovel` and `parseChapter` agree
   * on the same key.
   */
  static accessKey(path: string): string {
    return path
      .replace(/^https?:\/\/[^/]+\//, '')
      .replace(/^\/+/, '')
      .replace(/\/+$/, '');
  }

  /**
   * Reads Madara's locked-chapter markup (`.premium`, `.premium-block`,
   * `.content-blocked`, `.coin-N`) plus the countdown/`TBA` release text into an
   * explicit access state.
   */
  getChapterAccess(
    className: string,
    chapter: Cheerio<AnyNode>,
    releaseText: string,
  ): MadaraChapterAccess {
    const isLocked =
      /(?:^|\s)(?:premium|premium-block|content-blocked)(?=\s|$)/.test(
        className,
      ) || /(?:^|\s)coin-\d+(?=\s|$)/.test(className);
    if (!isLocked) return { state: 'free' };

    const classCoins = className.match(/(?:^|\s)coin-(\d+)(?=\s|$)/);
    const badgeCoins = chapter.find('span.coin').text().match(/\d+/);
    const coins = classCoins
      ? parseInt(classCoins[1], 10)
      : badgeCoins
        ? parseInt(badgeCoins[0], 10)
        : null;
    const unlock = this.getUnlockSchedule(releaseText);
    const id =
      className.match(/(?:^|\s)data-chapter-(\d+)(?=\s|$)/)?.[1] || null;

    return {
      state: unlock ? 'scheduled' : 'coin-locked',
      coins,
      unlock,
      id,
    };
  }

  /**
   * The release span of a locked chapter holds `TBA` or a countdown such as
   * `Unlocked in 2 weeks` instead of a date.
   */
  getUnlockSchedule(releaseText: string): string | null {
    const text = releaseText.trim();
    const countdown = text.match(/unlock(?:ed|s)?\s+in\s+(.+)/i);
    if (countdown) return `unlocks in ${countdown[1].trim()}`;
    if (/^tba$/i.test(text)) return 'TBA';
    return null;
  }

  /**
   * `scheduled: 12 coins, TBA` - used in the errors below.
   */
  describeChapterAccess(access: MadaraChapterAccess): string {
    if (access.state === 'free') return '';
    const details = [
      access.coins !== null ? `${access.coins} coins` : null,
      access.unlock,
    ].filter(Boolean);
    return `${access.state}${details.length ? `: ${details.join(', ')}` : ''}`;
  }

  /**
   * Apart from the free ones, the chapter name also carries the access state.
   */
  getLockedChapterName(
    chapterName: string,
    access: MadaraChapterAccess,
  ): string {
    if (access.state === 'free') return chapterName;
    const details = [
      access.coins !== null ? `${access.coins} coins` : null,
      access.unlock,
    ].filter(Boolean);
    return details.length
      ? `${chapterName} (${details.join(', ')})`
      : chapterName;
  }

  getLockedChapterError(access: MadaraChapterAccess): string {
    return `This chapter is locked on ${this.name} (${this.describeChapterAccess(
      access,
    )}). Its text is only available after unlocking it on the site.`;
  }

  /**
   * A locked chapter can also be unreachable when the source keeps it under a
   * different permalink than the derived one.
   */
  getWrongChapterPageError(access: MadaraChapterAccess): string {
    return `This chapter is locked on ${this.name} (${this.describeChapterAccess(
      access,
    )}) and its page could not be identified: the source resolves this URL to a different chapter. Its text is only available after unlocking it on the site.`;
  }

  getMissingChapterPageError(chapterPath: string): string {
    return `Could not load this chapter from ${this.name}: ${this.site}${chapterPath} did not return a chapter page. Locked chapters the source keeps under a different URL end up here; unlock them from the series page on the site.`;
  }

  /**
   * Locked chapters are linked as `#` on the source, but their permalink stays
   * derivable from the novel path and the chapter number shown in the list
   * (`series/<slug>/chapter-<n>/`).
   */
  getLockedChapterPath(novelPath: string, chapterName: string): string | null {
    const number = chapterName.match(/chapter\s*([0-9]+(?:\.[0-9]+)?)/i)?.[1];
    if (!number) return null;
    const novel = novelPath.replace(/^\/+/, '').replace(/\/*$/, '/');
    return `${novel}chapter-${number.replace('.', '-')}/`;
  }

  /**
   * Access state straight from the chapter page, which is the page that
   * decides whether the text can be read at all.
   */
  getPageChapterAccess(loadedCheerio: CheerioAPI): MadaraChapterAccess {
    const reading = loadedCheerio('.reading-content');
    if (!reading.length) return { state: 'free' };

    const lock = reading.find('.content-blocked, .premium-block').first();
    if (lock.length) {
      return this.getChapterAccess(lock.attr('class') || '', lock, '');
    }
    if (/this chapter is locked/i.test(reading.text())) {
      return { state: 'coin-locked', coins: null, unlock: null, id: null };
    }
    return { state: 'free' };
  }

  /**
   * Combines the access state read from a listing row with the one read from
   * the fetched page. The page wins on whether the chapter is gated (a chapter
   * can unlock between listing and reading and vice versa); the listing only
   * contributes details the page does not carry, such as the unlock countdown.
   */
  mergeChapterAccess(
    page: MadaraChapterAccess,
    listed: MadaraChapterAccess | undefined,
  ): MadaraChapterAccess {
    if (page.state === 'free' || !listed || listed.state === 'free') {
      return page;
    }
    const unlock = page.unlock ?? listed.unlock;
    return { ...page, state: unlock ? 'scheduled' : 'coin-locked', unlock };
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

    const listLockedChapters = this.options?.listLockedChapters === true;
    if (listLockedChapters) this.lockedChapterAccess.clear();

    const totalChapters = loadedCheerio('.wp-manga-chapter').length;
    loadedCheerio('.wp-manga-chapter').each((chapterIndex, element) => {
      const chapter = loadedCheerio(element);
      const rawChapterName = chapter.find('a').text().trim();
      const className = chapter.attr('class') || '';
      const access: MadaraChapterAccess = listLockedChapters
        ? this.getChapterAccess(
            className,
            chapter,
            chapter.find('span.chapter-release-date').text().trim(),
          )
        : { state: 'free' };
      const locked =
        access.state !== 'free' || className.includes('premium-block');
      let chapterName = locked ? '🔒 ' + rawChapterName : rawChapterName;
      if (access.state !== 'free') {
        chapterName = this.getLockedChapterName(chapterName, access);
      }

      let releaseDate = chapter.find('span.chapter-release-date').text().trim();

      if (releaseDate) {
        releaseDate = this.parseData(releaseDate);
      } else {
        releaseDate = dayjs().format('LL');
      }
      let chapterPath = (chapter.find('a').attr('href') || '').replace(
        /https?:\/\/.*?\//,
        '',
      );

      if (
        listLockedChapters &&
        access.state !== 'free' &&
        chapterPath === '#'
      ) {
        chapterPath =
          this.getLockedChapterPath(novelPath, rawChapterName) || chapterPath;
      }

      if (chapterPath && chapterPath != '#' && !(locked && this.hideLocked)) {
        if (listLockedChapters && access.state !== 'free') {
          const key = MadaraPlugin.accessKey(chapterPath);
          if (this.lockedChapterAccess.has(key)) {
            // Two locked rows can derive the same URL when the source reuses a
            // chapter number; the source resolves that URL to only one of
            // them, and a duplicated path would also collide in the app, so the
            // first row wins and the other chapter is left unlisted.
            return;
          }
          this.lockedChapterAccess.set(key, access);
        }
        chapters.push({
          name: chapterName,
          path: chapterPath,
          // A locked row's countdown/`TBA` is already in its name; parseData
          // would turn "Unlocked in 4 weeks" into a date four weeks in the past.
          releaseTime: access.state === 'free' ? releaseDate || null : null,
          chapterNumber: totalChapters - chapterIndex,
        });
      }
    });

    novel.chapters = chapters.reverse();
    return novel;
  }

  async parseChapter(chapterPath: string): Promise<string> {
    const loadedCheerio = await this.getCheerio(this.site + chapterPath, false);

    if (this.options?.listLockedChapters) {
      const listed = this.lockedChapterAccess.get(
        MadaraPlugin.accessKey(chapterPath),
      );
      const page = this.getPageChapterAccess(loadedCheerio);
      const pageId = loadedCheerio('#wp-manga-current-chap').attr('data-id');

      if (
        listed &&
        listed.state !== 'free' &&
        listed.id &&
        pageId &&
        pageId !== listed.id
      ) {
        throw new Error(this.getWrongChapterPageError(listed));
      }

      const access = this.mergeChapterAccess(page, listed);
      if (access.state !== 'free') {
        throw new Error(this.getLockedChapterError(access));
      }

      if (!loadedCheerio('.reading-content').length) {
        throw new Error(this.getMissingChapterPageError(chapterPath));
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
