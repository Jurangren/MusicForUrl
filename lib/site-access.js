const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

const MIN_SECRET_LENGTH = 8;
const DEFAULT_COOKIE_NAME = 'site_auth';
const CONFIG_FILE = path.join(__dirname, '..', 'data', 'site-access.json');

function safeEqual(left, right) {
  const a = Buffer.from(String(left || ''), 'utf8');
  const b = Buffer.from(String(right || ''), 'utf8');
  if (a.length !== b.length) return false;
  return crypto.timingSafeEqual(a, b);
}

function deriveSecret(secret, salt) {
  return crypto.scryptSync(String(secret), String(salt), 32).toString('hex');
}

function readStoredConfig(configFile = CONFIG_FILE) {
  try {
    if (!fs.existsSync(configFile)) return null;
    const parsed = JSON.parse(fs.readFileSync(configFile, 'utf8'));
    if (!parsed || parsed.version !== 1 || !parsed.salt || !parsed.hash) return null;
    return parsed;
  } catch (error) {
    console.warn('[后台密钥] 配置读取失败:', error?.message || error);
    return null;
  }
}

function writeStoredConfig(secret, configFile = CONFIG_FILE) {
  const value = String(secret || '');
  if (value.length < MIN_SECRET_LENGTH) {
    throw new Error(`密钥至少需要 ${MIN_SECRET_LENGTH} 个字符`);
  }

  const salt = crypto.randomBytes(16).toString('hex');
  const config = {
    version: 1,
    salt,
    hash: deriveSecret(value, salt),
    createdAt: new Date().toISOString()
  };

  fs.mkdirSync(path.dirname(configFile), { recursive: true });
  const tempFile = `${configFile}.${process.pid}.tmp`;
  fs.writeFileSync(tempFile, `${JSON.stringify(config, null, 2)}\n`, { mode: 0o600 });
  fs.renameSync(tempFile, configFile);
  try { fs.chmodSync(configFile, 0o600); } catch (_) {}
  return config;
}

function createSiteAccess(options = {}) {
  const configFile = options.configFile || CONFIG_FILE;
  const envSecret = options.envSecret == null ? process.env.SITE_PASSWORD : options.envSecret;
  const cookieSigningKey = String(
    options.cookieSigningKey || process.env.ENCRYPTION_KEY || 'music-for-url-site-access'
  );
  let storedConfig = readStoredConfig(configFile);

  function configured() {
    return Boolean(String(envSecret || '').trim() || storedConfig);
  }

  function source() {
    return String(envSecret || '').trim() ? 'environment' : (storedConfig ? 'setup' : 'none');
  }

  function verify(secret) {
    const value = String(secret || '');
    if (String(envSecret || '').trim()) {
      return safeEqual(value, String(envSecret));
    }
    if (!storedConfig) return false;
    return safeEqual(deriveSecret(value, storedConfig.salt), storedConfig.hash);
  }

  function setup(secret) {
    if (configured()) {
      const error = new Error('后台密钥已经设置');
      error.code = 'ALREADY_CONFIGURED';
      throw error;
    }
    storedConfig = writeStoredConfig(secret, configFile);
    return true;
  }

  function credentialFingerprint() {
    if (String(envSecret || '').trim()) {
      return crypto.createHash('sha256').update(String(envSecret)).digest('hex');
    }
    return storedConfig ? storedConfig.hash : 'not-configured';
  }

  function cookieValue() {
    return crypto
      .createHmac('sha256', cookieSigningKey)
      .update(`site-auth-v2:${credentialFingerprint()}`)
      .digest('hex');
  }

  function isCookieValid(value) {
    return configured() && safeEqual(value, cookieValue());
  }

  return {
    cookieName: DEFAULT_COOKIE_NAME,
    minSecretLength: MIN_SECRET_LENGTH,
    configured,
    source,
    verify,
    setup,
    cookieValue,
    isCookieValid
  };
}

module.exports = {
  MIN_SECRET_LENGTH,
  CONFIG_FILE,
  createSiteAccess,
  deriveSecret,
  readStoredConfig,
  writeStoredConfig
};
