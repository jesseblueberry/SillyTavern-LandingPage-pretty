import { characters, saveSettingsDebounced, this_chid } from '../../../../../script.js';
import { extension_settings } from '../../../../extensions.js';
import { groups, selected_group } from '../../../../group-chats.js';
import { executeSlashCommands } from '../../../../slash-commands.js';
import * as tagExports from '../../../../tags.js';
import { debounce, delay, isTrueBoolean } from '../../../../utils.js';
import { appReady, debounceAsync, log } from '../index.js';
import { Card } from './Card.js';
import { waitForFrame } from './wait.js';

export class LandingPage {
    /**@type {Card[]}*/ cards = [];
    /**@type {Boolean}*/ isLoadingCards = false;
    /**@type {Object.<'favorites'|'recents'|'search', Card[]>}*/ cardsByCategory = { favorites:[], recents:[], search:[] };
    /**@type {'favorites'|'recents'|'search'}*/ activeCategory = 'favorites';
    /**@type {Map<Card, any>}*/ cardEntries = new Map();
    /**@type {string}*/ searchQuery = '';
    /**@type {Set<string>}*/ selectedTagIds = new Set();
    /**@type {Card[]}*/ searchResults = [];
    /**@type {Array<{id:string, name:string}>}*/ availableTags = [];

    /**@type {Object}*/ settings;

    /**@type {HTMLElement}*/ dom;
    /**@type {HTMLElement}*/ fader;
    /**@type {HTMLVideoElement}*/ video;
    /**@type {HTMLVideoElement}*/ intro;
    /**@type {Boolean}*/ isStartingVideo;

    /**@type {Boolean}*/ isInputting = false;
    /**@type {HTMLElement} */ inputBlocker;
    /**@type {HTMLElement} */ sheld;
    /**@type {HTMLTextAreaElement} */ chatInput;
    // /**@type {String}*/ input = '';
    // /**@type {Number}*/ inputTime = 0;
    // /**@type {HTMLElement}*/ inputDisplayContainer;
    // /**@type {HTMLElement}*/ inputDisplay;
    /**@type {Function}*/ handleInputBound;

    /**@type {Function}*/ updateBackgroundDebounced;

    /**@type {number}*/ cacheBuster;
    /**@type {Promise}*/ bgResultUpdatePromise;
    /**@type {boolean[]}*/ bgResultList = [];
    /**@type {Object.<string,boolean>}*/ videoUrlCache = {};
    /**@type {Object.<string,boolean>}*/ introUrlCache = {};
    /**@type {Object.<string,string>}*/ videoCache = {};

    /**@type {import('./FizzPopCrackle/FPC.js').FPC}*/ fpc;




    constructor() {
        this.settings = Object.assign({
            isEnabled: true,
            displayStyle: 'Bottom',
            cardHeight: 200,
            showFavorites: true,
            onlyFavorites: false,
            highlightFavorites: true,
            numCards: 5,
            numAvatars: 4,
            showExpression: true,
            extensions: ['png'],
            expression: 'joy',
            menuList: [],
            lastChat: { character:null, group:null },
            hideTopBar: true,
            bgList: [],
            activeCategory: 'favorites',
            searchQuery: '',
        }, extension_settings.landingPage ?? {});
        extension_settings.landingPage = this.settings;
        if (this.settings.hideTopBar) {
            document.body.classList.add('stlp--hideTopBar');
        }

        this.handleInputBound = this.handleInput.bind(this);
        this.updateBackgroundDebounced = debounceAsync(async()=>{
            await this.preloadBackgrounds();
            await this.updateBgResultList();
            await this.updateBackground();
        }, 1000);

        this.cacheBuster = new Date().getTime();
        this.updateBgResultList();

        this.sheld = document.querySelector('#sheld');
        this.chatInput = document.querySelector('#send_textarea');
        if (!['favorites', 'recents', 'search'].includes(this.settings.activeCategory)) {
            this.settings.activeCategory = 'favorites';
        }
        this.activeCategory = this.settings.activeCategory;
        this.searchQuery = String(this.settings.searchQuery ?? '');
    }


