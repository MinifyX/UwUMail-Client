import { afterEach, describe, expect, it, vi } from "vitest";
import { fitMenu, keepMenusInView } from "./menuInView";

function menuAt(left: number, top: number, width: number, height: number) {
  const menu = document.createElement("div");
  menu.setAttribute("role", "menu");
  // Where the menu ends up after the shift, as a browser would report it.
  menu.getBoundingClientRect = () => {
    const [dx = 0, dy = 0] = (menu.style.translate || "0px 0px").split(" ").map((v) => parseFloat(v));
    return new DOMRect(left + dx, top + dy, width, height);
  };
  return menu;
}

afterEach(() => {
  document.body.innerHTML = "";
});

describe("fitMenu", () => {
  it("leaves a menu alone that fits", () => {
    const menu = menuAt(20, 100, 200, 150);
    fitMenu(menu, 375, 667);
    expect(menu.style.translate).toBe("");
  });

  it("moves a menu that sticks out on the left back in", () => {
    const menu = menuAt(-110, 100, 280, 150);
    fitMenu(menu, 375, 667);
    expect(menu.style.translate).toBe("118px 0px");
  });

  it("moves a menu that sticks out on the right back in", () => {
    const menu = menuAt(300, 100, 200, 150);
    fitMenu(menu, 375, 667);
    expect(menu.style.translate).toBe("-133px 0px");
  });

  it("keeps the left edge in view when the menu is wider than the window", () => {
    const menu = menuAt(-50, 100, 500, 150);
    fitMenu(menu, 375, 667);
    expect(menu.getBoundingClientRect().left).toBe(8);
  });

  it("lifts a menu that runs past the bottom, but not past the top", () => {
    const menu = menuAt(20, 600, 200, 150);
    fitMenu(menu, 375, 667);
    expect(menu.style.translate).toBe("0px -91px");
  });
});

describe("keepMenusInView", () => {
  it("fits menus as they open", async () => {
    const stop = keepMenusInView(document.body);
    const wrapper = document.createElement("div");
    const menu = menuAt(-40, 10, 200, 100);
    wrapper.append(menu);
    vi.stubGlobal("innerWidth", 375);
    document.body.append(wrapper);
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(menu.style.translate).toBe("48px 0px");
    stop();
    vi.unstubAllGlobals();
  });
});
