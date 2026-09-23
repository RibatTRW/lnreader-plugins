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
   * List coin-locked chapters even though their rows carry href="#": the site
   * serves them at `<novelPath>chapter-<n>/` (n taken from the row title) and
   * renders a lock notice instead of the body. Also makes parseChapter report
   * locked or unavailable chapters instead of returning an empty chapter.
   */
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
    const lockedChapterPaths = this.options?.listLockedChapters
      ? await this.deriveLockedChapterPaths(loadedCheerio, novelPath)
      : new Map<number, string>();
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

      const chapterUrl = loadedCheerio(element).find('a').attr('href') || '';
      const derivedPath = lockedChapterPaths.get(chapterIndex);
      const chapterPath =
        chapterUrl && chapterUrl != '#'
          ? chapterUrl.replace(/https?:\/\/.*?\//, '')
          : derivedPath || '';

      if (chapterPath && !(locked && this.hideLocked)) {
        chapters.push({
          name: chapterName,
          path: chapterPath,
          // A locked row's date cell is an unlock countdown ("Unlocked in 4
          // weeks" / "TBA"), not the chapter's release date.
          releaseTime: derivedPath ? null : releaseDate || null,
          chapterNumber: totalChapters - chapterIndex,
        });
      }
    });

    novel.chapters = chapters.reverse();
    return novel;
  }

  /**
   * Coin-locked rows carry href="#" in the chapter list, but the site serves
   * them at `<novelPath>chapter-<n>/`, where <n> is the number in the row title.
   * The plain slug is used as-is when the title is exactly "Chapter <n>" and
   * that number is unique in the novel - the site's own free rows confirm the
   * convention (3065/3083 exact; every exception a suffixed, decimal or
   * duplicated title). Any other title (subtitles, emoji, repeated numbers) does
   * not slugify the way it reads, so its candidate slugs are checked against the
   * chapter page's own post id and the row is skipped rather than listed with a
   * URL that serves a different chapter or the series page.
   */
  async deriveLockedChapterPaths(
    loadedCheerio: CheerioAPI,
    novelPath: string,
  ): Promise<Map<number, string>> {
    const rows = loadedCheerio('.wp-manga-chapter').toArray();
    const names = rows.map(row => loadedCheerio(row).find('a').text().trim());
    const numbers = names.map(name => /^chapter\s+(\d+(?:\.\d+)?)/i.exec(name));
    const paths = new Map<number, string>();

    for (let index = 0; index < rows.length; index++) {
      const row = rows[index];
      const rowClass = row.attribs['class'] || '';
      if (!rowClass.includes('premium-block')) continue;
      if ((loadedCheerio(row).find('a').attr('href') || '') !== '#') continue;

      const match = numbers[index];
      if (!match) continue;

      const number = match[1].replace('.', '-');
      const plainSlug = `chapter-${number}`;
      const rest = names[index].slice(match[0].length).trim();
      const unique =
        numbers.filter(other => other && other[1] === match[1]).length === 1;

      if (unique && !rest) {
        paths.set(index, novelPath + plainSlug + '/');
        continue;
      }

      const chapterId = /data-chapter-(\d+)/.exec(rowClass)?.[1];
      if (!chapterId) continue;

      // A trailing marker (e.g. an emoji) is sometimes part of the slug and
      // sometimes not, so both shapes are tried and verified by post id.
      const marker = /[^\u0020-\u007e]+/.exec(rest)?.[0];
      const candidates = marker
        ? [
            plainSlug,
            `${plainSlug}-${encodeURIComponent(marker).toLowerCase()}`,
          ]
        : [plainSlug];

      for (const candidate of candidates) {
        const postId = await this.chapterPostId(novelPath + candidate + '/');
        if (postId === chapterId) {
          paths.set(index, novelPath + candidate + '/');
          break;
        }
      }
    }

    return paths;
  }

  /**
   * Post id of the chapter served at `path`, or null when the site answers with
   * something other than a chapter page (an unknown chapter slug falls back to
   * the series page).
   */
  async chapterPostId(path: string): Promise<string | null> {
    const loadedCheerio = await this.getCheerio(this.site + path, false);
    return loadedCheerio('#wp-manga-current-chap').attr('data-id') || null;
  }

  async parseChapter(chapterPath: string): Promise<string> {
    const loadedCheerio = await this.getCheerio(this.site + chapterPath, false);

    if (this.options?.listLockedChapters) {
      const readingContent = loadedCheerio('.reading-content');
      // The site replaces a coin-locked chapter's body with a lock notice.
      if (
        readingContent.find('.content-blocked').length > 0 ||
        /this chapter is locked/i.test(readingContent.text())
      ) {
        const coins = /coin-(\d+)/.exec(
          readingContent.find('.content-blocked').attr('class') || '',
        )?.[1];
        throw new Error(
          `This chapter is locked on ${this.name} (premium${
            coins ? `, ${coins} coins` : ''
          }). Its text is only served to readers who unlocked it, so it becomes readable here once the site unlocks it.`,
        );
      }

      // An unknown chapter URL falls back to the series page, which has no
      // chapter body: fail loudly instead of returning an empty chapter.
      if (loadedCheerio('#wp-manga-current-chap').length === 0) {
        throw new Error(
          `This chapter is not available on ${this.name} anymore.`,
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
