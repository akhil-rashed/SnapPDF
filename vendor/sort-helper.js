/**
 * Lightweight pointer-based sortable helper with touch long-press & FLIP animation.
 * Zero dependencies, 60fps transform-only animations, respects prefers-reduced-motion.
 */
export function makeSortable(container, options = {}) {
  const {
    itemSelector = '.page-card',
    handleSelector = null,
    longPressMs = 250,
    onReorder = () => {},
  } = options;

  let draggingEl = null;
  let ghostEl = null;
  let startX = 0;
  let startY = 0;
  let offsetX = 0;
  let offsetY = 0;
  let longPressTimer = null;
  let pointerId = null;
  let startIndex = -1;
  let currentIndex = -1;

  const prefersReduced = () => window.matchMedia('(prefers-reduced-motion: reduce)').matches;

  function getItems() {
    return Array.from(container.querySelectorAll(itemSelector));
  }

  function captureRects() {
    const map = new Map();
    for (const el of getItems()) {
      map.set(el, el.getBoundingClientRect());
    }
    return map;
  }

  function playFlip(prevRects) {
    if (prefersReduced()) return;
    for (const el of getItems()) {
      if (el === draggingEl) continue;
      const prev = prevRects.get(el);
      if (!prev) continue;
      const next = el.getBoundingClientRect();
      const dx = prev.left - next.left;
      const dy = prev.top - next.top;
      if (Math.abs(dx) < 0.5 && Math.abs(dy) < 0.5) continue;
      el.style.transition = 'none';
      el.style.transform = `translate3d(${dx}px, ${dy}px, 0)`;
      el.getBoundingClientRect(); // force layout
      el.style.transition = 'transform 220ms cubic-bezier(0.22, 1, 0.36, 1)';
      el.style.transform = 'translate3d(0, 0, 0)';
      const cleanup = () => {
        el.style.transition = '';
        el.style.transform = '';
        el.removeEventListener('transitionend', cleanup);
      };
      el.addEventListener('transitionend', cleanup);
    }
  }

  function startDrag(item, e) {
    draggingEl = item;
    const rect = item.getBoundingClientRect();
    offsetX = e.clientX - rect.left;
    offsetY = e.clientY - rect.top;
    startIndex = getItems().indexOf(item);
    currentIndex = startIndex;

    ghostEl = item.cloneNode(true);
    ghostEl.classList.add('drag-ghost');
    ghostEl.style.width = `${rect.width}px`;
    ghostEl.style.height = `${rect.height}px`;
    ghostEl.style.left = `${rect.left}px`;
    ghostEl.style.top = `${rect.top}px`;
    document.body.appendChild(ghostEl);

    item.classList.add('is-dragging');
    if (navigator.vibrate) try { navigator.vibrate(12); } catch {}
  }

  function onPointerMove(e) {
    if (longPressTimer && Math.hypot(e.clientX - startX, e.clientY - startY) > 8) {
      clearTimeout(longPressTimer);
      longPressTimer = null;
      return;
    }
    if (!draggingEl || e.pointerId !== pointerId) return;
    e.preventDefault();

    const x = e.clientX - offsetX;
    const y = e.clientY - offsetY;
    ghostEl.style.transform = `translate3d(${x - parseFloat(ghostEl.style.left)}px, ${y - parseFloat(ghostEl.style.top)}px, 0) scale(1.03)`;

    // Find hovered sibling
    const items = getItems();
    let target = null;
    for (const el of items) {
      if (el === draggingEl) continue;
      const r = el.getBoundingClientRect();
      if (e.clientX >= r.left && e.clientX <= r.right && e.clientY >= r.top && e.clientY <= r.bottom) {
        target = el;
        break;
      }
    }
    if (target) {
      const prevRects = captureRects();
      const targetIdx = items.indexOf(target);
      const dragIdx = items.indexOf(draggingEl);
      if (dragIdx < targetIdx) {
        container.insertBefore(draggingEl, target.nextSibling);
      } else {
        container.insertBefore(draggingEl, target);
      }
      currentIndex = getItems().indexOf(draggingEl);
      playFlip(prevRects);
    }
  }

  function endDrag() {
    if (longPressTimer) {
      clearTimeout(longPressTimer);
      longPressTimer = null;
    }
    window.removeEventListener('pointermove', onPointerMove);
    window.removeEventListener('pointerup', endDrag);
    window.removeEventListener('pointercancel', endDrag);

    if (!draggingEl) return;
    draggingEl.classList.remove('is-dragging');
    if (ghostEl) {
      ghostEl.remove();
      ghostEl = null;
    }
    const from = startIndex;
    const to = currentIndex;
    draggingEl = null;
    pointerId = null;
    if (from !== -1 && to !== -1 && from !== to) {
      onReorder(from, to);
    }
  }

  function onPointerDown(e) {
    if (e.button !== 0 && e.pointerType === 'mouse') return;
    if (e.target.closest('button, input, label, select, a')) return;

    const item = e.target.closest(itemSelector);
    if (!item || !container.contains(item)) return;
    if (handleSelector && !e.target.closest(handleSelector)) return;

    startX = e.clientX;
    startY = e.clientY;
    pointerId = e.pointerId;

    window.addEventListener('pointermove', onPointerMove, { passive: false });
    window.addEventListener('pointerup', endDrag);
    window.addEventListener('pointercancel', endDrag);

    if (e.pointerType === 'touch') {
      longPressTimer = setTimeout(() => {
        longPressTimer = null;
        startDrag(item, e);
      }, longPressMs);
    } else {
      // Mouse/pen: start drag on slight movement (>5px) so normal clicks still select/open
      const moveStart = (mv) => {
        if (mv.pointerId !== pointerId) return;
        if (Math.hypot(mv.clientX - startX, mv.clientY - startY) > 5) {
          window.removeEventListener('pointermove', moveStart);
          startDrag(item, mv);
        }
      };
      window.addEventListener('pointermove', moveStart);
      window.addEventListener('pointerup', () => window.removeEventListener('pointermove', moveStart), { once: true });
    }
  }

  container.addEventListener('pointerdown', onPointerDown);
  return () => container.removeEventListener('pointerdown', onPointerDown);
}
