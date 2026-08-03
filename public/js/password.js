(function initThemeFromStorage() {
  const savedTheme = localStorage.getItem('theme');
  if (savedTheme === 'dark') document.documentElement.setAttribute('data-theme', 'dark');
})();

let setupMode = false;
let minSecretLength = 8;

function byId(id) {
  return document.getElementById(id);
}

function showError(message) {
  const el = byId('errorMessage');
  if (!el) return;
  el.textContent = String(message || '请求失败，请稍后重试');
  el.classList.add('show');
}

function clearError() {
  const el = byId('errorMessage');
  if (el) el.classList.remove('show');
}

function setMode(configured) {
  setupMode = !configured;
  byId('passwordModeBadge').textContent = setupMode ? '首次配置' : '安全访问';
  byId('passwordTitle').textContent = setupMode ? '设置后台密钥' : '后台密钥登录';
  byId('passwordDesc').textContent = setupMode
    ? '首次使用需要创建一个后台访问密钥。设置完成后才能进入管理界面。'
    : '后台已锁定，请输入密钥后继续访问。';
  byId('passwordInput').placeholder = setupMode ? `创建密钥（至少 ${minSecretLength} 位）` : '请输入后台密钥';
  byId('passwordInput').autocomplete = setupMode ? 'new-password' : 'current-password';
  byId('passwordConfirmInput').hidden = !setupMode;
  byId('passwordHint').hidden = !setupMode;
  byId('passwordSubmit').textContent = setupMode ? '设置并进入后台' : '登录后台';
}

async function loadStatus() {
  try {
    const response = await fetch('/api/site-access/status', { credentials: 'same-origin' });
    const payload = await response.json();
    if (payload.authenticated) {
      window.location.replace('/');
      return;
    }
    minSecretLength = Number(payload.minSecretLength) || 8;
    setMode(Boolean(payload.configured));
  } catch (_) {
    showError('无法读取后台安全状态，请刷新重试');
  }
}

async function handleSubmit(event) {
  event.preventDefault();
  clearError();

  const secret = byId('passwordInput').value;
  const confirmation = byId('passwordConfirmInput').value;
  if (!secret) {
    showError(setupMode ? '请输入要设置的后台密钥' : '请输入后台密钥');
    return false;
  }
  if (setupMode && secret.length < minSecretLength) {
    showError(`后台密钥至少需要 ${minSecretLength} 个字符`);
    return false;
  }
  if (setupMode && secret !== confirmation) {
    showError('两次输入的后台密钥不一致');
    return false;
  }

  const button = byId('passwordSubmit');
  button.disabled = true;
  button.textContent = setupMode ? '正在安全设置…' : '正在验证…';

  try {
    const endpoint = setupMode ? '/api/site-access/setup' : '/api/site-access/login';
    const response = await fetch(endpoint, {
      method: 'POST',
      credentials: 'same-origin',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ secret })
    });
    const payload = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(payload.message || '密钥验证失败');
    sessionStorage.removeItem('sitePassword');
    window.location.replace('/');
  } catch (error) {
    showError(error?.message || '请求失败，请稍后重试');
    byId('passwordInput').focus();
    if (!setupMode) byId('passwordInput').value = '';
  } finally {
    button.disabled = false;
    button.textContent = setupMode ? '设置并进入后台' : '登录后台';
  }

  return false;
}

window.handleSubmit = handleSubmit;
loadStatus();
