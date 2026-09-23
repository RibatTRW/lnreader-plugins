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
      const chapterElement = loadedCheerio(element);
      const chapterTitle = chapterElement.find('a').text().trim();
      const rowClass = element.attribs['class'] || '';
      let chapterName = chapterTitle;
      const locked = rowClass.includes('premium-block');
      const listLocked = locked && !!this.options?.listLockedChapters;

      let releaseDate = chapterElement
        .find('span.chapter-release-date')
        .text()
        .trim();

      let chapterUrl = chapterElement.find('a').attr('href') || '';

      if (listLocked) {
        // Coin-locked rows link to "#"; rebuild the real (still server-gated)
        // URL and surface the coin price plus the unlock state in the name.
        const coinMatch = rowClass.match(/\bcoin-(\d+)\b/);
        const price =
          coinMatch?.[1] || chapterElement.find('span.coin').text().trim();
        const lockState = releaseDate.replace(/\s+/g, ' ').trim() || 'locked';
        chapterName =
          chapterTitle.replace(/\s+/g, ' ') +
          ` [Premium - ${price ? `${price} coins - ` : ''}${lockState}]`;

        if (!chapterUrl || chapterUrl == '#') {
          const derivedPath = this.parseLockedChapterPath(
            novelPath,
            chapterTitle,
          );
          const chapterId = rowClass.match(/data-chapter-(\d+)/)?.[1];
          chapterUrl = derivedPath
            ? derivedPath + (chapterId ? `?chapter-id=${chapterId}` : '')
            : '';
        }

        // "TBA"/countdown is not a publication date; it is already in the name.
        releaseDate = '';
      } else if (locked) {
        chapterName = '🔒 ' + chapterName;
      }

      if (releaseDate) {
        releaseDate = this.parseData(releaseDate);
      } else if (!listLocked) {
        releaseDate = dayjs().format('LL');
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

  /**
   * Coin-locked chapter rows link to "#", so their real (still server-gated)
   * URL has to be rebuilt from the chapter name. The rule below was measured
   * against the site's own free-row hrefs (3288/3289 exact): a leading
   * "Chapter <number>" is the slug number (dots become dashes), an emoji token
   * right after the number is kept (Chapter 141 🔞 -> chapter-141-%F0%9F%94%9E),
   * while a " - subtitle" suffix is not part of the slug (Chapter 166 - Secret
   * -> chapter-166). Returns null when no number can be read from the name.
   */
  parseLockedChapterPath(
    novelPath: string,
    chapterName: string,
  ): string | null {
    const normalized = chapterName.replace(/\s+/g, ' ').trim();
    const named = /^Chapter\s+(\d+(?:\.\d+)?)\s*(.*)$/i.exec(normalized);
    const number = named?.[1] || normalized.match(/(\d+(?:\.\d+)?)/)?.[1] || '';
    if (!number) return null;

    let suffix = number.replace(/\./g, '-');
    const rest = named?.[2]?.trim() || '';
    if (rest && !rest.startsWith('-')) {
      const token = rest.split(/\s/)[0];
      // Keep an emoji/non-ASCII token that directly follows the number
      // (Chapter 141 🔞 -> chapter-141-%F0%9F%94%9E); ASCII subtitles are not
      // part of the slug.
      if ((token.codePointAt(0) || 0) > 0x7f) {
        suffix += '-' + encodeURIComponent(token);
      }
    }

    return novelPath.replace(/\/?$/, '/') + 'chapter-' + suffix + '/';
  }

  async parseChapter(chapterPath: string): Promise<string> {
    const loadedCheerio = await this.getCheerio(this.site + chapterPath, false);

    if (this.options?.listLockedChapters) {
      const currentChapter = loadedCheerio('#wp-manga-current-chap');
      // A rebuilt /chapter-<n>/ URL can silently fall back to the series page
      // (HTTP 200) when the site's slug differs from the chapter number.
      if (currentChapter.length === 0) {
        throw new Error(
          `Could not find this chapter's page on ${this.name}. The chapter may have moved or its URL may have changed.`,
        );
      }

      // Rebuilt paths carry the listing row's own post id; if the site resolves
      // the URL to a different post (duplicate chapter numbers), say so instead
      // of showing another chapter's notice as if it were this one.
      const expectedId = /[?&]chapter-id=(\d+)/.exec(chapterPath)?.[1];
      const pageId = currentChapter.attr('data-id');
      if (expectedId && pageId && expectedId !== pageId) {
        throw new Error(
          `This chapter could not be located on ${this.name}: its URL resolves to a different chapter (post ${pageId}). The site may have renamed it.`,
        );
      }

      // The site serves locked chapters as HTTP 200 with the body replaced by a
      // lock notice, so fail loudly instead of returning an empty chapter. The
      // price is read from that notice, which also covers rows still listed as
      // free whose page is already gated.
      const readingContent = loadedCheerio('.reading-content');
      const lockBlock = readingContent.find('.content-blocked, .premium-block');
      const hasBodyText =
        readingContent.find('.text-left, .text-right').text().trim().length > 0;
      const lockedNotice =
        !hasBodyText && /this chapter is locked/i.test(readingContent.text());
      if (lockBlock.length > 0 || lockedNotice) {
        const coinMatch = (
          lockBlock.attr('class') ||
          readingContent.find('[class*="coin-"]').attr('class') ||
          ''
        ).match(/\bcoin-(\d+)\b/);
        const price = coinMatch
          ? ` It costs ${coinMatch[1]} coins to unlock.`
          : '';
        throw new Error(
          `This chapter is locked on ${this.name}.${price} It requires a site account and a coin unlock, so its text cannot be shown here.`,
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