    async load() {
        log('LandingPage.load');
        const compRecent = (a,b)=>{
            if (this.settings.showFavorites) {
                if (a.char.fav && !b.char.fav) return -1;
                if (!a.char.fav && b.char.fav) return 1;
            }
            return (b.char.date_last_chat ?? 0) - (a.char.date_last_chat ?? 0);
        };
        if (this.settings.numCards > 0) {
            const entries = [...characters, ...groups]
                .filter(it=>!this.settings.onlyFavorites || it.fav)
                .map(char=>({
                    char,
                    card: (()=>{
                        const card = new Card(char);
                        card.onOpenChat = ()=>{
                            this.dom.classList.add('stlp--busy');
                        };
                        return card;
                    })(),
                }));

            const byRecent = entries.toSorted(compRecent);
            const byFavorites = byRecent.filter(it=>it.card.isFavorite);
            this.cardEntries = new Map(entries.map(it=>[it.card, it]));

            this.cardsByCategory = {
                favorites: byFavorites.map(it=>it.card).slice(0, this.settings.numCards),
                recents: byRecent.map(it=>it.card).slice(0, this.settings.numCards),
                search: byRecent.map(it=>it.card),
            };
            this.availableTags = this.getAvailableTags(this.cardsByCategory.search);
            this.updateSearchResults();

            this.cards = this.cardsByCategory[this.activeCategory] ?? [];
        } else {
            this.cards = [];
            this.cardEntries = new Map();
            this.searchResults = [];
            this.availableTags = [];
            this.cardsByCategory = { favorites:[], recents:[], search:[] };
        }
        log('LandingPage.load COMPLETED', this);
    }

    async updateBgResultList() {
        log('LandingPage.updateBgresultList');
        if (this.bgResultUpdatePromise) {
            await this.bgResultUpdatePromise;
            log('LandingPage.updateBgresultList COMPLETED OLD PROMISE');
            return;
        }
        const { promise, resolve } = Promise.withResolvers();
        this.bgResultUpdatePromise = promise;
        this.bgResultList = [];
        for (const item of this.settings.bgList) {
            let val = (await executeSlashCommands(item.command))?.pipe;
            let result;
            try { result = isTrueBoolean(val); } catch { /* empty */ }
            this.bgResultList.push(result);
            if (result) break;
        }
        resolve();
        this.bgResultUpdatePromise = null;
        log('LandingPage.updateBgresultList COMPLETED');
    }

    async preloadBackgrounds() {
        log('LandingPage.preloadBackgrounds');
        await Promise.all(this.settings.bgList.map(async(bg)=>this.preloadMedia(bg.url)));
        log('LandingPage.preloadBackgrounds COMPLETED');
    }
    async preloadMedia(url, intro = false) {
        log('LandingPage.preloadMedia', intro ? 'intro' : '', url);
        if (this.videoCache[url]) return;
        const baseUrl = url;
        try {
            url = `${baseUrl}?t=${this.cacheBuster}`;
            if (!this.videoUrlCache[baseUrl]) {
                log('video check not cached', intro ? 'intro' : '', baseUrl);
                const resp = await fetch(url, {
                    method: 'HEAD',
                });
                this.videoUrlCache[baseUrl] = resp.ok;
                if (!resp.ok) {
                    log('LandingPage.preloadMedia ABORTED', intro ? 'intro' : '', baseUrl);
                    return;
                }
                log('video check done', intro ? 'intro' : '', baseUrl);
            }
            const media = await fetch(url);
            const blob = await media.blob();
            this.videoCache[baseUrl] = URL.createObjectURL(blob);
            if (!intro && /\.mp4$/i.test(baseUrl)) {
                const baseUrlIntro = baseUrl.replace(/(\.[^.]+)$/, '-Intro$1');
                this.preloadMedia(baseUrlIntro, true);
            }
        } catch {
            return;
        }
        log('LandingPage.preloadMedia COMPLETED', intro ? 'intro' : '', baseUrl);
    }


