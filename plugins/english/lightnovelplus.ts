import { fetchApi } from '@libs/fetch';
import { Plugin } from '@/types/plugin';
import { Filters, FilterTypes } from '@libs/filterInputs';
import { NovelStatus } from '@libs/novelStatus';
import { load as loadCheerio } from 'cheerio';

const PAYLOAD_BATCH = 3;

type ChapterPayload = { chapters: Plugin.ChapterItem[]; totalPages: number };
const MAX_ATTEMPTS = 5;
const ATTEMPT_TIMEOUT_MS = 6000;

class LightNovelPlus implements Plugin.PluginBase {
  id = 'lightnovelplus';
  name = 'LightNovelPlus';
  icon = 'src/en/lightnovelplus/icon.png';
  site = 'https://lightnovelplus.com/';
  version = '3.0.0';

  filters = {
    type: {
      type: FilterTypes.Picker,
      label: 'Novel Listing',
      value: 'hot_novel',
      options: [
        { label: 'Hot Novel', value: 'hot_novel' },
        { label: 'Latest Release', value: 'last_release' },
        { label: 'Completed Novel', value: 'completed_novel' },
      ],
    },
    genre: {
      type: FilterTypes.Picker,
      label: 'Genre (overrides listing)',
      value: '',
      options: [
        { label: 'All', value: '' },
        { label: 'Action', value: '523' },
        { label: 'Adult', value: '540' },
        { label: 'Adventure', value: '116' },
        { label: 'Comedy', value: '522' },
        { label: 'Contemporary Romance', value: '344' },
        { label: 'Drama', value: '538' },
        { label: 'Eastern', value: '534' },
        { label: 'Eastern Fantasy', value: '334' },
        { label: 'Fan-fic', value: '548' },
        { label: 'Fantasy', value: '70' },
        { label: 'Fantasy Romance', value: '134' },
        { label: 'Game', value: '529' },
        { label: 'Harem', value: '517' },
        { label: 'Historical', value: '532' },
        { label: 'Historical Romance', value: '256' },
        { label: 'Horror', value: '545' },
        { label: 'Josei', value: '530' },
        { label: 'LGBT+', value: '182' },
        { label: 'Magical Realism', value: '331' },
        { label: 'Martial Arts', value: '535' },
        { label: 'Mature', value: '547' },
        { label: 'Modern', value: '66' },
        { label: 'Mystery', value: '77' },
        { label: 'Psychological', value: '539' },
        { label: 'Romance', value: '68' },
        { label: 'Sci-fi', value: '75' },
        { label: 'Sci-fi Romance', value: '252' },
        { label: 'School Life', value: '546' },
        { label: 'Seinen', value: '541' },
        { label: 'Shounen', value: '542' },
        { label: 'Slice of Life', value: '537' },
        { label: 'Sports', value: '536' },
        { label: 'Supernatural', value: '544' },
        { label: 'Video Games', value: '243' },
        { label: 'Wuxia', value: '543' },
        { label: 'Xianxia', value: '531' },
        { label: 'Xuanhuan', value: '76' },
        { label: 'Yaoi', value: '533' },
      ],
    },
  } satisfies Filters;

  private async sleep(ms: number) {
    return new Promise(resolve => setTimeout(resolve, ms));
  }

