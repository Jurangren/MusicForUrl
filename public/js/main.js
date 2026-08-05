let token = localStorage.getItem('token') || '';
let currentUser = null;

let currentPlaylist = null;
let userPlaylists = [];
let playlistPage = 1;
let playlistTotal = 0;
let isLoadingPlaylists = false;
const PAGE_SIZE = 5;

let userFavorites = [];
let favoritePage = 1;
let favoriteTotal = 0;
let isLoadingFavorites = false;

let userHistory = [];
let historyPage = 1;
let historyTotal = 0;
let isLoadingHistory = false;

let qrKey = '';
let qrCheckInterval = null;

let currentPlatform = 'netease';
let qqToken = localStorage.getItem('qqToken') || '';
let qqCurrentUser = null;
let qqQrKey = '';
let qqQrCheckInterval = null;
let qqUserPlaylists = [];
let qqPlaylistPage = 1;
let qqPlaylistTotal = 0;
let isLoadingQQPlaylists = false;
let qqUserFavorites = [];
let qqFavoritePage = 1;
let qqFavoriteTotal = 0;
let isLoadingQQFavorites = false;
let qqUserHistory = [];
let qqHistoryPage = 1;
let qqHistoryTotal = 0;
let isLoadingQQHistory = false;
let loginPlatform = 'netease';
const PERSONAL_PLATFORM_TAB_KEY = 'personalPlatformTab';
let personalPlatform = localStorage.getItem(PERSONAL_PLATFORM_TAB_KEY) || '';
let neteaseCenterTab = 'playlists';
let qqCenterTab = 'playlists';

const SPA_VIEW_CONTAINER_ID = 'appView';
const SPA_VIEW_CACHE = new Map();
let lastAutoPlayId = null;
let lastGeneratedUrl = '';
let lastGeneratedUrls = [];
let lastGeneratedLocalPath = '';
let selectedGeneratedUrlType = 'mp4';
let generationRequestSequence = 0;
let activeGenerationCancelPath = '';
let generationCancelInFlight = false;
const generationJobs = new Map();
const generationJobCancelsInFlight = new Set();
let generationJobsPollTimer = null;
let generationJobsPollInFlight = false;
let tmplinkSettingsLoadedFor = '';
let tmplinkSettingsLoadedAccountToken = '';
let tmplinkSettingsLoading = false;
let tmplinkSettingsState = null;
const GENERATION_HISTORY_PLATFORM_KEY = 'generationHistoryPlatform';
let generationHistoryPlatform = localStorage.getItem(GENERATION_HISTORY_PLATFORM_KEY) || '';
let generationHistoryPage = 1;
let generationHistoryLoading = false;
let generationHistoryLoadSequence = 0;
const HIGH_CONCURRENCY_WARNING_KEY = 'highConcurrencyWarningConfirmed';
let lastGenerationConcurrency = 4;

async function lockSiteAccess() {
  try {
    await fetch('/api/site-access/logout', { method: 'POST', credentials: 'same-origin' });
  } finally {
    sessionStorage.removeItem('sitePassword');
    window.location.replace('/');
  }
}

window.lockSiteAccess = lockSiteAccess;
const MFU_ERROR = (typeof window !== 'undefined' && window.MfuError) ? window.MfuError : null;

function hasSpaContainer() {
  return !!document.getElementById(SPA_VIEW_CONTAINER_ID);
}

function resolveViewFromPath(pathname) {
  const p = (pathname || '/').replace(/\/+$/, '') || '/';
  if (p === '/user' || p === '/user.html') return 'user';
  if (p === '/generated' || p === '/generated.html') return 'generated';
  return 'home';
}

function viewTitle(view) {
  if (view === 'user') return '个人中心 - MusicForUrl';
  if (view === 'generated') return '历史生成 - MusicForUrl';
  return 'MusicForUrl';
}

function isUserViewActive() {
  return resolveViewFromPath(window.location.pathname) === 'user';
}

function isGenerationHistoryViewActive() {
  return resolveViewFromPath(window.location.pathname) === 'generated';
}

function rememberPersonalPlatform(platform) {
  const value = platform === 'qq' ? 'qq' : 'netease';
  personalPlatform = value;
  localStorage.setItem(PERSONAL_PLATFORM_TAB_KEY, value);
}

function resolveDefaultPersonalPlatform() {
  const hasNetease = !!token;
  const hasQQ = !!qqToken;

  if (hasNetease && !hasQQ) return 'netease';
  if (!hasNetease && hasQQ) return 'qq';
  if (hasNetease && hasQQ) {
    const saved = localStorage.getItem(PERSONAL_PLATFORM_TAB_KEY);
    if (saved === 'netease' || saved === 'qq') return saved;
    return 'netease';
  }
  return 'netease';
}

function refreshPersonalCenterIfActive() {
  if (!isUserViewActive()) return;
  renderPersonalCenter();
}

function navigate(path, { replace = false } = {}) {
  if (!path) return;

  if (!hasSpaContainer()) {
    window.location.href = path;
    return;
  }

  const url = new URL(path, window.location.origin);
  const next = url.pathname + url.search + url.hash;

  if (replace) {
    history.replaceState({}, '', next);
  } else {
    history.pushState({}, '', next);
  }
  renderCurrentRoute();
}

async function fetchViewHtml(view) {
  if (SPA_VIEW_CACHE.has(view)) return SPA_VIEW_CACHE.get(view);

  const requestPath = `/views/${view}.html`;
  let res;
  try {
    res = await fetch(requestPath, { cache: 'no-cache' });
  } catch (error) {
    throw normalizeRuntimeError('SPA_VIEW_FETCH', error, requestPath);
  }

  if (!res.ok) {
    if (MFU_ERROR && typeof MFU_ERROR.normalizeHttpError === 'function') {
      throw MFU_ERROR.normalizeHttpError({
        scope: 'SPA_VIEW_FETCH',
        status: res.status,
        payload: null,
        requestPath
      });
    }
    throw new Error('页面加载失败，请刷新重试');
  }

  let html;
  try {
    html = await res.text();
  } catch (error) {
    const parseError = Object.assign(new Error(error && error.message ? error.message : 'view html parse error'), {
      __mfuType: 'PARSE',
      __mfuStatus: res.status
    });
    throw normalizeRuntimeError('SPA_VIEW_FETCH', parseError, requestPath);
  }
  SPA_VIEW_CACHE.set(view, html);
  return html;
}

function animateViewEnter(container) {
  if (!container) return;
  container.classList.remove('view-enter');
  void container.offsetWidth;
  container.classList.add('view-enter');
}

async function renderView(view) {
  const container = document.getElementById(SPA_VIEW_CONTAINER_ID);
  if (!container) return;

  container.innerHTML = `<div style="text-align:center; padding: 2rem;"><span class="loading"></span></div>`;
  document.title = viewTitle(view);

  try {
    const html = await fetchViewHtml(view);
    container.innerHTML = html;
    animateViewEnter(container);
    onViewMounted(view);
  } catch (e) {
    logError({
      channel: 'spa',
      scope: 'SPA_VIEW_FETCH',
      requestPath: `/views/${view}.html`,
      errorCode: e && e.errorCode,
      meta: e && e._errorMeta ? e._errorMeta : e
    });
    container.innerHTML = `<div class="empty">${escapeHtml(toErrorDisplay(e, '页面加载失败，请刷新重试'))}</div>`;
    animateViewEnter(container);
  }
}

function renderCurrentRoute() {
  if (!hasSpaContainer()) return;
  const view = resolveViewFromPath(window.location.pathname);
  renderView(view);
}

function interceptInternalLinks() {
  document.addEventListener('click', (e) => {
    const a = e.target && e.target.closest ? e.target.closest('a') : null;
    if (!a) return;

    const href = a.getAttribute('href');
    if (!href) return;
    if (a.target === '_blank' || a.hasAttribute('download')) return;
    if (/^(https?:|mailto:|tel:)/i.test(href)) return;
    if (href.startsWith('#')) return;

    if (!href.startsWith('/')) return;
    if (href.startsWith('/api/') || href.startsWith('/includes/') || href.startsWith('/views/')) return;

    if (hasSpaContainer()) {
      e.preventDefault();
      navigate(href);
    }
  });
}

function maybeRestoreHomeState() {
  const result = document.getElementById('resultSection');
  if (!result) return;

  if (currentPlaylist && lastGeneratedUrl) {
    const cover = document.getElementById('playlistCover');
    const name = document.getElementById('playlistName');
    const meta = document.getElementById('playlistMeta');
    const urlOptions = document.getElementById('playlistUrlOptions');

    if (cover) cover.src = imageSrc(currentPlaylist.cover);
    if (name) name.textContent = currentPlaylist.name || '';
    if (meta) meta.textContent = `共 ${currentPlaylist.songCount} 首`;
    if (urlOptions) renderGeneratedUrlOptions();
    renderGeneratedLocalPath(lastGeneratedLocalPath);
    result.classList.add('show');
  }
}

function getSelectedGeneratedUrl() {
  if (Array.isArray(lastGeneratedUrls) && lastGeneratedUrls.length) {
    const picked =
      lastGeneratedUrls.find(u => u && u.type === selectedGeneratedUrlType) ||
      lastGeneratedUrls[0];
    if (picked && picked.url) return String(picked.url);
  }
  return String(lastGeneratedUrl || '');
}

function renderGeneratedUrlOptions() {
  const container = document.getElementById('playlistUrlOptions');
  if (!container) return;

  if (!Array.isArray(lastGeneratedUrls) || lastGeneratedUrls.length === 0) {
    container.innerHTML = '';
    return;
  }

  const html = lastGeneratedUrls.map((opt) => {
    const type = String(opt && opt.type ? opt.type : '');
    const label = escapeHtml(opt && opt.label ? opt.label : type);
    const note = escapeHtml(opt && opt.note ? opt.note : '');
    const url = escapeHtml(opt && opt.url ? opt.url : '');
    const selected = type && type === selectedGeneratedUrlType;
    const selectedBadge = selected ? '<div class="url-option-selected">已选</div>' : '';
    const noteHtml = note ? `<div class="url-option-note">${note}</div>` : '';

    return `
      <div class="url-option ${selected ? 'selected' : ''}" onclick="selectUrlOption('${type}')">
        <div class="url-option-header">
          <div class="url-option-title">${label}</div>
          ${selectedBadge}
        </div>
        ${noteHtml}
        <div class="url-option-url">${url}</div>
      </div>
    `;
  }).join('');

  container.innerHTML = html;
}

function selectUrlOption(type) {
  selectedGeneratedUrlType = String(type || '');
  lastGeneratedUrl = getSelectedGeneratedUrl();
  renderGeneratedUrlOptions();
}

async function maybeAutoplayFromUrl() {
  const urlParams = new URLSearchParams(window.location.search);
  const playId = urlParams.get('play');
  if (!playId) return;
  if (playId === lastAutoPlayId) return;
  lastAutoPlayId = playId;

  const platform = urlParams.get('platform');
  if (platform && platform !== currentPlatform) switchPlatform(platform);

  const input = document.getElementById('playlistInput');
  if (!input) return;
  input.value = playId;
  await generatePlaylist();
}

function onViewMounted(view) {
  if (view === 'home') {
    restorePlatformTab();
    syncGenerationOptionAvailability();
    lastGenerationConcurrency = Number(document.querySelector('input[name="generationConcurrency"]:checked')?.value) || 4;
    maybeRestoreHomeState();
    startGenerationJobsPolling();
    maybeAutoplayFromUrl();
    return;
  }

  stopGenerationJobsPolling();

  if (view === 'generated') {
    if (!token && !qqToken) {
      showToast('请先登录', 'error');
      showLogin();
      navigate('/', { replace: true });
      return;
    }
    if (generationHistoryPlatform !== 'netease' && generationHistoryPlatform !== 'qq') {
      generationHistoryPlatform = resolveDefaultPersonalPlatform();
    }
    switchGenerationHistoryPlatform(generationHistoryPlatform);
    return;
  }

  if (view === 'user') {
    if (!token && !qqToken) {
      showToast('请先登录', 'error');
      showLogin();
      navigate('/', { replace: true });
      return;
    }

    rememberPersonalPlatform(resolveDefaultPersonalPlatform());
    renderPersonalCenter();
  }
}

function renderPersonalAuthPanel(platform) {
  const isQQ = platform === 'qq';
  const platformName = isQQ ? 'QQ音乐' : '网易云音乐';
  const action = isQQ ? "showLogin('qq')" : "showLogin('netease')";
  return `
    <div class="platform-auth-empty">
      <p>当前未登录${platformName}</p>
      <button class="btn btn-primary" onclick="${action}">登录${platformName}</button>
    </div>
  `;
}

function renderPlatformStatusCard(platform) {
  const isQQ = platform === 'qq';
  const user = isQQ ? qqCurrentUser : currentUser;
  const hasToken = isQQ ? !!qqToken : !!token;
  const logoutAction = isQQ ? 'logoutQQ()' : 'logout()';
  const badge = isQQ
    ? '<span class="platform-badge qq">QQ音乐</span>'
    : '<span class="platform-badge netease">网易云</span>';

  if (!hasToken) return '';

  if (!user) {
    return `
      <div class="platform-account">
        ${badge}
        <span class="account-name">已登录，正在加载账号信息...</span>
        <button class="btn btn-ghost" style="padding:0.3rem 0.6rem;font-size:0.8rem;" onclick="${logoutAction}">退出</button>
      </div>
    `;
  }

  const av = imageSrc(user.avatar);
  const name = escapeHtml(user.nickname);
  const vipBadge = (!isQQ && user.vipType > 0)
    ? `<span class="vip-badge">${user.vipType === 11 ? '黑胶' : 'VIP'}</span>`
    : '';

  return `
    <div class="platform-account">
      ${badge}
      <img class="user-avatar" src="${av}" alt="" referrerpolicy="no-referrer" loading="lazy">
      <span class="account-name">${name}</span>
      ${vipBadge}
      <button class="btn btn-ghost" style="padding:0.3rem 0.6rem;font-size:0.8rem;" onclick="${logoutAction}">退出</button>
    </div>
  `;
}

