export function proxyRotatorFromEnv(prefix, env = process.env) {
  const proxies = proxyListFromEnv(prefix, env);
  let index = 0;

  return {
    count: proxies.length,
    next() {
      if (!proxies.length) return undefined;
      const proxy = proxies[index % proxies.length];
      index += 1;
      return proxy;
    },
  };
}

function proxyListFromEnv(prefix, env) {
  const upperPrefix = String(prefix || '').toUpperCase();
  const bypass = clean(env[`${upperPrefix}_PROXY_BYPASS`]);
  const username = clean(env[`${upperPrefix}_PROXY_USERNAME`]);
  const password = clean(env[`${upperPrefix}_PROXY_PASSWORD`]);
  const proxyUrls = splitList(env[`${upperPrefix}_PROXY_URLS`]);

  if (proxyUrls.length) {
    return proxyUrls.map((value) => proxyFromUrl(value, { bypass, username, password })).filter(Boolean);
  }

  const proxyUrl = clean(env[`${upperPrefix}_PROXY_URL`]);
  if (proxyUrl) return [proxyFromUrl(proxyUrl, { bypass, username, password })].filter(Boolean);

  const server = clean(env[`${upperPrefix}_PROXY_SERVER`]);
  if (!server) return [];

  return [
    withOptionalFields({
      server,
      username,
      password,
      bypass,
    }),
  ];
}

function proxyFromUrl(value, defaults) {
  const raw = clean(value);
  if (!raw) return undefined;

  try {
    const url = new URL(raw);
    const username = decodeURIComponent(url.username || '') || defaults.username;
    const password = decodeURIComponent(url.password || '') || defaults.password;

    return withOptionalFields({
      server: `${url.protocol}//${url.host}`,
      username,
      password,
      bypass: defaults.bypass,
    });
  } catch {
    return withOptionalFields({
      server: raw,
      username: defaults.username,
      password: defaults.password,
      bypass: defaults.bypass,
    });
  }
}

function splitList(value) {
  return String(value || '')
    .split(/\r?\n|,/)
    .map((item) => item.trim())
    .filter(Boolean);
}

function withOptionalFields(proxy) {
  return Object.fromEntries(Object.entries(proxy).filter(([, value]) => clean(value)));
}

function clean(value) {
  return String(value || '').trim();
}
