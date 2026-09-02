// Central product service origins. Keep domain migrations here; consumers
// should import these constants or the derived URLs below.
export const WEBSITE_ORIGIN = 'https://sba.henriz.dev';
export const LICENTRA_BASE_URL = 'https://licentra.henriz.dev';
const SETTINGS_UTM = 'utm_source=settings_page';

export const PREMIUM_URL = `${WEBSITE_ORIGIN}/?${SETTINGS_UTM}`;
export const CONTACT_URL = `${WEBSITE_ORIGIN}/contact?${SETTINGS_UTM}`;
export const UNINSTALL_URL = `${WEBSITE_ORIGIN}/goodbye`;

export const GETTING_STARTED_URL = `${WEBSITE_ORIGIN}/getting-started`;

export const STORE_REVIEW_URLS = Object.freeze({
  chrome: `https://chromewebstore.google.com/detail/stealth-browser-assistant/hmljpmgcniamoobeeppkikeoednpggfd/reviews?${SETTINGS_UTM}`,
  edge: `https://microsoftedge.microsoft.com/addons/detail/stealth-browser-assistant/mldmkfpdbbefhccomffanjmndpgbdidd?${SETTINGS_UTM}`,
  firefox: `https://addons.mozilla.org/en-GB/firefox/addon/stealth-browser-assistant/reviews/?${SETTINGS_UTM}`,
});

/** Return the product platform matching the browser running the extension. */
export function getBrowserPlatform(userAgent = '') {
  const firefoxApi =
    typeof browser !== 'undefined' &&
    typeof browser.runtime?.getBrowserInfo === 'function';
  if (firefoxApi || /Firefox\//i.test(userAgent)) return 'firefox';
  if (/Edg\//i.test(userAgent)) return 'edge';
  return 'chrome';
}

/** Return the installation welcome/tutorial page for the current browser. */
export function getGettingStartedUrl(userAgent = '') {
  const browserName = getBrowserPlatform(userAgent);
  return `${GETTING_STARTED_URL}?installed=1&browser=${browserName}`;
}

/** Return the matching store review page for the browser running the extension. */
export function getStoreReviewUrl(userAgent = '') {
  return STORE_REVIEW_URLS[getBrowserPlatform(userAgent)];
}