function switchPersonalPlatform(platform) {
  rememberPersonalPlatform(platform);
  renderPersonalCenter();
}

function renderPersonalCenter() {
  if (!isUserViewActive()) return;

  const neteaseTabBtn = document.getElementById('personalPlatformNetease');
  const qqTabBtn = document.getElementById('personalPlatformQQ');
  const neteasePanel = document.getElementById('neteasePanel');
  const qqPanel = document.getElementById('qqPanel');
  const neteaseAuthState = document.getElementById('neteaseAuthState');
  const qqAuthState = document.getElementById('qqAuthState');
  const neteaseContent = document.getElementById('neteaseContent');
  const qqContent = document.getElementById('qqContent');

  if (!neteasePanel || !qqPanel || !neteaseAuthState || !qqAuthState || !neteaseContent || !qqContent) {
    return;
  }

  if (personalPlatform !== 'netease' && personalPlatform !== 'qq') {
    personalPlatform = resolveDefaultPersonalPlatform();
  }

  if (neteaseTabBtn) neteaseTabBtn.classList.toggle('active', personalPlatform === 'netease');
  if (qqTabBtn) qqTabBtn.classList.toggle('active', personalPlatform === 'qq');
  neteasePanel.classList.toggle('active', personalPlatform === 'netease');
  qqPanel.classList.toggle('active', personalPlatform === 'qq');

  if (token) {
    neteaseAuthState.innerHTML = renderPlatformStatusCard('netease');
    neteaseContent.style.display = '';
    if (personalPlatform === 'netease') switchPersonalTab(neteaseCenterTab);
  } else {
    neteaseAuthState.innerHTML = renderPersonalAuthPanel('netease');
    neteaseContent.style.display = 'none';
  }

  if (qqToken) {
    qqAuthState.innerHTML = renderPlatformStatusCard('qq');
    qqContent.style.display = '';
    if (personalPlatform === 'qq') {
      if (qqCenterTab !== 'playlists' && qqCenterTab !== 'favorites' && qqCenterTab !== 'history') {
        qqCenterTab = 'playlists';
      }
      switchQQPersonalTab(qqCenterTab);
    }
  } else {
    qqAuthState.innerHTML = renderPersonalAuthPanel('qq');
    qqContent.style.display = 'none';
  }

  renderTmplinkSettings();
  loadTmplinkSettings();
}

function initSpa() {
  if (!hasSpaContainer()) return;
  window.navigate = navigate;
  interceptInternalLinks();
  window.addEventListener('popstate', renderCurrentRoute);
  renderCurrentRoute();
}

document.addEventListener('DOMContentLoaded', () => {
  initTheme();
  installGlobalUiErrorHandlers();
  loadIncludes();
  initSpa();
});

async function loadIncludes() {
  const headerPlaceholder = document.getElementById('header-placeholder');
  const footerPlaceholder = document.getElementById('footer-placeholder');

  if (headerPlaceholder) {
    try {
      const res = await fetch('/includes/header.html');
      if (res.ok) {
        headerPlaceholder.outerHTML = await res.text();
        initTheme();
        if (token) checkLoginStatus();
        if (qqToken) checkQQLoginStatus();
      } else {
        logError({
          channel: 'include',
          requestPath: '/includes/header.html',
          errorCode: MFU_ERROR && typeof MFU_ERROR.buildErrorCode === 'function'
            ? MFU_ERROR.buildErrorCode('HTTP', 'INCLUDE_HEADER', res.status)
            : `E-HTTP-INCLUDE_HEADER-${res.status}`,
          meta: { status: res.status }
        });
      }
    } catch (e) {
      const normalized = normalizeRuntimeError('INCLUDE_HEADER', e, '/includes/header.html');
      logError({
        channel: 'include',
        requestPath: '/includes/header.html',
        errorCode: normalized.errorCode,
        meta: normalized._errorMeta
      });
    }
  }

  if (footerPlaceholder) {
    try {
      const res = await fetch('/includes/footer.html');
      if (res.ok) {
        footerPlaceholder.outerHTML = await res.text();
      } else {
        logError({
          channel: 'include',
          requestPath: '/includes/footer.html',
          errorCode: MFU_ERROR && typeof MFU_ERROR.buildErrorCode === 'function'
            ? MFU_ERROR.buildErrorCode('HTTP', 'INCLUDE_FOOTER', res.status)
            : `E-HTTP-INCLUDE_FOOTER-${res.status}`,
          meta: { status: res.status }
        });
      }
    } catch (e) {
      const normalized = normalizeRuntimeError('INCLUDE_FOOTER', e, '/includes/footer.html');
      logError({
        channel: 'include',
        requestPath: '/includes/footer.html',
        errorCode: normalized.errorCode,
        meta: normalized._errorMeta
      });
    }
  }
}

function initTheme() {
  const savedTheme = localStorage.getItem('theme');
  const toggle = document.getElementById('themeToggle');
  
  if (savedTheme === 'dark') {
    document.documentElement.setAttribute('data-theme', 'dark');
    if (toggle) toggle.checked = true;
  } else {
    document.documentElement.removeAttribute('data-theme');
    if (toggle) toggle.checked = false;
  }
}

function toggleTheme() {
  const toggle = document.getElementById('themeToggle');
  if (toggle && toggle.checked) {
    document.documentElement.setAttribute('data-theme', 'dark');
    localStorage.setItem('theme', 'dark');
  } else {
    document.documentElement.removeAttribute('data-theme');
    localStorage.setItem('theme', 'light');
  }
}

function showAbout() {
  const modal = document.getElementById('aboutModal');
  if (modal) modal.classList.add('show');
}

function hideAbout() {
  const modal = document.getElementById('aboutModal');
  if (modal) modal.classList.remove('show');
}

function switchPersonalTab(tab) {
  neteaseCenterTab = tab;

  if (!token) return;

  document.querySelectorAll('.tab-btn').forEach(btn => btn.classList.remove('active'));
  document.querySelectorAll('.tab-content').forEach(content => content.classList.remove('active'));
  
  const tabBtn = document.getElementById(tab === 'playlists' ? 'tabPlaylists' : tab === 'favorites' ? 'tabFavorites' : 'tabHistory');
  const tabContent = document.getElementById(tab === 'playlists' ? 'playlistsContent' : tab === 'favorites' ? 'favoritesContent' : 'historyContent');

  if (tabBtn) tabBtn.classList.add('active');
  if (tabContent) tabContent.classList.add('active');
  
  if (tab === 'playlists') {
    if (userPlaylists.length === 0) {
      loadUserPlaylists(1);
    } else {
      renderPlaylists();
      renderPagination('playlistsPagination', playlistTotal, playlistPage, PAGE_SIZE, 'loadUserPlaylists');
    }
  } else if (tab === 'favorites') {
    if (userFavorites.length === 0) {
      loadFavorites(1);
    } else {
      renderFavorites();
      renderPagination('favoritesPagination', favoriteTotal, favoritePage, PAGE_SIZE, 'loadFavorites');
    }
  } else {
    if (userHistory.length === 0) {
      loadHistory(1);
    } else {
      renderHistory();
      renderPagination('historyPagination', historyTotal, historyPage, PAGE_SIZE, 'loadHistory');
    }
  }
}

function switchQQPersonalTab(tab) {
  qqCenterTab = tab;

  if (!qqToken) return;

  const tabMap = {
    playlists: {
      buttonId: 'tabQQPlaylists',
      contentId: 'qqPlaylistsContent',
      load: () => {
        if (qqUserPlaylists.length === 0) {
          loadQQUserPlaylists(1);
        } else {
          renderQQPlaylists();
          renderPagination('qqPlaylistsPagination', qqPlaylistTotal, qqPlaylistPage, PAGE_SIZE, 'loadQQUserPlaylists');
        }
      }
    },
    favorites: {
      buttonId: 'tabQQFavorites',
      contentId: 'qqFavoritesContent',
      load: () => {
        if (qqUserFavorites.length === 0) {
          loadQQFavorites(1);
        } else {
          renderQQFavorites();
          renderPagination('qqFavoritesPagination', qqFavoriteTotal, qqFavoritePage, PAGE_SIZE, 'loadQQFavorites');
        }
      }
    },
    history: {
      buttonId: 'tabQQHistory',
      contentId: 'qqHistoryContent',
      load: () => {
        if (qqUserHistory.length === 0) {
          loadQQHistory(1);
        } else {
          renderQQHistory();
          renderPagination('qqHistoryPagination', qqHistoryTotal, qqHistoryPage, PAGE_SIZE, 'loadQQHistory');
        }
      }
    }
  };

  const keys = Object.keys(tabMap);
  keys.forEach((key) => {
    const conf = tabMap[key];
    const btn = document.getElementById(conf.buttonId);
    const content = document.getElementById(conf.contentId);
    if (btn) btn.classList.toggle('active', key === tab);
    if (content) content.classList.toggle('active', key === tab);
  });

  if (tabMap[tab]) {
    tabMap[tab].load();
  }
}

function escapeHtml(str) {
  if (!str) return '';
  const div = document.createElement('div');
  div.textContent = str;
  return div.innerHTML;
}

function escapeUrl(url) {
  if (!url) return '';
  const str = String(url);
  const isHttp = /^https?:\/\//i.test(str);

  if (!isHttp) return '';
  return escapeHtml(str);
}

function imageSrc(url) {
  const str = (url == null) ? '' : String(url).trim();
  if (!str) return '/placeholder.svg';

  let u;
  try {
    u = new URL(str);
  } catch (_) {
    return '/placeholder.svg';
  }
  if (u.protocol !== 'http:' && u.protocol !== 'https:') return '/placeholder.svg';
  if (u.protocol === 'http:') u.protocol = 'https:';

  return escapeHtml(u.toString());
}

function showToast(message, type = 'success') {
  if (typeof shouldDisplayToast === 'function' && !shouldDisplayToast(message)) return;
  const toast = document.getElementById('toast');
  if (!toast) return;
  toast.textContent = message;
  toast.className = 'toast ' + type + ' show';
  setTimeout(() => toast.classList.remove('show'), 3000);
}

function normalizeScope(scope) {
  const value = String(scope || '').trim().toUpperCase().replace(/[^A-Z0-9_]+/g, '_');
  return value || 'UNKNOWN';
}

function normalizeRuntimeError(scope, error, requestPath) {
  if (error && typeof error === 'object' && error.success === false && error.errorCode) {
    return error;
  }

  const normalizedScope = normalizeScope(scope);
  if (MFU_ERROR && typeof MFU_ERROR.normalizeCaughtError === 'function') {
    return MFU_ERROR.normalizeCaughtError({
      scope: normalizedScope,
      error,
      requestPath: requestPath || ''
    });
  }

  return {
    success: false,
    message: (error && error.message) ? String(error.message) : '请求失败，请稍后重试',
    errorCode: `E-FE-${normalizedScope}-UNKNOWN`,
    _errorMeta: {
      kind: 'FE',
      scope: normalizedScope,
      status: null,
      requestPath: requestPath || '',
      rawMessage: (error && error.message) ? String(error.message) : ''
    }
  };
}

function toErrorDisplay(errorLike, fallbackMessage) {
  if (MFU_ERROR && typeof MFU_ERROR.toDisplayMessage === 'function') {
    return MFU_ERROR.toDisplayMessage(errorLike, fallbackMessage);
  }
  return String((errorLike && errorLike.message) || fallbackMessage || '请求失败，请稍后重试');
}

function logError(meta) {
  if (MFU_ERROR && typeof MFU_ERROR.logDebug === 'function') {
    MFU_ERROR.logDebug(meta);
    return;
  }
  console.error('[MFU_ERROR]', meta);
}

function showActionError(errorLike, fallbackMessage) {
  showToast(toErrorDisplay(errorLike, fallbackMessage), 'error');
}

function renderInlineError(container, errorLike, fallbackMessage) {
  if (!container) return;
  container.innerHTML = `<div class="empty">${escapeHtml(toErrorDisplay(errorLike, fallbackMessage))}</div>`;
}

