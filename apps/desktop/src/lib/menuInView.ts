/** Room kept between a menu and the window's edge. */
const MARGIN = 8;

/**
 * Moves a menu that opened partly outside the window back in. The package's menus hang off their
 * button's left or right edge; on a phone a button in the middle of a row leaves too little room
 * on that side, and the menu (or half of it) ended up off the screen.
 */
export function fitMenu(menu: HTMLElement, width = window.innerWidth, height = window.innerHeight) {
  menu.style.translate = "";
  const box = menu.getBoundingClientRect();
  let dx = 0;
  if (box.right > width - MARGIN) dx = width - MARGIN - box.right;
  if (box.left + dx < MARGIN) dx = MARGIN - box.left;
  let dy = 0;
  if (box.bottom > height - MARGIN) dy = Math.max(height - MARGIN - box.bottom, MARGIN - box.top);
  if (dx !== 0 || dy !== 0) menu.style.translate = `${Math.round(dx)}px ${Math.round(dy)}px`;
}

/** Keeps every menu that opens from now on inside the window. Returns the undo. */
export function keepMenusInView(root: Node = document.body): () => void {
  const observer = new MutationObserver((records) => {
    for (const record of records) {
      for (const node of record.addedNodes) {
        if (!(node instanceof HTMLElement)) continue;
        const menus = node.matches("[role=menu]") ? [node] : [...node.querySelectorAll<HTMLElement>("[role=menu]")];
        for (const menu of menus) fitMenu(menu);
      }
    }
  });
  observer.observe(root, { childList: true, subtree: true });
  return () => observer.disconnect();
}
