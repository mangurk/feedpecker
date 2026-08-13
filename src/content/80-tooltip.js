function tooltipText(flag) {
  const base = (flag.dataset.tfLocation || flag.getAttribute('data-tf-tip') || '').trim();
  const localTime = flag.dataset.tfTz ? getLocalTimeString(flag.dataset.tfTz) : '';
  let label = localTime ? `${base} (${flag.dataset.tfTz} • ${localTime})` : base;
  if (flag.dataset.tfApproximate === 'true') label += ' (Approximate)';
  if (flag.dataset.tfExcluded === 'true') label += ' (Excluded from country filtering)';
  return label;
}

function placeTooltip(flag) {
  const anchor = flag.getBoundingClientRect();
  const box = tip.getBoundingClientRect();
  const centered = anchor.left + (anchor.width - box.width) / 2;
  const left = Math.max(10, Math.min(centered, window.innerWidth - box.width - 10));
  const above = anchor.top - box.height - 8;
  tip.style.left = `${left}px`;
  tip.style.top = `${above >= 10 ? above : anchor.bottom + 8}px`;
}

function hideTooltip() {
  if (tip) tip.style.opacity = '0';
}

function attachTooltip() {
  document.body.addEventListener('mouseover', event => {
    const flag = event.target.closest?.('.tf-flag');
    if (!flag) return;
    const label = tooltipText(flag);
    if (!label) return;
    if (!tip) {
      tip = document.createElement('div');
      tip.id = 'tf-tooltip';
      document.body.appendChild(tip);
    }
    tip.textContent = label;
    tip.style.cssText += ';display:block;opacity:0';
    placeTooltip(flag);
    tip.style.opacity = '1';
  });
  document.body.addEventListener('mouseout', event => {
    if (event.target.closest?.('.tf-flag')) hideTooltip();
  });
  document.body.addEventListener('click', hideTooltip);
}