    async updateBackground() {
        if (!this.dom) return;
        if (this.isStartingVideo) return;
        log('LandingPage.updateBackground');
        this.isStartingVideo = true;
        await this.bgResultUpdatePromise ?? Promise.resolve();
        const idx = this.bgResultList.indexOf(true);
        this.updateBgResultList();
        if (idx == -1) {
            log('no bg true');
            this.isStartingVideo = false;
            return;
        }
        let bg = this.settings.bgList[idx];
        log('bg decided');
        if (bg) {
            let missingBlob = false;
            const baseUrl = bg.url;
            const url = `${baseUrl}?t=${this.cacheBuster}`;
            if (/\.mp4$/i.test(bg.url)) {
                const baseUrlIntro = bg.url.replace(/(\.[^.]+)$/, '-Intro$1');
                const urlIntro = `${baseUrlIntro}?t=${this.cacheBuster}`;
                if (!this.videoUrlCache[baseUrl]) {
                    log('video check not cached');
                    const resp = await fetch(url, {
                        method: 'HEAD',
                    });
                    this.videoUrlCache[baseUrl] = resp.ok;
                    if (!resp.ok) {
                        this.video.src = '';
                        this.dom.style.backgroundImage = '';
                        toastr.warning(`Could not find background: ${baseUrl}`);
                        this.isStartingVideo = false;
                        log('LandingPage.updateBackground ABORTED');
                        return;
                    }
                    log('video check done');
                }
                this.dom.style.backgroundImage = '';
                if (this.introUrlCache[baseUrlIntro] === undefined) {
                    log('intro check not cached');
                    const respIntro = await fetch(urlIntro, {
                        method: 'HEAD',
                    });
                    this.introUrlCache[baseUrlIntro] = respIntro.ok;
                    log('intro check done');
                }
                if (this.introUrlCache[baseUrlIntro]) {
                    this.video.style.opacity = '0';
                    this.video.autoplay = false;
                    if (this.videoCache[baseUrl]) {
                        log('video from blob');
                        this.video.src = this.videoCache[baseUrl];
                    } else {
                        log('video from url');
                        missingBlob = true;
                        this.video.src = url;
                    }
                    await new Promise(async(resolve)=>{
                        log('  play intro');
                        // this.intro.src = this.videoCache[baseUrlIntro] ?? urlIntro;
                        if (this.videoCache[baseUrlIntro]) {
                            log('intro from blob');
                            this.intro.src = this.videoCache[baseUrlIntro];
                        } else {
                            log('intro from url');
                            missingBlob = true;
                            this.intro.src = urlIntro;
                        }
                        while (!appReady) await delay(100);
                        this.intro.play();
                        const resolver = ()=>{
                            this.intro.removeEventListener('ended', resolve);
                            this.intro.removeEventListener('error', resolve);
                            resolve();
                        };
                        this.intro.addEventListener('ended', resolver, { once:true });
                        this.intro.addEventListener('error', resolver, { once:true });
                    });
                    log('  play video');
                    this.video.play();
                    this.video.style.opacity = '1';
                    await delay(100);
                    this.intro.style.opacity = '0';
                    this.intro.src = '';
                } else {
                    this.video.style.opacity = '1';
                    if (this.videoCache[baseUrl]) {
                        log('video from blob');
                        this.video.src = this.videoCache[baseUrl];
                    } else {
                        log('video from url');
                        missingBlob = true;
                        this.video.src = url;
                    }
                }
            } else {
                this.video.src = '';
                if (this.videoCache[baseUrl]) {
                    log('img from blob');
                    this.dom.style.backgroundImage = `url("${this.videoCache[baseUrl]}")`;
                } else {
                    log('img from url');
                    missingBlob = true;
                    this.dom.style.backgroundImage = `url("${url}")`;
                }
            }
            if (missingBlob) {
                log('missing blob -> preload');
                this.preloadBackgrounds();
            }
        } else {
            this.video.src = '';
            this.dom.style.backgroundImage = '';
        }
        this.isStartingVideo = false;
        log('LandingPage.updateBackground COMPLETED');
    }



    async fadeOut() {
        if (!this.fader) this.renderFader();
        this.fader.classList.add('stlp--preactive');
        await waitForFrame();
        this.fader.classList.add('stlp--active');
        await delay(410);
    }
    async fadeIn() {
        if (!this.fader) return;
        this.fader?.classList.remove('stlp--active');
        await delay(410);
        this.fader?.classList.remove('stlp--preactive');
    }




