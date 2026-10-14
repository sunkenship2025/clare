// Deployment config. scripts/build.mjs replaces the __CLARE_*__ placeholders.
// Values that still look like placeholders are treated as unset by api.js.
window.CLARE = {
  apiUrl: "__CLARE_API_URL__",
  webUrl: "__CLARE_WEB_URL__",
  releasesUrl: "__CLARE_RELEASES_URL__",
  // Chrome Web Store listing for the extension, once published (clare.config.json → extensionUrl).
  // Empty = show the "download zip + load unpacked" guide on the enroll page instead.
  extensionUrl: "__CLARE_EXTENSION_URL__",
};
