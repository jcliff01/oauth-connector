export const regions = new Set([
  'mypurecloud.com', 'usw2.pure.cloud', 'cac1.pure.cloud', 'sae1.pure.cloud',
  'mxc1.pure.cloud', 'mypurecloud.ie', 'mypurecloud.de', 'euw2.pure.cloud',
  'euc2.pure.cloud', 'mec1.pure.cloud', 'aps1.pure.cloud', 'apse1.pure.cloud',
  'mypurecloud.com.au', 'mypurecloud.jp', 'apne2.pure.cloud', 'apne3.pure.cloud',
  'use2.us-gov-pure.cloud', 'edee1.eusc-pure.cloud',
]);

export function parseTokenUrl(value) {
  let url;
  try { url = new URL(value); } catch { /* Use the same validation error below. */ }
  const region = url?.hostname.slice('login.'.length);
  if (!regions.has(region) || url.href !== `https://login.${region}/oauth/token`) {
    throw new Error('Enter a Genesys Cloud access token URL ending in /oauth/token.');
  }
  return { region, tokenUrl: url.href, authorizationUrl: new URL('/oauth/authorize', url) };
}