async function requestJson(basePath, path, options = {}, scope = 'UNKNOWN', tokenHeader = '', tokenValue = '') {
  const normalizedScope = normalizeScope(scope);
  const headers = { 'Content-Type': 'application/json' };
  if (tokenHeader && tokenValue) headers[tokenHeader] = tokenValue;

  const requestPath = `${basePath}${path}`;
  const method = String((options && options.method) || 'GET').toUpperCase();
  let res;

  try {
    res = await fetch(requestPath, {
      ...options,
      headers: { ...headers, ...(options && options.headers ? options.headers : {}) }
    });
  } catch (error) {
    const normalized = normalizeRuntimeError(normalizedScope, error, requestPath);
    logError({
      channel: 'request',
      method,
      requestPath,
      errorCode: normalized.errorCode,
      meta: normalized._errorMeta
    });
    return normalized;
  }

  let payload;
  try {
    payload = await res.json();
  } catch (error) {
    const parseError = Object.assign(new Error(error && error.message ? error.message : 'response parse error'), {
      __mfuType: 'PARSE',
      __mfuStatus: res.status
    });
    const normalized = normalizeRuntimeError(normalizedScope, parseError, requestPath);
    logError({
      channel: 'request',
      method,
      requestPath,
      errorCode: normalized.errorCode,
      meta: normalized._errorMeta
    });
    return normalized;
  }

  if (!res.ok || (payload && typeof payload === 'object' && payload.success === false)) {
    const normalized = (MFU_ERROR && typeof MFU_ERROR.normalizeHttpError === 'function')
      ? MFU_ERROR.normalizeHttpError({
        scope: normalizedScope,
        status: res.status,
        payload,
        requestPath
      })
      : {
        success: false,
        message: (payload && payload.message) ? payload.message : '请求失败，请稍后重试',
        errorCode: `E-HTTP-${normalizedScope}-${res.status || 'UNKNOWN'}`,
        _errorMeta: {
          kind: 'HTTP',
          scope: normalizedScope,
          status: res.status || null,
          requestPath,
          rawMessage: (payload && payload.message) ? payload.message : ''
        }
      };

    logError({
      channel: 'request',
      method,
      requestPath,
      errorCode: normalized.errorCode,
      meta: normalized._errorMeta
    });
    return normalized;
  }

  if (payload && typeof payload === 'object') return payload;

  const parseError = Object.assign(new Error('响应结构异常'), {
    __mfuType: 'PARSE',
    __mfuStatus: res.status
  });
  const normalized = normalizeRuntimeError(normalizedScope, parseError, requestPath);
  logError({
    channel: 'request',
    method,
    requestPath,
    errorCode: normalized.errorCode,
    meta: normalized._errorMeta
  });
  return normalized;
}

async function api(path, options = {}, scope = 'UNKNOWN') {
  return requestJson('/api', path, options, scope, 'X-Token', token);
}

async function qqApi(path, options = {}, scope = 'UNKNOWN') {
  return requestJson('/api/qq', path, options, scope, 'X-QQ-Token', qqToken);
}

function showTmplinkHelp() {
  const modal = document.getElementById('tmplinkHelpModal');
  if (modal) modal.classList.add('show');
}

function hideTmplinkHelp() {
  const modal = document.getElementById('tmplinkHelpModal');
  if (modal) modal.classList.remove('show');
}

function tmplinkSettingsApi(options = {}) {
  const source = personalPlatform === 'qq' ? 'qq' : 'netease';
  const header = source === 'qq' ? 'X-QQ-Token' : 'X-Token';
  const value = source === 'qq' ? qqToken : token;
  return requestJson('/api', `/upload-settings/tmplink?source=${source}`, options, 'TMPLINK_SETTINGS', header, value);
}

function renderTmplinkSettings() {
  const source = personalPlatform === 'qq' ? 'qq' : 'netease';
  const loggedIn = source === 'qq' ? Boolean(qqToken) : Boolean(token);
  const accountToken = source === 'qq' ? qqToken : token;
  const sourceLabel = document.getElementById('tmplinkAccountSource');
  const input = document.getElementById('tmplinkTokenInput');
  const saveButton = document.getElementById('saveTmplinkTokenBtn');
  const removeButton = document.getElementById('removeTmplinkTokenBtn');
  const status = document.getElementById('tmplinkSettingsStatus');
  if (!input || !saveButton || !status) return;

  if (sourceLabel) sourceLabel.textContent = source === 'qq' ? 'QQ 音乐账号' : '网易云账号';
  input.disabled = !loggedIn || tmplinkSettingsLoading;
  saveButton.disabled = !loggedIn || tmplinkSettingsLoading;
  saveButton.textContent = tmplinkSettingsLoading ? '正在验证…' : '验证并保存';
  const currentState = tmplinkSettingsLoadedFor === source && tmplinkSettingsLoadedAccountToken === accountToken
    ? tmplinkSettingsState
    : null;
  if (!loggedIn) {
    status.textContent = '请先登录当前音乐账号再配置';
    if (removeButton) removeButton.hidden = true;
  } else if (tmplinkSettingsLoading) {
    status.textContent = '正在读取 TMPLINK 配置…';
  } else if (currentState?.configured) {
    const expiry = currentState.expiresAt ? `，有效期至 ${new Date(currentState.expiresAt).toLocaleString()}` : '';
    status.textContent = `已配置并通过服务器验证（UID ${currentState.uid || '-'}${expiry}）`;
    if (removeButton) removeButton.hidden = false;
  } else {
    status.textContent = '尚未配置；Token 会先通过 TMPLINK 服务器验证，成功后才加密保存';
    if (removeButton) removeButton.hidden = true;
  }
}

async function loadTmplinkSettings(force = false) {
  if (!isUserViewActive()) return;
  const source = personalPlatform === 'qq' ? 'qq' : 'netease';
  const accountToken = source === 'qq' ? qqToken : token;
  const loggedIn = Boolean(accountToken);
  if (!loggedIn || tmplinkSettingsLoading || (!force && tmplinkSettingsLoadedFor === source && tmplinkSettingsLoadedAccountToken === accountToken)) {
    renderTmplinkSettings();
    return;
  }
  tmplinkSettingsLoading = true;
  renderTmplinkSettings();
  const response = await tmplinkSettingsApi();
  tmplinkSettingsLoading = false;
  if (response.success) {
    tmplinkSettingsLoadedFor = source;
    tmplinkSettingsLoadedAccountToken = accountToken;
    tmplinkSettingsState = response.data || { configured: false };
  } else {
    tmplinkSettingsLoadedFor = source;
    tmplinkSettingsLoadedAccountToken = accountToken;
    tmplinkSettingsState = { configured: false };
    const status = document.getElementById('tmplinkSettingsStatus');
    if (status) status.textContent = response.message || '读取 TMPLINK 配置失败';
  }
  renderTmplinkSettings();
}

async function saveTmplinkToken() {
  const source = personalPlatform === 'qq' ? 'qq' : 'netease';
  const accountToken = source === 'qq' ? qqToken : token;
  const input = document.getElementById('tmplinkTokenInput');
  const value = String(input?.value || '').trim();
  if (!value) return showToast('请输入 TMPLINK Token', 'error');
  tmplinkSettingsLoading = true;
  renderTmplinkSettings();
  const response = await tmplinkSettingsApi({ method: 'PUT', body: JSON.stringify({ token: value }) });
  tmplinkSettingsLoading = false;
  if (!response.success) {
    renderTmplinkSettings();
    return showActionError(response, 'TMPLINK Token 验证失败');
  }
  if (input) input.value = '';
  tmplinkSettingsLoadedFor = source;
  tmplinkSettingsLoadedAccountToken = accountToken;
  tmplinkSettingsState = response.data || { configured: true };
  renderTmplinkSettings();
  showToast('TMPLINK Token 验证通过并已保存');
}

async function removeTmplinkToken() {
  const source = personalPlatform === 'qq' ? 'qq' : 'netease';
  const accountToken = source === 'qq' ? qqToken : token;
  tmplinkSettingsLoading = true;
  renderTmplinkSettings();
  const response = await tmplinkSettingsApi({ method: 'DELETE' });
  tmplinkSettingsLoading = false;
  if (!response.success) {
    renderTmplinkSettings();
    return showActionError(response, '移除 TMPLINK Token 失败');
  }
  tmplinkSettingsLoadedFor = source;
  tmplinkSettingsLoadedAccountToken = accountToken;
  tmplinkSettingsState = { configured: false };
  renderTmplinkSettings();
  showToast('已移除 TMPLINK Token');
}

function generationHistoryApi(platform, page) {
  const source = platform === 'qq' ? 'qq' : 'netease';
  const header = source === 'qq' ? 'X-QQ-Token' : 'X-Token';
  const value = source === 'qq' ? qqToken : token;
  return requestJson(
    '/api',
    `/generation-history?source=${source}&page=${Math.max(1, Number(page) || 1)}&limit=10`,
    {},
    'GENERATION_HISTORY',
    header,
    value
  );
}

function switchGenerationHistoryPlatform(platform) {
  generationHistoryPlatform = platform === 'qq' ? 'qq' : 'netease';
  localStorage.setItem(GENERATION_HISTORY_PLATFORM_KEY, generationHistoryPlatform);
  const neteaseButton = document.getElementById('generationHistoryNetease');
  const qqButton = document.getElementById('generationHistoryQQ');
  if (neteaseButton) neteaseButton.classList.toggle('active', generationHistoryPlatform === 'netease');
  if (qqButton) qqButton.classList.toggle('active', generationHistoryPlatform === 'qq');
  generationHistoryPage = 1;
  loadGenerationHistory(1);
}

function formatGenerationHistoryDate(value) {
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? String(value || '-') : date.toLocaleString();
}

function formatGenerationHistoryExpiration(value) {
  const generatedAt = new Date(value);
  if (Number.isNaN(generatedAt.getTime())) return '-';
  const expiresAt = new Date(generatedAt.getTime() + 7 * 24 * 60 * 60 * 1000);
  const remainingMs = expiresAt.getTime() - Date.now();
  const totalHours = Math.floor(Math.abs(remainingMs) / (60 * 60 * 1000));
  const days = Math.floor(totalHours / 24);
  const hours = totalHours % 24;
  return remainingMs >= 0 ? `${days}天${hours}小时后` : `已过期${days}天${hours}小时`;
}

function generationHistoryActionApi(source, jobId, action, options = {}) {
  const platform = source === 'qq' ? 'qq' : 'netease';
  const header = platform === 'qq' ? 'X-QQ-Token' : 'X-Token';
  const value = platform === 'qq' ? qqToken : token;
  return requestJson(
    '/api',
    `/generation-history/${encodeURIComponent(jobId)}/${action}?source=${platform}`,
    options,
    `GENERATION_HISTORY_${String(action).toUpperCase()}`,
    header,
    value
  );
}

function generationHistoryLinkStatusId(jobId) {
  return `generation-history-link-${String(jobId || '').replace(/[^A-Za-z0-9_-]/g, '')}`;
}

async function checkGenerationHistoryLink(item, source, sequence) {
  if (!item.publicUrl || sequence !== generationHistoryLoadSequence) return;
  const element = document.getElementById(generationHistoryLinkStatusId(item.jobId));
  if (!element) return;
  element.className = 'generation-history-link-status is-checking';
  element.textContent = '检测中…';
  const response = await generationHistoryActionApi(source, item.jobId, 'check-link', { method: 'POST', body: '{}' });
  if (sequence !== generationHistoryLoadSequence) return;
  const target = document.getElementById(generationHistoryLinkStatusId(item.jobId));
  if (!target) return;
  if (!response.success) {
    target.className = 'generation-history-link-status is-invalid';
    target.textContent = '检测失败';
    target.title = response.message || '';
    return;
  }
  const result = response.data || {};
  target.className = `generation-history-link-status ${result.valid ? 'is-valid' : 'is-invalid'}`;
  target.textContent = result.valid
    ? `有效 · HTTP ${result.statusCode || 200}`
    : `无效${result.statusCode ? ` · HTTP ${result.statusCode}` : ''}`;
  target.title = result.error || `检测时间：${formatGenerationHistoryDate(result.checkedAt)}`;
}

async function checkGenerationHistoryLinks(rows, source, sequence) {
  const pending = rows.filter((item) => item.publicUrl);
  let nextIndex = 0;
  async function worker() {
    while (sequence === generationHistoryLoadSequence) {
      const index = nextIndex++;
      if (index >= pending.length) return;
      await checkGenerationHistoryLink(pending[index], source, sequence);
    }
  }
  await Promise.all(Array.from({ length: Math.min(3, pending.length) }, () => worker()));
}

async function reuploadGenerationHistory(jobId, source, button) {
  if (button) {
    button.disabled = true;
    button.textContent = '正在加入…';
  }
  const callApi = source === 'qq' ? qqApi : api;
  const response = await callApi('/playlist-video/generation-jobs/reupload', {
    method: 'POST',
    body: JSON.stringify({ historyJobId: jobId })
  }, source === 'qq' ? 'QQ_GENERATION_REUPLOAD' : 'GENERATION_REUPLOAD');
  if (!response.success) {
    if (button) {
      button.disabled = false;
      button.textContent = '重新上传';
    }
    return showActionError(response, '重新上传任务创建失败');
  }
  if (button) button.textContent = '已加入队列';
  showToast('仅上传任务已加入生成队列，可在首页查看进度');
}

function copyGenerationHistoryValue(value) {
  const text = String(value || '');
  if (!text) return;
  if (navigator.clipboard && typeof navigator.clipboard.writeText === 'function') {
    navigator.clipboard.writeText(text).then(() => showToast('复制成功')).catch(() => fallbackCopyText(text));
  } else {
    fallbackCopyText(text);
  }
}

