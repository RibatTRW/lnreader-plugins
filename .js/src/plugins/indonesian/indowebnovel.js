"use strict";
var __awaiter = (this && this.__awaiter) || function (thisArg, _arguments, P, generator) {
    function adopt(value) { return value instanceof P ? value : new P(function (resolve) { resolve(value); }); }
    return new (P || (P = Promise))(function (resolve, reject) {
        function fulfilled(value) { try { step(generator.next(value)); } catch (e) { reject(e); } }
        function rejected(value) { try { step(generator["throw"](value)); } catch (e) { reject(e); } }
        function step(result) { result.done ? resolve(result.value) : adopt(result.value).then(fulfilled, rejected); }
        step((generator = generator.apply(thisArg, _arguments || [])).next());
    });
};
var __generator = (this && this.__generator) || function (thisArg, body) {
    var _ = { label: 0, sent: function() { if (t[0] & 1) throw t[1]; return t[1]; }, trys: [], ops: [] }, f, y, t, g = Object.create((typeof Iterator === "function" ? Iterator : Object).prototype);
    return g.next = verb(0), g["throw"] = verb(1), g["return"] = verb(2), typeof Symbol === "function" && (g[Symbol.iterator] = function() { return this; }), g;
    function verb(n) { return function (v) { return step([n, v]); }; }
    function step(op) {
        if (f) throw new TypeError("Generator is already executing.");
        while (g && (g = 0, op[0] && (_ = 0)), _) try {
            if (f = 1, y && (t = op[0] & 2 ? y["return"] : op[0] ? y["throw"] || ((t = y["return"]) && t.call(y), 0) : y.next) && !(t = t.call(y, op[1])).done) return t;
            if (y = 0, t) op = [op[0] & 2, t.value];
            switch (op[0]) {
                case 0: case 1: t = op; break;
                case 4: _.label++; return { value: op[1], done: false };
                case 5: _.label++; y = op[1]; op = [0]; continue;
                case 7: op = _.ops.pop(); _.trys.pop(); continue;
                default:
                    if (!(t = _.trys, t = t.length > 0 && t[t.length - 1]) && (op[0] === 6 || op[0] === 2)) { _ = 0; continue; }
                    if (op[0] === 3 && (!t || (op[1] > t[0] && op[1] < t[3]))) { _.label = op[1]; break; }
                    if (op[0] === 6 && _.label < t[1]) { _.label = t[1]; t = op; break; }
                    if (t && _.label < t[2]) { _.label = t[2]; _.ops.push(op); break; }
                    if (t[2]) _.ops.pop();
                    _.trys.pop(); continue;
            }
            op = body.call(thisArg, _);
        } catch (e) { op = [6, e]; y = 0; } finally { f = t = 0; }
        if (op[0] & 5) throw op[1]; return { value: op[0] ? op[1] : void 0, done: true };
    }
};
Object.defineProperty(exports, "__esModule", { value: true });
var cheerio_1 = require("cheerio");
var fetch_1 = require("@libs/fetch");
var novelStatus_1 = require("@libs/novelStatus");
// import { Filters, FilterTypes } from '@libs/filterInputs';
var IndoWebNovel = /** @class */ (function () {
    function IndoWebNovel() {
        this.id = 'IDWN.id';
        this.name = 'IndoWebNovel';
        this.icon = 'src/id/indowebnovel/icon.png';
        this.site = 'https://indowebnovel.id/';
        this.version = '1.3.2';
        this.headers = {
            'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
            Accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,*/*;q=0.8',
            'Accept-Language': 'id-ID,id;q=0.9,en-US;q=0.8,en;q=0.7',
            Referer: 'https://indowebnovel.id/',
        };
        // filters = {
        //   status: {
        //     value: '',
        //     label: 'Status',
        //     options: [
        //       { label: 'All', value: '' },
        //       { label: 'Ongoing', value: 'ongoing' },
        //       { label: 'Completed', value: 'completed' },
        //     ],
        //     type: FilterTypes.Picker,
        //   },
        //   type: {
        //     value: '',
        //     label: 'Type',
        //     options: [
        //       { label: 'All', value: '' },
        //       { label: 'Web Novel', value: 'Web+Novel' },
        //       { label: 'Light Novel', value: 'Light+Novel' },
        //     ],
        //     type: FilterTypes.Picker,
        //   },
        //   sort: {
        //     value: 'rating',
        //     label: 'Order By',
        //     options: [
        //       { label: 'A-Z', value: 'title' },
        //       { label: 'Z-A', value: 'titlereverse' },
        //       { label: 'Latest Update', value: 'update' },
        //       { label: 'Latest Added', value: 'latest' },
        //       { label: 'Popular', value: 'popular' },
        //       { label: 'Rating', value: 'rating' },
        //     ],
        //     type: FilterTypes.Picker,
        //   },
        //   lang: {
        //     value: ['china', 'jepang', 'korea', 'unknown'],
        //     label: 'Country',
        //     options: [
        //       { label: 'China', value: 'china' },
        //       { label: 'Jepang', value: 'jepang' },
        //       { label: 'Korea', value: 'korea' },
        //       { label: 'Unknown', value: 'unknown' },
        //     ],
        //     type: FilterTypes.CheckboxGroup,
        //   },
        //   genre: {
        //     value: [],
        //     label: 'Genres',
        //     options: [
        //       { label: 'Action', value: 'action' },
        //       { label: 'Adult', value: 'adult' },
        //       { label: 'Adventure', value: 'adventure' },
        //       { label: 'Comedy', value: 'comedy' },
        //       { label: 'Drama', value: 'drama' },
        //       { label: 'Ecchi', value: 'ecchi' },
        //       { label: 'Fantasy', value: 'fantasy' },
        //       { label: 'Gender Bender', value: 'gender-bender' },
        //       { label: 'Harem', value: 'harem' },
        //       { label: 'Horror', value: 'horror' },
        //       { label: 'Josei', value: 'josei' },
        //       { label: 'Josei', value: 'josei' },
        //       { label: 'Martial Arts', value: 'martial-arts' },
        //       { label: 'Mature', value: 'mature' },
        //       { label: 'Mecha', value: 'mecha' },
        //       { label: 'Mystery', value: 'mystery' },
        //       { label: 'Psychological', value: 'psychological' },
        //       { label: 'Romance', value: 'romance' },
        //       { label: 'School Life', value: 'school-life' },
        //       { label: 'Sci-fi', value: 'sci-fi' },
        //       { label: 'Seinen', value: 'seinen' },
        //       { label: 'Shoujo', value: 'shoujo' },
        //       { label: 'Shounen', value: 'shounen' },
        //       { label: 'Slice of Life', value: 'slice-of-life' },
        //       { label: 'Smut', value: 'smut' },
        //       { label: 'Supernatural', value: 'supernatural' },
        //       { label: 'Tragedy', value: 'tragedy' },
        //       { label: 'Wuxia', value: 'wuxia' },
        //       { label: 'Xianxia', value: 'xianxia' },
        //       { label: 'Xuanhuan', value: 'xuanhuan' },
        //     ],
        //     type: FilterTypes.CheckboxGroup,
        //   },
        // } satisfies Filters;
    }
    IndoWebNovel.prototype.fetchPage = function (url) {
        return __awaiter(this, void 0, void 0, function () {
            var res;
            return __generator(this, function (_a) {
                switch (_a.label) {
                    case 0: return [4 /*yield*/, (0, fetch_1.fetchApi)(url, { headers: this.headers })];
                    case 1:
                        res = _a.sent();
                        if (!res.ok) {
                            throw Object.assign(new Error('Request failed: ' + res.status), {
                                status: res.status,
                            });
                        }
                        return [2 /*return*/, res.text()];
                }
            });
        });
    };
    IndoWebNovel.prototype.parseNovels = function (loadedCheerio) {
        var _this = this;
        var novels = [];
        // The search/paged listing (`page/<n>/?s`) renders `.flexbox2-item`
        // cards, while the front page renders `.flexbox3-item` cards (latest
        // updates) and `.popular .flexbox-item` cards (ranked list). Accept
        // every variant so a listing page never parses to zero novels just
        // because the server returned another listing layout.
        var items = loadedCheerio('.flexbox2-item').length
            ? loadedCheerio('.flexbox2-item')
            : loadedCheerio('.flexbox3-item').length
                ? loadedCheerio('.flexbox3-item')
                : loadedCheerio('.popular .flexbox-item');
        items.each(function (i, el) {
            var item = loadedCheerio(el);
            var novelName = (item.find('.flexbox2-title span').first().text() ||
                item.find('.title a').first().text() ||
                item.find('.flexbox-title').first().text()).trim();
            var novelCover = item.find('img').attr('src');
            var novelUrl = item.find('.flexbox2-content > a').attr('href') ||
                item.find('.flexbox3-content > a').attr('href') ||
                item.find('a').attr('href');
            if (!novelUrl)
                return;
            novels.push({
                name: novelName,
                cover: novelCover,
                path: novelUrl.slice(_this.site.length),
            });
        });
        return novels;
    };
    IndoWebNovel.prototype.popularNovels = function (
    // { filters }: Plugin.PopularNovelsOptions<typeof this.filters>,
    ) {
        return __awaiter(this, arguments, void 0, function (page) {
            var link, body, loadedCheerio;
            if (page === void 0) { page = 1; }
            return __generator(this, function (_a) {
                switch (_a.label) {
                    case 0:
                        link = this.site + "page/".concat(page, "/?s");
                        return [4 /*yield*/, this.fetchPage(link)];
                    case 1:
                        body = _a.sent();
                        loadedCheerio = (0, cheerio_1.load)(body);
                        return [2 /*return*/, this.parseNovels(loadedCheerio)];
                }
            });
        });
    };
    IndoWebNovel.prototype.parseNovel = function (novelPath) {
        return __awaiter(this, void 0, void 0, function () {
            var body, loadedCheerio, novel, chapters;
            var _this = this;
            return __generator(this, function (_a) {
                switch (_a.label) {
                    case 0: return [4 /*yield*/, this.fetchPage(this.site + novelPath)];
                    case 1:
                        body = _a.sent();
                        loadedCheerio = (0, cheerio_1.load)(body);
                        loadedCheerio('.series-synops div').remove();
                        novel = {
                            path: novelPath,
                            name: loadedCheerio('.series-title h2').text().trim() || 'Untitled',
                            cover: loadedCheerio('.series-thumb img').attr('src'),
                            author: loadedCheerio(".series-infolist li:contains('Author') span")
                                .text()
                                .trim(),
                            status: loadedCheerio('.status').text().trim() === 'Completed'
                                ? novelStatus_1.NovelStatus.Completed
                                : novelStatus_1.NovelStatus.Ongoing,
                            summary: loadedCheerio('.series-synops').text().trim(),
                            chapters: [],
                        };
                        novel.genres = loadedCheerio('.series-genres a')
                            .map(function (i, el) { return loadedCheerio(el).text().trim(); })
                            .toArray()
                            .join(',');
                        chapters = [];
                        loadedCheerio('.series-chapterlists li').each(function (i, el) {
                            // The list entry also holds a `span.date`; drop it so the chapter name
                            // does not end with the release date.
                            var chapterName = loadedCheerio(el)
                                .find('a span')
                                .not('.date')
                                .first()
                                .text()
                                .replace(/\s+/g, ' ')
                                .trim();
                            var chapterUrl = loadedCheerio(el).find('a').attr('href');
                            if (!chapterUrl)
                                return;
                            var chapter = {
                                name: chapterName,
                                path: chapterUrl.slice(_this.site.length),
                            };
                            // Each entry also holds a `span.date` like "October 23, 2025".
                            var releaseDate = loadedCheerio(el)
                                .find('span.date')
                                .first()
                                .text()
                                .trim();
                            if (releaseDate && !isNaN(Date.parse(releaseDate))) {
                                chapter.releaseTime = new Date(releaseDate).toISOString();
                            }
                            chapters.push(chapter);
                        });
                        novel.chapters = chapters.reverse();
                        return [2 /*return*/, novel];
                }
            });
        });
    };
    IndoWebNovel.prototype.parseChapter = function (chapterPath) {
        return __awaiter(this, void 0, void 0, function () {
            var body, realTags, safeBody, loadedCheerio, hosts, chapter, i, contentTags, rogue, divs, _i, divs_1, div, node, chapterText;
            return __generator(this, function (_a) {
                switch (_a.label) {
                    case 0: return [4 /*yield*/, this.fetchPage(this.site + chapterPath)];
                    case 1:
                        body = _a.sent();
                        realTags = {
                            a: true,
                            abbr: true,
                            address: true,
                            area: true,
                            article: true,
                            aside: true,
                            audio: true,
                            b: true,
                            base: true,
                            bdi: true,
                            bdo: true,
                            blockquote: true,
                            body: true,
                            br: true,
                            button: true,
                            canvas: true,
                            caption: true,
                            cite: true,
                            code: true,
                            col: true,
                            colgroup: true,
                            data: true,
                            datalist: true,
                            dd: true,
                            del: true,
                            details: true,
                            dfn: true,
                            dialog: true,
                            div: true,
                            dl: true,
                            dt: true,
                            em: true,
                            embed: true,
                            fieldset: true,
                            figcaption: true,
                            figure: true,
                            footer: true,
                            form: true,
                            h1: true,
                            h2: true,
                            h3: true,
                            h4: true,
                            h5: true,
                            h6: true,
                            head: true,
                            header: true,
                            hgroup: true,
                            hr: true,
                            html: true,
                            i: true,
                            iframe: true,
                            img: true,
                            input: true,
                            ins: true,
                            kbd: true,
                            label: true,
                            legend: true,
                            li: true,
                            link: true,
                            main: true,
                            map: true,
                            mark: true,
                            meta: true,
                            meter: true,
                            nav: true,
                            nobr: true,
                            noscript: true,
                            object: true,
                            ol: true,
                            optgroup: true,
                            option: true,
                            output: true,
                            p: true,
                            path: true,
                            picture: true,
                            pre: true,
                            progress: true,
                            q: true,
                            rp: true,
                            rt: true,
                            ruby: true,
                            s: true,
                            samp: true,
                            script: true,
                            search: true,
                            section: true,
                            select: true,
                            small: true,
                            source: true,
                            span: true,
                            strike: true,
                            strong: true,
                            style: true,
                            sub: true,
                            summary: true,
                            sup: true,
                            svg: true,
                            table: true,
                            tbody: true,
                            td: true,
                            template: true,
                            textarea: true,
                            tfoot: true,
                            th: true,
                            thead: true,
                            time: true,
                            title: true,
                            tr: true,
                            track: true,
                            tt: true,
                            u: true,
                            ul: true,
                            var: true,
                            video: true,
                            wbr: true,
                        };
                        safeBody = body.replace(/<(\/?)([A-Za-z][A-Za-z0-9]*)([^<>\n]*>)/g, function (match, slash, name, rest) {
                            if (realTags[name.toLowerCase()])
                                return match;
                            var inner = slash + name + rest.slice(0, -1);
                            // A clean tag shape (lowercase token words only) is a site token,
                            // left for the parser and the unwrap below.
                            if (/^\/?[a-z][a-z0-9]*(?: [a-z][a-z0-9]*)*\/?$/.test(inner)) {
                                return match;
                            }
                            return '&lt;' + inner + '&gt;';
                        });
                        loadedCheerio = (0, cheerio_1.load)(safeBody);
                        hosts = [
                            'main #content',
                            'main #nr-nv-content',
                            'main .entry-content',
                            'main .text-left',
                            'main .tldariinggrissendiribrojangancopy',
                        ];
                        chapter = loadedCheerio(hosts[0]);
                        for (i = 1; i < hosts.length; i++) {
                            if (chapter.length && (chapter.html() || '').trim())
                                break;
                            chapter = loadedCheerio(hosts[i]);
                        }
                        if (!chapter.length || !(chapter.html() || '').trim()) {
                            // Fail loudly so a future template change reports instead of
                            // pretending success with an empty chapter, mirroring how refused
                            // responses throw above.
                            throw Object.assign(new Error('IndoWebNovel: no readable chapter body found: ' + chapterPath), { status: 200 });
                        }
                        // Scripts and styles are never story content, and their raw `<`/`&`
                        // characters are not valid XHTML, so drop them.
                        chapter.find('script, style').remove();
                        // Drop hidden elements (audio payloads, overlay containers): they are
                        // never visible story content in a static reader. Match complete zero
                        // values only: a prefix match would delete visible elements styled
                        // e.g. `opacity: 0.5` or `font-size: 0.9em`.
                        chapter.find('[style]').each(function (_, el) {
                            var style = loadedCheerio(el).attr('style') || '';
                            if (/display\s*:\s*none|visibility\s*:\s*hidden|opacity\s*:\s*0(?=\s*(?:;|$|!))|font-size\s*:\s*0(?:px|em|rem)?(?=\s*(?:;|$|!))/i.test(style)) {
                                loadedCheerio(el).remove();
                            }
                        });
                        contentTags = 'a, abbr, b, big, blockquote, br, center, cite, code, dd, del, dfn, ' +
                            'div, dl, dt, em, figcaption, figure, font, h1, h2, h3, h4, h5, h6, hr, ' +
                            'i, img, ins, kbd, li, mark, ol, p, pre, q, s, samp, small, source, ' +
                            'span, strike, strong, sub, sup, table, tbody, td, tfoot, th, thead, ' +
                            'tr, tt, u, ul, var, wbr';
                        rogue = chapter.find('*').not(contentTags);
                        while (rogue.length) {
                            rogue.each(function (_, el) {
                                var node = loadedCheerio(el);
                                node.replaceWith(node.html() || '');
                            });
                            rogue = chapter.find('*').not(contentTags);
                        }
                        divs = chapter.find('div').toArray().reverse();
                        for (_i = 0, divs_1 = divs; _i < divs_1.length; _i++) {
                            div = divs_1[_i];
                            node = loadedCheerio(div);
                            if (!node.children().length && !node.text().trim())
                                node.remove();
                        }
                        chapter.find('*').each(function (_, el) {
                            var attribs = el.attribs || {};
                            Object.keys(attribs).forEach(function (name) {
                                // Drop attributes with invalid XML names, and attributes with
                                // empty values: downstream serializers emit those bare, which is
                                // not well-formed XML (e.g. a valueless `data-*` reader widget
                                // attribute). An empty attribute value carries no information.
                                if (attribs[name] === '' ||
                                    !/^[A-Za-z_:][A-Za-z0-9_.:-]*$/.test(name)) {
                                    loadedCheerio(el).removeAttr(name);
                                }
                            });
                        });
                        chapterText = chapter.html() || '';
                        if (!chapterText.trim()) {
                            throw Object.assign(new Error('IndoWebNovel: chapter body empty after cleanup: ' + chapterPath), { status: 200 });
                        }
                        return [2 /*return*/, chapterText];
                }
            });
        });
    };
    IndoWebNovel.prototype.searchNovels = function (searchTerm_1) {
        return __awaiter(this, arguments, void 0, function (searchTerm, page) {
            var link, body, loadedCheerio;
            if (page === void 0) { page = 1; }
            return __generator(this, function (_a) {
                switch (_a.label) {
                    case 0:
                        link = this.site + "page/".concat(page, "/?s=").concat(searchTerm);
                        return [4 /*yield*/, this.fetchPage(link)];
                    case 1:
                        body = _a.sent();
                        loadedCheerio = (0, cheerio_1.load)(body);
                        return [2 /*return*/, this.parseNovels(loadedCheerio)];
                }
            });
        });
    };
    return IndoWebNovel;
}());
exports.default = new IndoWebNovel();
