/* Font Awesome classes accepted anywhere an icon comes from data. The site loads Font Awesome 6.4;
   free text here would end up inside a class attribute, so only this exact shape is allowed. */

const ICON_RE = /^fa[srb] fa-[a-z0-9-]{1,40}$/;
const DEFAULT_ICON = "fas fa-code";

module.exports = { ICON_RE, DEFAULT_ICON };