async function loadGenerationHistory(page = 1) {
  if (!isGenerationHistoryViewActive() || generationHistoryLoading) return;
  const list = document.getElementById('generationHistoryList');
  const pagination = document.getElementById('generationHistoryPagination');
  if (!list || !pagination) return;
  const source = generationHistoryPlatform === 'qq' ? 'qq' : 'netease';
  const loggedIn = source === 'qq' ? Boolean(qqToken) : Boolean(token);
  if (!loggedIn) {
    list.innerHTML = `<div class="empty">请先登录${source === 'qq' ? 'QQ 音乐' : '网易云音乐'}后查看生成记录</div>`;
    pagination.innerHTML = '';
    return;
  }

  generationHistoryLoading = true;
  const loadSequence = ++generationHistoryLoadSequence;
  generationHistoryPage = Math.max(1, Number(page) || 1);
  list.innerHTML = '<div style="text-align:center;padding:2rem"><span class="loading"></span></div>';
  pagination.innerHTML = '';
  const response = await generationHistoryApi(source, generationHistoryPage);
  generationHistoryLoading = false;
  if (!response.success) {
    return renderInlineError(list, response, '读取历史生成记录失败');
  }

  const rows = Array.isArray(response.data) ? response.data : [];
  if (rows.length === 0) {
    list.innerHTML = '<div class="empty">暂时没有生成记录</div>';
    return;
  }

  list.innerHTML = rows.map((item) => {
    const rawUrl = String(item.publicUrl || '');
    const publicUrl = /^https?:\/\//i.test(rawUrl) ? rawUrl : '';
    const localPath = String(item.localPath || '');
    const linkField = publicUrl
      ? `<div class="generation-history-link"><a href="${escapeHtml(publicUrl)}" target="_blank" rel="noopener noreferrer" title="${escapeHtml(publicUrl)}">${escapeHtml(publicUrl)}</a><span class="generation-history-link-status is-checking" id="${generationHistoryLinkStatusId(item.jobId)}">等待检测</span></div>`
      : `<code>${escapeHtml(item.uploadStatus === 'not_configured' ? '未配置 TMPLINK Token' : '未获取公开链接')}</code>`;
    return `
      <article class="generation-history-card">
        <img class="generation-history-cover" src="${imageSrc(item.playlistCover)}" alt="" referrerpolicy="no-referrer" loading="lazy">
        <div class="generation-history-content">
          <h3 class="generation-history-title">${escapeHtml(item.playlistName || '未命名歌单')}</h3>
          <div class="generation-history-author">作者：${escapeHtml(item.playlistCreator || '未知作者')}</div>
          <div class="generation-history-meta">
            <span>生成时间：${escapeHtml(formatGenerationHistoryDate(item.generatedAt))}</span>
            <span>生成耗时：${formatGenerationDuration(item.generationSeconds)}</span>
            <span>预计过期：${escapeHtml(formatGenerationHistoryExpiration(item.generatedAt))}</span>
          </div>
          <div class="generation-history-fields">
            <div class="generation-history-field">
              <span>公开链接</span>${linkField}
              ${publicUrl ? `<button class="btn btn-ghost generation-history-copy" type="button" data-value="${escapeHtml(publicUrl)}" onclick="copyGenerationHistoryValue(this.dataset.value)">复制</button>` : ''}
            </div>
            <div class="generation-history-field">
              <span>本地路径</span><code title="${escapeHtml(localPath)}">${escapeHtml(localPath || '-')}</code>
              ${localPath ? `<div class="generation-history-actions"><button class="btn btn-ghost generation-history-copy" type="button" data-value="${escapeHtml(localPath)}" onclick="copyGenerationHistoryValue(this.dataset.value)">复制</button><button class="btn btn-ghost generation-history-copy" type="button" onclick="reuploadGenerationHistory('${escapeHtml(item.jobId)}','${source}',this)">重新上传</button></div>` : ''}
            </div>
          </div>
        </div>
      </article>
    `;
  }).join('');
  renderPagination('generationHistoryPagination', Number(response.total) || 0, generationHistoryPage, Number(response.limit) || 10, 'loadGenerationHistory');
  checkGenerationHistoryLinks(rows, source, loadSequence);
}

function installGlobalUiErrorHandlers() {
  if (!MFU_ERROR || typeof MFU_ERROR.installGlobalErrorHandlers !== 'function') return;
  MFU_ERROR.installGlobalErrorHandlers({
    cooldownMs: 5000,
    onError: (errorLike) => {
      showActionError(errorLike, '页面出现未处理异常，请刷新重试');
    }
  });
}

function switchPlatform(platform) {
  if (currentPlatform === platform) return;
  currentPlatform = platform;

  const nBtn = document.getElementById('platformNetease');
  const qBtn = document.getElementById('platformQQ');
  if (nBtn) nBtn.classList.toggle('active', platform === 'netease');
  if (qBtn) qBtn.classList.toggle('active', platform === 'qq');

  const input = document.getElementById('playlistInput');
  if (input) {
    input.value = '';
    input.placeholder = platform === 'qq'
      ? '粘贴QQ音乐歌单/单曲链接或歌单ID'
      : '粘贴网易云歌单/单曲链接或歌单ID';
  }

  const result = document.getElementById('resultSection');
  if (result) result.classList.remove('show');
  currentPlaylist = null;
  lastGeneratedUrl = '';
  lastGeneratedUrls = [];
  generationRequestSequence++;
}

function renderGeneratedLocalPath(localPath = '') {
  const container = document.getElementById('generatedLocalPath');
  const value = document.getElementById('generatedLocalPathValue');
  if (!container || !value) return;
  const normalized = String(localPath || '').trim();
  value.textContent = normalized;
  value.title = normalized;
  container.hidden = !normalized;
}

function restorePlatformTab() {
  const nBtn = document.getElementById('platformNetease');
  const qBtn = document.getElementById('platformQQ');
  if (nBtn) nBtn.classList.toggle('active', currentPlatform === 'netease');
  if (qBtn) qBtn.classList.toggle('active', currentPlatform === 'qq');

  const input = document.getElementById('playlistInput');
  if (input) {
    input.placeholder = currentPlatform === 'qq'
      ? '粘贴QQ音乐歌单/单曲链接或歌单ID'
      : '粘贴网易云歌单/单曲链接或歌单ID';
  }
}

async function checkLoginStatus() {
  const res = await api('/auth/status', {}, 'AUTH_STATUS');
  if (res.success && res.data.logged) {
    currentUser = res.data.user;
    updateUserUI();
    refreshPersonalCenterIfActive();
  } else if (res.success && !res.data.logged) {
    logout(false);
  } else if (res && res._errorMeta && res._errorMeta.status === 401) {
    logout(false);
  }
}

function updateUserUI() {
  const area = document.getElementById('userArea');
  if (!area) return;

  const hasNetease = !!currentUser;
  const hasQQ = !!qqCurrentUser;

  if (!hasNetease && !hasQQ) {
    area.innerHTML = `<button class="btn btn-primary" onclick="showLogin()">登录</button>`;
    if (isUserViewActive()) navigate('/', { replace: true });
    return;
  }

  area.innerHTML = `<button class="btn btn-primary" onclick="navigate('/user')">个人中心</button>`;
}

function logout(notify = true) {
  if (token) {
    api('/auth/logout', { method: 'POST' }, 'AUTH_LOGOUT');
  }
  token = '';
  currentUser = null;
  userPlaylists = [];
  localStorage.removeItem('token');
  updateUserUI();
  refreshPersonalCenterIfActive();
  if (notify) showToast('已退出网易云登录');
}

function showLogin(platform) {
  const modal = document.getElementById('loginModal');
  if (modal) {
    modal.classList.add('show');
    switchLoginPlatform(platform || currentPlatform || 'netease');
  }
}

function hideLogin() {
  const modal = document.getElementById('loginModal');
  if (modal) modal.classList.remove('show');
  if (qrCheckInterval) {
    clearInterval(qrCheckInterval);
    qrCheckInterval = null;
  }
  if (qqQrCheckInterval) {
    clearInterval(qqQrCheckInterval);
    qqQrCheckInterval = null;
  }
}

function switchLoginPlatform(platform) {
  loginPlatform = platform;

  const nBtn = document.getElementById('loginPlatformNetease');
  const qBtn = document.getElementById('loginPlatformQQ');
  if (nBtn) nBtn.classList.toggle('active', platform === 'netease');
  if (qBtn) qBtn.classList.toggle('active', platform === 'qq');

  const nPanel = document.getElementById('neteaseLoginPanel');
  const qPanel = document.getElementById('qqLoginPanel');
  if (nPanel) nPanel.style.display = platform === 'netease' ? '' : 'none';
  if (qPanel) qPanel.style.display = platform === 'qq' ? '' : 'none';

  const title = document.getElementById('loginModalTitle');
  if (title) title.textContent = platform === 'qq' ? '登录QQ音乐' : '登录网易云';

  if (platform === 'netease') {
    switchLoginTab('qrcode');
    if (qqQrCheckInterval) { clearInterval(qqQrCheckInterval); qqQrCheckInterval = null; }
  } else {
    loadQQQRCode();
    if (qrCheckInterval) { clearInterval(qrCheckInterval); qrCheckInterval = null; }
  }
}

function switchLoginTab(tab) {
  const panel = document.getElementById('neteaseLoginPanel');
  if (!panel) return;

  panel.querySelectorAll('.login-tab').forEach(t => t.classList.remove('active'));
  panel.querySelectorAll('.login-content').forEach(c => c.classList.remove('active'));

  const tabs = ['qrcode', 'captcha', 'password', 'cookie'];
  const index = tabs.indexOf(tab);

  const tabBtns = panel.querySelectorAll('.login-tab');
  if (tabBtns[index]) tabBtns[index].classList.add('active');

  const content = document.getElementById(tab + 'Content');
  if (content) content.classList.add('active');

  if (tab === 'qrcode') {
    loadQRCode();
  } else if (qrCheckInterval) {
    clearInterval(qrCheckInterval);
    qrCheckInterval = null;
  }
}

async function loadQRCode() {
  const img = document.getElementById('qrCodeImg');
  const status = document.getElementById('qrStatus');
  if (!img || !status) return;
  
  img.src = '/placeholder.svg';
  status.textContent = '加载中...';
  
  const res = await api('/auth/qrcode', {}, 'AUTH_QRCODE');
  if (!res.success) {
    status.textContent = toErrorDisplay(res, '获取二维码失败，请重试');
    return;
  }
  
  qrKey = res.data.key;
  img.src = res.data.qrimg;
  status.textContent = '请使用APP扫码';
  
  if (qrCheckInterval) clearInterval(qrCheckInterval);
  qrCheckInterval = setInterval(checkQRCode, 2000);
}

async function checkQRCode() {
  if (!qrKey) return;
  const res = await api('/auth/qrcode/check?key=' + qrKey, {}, 'AUTH_QRCODE_CHECK');
  const status = document.getElementById('qrStatus');

  if (!res.success) {
    if (status) status.textContent = toErrorDisplay(res, '二维码状态检查失败，正在重试…');
    clearInterval(qrCheckInterval);
    setTimeout(loadQRCode, 1000);
    return;
  }
  
  if (res.code === 800) {
    if (status) status.textContent = '二维码过期，请刷新';
    clearInterval(qrCheckInterval);
    setTimeout(loadQRCode, 1000);
  } else if (res.code === 801) {
    if (status) status.textContent = '请使用APP扫码';
  } else if (res.code === 802) {
    if (status) status.textContent = '扫码成功，请确认';
  } else if (res.code === 803) {
    clearInterval(qrCheckInterval);
    token = res.data.token;
    currentUser = res.data.user;
    localStorage.setItem('token', token);
    rememberPersonalPlatform('netease');
    hideLogin();
    updateUserUI();
    refreshPersonalCenterIfActive();
    showToast('登录成功');
  }
}

async function sendCaptcha() {
  const phoneInput = document.getElementById('captchaPhone');
  const btn = document.getElementById('sendCaptchaBtn');
  if (!phoneInput || !btn) return;

  const phone = phoneInput.value;
  if (!phone) return showToast('输入手机号', 'error');
  
  btn.disabled = true;
  
  const res = await api('/auth/captcha/send', {
    method: 'POST',
    body: JSON.stringify({ phone })
  }, 'AUTH_CAPTCHA_SEND');
  
  if (res.success) {
    showToast('验证码已发送');
    let countdown = 60;
    const interval = setInterval(() => {
      btn.textContent = countdown + 's';
      countdown--;
      if (countdown < 0) {
        clearInterval(interval);
        btn.textContent = '发送';
        btn.disabled = false;
      }
    }, 1000);
  } else {
    showActionError(res, '发送验证码失败');
    btn.disabled = false;
  }
}

async function loginWithCaptcha() {
  const phone = document.getElementById('captchaPhone').value;
  const captcha = document.getElementById('captchaCode').value;
  if (!phone || !captcha) return showToast('请填写完整', 'error');
  
  const res = await api('/auth/login/captcha', {
    method: 'POST',
    body: JSON.stringify({ phone, captcha })
  }, 'AUTH_LOGIN_CAPTCHA');
  
  if (res.success) {
    token = res.data.token;
    currentUser = res.data.user;
    localStorage.setItem('token', token);
    rememberPersonalPlatform('netease');
    hideLogin();
    updateUserUI();
    refreshPersonalCenterIfActive();
    showToast('登录成功');
  } else {
    showActionError(res, '验证码登录失败');
  }
}

async function loginWithPassword() {
  const phone = document.getElementById('passwordPhone').value;
  const password = document.getElementById('passwordInput').value;
  if (!phone || !password) return showToast('请填写完整', 'error');
  
  const res = await api('/auth/login/password', {
    method: 'POST',
    body: JSON.stringify({ phone, password })
  }, 'AUTH_LOGIN_PASSWORD');
  
  if (res.success) {
    token = res.data.token;
    currentUser = res.data.user;
    localStorage.setItem('token', token);
    rememberPersonalPlatform('netease');
    hideLogin();
    updateUserUI();
    refreshPersonalCenterIfActive();
    showToast('登录成功');
  } else {
    showActionError(res, '密码登录失败');
  }
}

async function loginWithCookie() {
  const cookie = document.getElementById('cookieInput').value;
  if (!cookie) return showToast('请输入Cookie', 'error');
  
  const res = await api('/auth/login/cookie', {
    method: 'POST',
    body: JSON.stringify({ cookie })
  }, 'AUTH_LOGIN_COOKIE');
  
  if (res.success) {
    token = res.data.token;
    currentUser = res.data.user;
    localStorage.setItem('token', token);
    rememberPersonalPlatform('netease');
    hideLogin();
    updateUserUI();
    refreshPersonalCenterIfActive();
    showToast('登录成功');
  } else {
    showActionError(res, 'Cookie登录失败');
  }
}