    renderFader() {
        if (this.fader) return;
        const fader = document.createElement('div'); {
            this.fader = fader;
            fader.classList.add('stlp--fader');
            document.body.append(fader);
        }
    }
    render() {
        this.renderFader();
        this.dom?.remove();
        const container = document.createElement('div'); {
            container.classList.add('stlp--container');
            container.style.setProperty('--stlp--cardHeight', `${this.settings.cardHeight}px`);
            container.style.backgroundColor = window.getComputedStyle(document.body).backgroundColor;
            // await delay(1);
            container.style.transition = 'transition: background-color 200ms';
            const intro = document.createElement('video'); {
                this.intro = intro;
                intro.classList.add('stlp--intro');
                intro.loop = false;
                intro.muted = true;
                intro.autoplay = false;
                intro.addEventListener('play', ()=>log('intro.play'));
                intro.addEventListener('playing', ()=>log('intro.playing'));
                container.append(intro);
            }
            const video = document.createElement('video'); {
                this.video = video;
                video.classList.add('stlp--video');
                video.loop = true;
                video.muted = true;
                video.autoplay = true;
                video.addEventListener('play', ()=>log('video.play'));
                video.addEventListener('playing', ()=>log('video.playing'));
                container.append(video);
            }
            const blocker = document.createElement('div'); {
                this.inputBlocker = blocker;
                blocker.classList.add('stlp--inputBlocker');
                blocker.addEventListener('click', ()=>{
                    this.endInput();
                });
                container.append(blocker);
            }
            const d = Number(new Date().toISOString().slice(5, 10).replace('-', ''));
            if (d >= 1231 || d < 102) {
                import('./FizzPopCrackle/FPC.js').then(async(fpcModule)=>{
                    const fpc = new fpcModule.FPC();
                    this.fpc = fpc;
                    await fpc.loadPromise;
                    container.append(fpc.canvas);
                    while (!appReady) await delay(100);
                    if (selected_group || this_chid ) return;
                    await delay(1000);
                    await fpc.start();
                    { // prefs
                        let panel;
                        const prefsTrigger = document.createElement('div'); {
                            prefsTrigger.classList.add('fa-solid', 'fa-fw', 'fa-volume-high');
                            prefsTrigger.classList.add('stlp--fpc--prefsTrigger');
                            prefsTrigger.addEventListener('click', ()=>{
                                if (panel) {
                                    panel.remove();
                                    panel = null;
                                } else {
                                    panel = document.createElement('div'); {
                                        panel.classList.add('stlp--fpc--prefsPanel');
                                        const volGroup = document.createElement('div'); {
                                            volGroup.classList.add('stlp--fpc--prefsGroup');
                                            const mute = document.createElement('div'); {
                                                mute.classList.add('menu_button');
                                                mute.classList.add('fa-solid', 'fa-fw', extension_settings.landingPage.fpcMute ? 'fa-volume-mute' : 'fa-volume-high');
                                                mute.title = extension_settings.landingPage.fpcMute ? 'Unmute' : 'Mute';
                                                mute.addEventListener('click', ()=>{
                                                    extension_settings.landingPage.fpcMute = !extension_settings.landingPage.fpcMute;
                                                    mute.title = extension_settings.landingPage.fpcMute ? 'Unmute' : 'Mute';
                                                    mute.classList.remove(extension_settings.landingPage.fpcMute ? 'fa-volume-high' : 'fa-volume-mute');
                                                    mute.classList.add(extension_settings.landingPage.fpcMute ? 'fa-volume-mute' : 'fa-volume-high');
                                                    saveSettingsDebounced();
                                                });
                                                volGroup.append(mute);
                                            }
                                            const vol = document.createElement('input'); {
                                                vol.classList.add('text_pole');
                                                vol.type = 'range';
                                                vol.min = '0';
                                                vol.max = '100';
                                                vol.value = (extension_settings.landingPage.fpcVolume ?? 15).toString();
                                                vol.addEventListener('input', ()=>{
                                                    extension_settings.landingPage.fpcVolume = parseInt(vol.value);
                                                    saveSettingsDebounced();
                                                });
                                                volGroup.append(vol);
                                            }
                                            panel.append(volGroup);
                                        }
                                        const opGroup = document.createElement('div'); {
                                            opGroup.classList.add('stlp--fpc--prefsGroup');
                                            const icon = document.createElement('div'); {
                                                icon.classList.add('menu_button');
                                                icon.classList.add('fa-solid', 'fa-fw', 'fa-circle-half-stroke');
                                                icon.title = 'Opacity';
                                                opGroup.append(icon);
                                            }
                                            const opacity = document.createElement('input'); {
                                                opacity.classList.add('text_pole');
                                                opacity.type = 'range';
                                                opacity.min = '0';
                                                opacity.max = '100';
                                                opacity.value = (extension_settings.landingPage.fpcOpacity ?? 60).toString();
                                                opacity.addEventListener('input', ()=>{
                                                    extension_settings.landingPage.fpcOpacity = parseInt(opacity.value);
                                                    fpc.canvas.style.opacity = `${opacity.value}%`;
                                                    saveSettingsDebounced();
                                                });
                                                opGroup.append(opacity);
                                            }
                                            panel.append(opGroup);
                                        }
                                        container.append(panel);
                                    }
                                }
                            });
                            container.append(prefsTrigger);
                        }
                    }
                });
            }
            this.dom = container;
        }

        window.addEventListener('keydown', this.handleInputBound);

        return this.dom;
    }
    unrender() {
        this.fadeIn().then(()=>{
            this.fader?.remove();
            this.fader = null;
        });
        window.removeEventListener('keydown',this.handleInputBound);
        this.fpc?.stop();
        this.dom?.remove();
        this.dom = null;
        this.isStartingVideo = false;
        this.endInput();
    }



