const htmlSources = new WeakMap();
const mediaSources = new WeakMap();

export function setSalesHtml(root, selector, html) {
  const node = root.querySelector(selector);
  if (!node || htmlSources.get(node) === html) return;
  node.innerHTML = html;
  htmlSources.set(node, html);
}

export function renderSalesMaterials(container, assets, { locked, expiredLabel, deleteLabel }) {
  const doc = container.ownerDocument;
  const existing = new Map([...container.children].map(node => [node.dataset.assetId, node]));
  const retained = new Set();
  for (const [index, asset] of assets.entries()) {
    let figure = existing.get(asset.id);
    if (!figure) {
      figure = doc.createElement('figure');
      figure.dataset.assetId = asset.id;
      const caption = doc.createElement('figcaption');
      const name = doc.createElement('span');
      name.setAttribute('translate', 'no');
      caption.append(name);
      figure.append(caption);
    }
    retained.add(figure);
    const caption = figure.querySelector('figcaption');
    const source = JSON.stringify([asset.expired, asset.type, asset.url]);
    if (mediaSources.get(figure) !== source) {
      for (const child of [...figure.children]) if (child !== caption) child.remove();
      let media;
      if (asset.expired) {
        media = doc.createElement('span');
      } else if (asset.type === 'audio') {
        media = doc.createElement('audio');
        media.setAttribute('controls', '');
        media.setAttribute('preload', 'metadata');
        media.setAttribute('src', asset.url);
      } else {
        media = doc.createElement('a');
        media.setAttribute('href', asset.url);
        media.setAttribute('target', '_blank');
        media.setAttribute('rel', 'noopener');
        const img = doc.createElement('img');
        img.setAttribute('src', asset.url);
        media.append(img);
      }
      figure.insertBefore(media, caption);
      mediaSources.set(figure, source);
    }
    if (asset.expired && figure.firstChild.textContent !== expiredLabel) figure.firstChild.textContent = expiredLabel;
    const img = figure.querySelector('img');
    if (img && img.getAttribute('alt') !== asset.name) img.setAttribute('alt', asset.name);
    if (caption.firstChild.textContent !== asset.name) caption.firstChild.textContent = asset.name;
    let remove = caption.querySelector('button');
    if (locked) remove?.remove();
    else {
      if (!remove) {
        remove = doc.createElement('button');
        remove.type = 'button';
        remove.dataset.sales = 'remove';
        remove.dataset.id = asset.id;
        remove.textContent = '×';
        caption.append(remove);
      }
      const label = deleteLabel + ' ' + asset.name;
      if (remove.getAttribute('aria-label') !== label) remove.setAttribute('aria-label', label);
    }
    if (container.children[index] !== figure) container.insertBefore(figure, container.children[index] || null);
  }
  for (const node of [...container.children]) if (!retained.has(node)) node.remove();
}
