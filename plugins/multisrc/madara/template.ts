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
  /**
   * Sources that publish coin-locked (premium) chapters with `href="#"` but a
   * guessable `/series/<slug>/chapter-<n>/` URL. When enabled, those rows are
   * listed, labelled by lock state and reported honestly by parseChapter
   * instead of being dropped.
   */
  listPremiumChapters?: boolean;
};

type PremiumChapterRow = {
  title: string;
  releaseText: string;
  coins: string;
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
      const rowClass = element.attribs['class'] || '';
      const locked = rowClass.includes('premium-block');
      const chapterTitle = loadedCheerio(element).find('a').text().trim();
      let chapterName = chapterTitle;

      let releaseDate = loadedCheerio(element)
        .find('span.chapter-release-date')
        .text()
        .trim();

      const releaseText = releaseDate;
      if (releaseDate) {
        releaseDate = this.parseData(releaseDate);
      } else {
        releaseDate = dayjs().format('LL');
      }

      let chapterUrl = loadedCheerio(element).find('a').attr('href') || '';

      if (this.options?.listPremiumChapters && locked) {
        // Coin-locked rows have no link; the site serves them from
        // /series/<slug>/chapter-<n>/ and gates the body server-side.
        if (!chapterUrl || chapterUrl === '#') {
          chapterUrl =
            this.premiumChapterUrl(novelPath, chapterTitle) || chapterUrl;
        }
        chapterName +=
          ' ' +
          this.premiumChapterLabel(
            releaseText,
            this.premiumChapterCoins(
              rowClass,
              loadedCheerio(element).find('span.coin').text(),
            ),
          );
        releaseDate = '';
      } else if (locked) {
        chapterName = '🔒 ' + chapterName;
      }

      if (chapterUrl && chapterUrl != '#' && !(locked && this.hideLocked)) {
        chapters.push({
          name: chapterName,
          path: chapterUrl.replace(/https?:\/\/.*?\//, ''),
          releaseTime: releaseDate || null,
          chapterNumber: totalChapters - chapterIndex,
        });
      }
    });

    novel.chapters = chapters.reverse();
    return novel;
  }

  async parseChapter(chapterPath: string): Promise<string> {
    const loadedCheerio = await this.getCheerio(this.site + chapterPath, false);

    if (this.options?.listPremiumChapters) {
      const lockedBlock = loadedCheerio(
        '.reading-content .content-blocked, .reading-content .premium-block',
      ).first();
      if (lockedBlock.length > 0) {
        throw new Error(
          await this.getPremiumChapterError(
            chapterPath,
            loadedCheerio,
            lockedBlock,
          ),
        );
      }
      if (loadedCheerio('#wp-manga-current-chap').length === 0) {
        throw new Error(
          'This chapter could not be found on the site (the URL listed for it may be out of date).',
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

  /**
   * Rebuilds the real (still coin-gated) chapter URL of a premium row from its
   * chapter name, e.g. "Chapter 27.2" -> series/<slug>/chapter-27-2/. A
   * non-ASCII suffix written directly after the number (e.g. the adult marker
   * in "Chapter 176 🔞") is part of the site's slug, while " - Title" suffixes
   * are not.
   */
  premiumChapterUrl(novelPath: string, chapterTitle: string) {
    const match = chapterTitle.match(/(\d+(?:\.\d+)?)(.*)$/);
    if (!match) return '';

    const number = match[1].replace(/\./g, '-');
    const tail = match[2].trim();
    const suffix =
      tail && tail.charCodeAt(0) > 0x7f ? tail.split(/\s+/)[0] : '';
    const slug = novelPath
      .replace(/^https?:\/\/[^/]+/, '')
      .replace(/^\/+|\/+$/g, '');

    return (
      slug +
      '/chapter-' +
      number +
      (suffix ? '-' + encodeURIComponent(suffix) : '') +
      '/'
    );
  }

  premiumChapterCoins(rowClass: string, coinText: string) {
    const price = /coin-(\d+)/.exec(rowClass);
    return price ? price[1] : coinText.replace(/\D/g, '');
  }

  /** "Unlocked in 3 weeks" -> "3 weeks" (undefined for TBA or a plain date). */
  premiumChapterUnlockIn(releaseText: string) {
    const unlock = /unlocked in\s+(.+)/i.exec(releaseText);
    return unlock ? unlock[1].trim() : undefined;
  }

  premiumChapterLabel(releaseText: string, coins: string) {
    const unlockIn = this.premiumChapterUnlockIn(releaseText);
    if (unlockIn) return `[Soon - unlocks in ${unlockIn}]`;
    return coins ? `[Premium - ${coins} coins]` : '[Premium - coin-locked]';
  }

  /** Fail-loud message for a chapter whose body the site gates behind coins. */
  async getPremiumChapterError(
    chapterPath: string,
    loadedCheerio: CheerioAPI,
    lockedBlock: Cheerio<AnyNode>,
  ) {
    const chapterId =
      loadedCheerio('#wp-manga-current-chap').attr('data-id') ||
      /data-chapter-(\d+)/.exec(lockedBlock.attr('class') || '')?.[1] ||
      '';
    let coins = this.premiumChapterCoins(
      lockedBlock.attr('class') || '',
      lockedBlock.find('.coin').text(),
    );
    let title = '';
    let releaseText = '';

    // The locked page looks the same whether the chapter is TBA or has an
    // unlock countdown, so read the state from the series' chapter list.
    const row = await this.getPremiumChapterRow(chapterPath, chapterId);
    if (row) {
      title = row.title;
      releaseText = row.releaseText;
      coins = row.coins || coins;
    }

    const name = title ? `${title} is ` : 'This chapter is ';
    const price = coins ? ` (${coins} coins)` : '';
    const unlockIn = this.premiumChapterUnlockIn(releaseText);

    if (unlockIn) {
      return (
        `${name}a scheduled premium chapter: the site unlocks it for free in ` +
        `${unlockIn}, and it is coin-locked${price} until then. LNReader cannot ` +
        `bypass the site's coin gate - open it on ${this.site} to unlock it with coins.`
      );
    }

    return (
      `${name}a locked premium chapter${price}: its free-unlock date is TBA, ` +
      `and LNReader cannot bypass the site's coin gate - open it on ` +
      `${this.site} to unlock it with coins.`
    );
  }

  async getPremiumChapterRow(
    chapterPath: string,
    chapterId: string,
  ): Promise<PremiumChapterRow | undefined> {
    const parts = chapterPath.split('/').filter(part => part !== '');
    if (!chapterId || parts.length < 3 || parts[0] !== 'series')
      return undefined;

    const seriesPath = parts[0] + '/' + parts[1] + '/';
    try {
      const html = await fetchApi(this.site + seriesPath + 'ajax/chapters/', {
        method: 'POST',
        referrer: this.site + seriesPath,
      }).then((res: Response) => res.text());
      if (!html || html === '0') return undefined;

      const marker = 'data-chapter-' + chapterId;
      const $rows = parseHTML(html);
      let found: PremiumChapterRow | undefined;
      $rows('.wp-manga-chapter').each((index, element) => {
        const rowClass = element.attribs['class'] || '';
        if (found || !rowClass.includes(marker)) return;
        if (!rowClass.includes('premium-block')) return;

        const row = $rows(element);
        found = {
          title: row.find('a').text().replace(/\s+/g, ' ').trim(),
          releaseText: row
            .find('span.chapter-release-date')
            .text()
            .replace(/\s+/g, ' ')
            .trim(),
          coins: this.premiumChapterCoins(rowClass, row.find('.coin').text()),
        };
      });
      return found;
    } catch {
      return undefined;
    }
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