    getCategoryButtons() {
        return [
            { key:'favorites', label:'Favourites' },
            { key:'recents', label:'Recents' },
            { key:'search', label:'Search' },
        ];
    }

    async renderCardsForCategory(root, category) {
        root.innerHTML = '';
        this.cards = this.cardsByCategory[category] ?? [];
        for (const card of this.cards) {
            root.append(await card.render(this.settings));
        }
    }

    getAvailableTags(cards) {
        const tagsById = this.getTagsById();
        const ids = new Set();
        cards.forEach(card=>this.getCardTagIds(card).forEach(id=>ids.add(String(id))));
        return Array.from(ids)
            .map(id=>({ id, name: tagsById.get(id)?.name ?? id }))
            .toSorted((a,b)=>a.name.localeCompare(b.name, undefined, { sensitivity:'base' }));
    }

    getTagsById() {
        const out = new Map();
        const candidates = [
            tagExports.tags,
            tagExports.characterTags,
            tagExports.TAGS,
            tagExports.allTags,
            tagExports.power_user?.tags,
        ];
        for (const item of candidates) {
            if (!Array.isArray(item)) continue;
            item.forEach(tag=>{
                const id = tag?.id ?? tag?.tag_id ?? tag?.uuid;
                if (id === undefined || id === null) return;
                const sid = String(id);
                out.set(sid, {
                    id: sid,
                    name: String(tag?.name ?? tag?.title ?? sid),
                });
            });
        }
        return out;
    }

    getRawTagMap() {
        const candidates = [
            tagExports.tag_map,
            tagExports.tagMap,
            tagExports.character_tag_map,
            tagExports.characterTagMap,
            tagExports.groupTagMap,
        ];
        return candidates.find(it=>it && typeof it === 'object') ?? {};
    }

    getCardTagIds(card) {
        const entry = this.cardEntries.get(card);
        if (!entry?.char) return [];
        const char = entry.char;
        const rawMap = this.getRawTagMap();
        const keys = [
            char.avatar,
            char.avatar_url,
            char.name,
            char.id,
            char.chat,
            char.chat_id,
            this.getCharacterIdByAvatar(char.avatar),
        ]
            .filter(it=>it !== undefined && it !== null)
            .map(String);
        const found = [];
        keys.forEach(key=>{
            const arr = rawMap[key];
            if (Array.isArray(arr)) {
                arr.forEach(id=>found.push(String(id)));
            }
        });
        return Array.from(new Set(found)).toSorted();
    }

    getCharacterIdByAvatar(avatar) {
        if (!avatar) return null;
        const idx = characters.findIndex(it=>it.avatar === avatar);
        return idx >= 0 ? String(idx) : null;
    }

