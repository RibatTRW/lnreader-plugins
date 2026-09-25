import { load as parseHTML } from 'cheerio';
import { fetchApi } from '@libs/fetch';
import { Plugin } from '@/types/plugin';
import { NovelStatus } from '@libs/novelStatus';

const headers = {
  'User-Agent':
    'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36',
  Referer: 'https://novelping.com/',
  'Accept-Language': 'en-US,en;q=0.9',
};

// Throw on a non-ok response carrying the HTTP status, so a refusal
// surfaces as an error (classified INCONCLUSIVE by the live check)
// instead of parsing into an empty result.
async function fetchSite(url: string) {
  const res = await fetchApi(url, { headers });
  if (!res.ok) {
    throw Object.assign(new Error('Request failed: ' + res.status), {
      status: res.status,
    });
  }
  return res.text();
}

class NovelArrow implements Plugin.PluginBase {
  id = 'novelarrow';
  name = 'Novel Arrow';
  icon = 'src/en/novelarrow/icon.png';
  site = 'https://novelping.com/';
  version = '2.0.0';

  private toPath(href?: string) {
    if (!href) {
      return '';
    }
    try {
      return new URL(href, this.site).pathname.replace(/^\//, '');
    } catch {
      return href.replace(/^\//, '');
    }
  }

  private parseListing(html: string) {
    const $ = parseHTML(html);
    const novels: Plugin.NovelItem[] = [];

    $('.novel-title a').each((i, el) => {
      const name = $(el).text().trim();
      const path = this.toPath($(el).attr('href'));
      const cover = $(el).closest('.row').find('img.cover').attr('src');

      if (name && path) {
        novels.push({
          name,
          cover,
          path,
        });
      }
    });

    return novels;
  }

  async popularNovels(page: number) {
    const url = `${this.site}sort/updates?page=${page}`;
    const result = await fetchSite(url);
    return this.parseListing(result);
  }

  async parseNovel(novelPath: string) {
    // Accept both the previous `novel/<slug>` paths (kept by existing
    // library entries) and the current `book/<slug>` paths, and always
    // request the current route.
    const slug = novelPath
      .replace(/^\//, '')
      .replace(/^(book|novel)\//, '')
      .split('/')[0];
    const canonicalPath = `book/${slug}`;
    // Ensure no double slashes in the URL
    const url = this.site + canonicalPath;
    const result = await fetchSite(url);
    const $ = parseHTML(result);

    const novelId = slug;

    // Get the full summary from the paragraphs inside the description block
    const fullSummary =
      $('#novel-description-content p')
        .map((i, el) => $(el).text().trim())
        .get()
        .join('\n\n') || $('#novel-description-content').text().trim();

    const statusText = (
      $('meta[property="og:novel:status"]').attr('content') || ''
    ).toLowerCase();

    const novel: Plugin.SourceNovel = {
      path: canonicalPath,
      name:
        $('meta[property="og:novel:novel_name"]').attr('content') ||
        $('h3.title').first().text().trim(),
      cover: $('meta[property="og:image"]').attr('content'),
      author: $('meta[property="og:novel:author"]').attr('content'),
      status:
        statusText === 'ongoing' ? NovelStatus.Ongoing : NovelStatus.Completed,
      summary: fullSummary,
      genres: $('meta[property="og:novel:genre"]').attr('content'),
      chapters: [],
    };

    // The chapter list is rendered through an ajax endpoint
    const chaptersUrl = `${this.site}ajax/chapter-archive?novelId=${encodeURIComponent(novelId)}`;
    const chaptersHtml = await fetchSite(chaptersUrl);
    const $$ = parseHTML(chaptersHtml);
    const chapters: Plugin.ChapterItem[] = [];

    $$('li[data-chapter-item]').each((i, el) => {
      const chapterId = $$(el).attr('data-chapter-id');
      const anchor = $$(el).find('a');
      const name = (anchor.attr('title') || anchor.text()).trim();

      if (chapterId && name) {
        chapters.push({
          name,
          path: `book/${novelId}/${chapterId}`,
          releaseTime: null,
        });
      }
    });

    novel.chapters = chapters;

    return novel;
  }

  async parseChapter(chapterPath: string) {
    // Accept the previous `chapter/<slug>/<id>` form as well as the current
    // `book/<slug>/<id>` form.
    const cleanPath = chapterPath.replace(/^\//, '');
    const canonicalChapterPath = cleanPath.startsWith('chapter/')
      ? `book/${cleanPath.replace(/^chapter\//, '')}`
      : cleanPath;
    const result = await fetchSite(this.site + canonicalChapterPath);
    const $ = parseHTML(result);
    const content = $('#chr-content');

    // Strip ad slots injected inside the chapter body
    content.find('.js-ad-slot').remove();

    return content.html() || 'Content not found or premium.';
  }

  async searchNovels(searchTerm: string, page: number) {
    const url = `${this.site}search?keyword=${encodeURIComponent(searchTerm)}&page=${page}`;
    const result = await fetchSite(url);
    return this.parseListing(result);
  }
}

export default new NovelArrow();
