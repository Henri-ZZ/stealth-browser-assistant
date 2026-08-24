// Central product URLs. Change WEBSITE_ORIGIN here if the official website
// moves to another domain; consumers should import the derived URLs below.
export const WEBSITE_ORIGIN = 'https://stealthba.henri.ren';
const SETTINGS_UTM = 'utm_source=settings_page';

export const PREMIUM_URL = `${WEBSITE_ORIGIN}/?${SETTINGS_UTM}`;
export const CONTACT_URL = `${WEBSITE_ORIGIN}/contact?${SETTINGS_UTM}`;
export const UNINSTALL_URL = `${WEBSITE_ORIGIN}/goodbye`;

export const STORE_REVIEW_URLS = Object.freeze({
  chrome: `https://chromewebstore.google.com/detail/stealth-browser-assistant/hmljpmgcniamoobeeppkikeoednpggfd/reviews?${SETTINGS_UTM}`,
  edge: `https://microsoftedge.microsoft.com/addons/detail/stealth-browser-assistant/mldmkfpdbbefhccomffanjmndpgbdidd?${SETTINGS_UTM}`,
  firefox: `https://addons.mozilla.org/en-GB/firefox/addon/stealth-browser-assistant/reviews/?${SETTINGS_UTM}`,
});

/** Return the matching store review page for the browser running the extension. */
export function getStoreReviewUrl(userAgent = '') {
  const firefoxApi =
    typeof browser !== 'undefined' &&
    typeof browser.runtime?.getBrowserInfo === 'function';
  if (firefoxApi || /Firefox\//i.test(userAgent)) return STORE_REVIEW_URLS.firefox;
  if (/Edg\//i.test(userAgent)) return STORE_REVIEW_URLS.edge;
  return STORE_REVIEW_URLS.chrome;
}
