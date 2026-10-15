import { fetchApi } from '@libs/fetch';
import { Plugin } from '@/types/plugin';
import { FilterTypes } from '@libs/filterInputs';
import { CheerioAPI, load as loadCheerio } from 'cheerio';
import { defaultCover } from '@libs/defaultCover';

/**
 * Notes on the site (onlinereadfreenovel.com):
 * - Listing: `/allbooks/` and `/gr/<genre>/` list books as `article.box`
 *   items (`h2.title a` + preview image); further pages are `/p/<n>/`.
 * - Search: `/search_by_author_title_series/q/<term>` lists `ul.books li a`.
 * - Book: `/<author>/<id>-<slug>_read.html` is page 1 of the text. The text
 *   is split across numbered pages, `/<author>/p,<n>,<id>-<slug>_read.html`.
 *   Each page is a plugin "chapter". The site has no chapter list, so the
 *   pages are walked until one has no next link.
 * - Some pages are served empty (e.g. page 2 of some books); those are skipped
 *   rather than listed as empty chapters.
 */

// Upper bound on text pages walked per book. Every page is one sequential
// request made before the novel detail returns, so the cap keeps a single
// book from issuing an unbounded number of requests. Books longer than this
// are truncated, and parsePages logs a warning when it hits the cap.
const MAX_PAGES = 300;

class OnlineReadFreeNovelPlugin implements Plugin.PluginBase {
  id = 'onlinereadfreenovel';
  name = 'Online Read Free Novel';
  icon = 'src/en/onlinereadfreenovel/icon.png';
  site = 'https://onlinereadfreenovel.com';
  version = '1.0.0';

  filters = {
    genre: {
      label: 'Genre',
      value: 'all',
      options: [
        { label: 'All', value: 'all' },
        { label: 'Action & Adventure', value: 'actions_adventure' },
        { label: 'Fantasy', value: 'fantasy' },
        { label: 'History & Fiction', value: 'historical_fiction' },
        { label: 'Horror', value: 'horror' },
        { label: 'Humor', value: 'humor' },
        { label: 'Mystery & Detective', value: 'mystery_detective' },
        { label: 'Romance & Love', value: 'romance_love' },
        { label: 'Science Fiction', value: 'science_fiction' },
        { label: 'Thrillers & Crime', value: 'thrillers_crime' },
        { label: 'Western', value: 'western' },
        { label: 'Young Adult', value: 'young_adult' },
      ],
      type: FilterTypes.Picker,
    },
  };

  async popularNovels(
    pageNo: number,
    { filters }: Plugin.PopularNovelsOptions<typeof this.filters>,
  ): Promise<Plugin.NovelItem[]> {
    const genre = filters?.genre?.value || 'all';
    const base = genre === 'all' ? '/allbooks/' : '/gr/' + genre + '/';
    const path = pageNo > 1 ? base + 'p/' + pageNo + '/' : base;
    const $ = await this.fetchDom(path);
    return this.parseBookList($);
  }

  async parseNovel(novelPath: string): Promise<Plugin.SourceNovel> {
    const $ = await this.fetchDom(novelPath);

    const novel: Plugin.SourceNovel = {
      path: novelPath,
      name: $('h1').first().text().trim() || 'Untitled',
      author: $('.box_in > b > a').first().text().trim(),
    };

    const cover = $('#textToRead img').first().attr('src');
    novel.cover = cover ? this.toAbsolute(cover) : defaultCover;

    novel.chapters = await this.parsePages(novelPath, $);
    return novel;
  }

  async parseChapter(chapterPath: string): Promise<string> {
    const $ = await this.fetchDom(chapterPath);
    $('#textToRead').find('img, a.highslide, script, style').remove();

    // The text is one block of `<br>`-separated lines; a run of two or more
    // line breaks marks a paragraph boundary.
    const html = ($('#textToRead').html() || '').replace(/<\/?p[^>]*>/gi, '');
    return html
      .split(/(?:<br\s*\/?>\s*){2,}/i)
      .map(part =>
        part.replace(
          /^(?:<br\s*\/?>|&nbsp;|\u00a0|\s)+|(?:&nbsp;|\u00a0|\s)+$/gi,
          '',
        ),
      )
      .filter(part => part.length > 0)
      .map(part => '<p>' + part + '</p>')
      .join('');
  }

  async searchNovels(
    searchTerm: string,
    pageNo: number,
  ): Promise<Plugin.NovelItem[]> {
    const base =
      '/search_by_author_title_series/q/' + encodeURIComponent(searchTerm);
    const path = pageNo > 1 ? base + '/p/' + pageNo : base;
    const $ = await this.fetchDom(path);

    return $('ul.books li a')
      .toArray()
      .flatMap(el => {
        const item = $(el);
        const href = item.attr('href');
        if (!href) return [];
        const style = item.find('.i1').attr('style') || '';
        const cover = style.match(/url\(["']?([^"')]+)["']?\)/);
        return [
          {
            name: item.find('.h2').attr('title') || item.text().trim(),
            path: this.toPath(href),
            cover: cover ? this.toAbsolute(cover[1]) : defaultCover,
          },
        ];
      });
  }

  resolveUrl = (path: string) => this.site + path;

  parseBookList($: CheerioAPI): Plugin.NovelItem[] {
    return $('article.box')
      .toArray()
      .flatMap(el => {
        const link = $(el).find('h2.title a').first();
        const href = link.attr('href');
        if (!href) return [];
        const src = $(el).find('div.text img').first().attr('src');
        return [
          {
            name: link.text().trim(),
            path: this.toPath(href),
            cover: src ? this.toAbsolute(src) : defaultCover,
          },
        ];
      });
  }

  /**
   * Walks the text pages of a book. Page 1 is the novel path itself; page `n`
   * is `p,<n>,` inserted before the id. Stops at the last page (no next
   * link), or after two empty pages in a row.
   */
  async parsePages(
    novelPath: string,
    firstPage: CheerioAPI,
  ): Promise<Plugin.ChapterItem[]> {
    const chapters: Plugin.ChapterItem[] = [];
    let emptyRun = 0;

    for (let page = 1; page <= MAX_PAGES; page++) {
      const pagePath = this.pagePath(novelPath, page);
      const $ = page === 1 ? firstPage : await this.fetchDom(pagePath);
      const hasText = $('#textToRead').text().trim().length > 0;

      if (hasText) {
        emptyRun = 0;
        chapters.push({
          name: 'Page ' + page,
          path: pagePath,
          chapterNumber: chapters.length + 1,
        });
        if ($('.page_next a').length === 0) return chapters;
      } else if (++emptyRun >= 2) {
        return chapters;
      }
    }

    console.warn(
      `onlinereadfreenovel: stopped at MAX_PAGES (${MAX_PAGES}) for ${novelPath}; remaining pages were not listed`,
    );
    return chapters;
  }

  pagePath(novelPath: string, page: number): string {
    if (page <= 1) return novelPath;
    return novelPath.replace(/\/(\d+-[^/]+_read\.html)$/, '/p,' + page + ',$1');
  }

  async fetchDom(path: string): Promise<CheerioAPI> {
    const res = await fetchApi(this.site + path);
    return loadCheerio(await res.text());
  }

  toPath(href: string): string {
    return new URL(href, this.site).pathname;
  }

  toAbsolute(src: string): string {
    return new URL(src, this.site).href;
  }
}

export default new OnlineReadFreeNovelPlugin();
