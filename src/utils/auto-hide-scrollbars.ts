/**
 * Auto-hiding scrollbars utility
 * Adds 'scrolling' class to elements while they're being scrolled
 */

let scrollTimeout: NodeJS.Timeout;
const scrollingElements = new Set<Element>();

function isScrollable(element: Element): boolean {
  return (
    element.scrollHeight > element.clientHeight ||
    element.scrollWidth > element.clientWidth
  );
}

function addScrollListener(element: Element) {
  if (isScrollable(element)) {
    element.addEventListener("scroll", handleScroll, { passive: true });
  }
}

function handleScroll(event: Event) {
  const target = event.target;

  if (!target || target === document || target === window) return;

  const element = target as Element;

  // Add scrolling class
  element.classList.add("scrolling");
  scrollingElements.add(element);

  // Clear existing timeout
  clearTimeout(scrollTimeout);

  // Remove scrolling class after scroll ends
  scrollTimeout = setTimeout(() => {
    scrollingElements.forEach((el) => {
      el.classList.remove("scrolling");
    });
    scrollingElements.clear();
  }, 150);
}

export function initAutoHideScrollbars() {
  // Add scroll event listener to capture all scroll events
  document.addEventListener("scroll", handleScroll, {
    passive: true,
    capture: true,
  });

  // Also handle programmatic scrolls by observing scroll events on all elements
  const observer = new MutationObserver((mutations) => {
    mutations.forEach((mutation) => {
      mutation.addedNodes.forEach((node) => {
        if (node.nodeType === Node.ELEMENT_NODE) {
          const element = node as Element;
          addScrollListener(element);
          const childElements = element.querySelectorAll("*");
          childElements.forEach(addScrollListener);
        }
      });
    });
  });

  observer.observe(document.body, {
    childList: true,
    subtree: true,
  });

  const scrollableElements = document.querySelectorAll("*");
  scrollableElements.forEach(addScrollListener);
}

export function cleanupAutoHideScrollbars() {
  document.removeEventListener("scroll", handleScroll, true);
  clearTimeout(scrollTimeout);
  scrollingElements.clear();
}