async function loadQQQRCode() {
  const img = document.getElementById('qqQrCodeImg');
  const status = document.getElementById('qqQrStatus');
  if (!img || !status) return;

  img.src = '/placeholder.svg';
  status.textContent = '加载中...';

  const res = await qqApi('/auth/qrcode', {}, 'QQ_AUTH_QRCODE');
  if (!res.success) {
    status.textContent = toErrorDisplay(res, '获取QQ二维码失败，请重试');
    return;
  }

  qqQrKey = res.data.key;
  img.src = res.data.qrimg;
  status.textContent = '请使用QQ扫码';

  if (qqQrCheckInterval) clearInterval(qqQrCheckInterval);
  qqQrCheckInterval = setInterval(checkQQQRCode, 2000);
}

async function checkQQQRCode() {
  if (!qqQrKey) return;
  const res = await qqApi('/auth/qrcode/check?key=' + qqQrKey, {}, 'QQ_AUTH_QRCODE_CHECK');
  const status = document.getElementById('qqQrStatus');

  if (res.success === false) {
    const message = toErrorDisplay(res, res.code === 804
      ? '登录成功但会话初始化失败，请重试扫码'
      : '二维码已失效');
    if (status) status.textContent = message.includes('刷新') ? message : `${message}，正在刷新…`;
    clearInterval(qqQrCheckInterval);
    setTimeout(loadQQQRCode, 1000);
  } else if (res.code === 800) {
    if (status) status.textContent = '二维码过期，请刷新';
    clearInterval(qqQrCheckInterval);
    setTimeout(loadQQQRCode, 1000);
  } else if (res.code === 801) {
    if (status) status.textContent = '请使用QQ扫码';
  } else if (res.code === 802) {
    if (status) status.textContent = '扫码成功，请确认';
  } else if (res.code === 804) {
    const message = toErrorDisplay(res, '登录成功但会话初始化失败，请重试扫码');
    if (status) status.textContent = `${message}，正在刷新…`;
    clearInterval(qqQrCheckInterval);
    setTimeout(loadQQQRCode, 1000);
  } else if (res.code === 803) {
    clearInterval(qqQrCheckInterval);
    qqToken = res.data.token;
    qqCurrentUser = res.data.user;
    localStorage.setItem('qqToken', qqToken);
    rememberPersonalPlatform('qq');
    hideLogin();
    updateUserUI();
    refreshPersonalCenterIfActive();
    showToast('QQ音乐登录成功');
    navigate('/user');
  } else {
    console.warn('QQ扫码未知状态:', res);
  }
}

async function checkQQLoginStatus() {
  const res = await qqApi('/auth/status', {}, 'QQ_AUTH_STATUS');
  if (res.success && res.data.logged) {
    qqCurrentUser = res.data.user;
    updateUserUI();
    refreshPersonalCenterIfActive();
  } else if (res.success && !res.data.logged) {
    logoutQQ(false);
  } else if (res && res._errorMeta && res._errorMeta.status === 401) {
    logoutQQ(false);
  }
}

function logoutQQ(notify = true) {
  if (qqToken) {
    qqApi('/auth/logout', { method: 'POST' }, 'QQ_AUTH_LOGOUT');
  }
  qqToken = '';
  qqCurrentUser = null;
  qqUserPlaylists = [];
  qqUserFavorites = [];
  qqUserHistory = [];
  qqPlaylistTotal = 0;
  qqFavoriteTotal = 0;
  qqHistoryTotal = 0;
  qqPlaylistPage = 1;
  qqFavoritePage = 1;
  qqHistoryPage = 1;
  localStorage.removeItem('qqToken');
  updateUserUI();
  refreshPersonalCenterIfActive();
  if (notify) showToast('已退出QQ音乐登录');
}

function formatGenerationDuration(seconds) {
  const total = Math.max(0, Math.floor(Number(seconds) || 0));
  const hours = Math.floor(total / 3600);
  const minutes = Math.floor((total % 3600) / 60);
  const secs = total % 60;
  return hours > 0
    ? `${String(hours).padStart(2, '0')}:${String(minutes).padStart(2, '0')}:${String(secs).padStart(2, '0')}`
    : `${String(minutes).padStart(2, '0')}:${String(secs).padStart(2, '0')}`;
}

function updateUploadProgress(job = {}) {
  const container = document.getElementById('uploadProgress');
  const status = document.getElementById('uploadStatus');
  const percent = document.getElementById('uploadPercent');
  const track = document.getElementById('uploadProgressTrack');
  const bar = document.getElementById('uploadProgressBar');
  const message = document.getElementById('uploadProgressMessage');
  if (!container) return;
  const uploadStatus = String(job.uploadStatus || 'waiting');
  const shouldShow = Boolean(job.localPath) && uploadStatus !== 'waiting';
  container.hidden = !shouldShow;
  if (!shouldShow) return;
  const value = Math.max(0, Math.min(100, Number(job.uploadPercent) || 0));
  const failed = uploadStatus === 'failed' || uploadStatus === 'not_configured' || job.status === 'upload_failed';
  const completed = uploadStatus === 'completed' && Boolean(job.publicUrl);
  container.classList.toggle('is-failed', failed);
  container.classList.toggle('is-complete', completed);
  if (status) status.textContent = completed ? '公开链接上传完成' : (failed ? '公开链接上传未完成' : '正在上传获取公开链接');
  if (percent) percent.textContent = `${Math.round(value)}%`;
  if (bar) bar.style.width = `${value}%`;
  if (track) track.setAttribute('aria-valuenow', String(Math.round(value)));
  if (message) message.textContent = job.uploadError || job.uploadMessage || '正在准备上传视频';
}

function renderSkippedSongs(job = {}) {
  const container = document.getElementById('generatedSkippedSongs');
  const title = document.getElementById('generatedSkippedSongsTitle');
  const list = document.getElementById('generatedSkippedSongsList');
  if (!container || !list) return;
  const songs = Array.isArray(job.skippedSongs) ? job.skippedSongs : [];
  container.hidden = songs.length === 0;
  if (songs.length === 0) {
    list.innerHTML = '';
    return;
  }
  if (title) title.textContent = `已跳过 ${songs.length} 首不可播放歌曲`;
  list.innerHTML = songs.map((song) => {
    const index = Math.max(1, Number(song?.index) || 1);
    const name = escapeHtml(song?.name || song?.id || '未知歌曲');
    const reason = escapeHtml(song?.reason || '当前不可播放');
    return `<li><span>${index}. ${name}</span><small>${reason}</small></li>`;
  }).join('');
}

function updateGenerationProgress(job = {}) {
  const progress = document.getElementById('generationProgress');
  const status = document.getElementById('generationStatus');
  const percent = document.getElementById('generationPercent');
  const bar = document.getElementById('generationProgressBar');
  const track = progress?.querySelector('.generation-progress-track');
  const currentSong = document.getElementById('generationCurrentSong');
  const count = document.getElementById('generationCount');
  const elapsed = document.getElementById('generationElapsed');
  const eta = document.getElementById('generationEta');
  const cancelButton = document.getElementById('cancelGenerationBtn');
  const value = Math.max(0, Math.min(100, Number(job.percent) || 0));

  if (progress) {
    progress.classList.toggle('is-complete', job.status === 'completed' || Boolean(job.localPath));
    progress.classList.toggle('is-failed', job.status === 'failed');
    progress.classList.toggle('is-cancelled', job.status === 'cancelled');
  }
  if (status) {
    const baseStatus = job.message || (job.status === 'queued' ? '等待生成' : '正在生成视频');
    const encoderStatus = job.encoder
      ? ` · ${job.encoder}${job.gpu ? ' GPU' : ''}${job.concurrency > 1 ? ` · ${job.concurrency} 路并行` : ''}`
      : '';
    status.textContent = `${baseStatus}${encoderStatus}`;
  }
  if (percent) percent.textContent = `${Math.round(value)}%`;
  if (bar) bar.style.width = `${value}%`;
  if (track) track.setAttribute('aria-valuenow', String(Math.round(value)));
  if (currentSong) currentSong.textContent = job.currentSong ? `当前：${job.currentSong}` : (job.message || '正在准备…');
  if (count) {
    const processed = Number.isFinite(Number(job.processed))
      ? Number(job.processed)
      : (Number(job.completed) || 0) + (Number(job.skipped) || 0);
    count.textContent = `${processed} / ${Number(job.total) || 0}${Number(job.skipped) > 0 ? `（跳过 ${Number(job.skipped)}）` : ''}`;
  }
  if (elapsed) elapsed.textContent = formatGenerationDuration(job.elapsedSeconds);
  if (eta) {
    if (job.status === 'completed' || job.localPath) eta.textContent = '已完成';
    else if (job.status === 'finalizing') eta.textContent = '正在合并…';
    else if (job.status === 'failed' || job.status === 'cancelled') eta.textContent = '--';
    else if (Number.isFinite(Number(job.etaSeconds))) eta.textContent = formatGenerationDuration(job.etaSeconds);
    else eta.textContent = '计算中…';
  }
  if (job.cancelPath) activeGenerationCancelPath = String(job.cancelPath);
  if (job.localPath) {
    lastGeneratedLocalPath = String(job.localPath);
  } else if (['queued', 'running', 'failed', 'cancelled'].includes(job.status)) {
    lastGeneratedLocalPath = '';
  }
  renderGeneratedLocalPath(lastGeneratedLocalPath);
  renderSkippedSongs(job);
  updateUploadProgress(job);
  const cancellable = Boolean(job.canCancel && activeGenerationCancelPath);
  if (cancelButton) {
    cancelButton.hidden = !cancellable;
    cancelButton.disabled = generationCancelInFlight || job.status === 'cancelling';
    cancelButton.textContent = job.status === 'cancelling' ? '正在取消…' : '取消生成';
  }
  if (['completed', 'failed', 'cancelled', 'upload_failed', 'uploading', 'resolving_link'].includes(job.status)) activeGenerationCancelPath = '';
}

async function requestGeneration(path, options = {}) {
  const response = await fetch(path, {
    credentials: 'same-origin',
    headers: { 'Content-Type': 'application/json', ...(options.headers || {}) },
    ...options
  });
  let payload;
  try { payload = await response.json(); } catch (_) { payload = null; }
  if (!response.ok || !payload?.success) {
    throw new Error(payload?.message || payload?.error || `生成服务返回 ${response.status}`);
  }
  return payload.data;
}

function isActiveGenerationJob(job) {
  return ['queued', 'running', 'finalizing', 'cancelling', 'waiting_upload', 'uploading', 'resolving_link'].includes(job?.status);
}

function generationTaskStatus(job) {
  const position = Math.max(0, Number(job.queuePosition) || 0);
  const labels = {
    running: '生成中',
    finalizing: '正在合并',
    cancelling: '正在取消',
    waiting_upload: '等待上传',
    uploading: '正在上传',
    resolving_link: '正在获取直链',
    completed: '已完成',
    upload_failed: '本地已完成',
    failed: '生成失败',
    cancelled: '已取消'
  };
  if (job.status === 'queued' || job.status === 'waiting_upload') {
    if (job.status === 'waiting_upload') {
      return position <= 1 ? '等待上传 · 下一个开始' : `等待上传 · 前面 ${position - 1} 个任务`;
    }
    return position <= 1 ? '排队中 · 下一个开始' : `排队中 · 前面 ${position - 1} 个任务`;
  }
  return labels[job.status] || job.message || '等待中';
}

function generationTaskMeta(job) {
  const quality = { low: '低音质', medium: '中音质', high: '高音质' }[job.quality] || '高音质';
  const mode = job.mode === 'ultra_fast' ? '极速' : (job.mode === 'fast' ? '平衡' : '质量');
  const source = job.source === 'qq' ? 'QQ音乐' : '网易云';
  if (job.taskType === 'upload_only') return `${source} · 仅上传本地视频`;
  return `${source} · ${quality} · ${mode} · ${escapeHtml(job.resolution || '')} · ${Number(job.fps) || 1}FPS · 音量 ${Number.isFinite(Number(job.volume)) ? Number(job.volume) : 100}% · ${Number(job.requestedConcurrency) || 4} 并发`;
}

function generationTaskOutput(job) {
  const rows = [];
  const localPath = String(job.localPath || '');
  const publicUrl = escapeUrl(job.publicUrl || '');
  if (localPath) {
    rows.push(`
      <div class="generation-task-output-row">
        <span class="generation-task-output-label">本地路径</span>
        <code title="${escapeHtml(localPath)}">${escapeHtml(localPath)}</code>
        <button class="btn btn-ghost generation-task-copy" type="button" data-value="${escapeHtml(localPath)}" onclick="copyGenerationTaskValue(this)">复制</button>
      </div>`);
  }
  if (publicUrl) {
    rows.push(`
      <div class="generation-task-output-row">
        <span class="generation-task-output-label">公开直链</span>
        <a href="${publicUrl}" target="_blank" rel="noopener noreferrer" title="${publicUrl}">${publicUrl}</a>
        <button class="btn btn-ghost generation-task-copy" type="button" data-value="${publicUrl}" onclick="copyGenerationTaskValue(this)">复制</button>
      </div>`);
  }
  if (job.uploadError && job.status === 'upload_failed') {
    rows.push(`<div class="generation-task-current">公开链接：${escapeHtml(job.uploadError)}</div>`);
  }
  return rows.length ? `<div class="generation-task-output">${rows.join('')}</div>` : '';
}

function generationTaskSkippedSongs(job) {
  const songs = Array.isArray(job.skippedSongs) ? job.skippedSongs : [];
  if (songs.length === 0) return '';
  const items = songs.map((song) =>
    `<li><span>${Number(song.index) || '-'} · ${escapeHtml(song.name || song.id || '未知歌曲')}</span><small>${escapeHtml(song.reason || '当前不可播放')}</small></li>`
  ).join('');
  return `
    <details class="generation-task-skipped">
      <summary>已跳过 ${songs.length} 首不可播放歌曲</summary>
      <ul>${items}</ul>
    </details>`;
}