    updateSearchResults() {
        const query = this.searchQuery.trim().toLowerCase();
        const selected = Array.from(this.selectedTagIds).toSorted();
        const source = this.cardsByCategory.search ?? [];
        const matched = source.filter(card=>{
            const entry = this.cardEntries.get(card);
            const item = entry?.char ?? {};
            const cardTagIds = this.getCardTagIds(card);
            const tagsOk = selected.every(tagId=>cardTagIds.includes(tagId));
            if (!tagsOk) return false;
            if (!query) return true;
            const searchBlob = [
                card.name,
                item.name,
                item.description,
                item.personality,
                item.scenario,
                item.first_mes,
                item.mes_example,
                item.creator_notes,
                item.comment,
                item.system_prompt,
                item.post_history_instructions,
                item.tags?.join?.(' '),
            ]
                .filter(Boolean)
                .join('\n')
                .toLowerCase();
            return searchBlob.includes(query);
        });
        this.searchResults = matched;
    }

    setCardsLoadingState(overlay, isLoading) {
        this.isLoadingCards = isLoading;
        if (!overlay) return;
        overlay.classList.toggle('stlp--isHidden', !isLoading);
        overlay.setAttribute('aria-hidden', isLoading ? 'false' : 'true');
    }


    async renderContent() {
        const container = this.dom;
        const wrap = document.createElement('div'); {
            wrap.classList.add('stlp--wrapper');
            if (this.settings.highlightFavorites) {
                wrap.classList.add('stlp--highlightFavorites');
            }
            wrap.setAttribute('data-displayStyle', this.settings.displayStyle);

            const tabs = document.createElement('div'); {
                tabs.classList.add('stlp--categoryTabs');
                const searchToolbar = document.createElement('div');
                searchToolbar.classList.add('stlp--searchToolbar');
                const buttons = this.getCategoryButtons();
                buttons.forEach(({ key, label })=>{
                    const btn = document.createElement('button'); {
                        btn.type = 'button';
                        btn.classList.add('stlp--categoryTab');
                        if (key === this.activeCategory) {
                            btn.classList.add('stlp--active');
                        }
                        btn.textContent = label;
                        btn.addEventListener('click', async()=>{
                            if (this.activeCategory === key) return;
                            this.activeCategory = key;
                            this.settings.activeCategory = key;
                            saveSettingsDebounced();
                            tabs.querySelectorAll('.stlp--categoryTab').forEach(it=>it.classList.remove('stlp--active'));
                            btn.classList.add('stlp--active');
                            this.setCardsLoadingState(loadingOverlay, true);
                            searchToolbar.classList.toggle('stlp--active', key === 'search');
                            await this.renderCardsForCategory(root, key);
                            await waitForFrame();
                            this.setCardsLoadingState(loadingOverlay, false);
                        });
                        tabs.append(btn);
                    }
                });
                wrap.append(tabs);
                searchToolbar.classList.toggle('stlp--active', this.activeCategory === 'search');
                const searchInput = document.createElement('input'); {
                    searchInput.classList.add('stlp--searchInput');
                    searchInput.type = 'text';
                    searchInput.placeholder = 'Search cards…';
                    searchInput.value = this.searchQuery;
                    searchInput.addEventListener('input', debounce(async()=>{
                        this.searchQuery = searchInput.value;
                        this.settings.searchQuery = this.searchQuery;
                        this.updateSearchResults();
                        saveSettingsDebounced();
                        if (this.activeCategory === 'search') {
                            await this.renderCardsForCategory(root, 'search');
                        }
                    }, 100));
                    searchToolbar.append(searchInput);
                }
                if (this.availableTags.length > 0) {
                    const chips = document.createElement('div'); {
                        chips.classList.add('stlp--tagChips');
                        this.availableTags.forEach(tag=>{
                            const chip = document.createElement('button'); {
                                chip.type = 'button';
                                chip.classList.add('stlp--tagChip');
                                if (this.selectedTagIds.has(tag.id)) {
                                    chip.classList.add('stlp--active');
                                }
                                chip.textContent = tag.name;
                                chip.addEventListener('click', async()=>{
                                    if (this.selectedTagIds.has(tag.id)) {
                                        this.selectedTagIds.delete(tag.id);
                                        chip.classList.remove('stlp--active');
                                    } else {
                                        this.selectedTagIds.add(tag.id);
                                        chip.classList.add('stlp--active');
                                    }
                                    this.updateSearchResults();
                                    if (this.activeCategory === 'search') {
                                        await this.renderCardsForCategory(root, 'search');
                                    }
                                });
                                chips.append(chip);
                            }
                        });
                        searchToolbar.append(chips);
                    }
                }
                const clearBtn = document.createElement('button'); {
                    clearBtn.type = 'button';
                    clearBtn.classList.add('stlp--searchClear');
                    clearBtn.textContent = 'Reset';
                    clearBtn.addEventListener('click', async()=>{
                        this.searchQuery = '';
                        this.settings.searchQuery = '';
                        searchInput.value = '';
                        this.selectedTagIds.clear();
                        searchToolbar.querySelectorAll('.stlp--tagChip').forEach(it=>it.classList.remove('stlp--active'));
                        this.updateSearchResults();
                        saveSettingsDebounced();
                        if (this.activeCategory === 'search') {
                            await this.renderCardsForCategory(root, 'search');
                        }
                    });
                    searchToolbar.append(clearBtn);
                }
                wrap.append(searchToolbar);
            }

            const loadingOverlay = document.createElement('div'); {
                loadingOverlay.classList.add('stlp--loadingOverlay');
                loadingOverlay.setAttribute('aria-live', 'polite');
                loadingOverlay.setAttribute('aria-label', 'Loading cards');

                const shuffle = document.createElement('div'); {
                    shuffle.classList.add('stlp--loadingShuffle');
                    for (let i = 0; i < 3; i++) {
                        const card = document.createElement('div');
                        card.classList.add('stlp--loadingShuffleCard');
                        shuffle.append(card);
                    }
                    loadingOverlay.append(shuffle);
                }

                const label = document.createElement('div'); {
                    label.classList.add('stlp--loadingLabel');
                    label.textContent = 'Shuffling cards…';
                    loadingOverlay.append(label);
                }

                wrap.append(loadingOverlay);
            }

            const root = document.createElement('div'); {
                root.classList.add('stlp--cards');
                this.setCardsLoadingState(loadingOverlay, true);
                await this.renderCardsForCategory(root, this.activeCategory);
                await waitForFrame();
                await waitForFrame();
                this.setCardsLoadingState(loadingOverlay, false);
                const firstRenderStart = performance.now();
                await this.renderCardsForCategory(root, this.activeCategory);
                log('LandingPage.renderContent first-card-render-ms', Math.round(performance.now() - firstRenderStart));
                wrap.append(root);
            }
            container.append(wrap);
        }
        const menu = document.createElement('ul'); {
            menu.classList.add('stlp--menu');
            this.settings.menuList.forEach(item=>{
                const li = document.createElement('li'); {
                    li.classList.add('stlp--item');
                    li.setAttribute('data-stlp--label', item.label);
                    li.textContent = item.label;
                    li.addEventListener('click', async()=>{
                        await executeSlashCommands(item.command);
                    });
                    menu.append(li);
                }
            });
            container.append(menu);
        }
        const inputDisplayContainer = document.createElement('div'); {
            this.inputDisplayContainer = inputDisplayContainer;
            inputDisplayContainer.classList.add('stlp--inputDisplayContainer');
            const inputDisplay = document.createElement('div'); {
                this.inputDisplay = inputDisplay;
                inputDisplay.classList.add('stlp--inputDisplay');
                inputDisplayContainer.append(inputDisplay);
            }
        }
    }




    endInput() {
        this.isInputting = false;
        if (this.inputBlocker) {
            this.inputBlocker.style.display = '';
        }
        if (this.settings.isEnabled) {
            this.sheld.style.opacity = '0';
            this.sheld.style.pointerEvents = 'none';
        }
    }
    /**
     *
     * @param {KeyboardEvent} evt
     * @returns
     */
    handleInput(evt) {
        let key = evt.key;
        if (!this.isInputting) {
            if (key.length > 1 || evt.ctrlKey || evt.altKey) return;
            if (document.activeElement != document.body) return;
            toastr.info('Click outside the chat to close chat.', 'Landing Page');
            this.isInputting = true;
            // this.chatInput.value += key;
            this.inputBlocker.style.display = 'block';
            this.sheld.style.opacity = '';
            this.sheld.style.pointerEvents = '';
            this.sheld.style.zIndex = '2002';
            this.chatInput.focus();
            // this.sheld.style.alignItems = 'center';
            // this.sheld.style.width = 'calc(100vw - var(--nav-bar-width, 0))';
        }
        // this.inputTime = new Date().getTime();
        // this.inputDisplay.textContent = this.input;
    }
}
