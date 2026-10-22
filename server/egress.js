import http from 'node:http';
import https from 'node:https';
import {
  EnvHttpProxyAgent,
  fetch as undiciFetch,
  setGlobalDispatcher,
} from 'undici';

const HUB_PROXY = 'http://127.0.0.1:3129';
const NO_PROXY = 'localhost,127.0.0.1,::1';

/** Route every Hub HTTP client through the local policy proxy in production. */
export const configureProductionEgress = () => {
  const [major, minor] = process.versions.node.split('.').map(Number);
  const proxySupported =
    (major === 22 && minor >= 21) || (major === 24 && minor >= 5) || major > 24;
  if (!proxySupported)
    throw new Error(
      'Node.js 22.21+ oder 24.5+ mit HTTP-Proxy-Unterstützung wird benötigt.',
    );

  process.env.HTTP_PROXY = HUB_PROXY;
  process.env.HTTPS_PROXY = HUB_PROXY;
  process.env.http_proxy = HUB_PROXY;
  process.env.https_proxy = HUB_PROXY;
  process.env.NO_PROXY = NO_PROXY;
  process.env.no_proxy = NO_PROXY;
  process.env.NODE_USE_ENV_PROXY = '1';

  const proxyEnv = process.env;
  http.globalAgent = new http.Agent({
    ...http.globalAgent.options,
    proxyEnv,
  });
  https.globalAgent = new https.Agent({
    ...https.globalAgent.options,
    proxyEnv,
  });

  const dispatcher = new EnvHttpProxyAgent({
    httpProxy: HUB_PROXY,
    httpsProxy: HUB_PROXY,
    noProxy: NO_PROXY,
  });
  setGlobalDispatcher(dispatcher);
  // Keep fetch on the same explicitly configured dispatcher; some Node builds
  // bundle an Undici version that does not share runtime dispatcher changes.
  globalThis.fetch = undiciFetch;
  return dispatcher;
};
