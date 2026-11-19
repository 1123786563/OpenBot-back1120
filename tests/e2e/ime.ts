import type { Browser } from "@e2e-dev/web";

export function confirmComposition(browser: Browser) {
  return browser.evaluate(() => {
    const field = document.activeElement;
    if (
      !(
        field instanceof HTMLInputElement ||
        field instanceof HTMLTextAreaElement
      )
    )
      throw new Error("Focus the field that is composing a character");
    // Reproduce Chromium's event and the legacy event emitted after compositionend.
    return [{ isComposing: true }, { keyCode: 229 }].map((composition) => {
      const event = new KeyboardEvent("keydown", {
        key: "Enter",
        bubbles: true,
        cancelable: true,
        ...composition,
      });
      field.dispatchEvent(event);
      return event.defaultPrevented;
    });
  });
}