function renderGenerationJobs() {
  const panel = document.getElementById('generationQueuePanel');
  const container = document.getElementById('generationQueueList');
  const summary = document.getElementById('generationQueueSummary');
  if (!panel || !container || !summary) return;

  const jobs = Array.from(generationJobs.values()).sort((left, right) => {
    const leftActive = isActiveGenerationJob(left);
    const rightActive = isActiveGenerationJob(right);
    if (leftActive !== rightActive) return leftActive ? -1 : 1;
    if (left.status === 'running' || left.status === 'finalizing' || left.status === 'uploading' || left.status === 'resolving_link') return -1;
    if (right.status === 'running' || right.status === 'finalizing' || right.status === 'uploading' || right.status === 'resolving_link') return 1;
    if (['queued', 'waiting_upload'].includes(left.status) && ['queued', 'waiting_upload'].includes(right.status)) {
      return (Number(left.queuePosition) || 9999) - (Number(right.queuePosition) || 9999);
    }
    return (Number(right.createdAt) || 0) - (Number(left.createdAt) || 0);
  });
  panel.hidden = jobs.length === 0;
  if (jobs.length === 0) {
    container.innerHTML = '';
    summary.textContent = '';
    return;
  }

  const activeCount = jobs.filter(isActiveGenerationJob).length;
  const queuedCount = jobs.filter((job) => job.status === 'queued' || job.status === 'waiting_upload').length;
  summary.textContent = activeCount ? `${activeCount} 个进行中 · ${queuedCount} 个排队` : `最近 ${jobs.length} 个任务`;

  container.innerHTML = jobs.map((job) => {
    const percent = Math.max(0, Math.min(100, Number(job.percent) || 0));
    const processed = Number.isFinite(Number(job.processed)) ? Number(job.processed) : Number(job.completed) || 0;
    const total = Number(job.total) || 0;
    const current = job.error || job.currentSong || job.uploadMessage || job.message || generationTaskStatus(job);
    const eta = Number.isFinite(Number(job.etaSeconds)) ? formatGenerationDuration(job.etaSeconds) : '--';
    const uploadText = ['uploading', 'resolving_link'].includes(job.status)
      ? ` · 上传 ${Math.round(Number(job.uploadPercent) || 0)}%`
      : '';
    const cancelButton = job.canCancel
      ? `<button class="btn generation-task-cancel" type="button" data-job-id="${escapeHtml(job.id)}" data-source="${escapeHtml(job.source)}" onclick="cancelGenerationJob(this)" ${generationJobCancelsInFlight.has(job.id) || job.status === 'cancelling' ? 'disabled' : ''}>${job.status === 'queued' ? '取消排队' : (job.status === 'waiting_upload' ? '取消上传' : (job.status === 'cancelling' ? '正在取消…' : '取消任务'))}</button>`
      : '';
    const confirmButton = job.canDismiss
      ? `<button class="btn btn-ghost generation-task-confirm" type="button" data-job-id="${escapeHtml(job.id)}" data-source="${escapeHtml(job.source)}" onclick="confirmGenerationJob(this)">确认</button>`
      : '';
    const countText = job.taskType === 'upload_only'
      ? `仅上传${['uploading', 'resolving_link'].includes(job.status) ? ` · ${Math.round(Number(job.uploadPercent) || 0)}%` : ''}`
      : `${processed} / ${total}${Number(job.skipped) > 0 ? ` · 跳过 ${Number(job.skipped)}` : ''}${uploadText}`;
    return `
      <article class="generation-task-card is-${escapeHtml(job.status || 'queued')}">
        <div class="generation-task-head">
          <div class="generation-task-identity">
            <img class="generation-task-cover" src="${imageSrc(job.playlistCover)}" alt="" referrerpolicy="no-referrer">
            <div>
              <div class="generation-task-title">${escapeHtml(job.playlistName || `歌单 ${job.playlistId || ''}`)}</div>
              <div class="generation-task-meta">${escapeHtml(job.playlistCreator || '未知作者')}</div>
              <div class="generation-task-meta">${generationTaskMeta(job)}</div>
            </div>
          </div>
          <span class="generation-task-status">${escapeHtml(generationTaskStatus(job))}</span>
        </div>
        <div class="generation-task-status-row">
          <span>${countText}</span>
          <strong class="generation-task-percent">${Math.round(percent)}%</strong>
        </div>
        <div class="generation-progress-track" role="progressbar" aria-valuemin="0" aria-valuemax="100" aria-valuenow="${Math.round(percent)}">
          <div class="generation-progress-bar" style="width:${percent}%"></div>
        </div>
        <div class="generation-task-current" title="${escapeHtml(current)}">${escapeHtml(current)}</div>
        <div class="generation-task-footer">
          <div class="generation-task-timing"><span>已用 ${formatGenerationDuration(job.elapsedSeconds)}</span><span>预计还需 ${isActiveGenerationJob(job) ? eta : '--'}</span></div>
          <div class="generation-task-actions">${cancelButton}${confirmButton}</div>
        </div>
        ${generationTaskSkippedSongs(job)}
        ${generationTaskOutput(job)}
      </article>`;
  }).join('');
}

async function copyGenerationTaskValue(button) {
  const value = String(button?.dataset?.value || '');
  if (!value) return;
  try {
    await navigator.clipboard.writeText(value);
    showToast('复制成功');
  } catch (_) {
    fallbackCopyText(value);
  }
}

async function cancelGenerationJob(button) {
  const jobId = String(button?.dataset?.jobId || '');
  const source = button?.dataset?.source === 'qq' ? 'qq' : 'netease';
  if (!jobId || generationJobCancelsInFlight.has(jobId)) return;
  generationJobCancelsInFlight.add(jobId);
  renderGenerationJobs();
  try {
    const callApi = source === 'qq' ? qqApi : api;
    const response = await callApi(`/playlist-video/generation-jobs/${encodeURIComponent(jobId)}/cancel`, { method: 'POST', body: '{}' }, 'GENERATION_JOB_CANCEL');
    if (!response.success) throw new Error(response.message || '取消任务失败');
    const job = response.data;
    generationJobs.set(`${job.source}:${job.id}`, job);
    renderGenerationJobs();
    showToast(job.status === 'cancelled' ? '已取消排队任务' : '正在取消生成任务');
  } catch (error) {
    showToast(error?.message || '取消任务失败', 'error');
  } finally {
    generationJobCancelsInFlight.delete(jobId);
    loadGenerationJobs();
  }
}

async function confirmGenerationJob(button) {
  const jobId = String(button?.dataset?.jobId || '');
  const source = button?.dataset?.source === 'qq' ? 'qq' : 'netease';
  if (!jobId) return;
  button.disabled = true;
  button.textContent = '确认中…';
  const callApi = source === 'qq' ? qqApi : api;
  const response = await callApi(`/playlist-video/generation-jobs/${encodeURIComponent(jobId)}/dismiss`, { method: 'POST', body: '{}' }, 'GENERATION_JOB_DISMISS');
  if (!response.success) {
    button.disabled = false;
    button.textContent = '确认';
    return showActionError(response, '确认任务失败');
  }
  generationJobs.delete(`${source}:${jobId}`);
  renderGenerationJobs();
}

async function loadGenerationJobs() {
  if (generationJobsPollInFlight) return;
  generationJobsPollInFlight = true;
  try {
    const requests = [];
    if (token) requests.push(api('/playlist-video/generation-jobs', {}, 'GENERATION_JOBS'));
    if (qqToken) requests.push(qqApi('/playlist-video/generation-jobs', {}, 'QQ_GENERATION_JOBS'));
    const responses = await Promise.all(requests);
    const nextJobs = new Map();
    for (const response of responses) {
      if (!response?.success || !Array.isArray(response.data?.jobs)) continue;
      for (const job of response.data.jobs) nextJobs.set(`${job.source}:${job.id}`, job);
    }
    generationJobs.clear();
    for (const [key, job] of nextJobs) generationJobs.set(key, job);
    renderGenerationJobs();
  } finally {
    generationJobsPollInFlight = false;
    if (resolveViewFromPath(window.location.pathname) === 'home') {
      const hasActive = Array.from(generationJobs.values()).some(isActiveGenerationJob);
      generationJobsPollTimer = setTimeout(loadGenerationJobs, hasActive ? 1000 : 5000);
    }
  }
}

function startGenerationJobsPolling() {
  stopGenerationJobsPolling();
  loadGenerationJobs();
}

function stopGenerationJobsPolling() {
  if (generationJobsPollTimer) clearTimeout(generationJobsPollTimer);
  generationJobsPollTimer = null;
}

function waitForGenerationPoll() {
  return new Promise((resolve) => setTimeout(resolve, 1000));
}

async function generateEntirePlaylist(generationPath, requestSequence, button) {
  let job = await requestGeneration(generationPath, { method: 'POST', body: '{}' });
  updateGenerationProgress(job);
  while (['queued', 'running', 'finalizing', 'cancelling', 'uploading', 'resolving_link'].includes(job.status)) {
    if (requestSequence !== generationRequestSequence) throw new Error('生成任务已取消显示');
    button.innerHTML = ['uploading', 'resolving_link'].includes(job.status)
      ? `上传中 ${Math.round(Number(job.uploadPercent) || 0)}%`
      : `生成中 ${Math.round(Number(job.percent) || 0)}%`;
    await waitForGenerationPoll();
    job = await requestGeneration(job.statusPath);
    updateGenerationProgress(job);
  }
  if (job.status === 'cancelled') {
    const error = new Error('生成已取消');
    error.code = 'GENERATION_CANCELLED';
    error.job = job;
    throw error;
  }
  if (job.status === 'upload_failed' && job.localPath) return job;
  if (job.status !== 'completed') throw new Error(job.error || '整张歌单生成失败');
  return job;
}

function syncGenerationOptionAvailability() {
  const selectedMode = document.querySelector('input[name="generationMode"]:checked')?.value;
  const fixedFpsMode = selectedMode === 'fast' || selectedMode === 'ultra_fast';
  const fpsGroup = document.querySelector('.generation-fps');
  const fpsInputs = document.querySelectorAll('input[name="generationFps"]');
  const notice = document.getElementById('fastFpsNotice');
  fpsInputs.forEach((input) => { input.disabled = fixedFpsMode; });
  if (fpsGroup) fpsGroup.classList.toggle('is-fast-locked', fixedFpsMode);
  if (notice) notice.hidden = !fixedFpsMode;
}

function syncGenerationVolumeDisplay(value) {
  const volume = Math.max(0, Math.min(200, Math.round(Number(value) || 0)));
  const output = document.getElementById('generationVolumeValue');
  if (output) output.textContent = `${volume}%`;
}

function confirmHighConcurrencySelection(input) {
  if (!input?.checked) return;
  const nextConcurrency = Number(input.value);
  if (![8, 16].includes(nextConcurrency) || localStorage.getItem(HIGH_CONCURRENCY_WARNING_KEY) === '1') {
    lastGenerationConcurrency = nextConcurrency;
    return;
  }
  const accepted = window.confirm(
    `${nextConcurrency} 并发会明显增加 CPU、显存、内存和网络压力，可能导致生成不稳定或失败。是否继续？`
  );
  if (accepted) {
    localStorage.setItem(HIGH_CONCURRENCY_WARNING_KEY, '1');
    lastGenerationConcurrency = nextConcurrency;
    return;
  }
  const fallback = document.querySelector(`input[name="generationConcurrency"][value="${lastGenerationConcurrency}"]`)
    || document.querySelector('input[name="generationConcurrency"][value="4"]');
  if (fallback) fallback.checked = true;
}

async function cancelGeneration() {
  if (!activeGenerationCancelPath || generationCancelInFlight) return;
  generationCancelInFlight = true;
  const button = document.getElementById('cancelGenerationBtn');
  if (button) {
    button.disabled = true;
    button.textContent = '正在取消…';
  }
  try {
    const job = await requestGeneration(activeGenerationCancelPath, { method: 'POST', body: '{}' });
    updateGenerationProgress(job);
    showToast('正在取消生成，已完成的歌曲会保留');
  } catch (error) {
    showToast(error?.message || '取消生成失败', 'error');
  } finally {
    generationCancelInFlight = false;
    if (button && !button.hidden && button.textContent !== '正在取消…') button.disabled = false;
  }
}