  // The site answers "503 Server is busy" under load and sometimes never
  // answers a request, so give each attempt a deadline and retry.
  private async fetchHtml(url: string): Promise<string> {
    let status = 0;
    for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
      try {
        const response = await Promise.race([
          fetchApi(url),
          this.sleep(ATTEMPT_TIMEOUT_MS).then(() => null),
        ]);
        if (response) {
          status = response.status;
          if (response.ok) return await response.text();
        }
      } catch (error) {
        if (attempt === MAX_ATTEMPTS) throw error;
      }
      if (attempt < MAX_ATTEMPTS) await this.sleep(500 * attempt);
    }
    throw new Error(`LightNovelPlus: HTTP ${status || 'timeout'} for ${url}`);
  }

  // Each detail page ships its chapter list (100 per page) as a Nuxt payload:
  // a flat array where objects and arrays refer to their values by index.
  private async fetchChapterPayload(
    bookId: string,
    page: number,
  ): Promise<ChapterPayload> {
    const suffix = page > 1 ? `/page/${page}` : '';
    const raw = JSON.parse(
      await this.fetchHtml(
        `${this.site}en/detail/${bookId}${suffix}/_payload.json`,
      ),
    );
    const at = (index: number) => raw[index];
    const data = raw.find(
      (entry: unknown) =>
        entry &&
        typeof entry === 'object' &&
        'chapter_list' in (entry as object),
    );
    if (!data) throw new Error('LightNovelPlus: chapter list not found');

    const chapters: Plugin.ChapterItem[] = (at(data.chapter_list) as number[])
      .map(index => at(index))
      .map(item => ({
        id: at(item.id),
        order: at(item.displayOrder),
        title: String(at(item.title)).trim(),
      }))
      .sort((a, b) => a.order - b.order)
      .map(item => ({
        name: `${item.order}: ${item.title}`,
        path: `en/book/${bookId}/${item.id}`,
        releaseTime: null,
        chapterNumber: item.order,
      }));
    return { chapters, totalPages: Number(at(data.total_page)) || 1 };
  }

  private parseNovelList(html: string): Plugin.NovelItem[] {
    const $ = loadCheerio(html);
    const novels: Plugin.NovelItem[] = [];
    const seen = new Set<string>();

    $('.list-truyen h3.truyen-title a[href]').each((_, el) => {
      const href = $(el).attr('href');
      if (!href) return;
      const path = new URL(href, this.site).pathname.substring(1);
      if (seen.has(path)) return;
      seen.add(path);

      const name = ($(el).attr('title') || $(el).text()).trim();
      const cover = $(el).closest('.row').find('img.cover').attr('src');
      if (!name) return;
      novels.push({
        name,
        path,
        cover: cover ? new URL(cover, this.site).href : undefined,
      });
    });
    return novels;
  }

  async popularNovels(
    pageNo: number,
    {
      filters,
      showLatestNovels,
    }: Plugin.PopularNovelsOptions<typeof this.filters>,
  ): Promise<Plugin.NovelItem[]> {
    const params = new URLSearchParams();
    const genre = filters?.genre?.value;
    if (genre) {
      params.set('type', 'category_novel');
      params.set('id', genre);
    } else {
      params.set(
        'type',
        showLatestNovels ? 'last_release' : filters?.type?.value || 'hot_novel',
      );
      params.set('id', '0');
    }
    if (pageNo > 1) params.set('page_num', String(pageNo));

    const html = await this.fetchHtml(`${this.site}en/class?${params}`);
    return this.parseNovelList(html);
  }

  async searchNovels(
    searchTerm: string,
    pageNo: number,
  ): Promise<Plugin.NovelItem[]> {
    const params = new URLSearchParams({ keyword: searchTerm });
    if (pageNo > 1) params.set('page_num', String(pageNo));

    const html = await this.fetchHtml(`${this.site}en/search?${params}`);
    return this.parseNovelList(html);
  }

  async parseNovel(novelPath: string): Promise<Plugin.SourceNovel> {
    const $ = loadCheerio(await this.fetchHtml(this.site + novelPath));

    const name = (
      $('meta[property="og:title"]').attr('content') ||
      $('.books img.detail-cover').attr('alt') ||
      ''
    ).trim();
    if (!name) throw new Error('Missing novel name');

    const novel: Plugin.SourceNovel = { path: novelPath, name, chapters: [] };

    const cover = $('.books img.detail-cover').attr('src');
    if (cover) novel.cover = new URL(cover, this.site).href;

    $('.info > div').each((_, el) => {
      const row = $(el);
      const label = row
        .children('h3')
        .first()
        .text()
        .replace(':', '')
        .trim()
        .toLowerCase();
      const value =
        label === 'author' || label === 'genre'
          ? row.children('a').text().trim()
          : row.children('h3').last().text().trim();

      if (label === 'author') novel.author = value;
      else if (label === 'genre') novel.genres = value;
      else if (label === 'status') {
        const map: Record<string, string> = {
          ongoing: NovelStatus.Ongoing,
          completed: NovelStatus.Completed,
          hiatus: NovelStatus.OnHiatus,
          dropped: NovelStatus.Cancelled,
          cancelled: NovelStatus.Cancelled,
        };
        novel.status = map[value.toLowerCase()] ?? NovelStatus.Unknown;
      }
    });

    const summary = $('.desc-text').first().clone();
    summary.find('a.btn').remove();
    novel.summary = summary.text().trim();

    const bookId = novelPath.match(/detail\/(\d+)/)?.[1];
    const chapters: Plugin.ChapterItem[] = [];
    if (bookId) {
      const first = await this.fetchChapterPayload(bookId, 1);
      chapters.push(...first.chapters);
      for (let start = 2; start <= first.totalPages; start += PAYLOAD_BATCH) {
        const batch: Promise<ChapterPayload>[] = [];
        for (
          let page = start;
          page < start + PAYLOAD_BATCH && page <= first.totalPages;
          page++
        ) {
          batch.push(this.fetchChapterPayload(bookId, page));
        }
        (await Promise.all(batch)).forEach(p => chapters.push(...p.chapters));
      }
    }
    novel.chapters = chapters;

    return novel;
  }

  async parseChapter(chapterPath: string): Promise<string> {
    const html = await this.fetchHtml(this.site + chapterPath);
    const $ = loadCheerio(html);
    const content = $('#chapter-content');
    content.find('script, iframe, ins, .ads, [class*="ads"]').remove();
    content.find('p').each((_, el) => {
      if (!$(el).text().trim() && !$(el).find('img').length) $(el).remove();
    });
    return content.html()?.trim() || '';
  }

  resolveUrl = (path: string) => this.site + path;
}

export default new LightNovelPlus();
