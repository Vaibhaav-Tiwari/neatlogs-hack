const esc = value => String(value).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);

export function reasonText(value) {
  return String(value ?? '').split(/(\b[a-f\d]{40}\b)/gi).map(part =>
    /^[a-f\d]{40}$/i.test(part) ? `<abbr class="commit-hash" title="${part}">${part.slice(0, 7)}</abbr>` : esc(part),
  ).join('');
}