async function generatePlaylist() {
  if (currentPlatform === 'qq') {
    if (!qqToken) return showToast('请先登录QQ音乐', 'error');
  } else {
    if (!token) return showToast('请先登录网易云', 'error');
  }

  const input = document.getElementById('playlistInput').value.trim();
  if (!input) return showToast('请输入链接', 'error');

  const btn = document.getElementById('generateBtn');
  const originalText = btn.innerHTML;
  btn.innerHTML = '<span class="loading"></span>';
  btn.disabled = true;

  try {
    const isQQ = currentPlatform === 'qq';
    const callApi = isQQ ? qqApi : api;
    const generationOrder = document.querySelector('input[name="generationOrder"]:checked')?.value === 'shuffle'
      ? 'shuffle'
      : 'sequential';
    const selectedGenerationMode = document.querySelector('input[name="generationMode"]:checked')?.value;
    const generationMode = ['fast', 'ultra_fast'].includes(selectedGenerationMode)
      ? selectedGenerationMode
      : '';
    const generationQualityValue = document.querySelector('input[name="generationQuality"]:checked')?.value;
    const generationQuality = ['low', 'medium', 'high'].includes(generationQualityValue)
      ? generationQualityValue
      : 'high';
    const generationResolution = document.querySelector('input[name="generationResolution"]:checked')?.value === '1920x1080'
      ? '1920x1080'
      : '1600x900';
    const requestedFps = Number(document.querySelector('input[name="generationFps"]:checked')?.value);
    const generationFps = generationMode === 'fast' || generationMode === 'ultra_fast'
      ? 1
      : ([5, 10, 15, 30].includes(requestedFps) ? requestedFps : 15);
    const requestedConcurrency = Number(document.querySelector('input[name="generationConcurrency"]:checked')?.value);
    const generationConcurrency = [2, 4, 6, 8, 16].includes(requestedConcurrency) ? requestedConcurrency : 4;
    const requestedVolume = Number(document.getElementById('generationVolume')?.value);
    const generationVolume = Number.isFinite(requestedVolume)
      ? Math.max(0, Math.min(200, Math.round(requestedVolume)))
      : 100;
    const parseScope = isQQ ? 'QQ_PLAYLIST_PARSE' : 'PLAYLIST_PARSE';
    const urlScope = isQQ ? 'QQ_PLAYLIST_URL' : 'PLAYLIST_URL';
    const parseRes = await callApi('/playlist/parse?url=' + encodeURIComponent(input), {}, parseScope);
    if (!parseRes.success) {
      showActionError(parseRes, '解析歌单失败');
      return;
    }

    currentPlaylist = parseRes.data;
    currentPlaylist._platform = currentPlatform;

    const urlRes = await callApi(
      '/playlist/url?id=' + currentPlaylist.id + '&order=' + generationOrder +
        (generationMode ? '&mode=' + generationMode : '') +
        '&quality=' + generationQuality +
        '&resolution=' + generationResolution + '&fps=' + generationFps +
        '&concurrency=' + generationConcurrency + '&volume=' + generationVolume,
      {},
      urlScope
    );
    if (!urlRes.success) {
      showActionError(urlRes, '生成链接失败');
      return;
    }
    
    if (!urlRes.data?.generationPath) throw new Error('服务端未返回整单生成地址');
    const job = await requestGeneration(urlRes.data.generationPath, {
      method: 'POST',
      body: JSON.stringify({
        playlistName: currentPlaylist.name || '',
        playlistCover: currentPlaylist.cover || '',
        playlistCreator: currentPlaylist.creator || '',
        songCount: Number(currentPlaylist.songCount) || 0
      })
    });
    generationJobs.set(`${job.source}:${job.id}`, job);
    renderGenerationJobs();
    startGenerationJobsPolling();
    const position = Math.max(0, Number(job.queuePosition) || 0);
    showToast(job.status === 'queued' && position > 1
      ? `已加入生成队列，前面还有 ${position - 1} 个任务`
      : '任务已加入生成队列');

  } catch (e) {
    showActionError(normalizeRuntimeError('PLAYLIST_GENERATE', e, '/ui/generatePlaylist'), '获取歌单失败');
  } finally {
    btn.innerHTML = originalText;
    btn.disabled = false;
  }
}

function copyUrl() {
  const url = getSelectedGeneratedUrl();
  if (!url) return;

  // 优先使用 Clipboard API（需要安全上下文：HTTPS 或 localhost）
  if (navigator.clipboard && typeof navigator.clipboard.writeText === 'function') {
    navigator.clipboard.writeText(url).then(() => {
      showToast('复制成功');
    }).catch(() => {
      // Clipboard API 拒绝（如权限不足），回退到 execCommand
      fallbackCopyText(url);
    });
  } else {
    // 非 HTTPS 环境下 Clipboard API 不可用，使用兼容方案
    fallbackCopyText(url);
  }
}

function openGeneratedUrl() {
  const url = getSelectedGeneratedUrl();
  if (!url) return showToast('暂无可打开的链接', 'error');

  const link = document.createElement('a');
  link.href = url;
  link.target = '_blank';
  link.rel = 'noopener noreferrer';
  document.body.appendChild(link);
  link.click();
  link.remove();
}

function fallbackCopyText(text) {
  try {
    const textarea = document.createElement('textarea');
    textarea.value = text;
    textarea.style.cssText = 'position:fixed;left:-9999px;top:-9999px;opacity:0';
    document.body.appendChild(textarea);
    textarea.select();
    document.execCommand('copy');
    document.body.removeChild(textarea);
    showToast('复制成功');
  } catch (e) {
    showToast('复制失败，请手动复制', 'error');
  }
}

function renderPagination(containerId, total, page, pageSize, callbackName) {
  const container = document.getElementById(containerId);
  if (!container) return;
  
  const totalPages = Math.ceil(total / pageSize);
  if (totalPages <= 1) {
    container.innerHTML = '';
    return;
  }
  
  let html = '';
  
  html += `<button class="page-btn" onclick="${callbackName}(${page - 1})" ${page === 1 ? 'disabled' : ''}>&lt;</button>`;
  
  const range = 2;
  
  for (let i = 1; i <= totalPages; i++) {
    if (i === 1 || i === totalPages || (i >= page - range && i <= page + range)) {
      html += `<button class="page-btn ${i === page ? 'active' : ''}" onclick="${callbackName}(${i})">${i}</button>`;
    } else if (i === page - range - 1 || i === page + range + 1) {
      html += `<span class="page-ellipsis">...</span>`;
    }
  }
  
  html += `<button class="page-btn" onclick="${callbackName}(${page + 1})" ${page === totalPages ? 'disabled' : ''}>&gt;</button>`;
  
  container.innerHTML = html;
}

async function loadUserPlaylists(page = 1) {
  if (isLoadingPlaylists) return;
  const list = document.getElementById('playlistsList');
  if (!list) return;

  isLoadingPlaylists = true;
  playlistPage = page;
  
  list.innerHTML = '<div style="text-align:center; padding: 2rem;"><span class="loading"></span></div>';
  document.getElementById('playlistsPagination').innerHTML = '';
  
  const offset = (page - 1) * PAGE_SIZE;
  const res = await api(`/playlist/user?offset=${offset}&limit=${PAGE_SIZE}`, {}, 'PLAYLIST_USER');
  isLoadingPlaylists = false;
  
  if (!res.success) {
    renderInlineError(list, res, '获取歌单失败');
    return;
  }
  
  userPlaylists = res.data;
  playlistTotal = res.total;
  
  renderPlaylists();
  renderPagination('playlistsPagination', playlistTotal, playlistPage, PAGE_SIZE, 'loadUserPlaylists');
}

function renderPlaylists() {
  const list = document.getElementById('playlistsList');
  if (!list) return;
  
  if (userPlaylists.length === 0) {
    list.innerHTML = '<div class="empty">暂无歌单</div>';
    return;
  }
  
  const items = userPlaylists.map(p => {
    const safeCover = imageSrc(p.cover);
    const safeName = escapeHtml(p.name);
    const safeId = escapeHtml(String(p.id));
    const count = p.trackCount;
    return `
      <div class="list-item">
        <img class="item-cover" src="${safeCover}" alt="" referrerpolicy="no-referrer" loading="lazy">
        <div class="item-info">
          <div class="item-name">${safeName}</div>
          <div class="item-meta">${count}首 • ID: ${safeId}</div>
        </div>
        <div class="item-actions">
          <button class="btn btn-primary" style="padding: 0.4rem 0.8rem; font-size: 0.8rem;" onclick="playFavorite('${safeId}')">生成</button>
        </div>
      </div>
    `;
  }).join('');
  
  list.innerHTML = items;
}

async function loadQQUserPlaylists(page = 1) {
  if (!qqToken || qqCenterTab !== 'playlists') return;
  if (isLoadingQQPlaylists) return;

  const list = document.getElementById('qqPlaylistsList');
  if (!list) return;

  isLoadingQQPlaylists = true;
  qqPlaylistPage = page;
  list.innerHTML = '<div style="text-align:center; padding: 2rem;"><span class="loading"></span></div>';
  const pagination = document.getElementById('qqPlaylistsPagination');
  if (pagination) pagination.innerHTML = '';

  const offset = (page - 1) * PAGE_SIZE;
  const res = await qqApi(`/playlist/user?offset=${offset}&limit=${PAGE_SIZE}`, {}, 'QQ_PLAYLIST_USER');
  isLoadingQQPlaylists = false;

  if (!res.success) {
    renderInlineError(list, res, '获取QQ歌单失败');
    return;
  }

  qqUserPlaylists = Array.isArray(res.data) ? res.data : [];
  qqPlaylistTotal = Number.isFinite(res.total) ? res.total : qqUserPlaylists.length;

  renderQQPlaylists();
  renderPagination('qqPlaylistsPagination', qqPlaylistTotal, qqPlaylistPage, PAGE_SIZE, 'loadQQUserPlaylists');
}

function renderQQPlaylists() {
  const list = document.getElementById('qqPlaylistsList');
  if (!list) return;

  if (!Array.isArray(qqUserPlaylists) || qqUserPlaylists.length === 0) {
    list.innerHTML = '<div class="empty">暂无QQ音乐歌单</div>';
    return;
  }

  const items = qqUserPlaylists.map(p => {
    const safeCover = imageSrc(p.cover);
    const safeName = escapeHtml(p.name);
    const safeId = escapeHtml(String(p.id));
    const count = p.trackCount || p.songCount || 0;
    return `
      <div class="list-item">
        <img class="item-cover" src="${safeCover}" alt="" referrerpolicy="no-referrer" loading="lazy">
        <div class="item-info">
          <div class="item-name">${safeName}</div>
          <div class="item-meta"><span class="platform-badge-sm qq">QQ</span> ${count}首 · ID: ${safeId}</div>
        </div>
        <div class="item-actions">
          <button class="btn btn-primary" style="padding: 0.4rem 0.8rem; font-size: 0.8rem;" onclick="playFavorite('${safeId}', 'qq')">生成</button>
        </div>
      </div>
    `;
  }).join('');

  list.innerHTML = items;
}

async function loadQQFavorites(page = 1) {
  if (!qqToken || qqCenterTab !== 'favorites') return;
  if (isLoadingQQFavorites) return;

  const list = document.getElementById('qqFavoritesList');
  if (!list) return;

  isLoadingQQFavorites = true;
  qqFavoritePage = page;
  list.innerHTML = '<div style="text-align:center; padding: 2rem;"><span class="loading"></span></div>';
  const pagination = document.getElementById('qqFavoritesPagination');
  if (pagination) pagination.innerHTML = '';

  const offset = (page - 1) * PAGE_SIZE;
  const res = await qqApi(`/favorites?offset=${offset}&limit=${PAGE_SIZE}`, {}, 'QQ_FAVORITES_LIST');
  isLoadingQQFavorites = false;

  if (!res.success) {
    renderInlineError(list, res, '获取QQ收藏失败');
    return;
  }

  qqUserFavorites = Array.isArray(res.data) ? res.data : [];
  qqFavoriteTotal = Number.isFinite(res.total) ? res.total : qqUserFavorites.length;

  renderQQFavorites();
  renderPagination('qqFavoritesPagination', qqFavoriteTotal, qqFavoritePage, PAGE_SIZE, 'loadQQFavorites');
}

function renderQQFavorites() {
  const list = document.getElementById('qqFavoritesList');
  if (!list) return;

  if (!Array.isArray(qqUserFavorites) || qqUserFavorites.length === 0) {
    list.innerHTML = '<div class="empty">暂无QQ收藏</div>';
    return;
  }

  const items = qqUserFavorites.map((f) => {
    const safeCover = imageSrc(f.cover);
    const safeName = escapeHtml(f.nickname || f.name || '');
    const safePlaylistId = escapeHtml(String(f.playlistId || ''));
    return `
      <div class="list-item">
        <img class="item-cover" src="${safeCover}" alt="" referrerpolicy="no-referrer" loading="lazy">
        <div class="item-info">
          <div class="item-name">${safeName}</div>
          <div class="item-meta"><span class="platform-badge-sm qq">QQ</span> ID: ${safePlaylistId}</div>
        </div>
        <div class="item-actions">
          <button class="btn btn-primary" style="padding: 0.4rem 0.8rem; font-size: 0.8rem;" onclick="playFavorite('${safePlaylistId}', 'qq')">播放</button>
          <button class="btn btn-ghost" style="padding: 0.4rem;" onclick="removeFavorite('${safePlaylistId}', false, 'qq')">删除</button>
        </div>
      </div>
    `;
  }).join('');

  list.innerHTML = items;
}

async function loadQQHistory(page = 1) {
  if (!qqToken || qqCenterTab !== 'history') return;
  if (isLoadingQQHistory) return;

  const list = document.getElementById('qqHistoryList');
  if (!list) return;

  isLoadingQQHistory = true;
  qqHistoryPage = page;
  list.innerHTML = '<div style="text-align:center; padding: 2rem;"><span class="loading"></span></div>';
  const pagination = document.getElementById('qqHistoryPagination');
  if (pagination) pagination.innerHTML = '';

  const offset = (page - 1) * PAGE_SIZE;
  const res = await qqApi(`/history/recent?offset=${offset}&limit=${PAGE_SIZE}`, {}, 'QQ_HISTORY_RECENT');
  isLoadingQQHistory = false;

  if (!res.success) {
    renderInlineError(list, res, '获取QQ最近播放失败');
    return;
  }

  qqUserHistory = Array.isArray(res.data) ? res.data : [];
  qqHistoryTotal = Number.isFinite(res.total) ? res.total : qqUserHistory.length;

  renderQQHistory();
  renderPagination('qqHistoryPagination', qqHistoryTotal, qqHistoryPage, PAGE_SIZE, 'loadQQHistory');
}

function renderQQHistory() {
  const list = document.getElementById('qqHistoryList');
  if (!list) return;

  if (!Array.isArray(qqUserHistory) || qqUserHistory.length === 0) {
    list.innerHTML = '<div class="empty">暂无QQ最近播放歌单</div>';
    return;
  }

  const items = qqUserHistory.map((h) => {
    const safeCover = imageSrc(h.cover);
    const safeName = escapeHtml(h.name || '');
    const safePlaylistId = escapeHtml(String(h.playlistId || ''));
    const playedAtText = h.playedAt ? formatTime(h.playedAt) : '刚刚';
    const playCount = Number(h.playCount || 0);
    return `
      <div class="list-item">
        <img class="item-cover" src="${safeCover}" alt="" referrerpolicy="no-referrer" loading="lazy">
        <div class="item-info">
          <div class="item-name">${safeName}</div>
          <div class="item-meta"><span class="platform-badge-sm qq">QQ</span> 最近播放 ${playedAtText} • 播放 ${playCount} 次 • ID: ${safePlaylistId}</div>
        </div>
        <div class="item-actions">
          <button class="btn btn-primary" style="padding: 0.4rem 0.8rem; font-size: 0.8rem;" onclick="playFavorite('${safePlaylistId}', 'qq')">获取链接</button>
        </div>
      </div>
    `;
  }).join('');

  list.innerHTML = items;
}

async function loadFavorites(page = 1) {
  if (isLoadingFavorites) return;
  const list = document.getElementById('favoritesList');
  if (!list) return;

  isLoadingFavorites = true;
  favoritePage = page;
  
  list.innerHTML = '<div style="text-align:center; padding: 2rem;"><span class="loading"></span></div>';
  document.getElementById('favoritesPagination').innerHTML = '';

  const offset = (page - 1) * PAGE_SIZE;
  const res = await api(`/favorites?offset=${offset}&limit=${PAGE_SIZE}`, {}, 'FAVORITES_LIST');
  isLoadingFavorites = false;
  
  if (!res.success) {
    renderInlineError(list, res, '获取收藏失败');
    return;
  }
  
  userFavorites = res.data;
  favoriteTotal = res.total;
  
  renderFavorites();
  renderPagination('favoritesPagination', favoriteTotal, favoritePage, PAGE_SIZE, 'loadFavorites');
}

function renderFavorites() {
  const list = document.getElementById('favoritesList');
  if (!list) return;
  
  if (userFavorites.length === 0) {
    list.innerHTML = '<div class="empty">暂无收藏</div>';
    return;
  }
  
  const items = userFavorites.map(f => {
    const safeCover = imageSrc(f.cover);
    const safeName = escapeHtml(f.nickname || f.name);
    const safePlaylistId = escapeHtml(f.playlistId);
    return `
      <div class="list-item">
        <img class="item-cover" src="${safeCover}" alt="" referrerpolicy="no-referrer" loading="lazy">
        <div class="item-info">
          <div class="item-name">${safeName}</div>
          <div class="item-meta">ID: ${safePlaylistId}</div>
        </div>
        <div class="item-actions">
          <button class="btn btn-primary" style="padding: 0.4rem 0.8rem; font-size: 0.8rem;" onclick="playFavorite('${safePlaylistId}')">播放</button>
          <button class="btn btn-ghost" style="padding: 0.4rem;" onclick="removeFavorite('${safePlaylistId}')">删除</button>
        </div>
      </div>
    `;
  }).join('');

  list.innerHTML = items;
}

async function loadHistory(page = 1) {
  if (isLoadingHistory) return;
  const list = document.getElementById('historyList');
  if (!list) return;

  isLoadingHistory = true;
  historyPage = page;
  
  list.innerHTML = '<div style="text-align:center; padding: 2rem;"><span class="loading"></span></div>';
  document.getElementById('historyPagination').innerHTML = '';

  const offset = (page - 1) * PAGE_SIZE;
  const res = await api(`/history/recent?offset=${offset}&limit=${PAGE_SIZE}`, {}, 'HISTORY_RECENT');
  isLoadingHistory = false;
  
  if (!res.success) {
    renderInlineError(list, res, '获取最近播放失败');
    return;
  }
  
  userHistory = res.data;
  historyTotal = res.total;
  
  renderHistory();
  renderPagination('historyPagination', historyTotal, historyPage, PAGE_SIZE, 'loadHistory');
}

function renderHistory() {
  const list = document.getElementById('historyList');
  if (!list) return;
  
  if (userHistory.length === 0) {
    list.innerHTML = '<div class="empty">暂无最近播放歌单</div>';
    return;
  }
  
  const items = userHistory.map(h => {
    const safeCover = imageSrc(h.cover);
    const safeName = escapeHtml(h.name || '');
    const safePlaylistId = escapeHtml(String(h.playlistId || ''));
    const playedAtText = h.playedAt ? formatTime(h.playedAt) : '刚刚';
    const playCount = Number(h.playCount || 0);
    return `
      <div class="list-item">
        <img class="item-cover" src="${safeCover}" alt="" referrerpolicy="no-referrer" loading="lazy">
        <div class="item-info">
          <div class="item-name">${safeName}</div>
          <div class="item-meta">最近播放 ${playedAtText} • 播放 ${playCount} 次 • ID: ${safePlaylistId}</div>
        </div>
        <div class="item-actions">
          <button class="btn btn-primary" style="padding: 0.4rem 0.8rem; font-size: 0.8rem;" onclick="playFavorite('${safePlaylistId}')">获取链接</button>
        </div>
      </div>
    `;
  }).join('');

  list.innerHTML = items;
}

async function updateFavoriteBtn() {
  if (!currentPlaylist) return;
  const btn = document.getElementById('favoriteBtn');
  if (!btn) return;

  const platform = currentPlaylist._platform === 'qq' ? 'qq' : 'netease';
  const callApi = platform === 'qq' ? qqApi : api;
  const scope = platform === 'qq' ? 'QQ_FAVORITES_CHECK' : 'FAVORITES_CHECK';
  const res = await callApi('/favorites/check/' + currentPlaylist.id, {}, scope);

  if (res.success && res.data.favorited) {
    btn.innerHTML = '已收藏';
    btn.className = 'btn btn-primary';
    btn.onclick = () => removeFavorite(currentPlaylist.id, true, platform);
  } else {
    btn.innerHTML = '收藏';
    btn.className = 'btn btn-ghost';
    btn.onclick = () => addFavorite();
  }
}

async function addFavorite() {
  if (!currentPlaylist) return;
  const platform = currentPlaylist._platform === 'qq' ? 'qq' : 'netease';
  const callApi = platform === 'qq' ? qqApi : api;
  const scope = platform === 'qq' ? 'QQ_FAVORITES_ADD' : 'FAVORITES_ADD';
  const res = await callApi('/favorites', {
    method: 'POST',
    body: JSON.stringify({
      playlistId: currentPlaylist.id,
      playlistName: currentPlaylist.name,
      playlistCover: currentPlaylist.cover
    })
  }, scope);
  if (res.success) {
    showToast('收藏成功');
    updateFavoriteBtn();
    if (platform === 'qq') {
      if (document.getElementById('qqFavoritesList')) loadQQFavorites(1);
    } else if (document.getElementById('favoritesList')) {
      loadFavorites(1);
    }
  } else {
    showActionError(res, '收藏失败');
  }
}

async function removeFavorite(playlistId, updateBtn = false, platform = '') {
  const targetPlatform = platform || 'netease';
  const callApi = targetPlatform === 'qq' ? qqApi : api;
  const scope = targetPlatform === 'qq' ? 'QQ_FAVORITES_REMOVE' : 'FAVORITES_REMOVE';
  const res = await callApi('/favorites/' + playlistId, { method: 'DELETE' }, scope);
  if (res.success) {
    showToast('已取消收藏');
    if (targetPlatform === 'qq') {
      if (document.getElementById('qqFavoritesList')) loadQQFavorites(qqFavoritePage);
    } else if (document.getElementById('favoritesList')) {
      loadFavorites(favoritePage);
    }
    if (updateBtn) updateFavoriteBtn();
  } else {
    showActionError(res, '取消收藏失败');
  }
}

async function playFavorite(playlistId, platform) {
  const id = encodeURIComponent(String(playlistId || ''));
  const p = platform || 'netease';

  if (isUserViewActive()) {
    navigate(`/?play=${id}&platform=${p}`);
    return;
  }

  if (p !== currentPlatform) switchPlatform(p);

  const input = document.getElementById('playlistInput');
  if (!input) {
    navigate(`/?play=${id}&platform=${p}`);
    return;
  }

  input.value = String(playlistId || '');
  await generatePlaylist();
}

function formatTime(dateStr) {
  const date = new Date(dateStr);
  const now = new Date();
  const diff = now - date;
  if (diff < 60000) return '刚刚';
  if (diff < 3600000) return Math.floor(diff / 60000) + '分钟前';
  if (diff < 86400000) return Math.floor(diff / 3600000) + '小时前';
  return Math.floor(diff / 86400000) + '天前';
}

function renderAccountCards() {
  const nBody = document.getElementById('neteaseAccountBody');
  const qBody = document.getElementById('qqAccountBody');

  if (nBody) {
    if (currentUser) {
      const av = imageSrc(currentUser.avatar);
      const name = escapeHtml(currentUser.nickname);
      nBody.innerHTML = `
        <img class="user-avatar" src="${av}" alt="" referrerpolicy="no-referrer" loading="lazy">
        <span class="account-name">${name}</span>
        <button class="btn btn-ghost" style="padding:0.3rem 0.6rem;font-size:0.8rem;" onclick="logout()">退出</button>
      `;
    } else {
      nBody.innerHTML = `<button class="btn btn-primary" style="padding:0.4rem 0.8rem;font-size:0.85rem;" onclick="showLogin('netease')">登录</button>`;
    }
  }

  if (qBody) {
    if (qqCurrentUser) {
      const av = imageSrc(qqCurrentUser.avatar);
      const name = escapeHtml(qqCurrentUser.nickname);
      qBody.innerHTML = `
        <img class="user-avatar" src="${av}" alt="" referrerpolicy="no-referrer" loading="lazy">
        <span class="account-name">${name}</span>
        <button class="btn btn-ghost" style="padding:0.3rem 0.6rem;font-size:0.8rem;" onclick="logoutQQ()">退出</button>
      `;
    } else {
      qBody.innerHTML = `<button class="btn btn-primary" style="padding:0.4rem 0.8rem;font-size:0.85rem;" onclick="showLogin('qq')">登录</button>`;
    }
  }
}

async function loadAllPlaylists(page = 1) {
  const list = document.getElementById('playlistsList');
  if (!list) return;

  if ((userPlaylists.length > 0 || qqUserPlaylists.length > 0) && page !== 0) {
    playlistPage = page;
    renderAllPlaylists();
    return;
  }

  if (isLoadingPlaylists) return;
  isLoadingPlaylists = true;

  list.innerHTML = '<div style="text-align:center; padding: 2rem;"><span class="loading"></span></div>';
  document.getElementById('playlistsPagination').innerHTML = '';

  const promises = [];
  if (token) promises.push(loadUserPlaylistsData());
  if (qqToken) promises.push(loadQQUserPlaylistsData());

  const results = await Promise.all(promises);
  isLoadingPlaylists = false;

  const failed = results.filter(item => item && item.success === false).map(item => item.error);
  if (results.length > 0 && failed.length === results.length) {
    renderInlineError(list, failed[0], '获取歌单失败');
    return;
  }

  playlistPage = page === 0 ? 1 : page;
  renderAllPlaylists();
}

async function loadUserPlaylistsData() {
  const res = await api('/playlist/user?offset=0&limit=100', {}, 'PLAYLIST_USER');
  if (res.success) {
    userPlaylists = (res.data || []).map(p => ({ ...p, _platform: 'netease' }));
    return { success: true };
  }
  return { success: false, error: res };
}

async function loadQQUserPlaylistsData() {
  const res = await qqApi('/playlist/user?offset=0&limit=100', {}, 'QQ_PLAYLIST_USER');
  if (res.success) {
    qqUserPlaylists = (res.data || []).map(p => ({ ...p, _platform: 'qq' }));
    return { success: true };
  }
  return { success: false, error: res };
}

function renderAllPlaylists() {
  const list = document.getElementById('playlistsList');
  if (!list) return;

  const all = [...userPlaylists, ...qqUserPlaylists];
  playlistTotal = all.length;

  if (all.length === 0) {
    list.innerHTML = '<div class="empty">暂无歌单</div>';
    document.getElementById('playlistsPagination').innerHTML = '';
    return;
  }

  const offset = (playlistPage - 1) * PAGE_SIZE;
  const pageData = all.slice(offset, offset + PAGE_SIZE);

  const items = pageData.map(p => {
    const safeCover = imageSrc(p.cover);
    const safeName = escapeHtml(p.name);
    const safeId = escapeHtml(String(p.id));
    const count = p.trackCount || p.songCount || 0;
    const isQQ = p._platform === 'qq';
    const badge = isQQ
      ? '<span class="platform-badge-sm qq">QQ</span>'
      : '<span class="platform-badge-sm netease">网易云</span>';
    const platform = isQQ ? "'qq'" : "'netease'";
    return `
      <div class="list-item">
        <img class="item-cover" src="${safeCover}" alt="" referrerpolicy="no-referrer" loading="lazy">
        <div class="item-info">
          <div class="item-name">${safeName}</div>
          <div class="item-meta">${badge} ${count}首 · ID: ${safeId}</div>
        </div>
        <div class="item-actions">
          <button class="btn btn-primary" style="padding: 0.4rem 0.8rem; font-size: 0.8rem;" onclick="playFavorite('${safeId}', ${platform})">生成</button>
        </div>
      </div>
    `;
  }).join('');

  list.innerHTML = items;
  renderPagination('playlistsPagination', playlistTotal, playlistPage, PAGE_SIZE, 'loadAllPlaylists');
}
