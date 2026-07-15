import "@testing-library/jest-dom/vitest";

// jsdom has no ResizeObserver, but @tanstack/react-virtual (FileTree virtualization) and useSegmentIndicator
// observe elements with it. A no-op mock is enough — tests assert data/DOM presence, not layout-driven windowing.
class ResizeObserverMock {
  observe(): void {}
  unobserve(): void {}
  disconnect(): void {}
}
globalThis.ResizeObserver ??= ResizeObserverMock as unknown as typeof ResizeObserver;

// Lexical uses browser geometry to keep a restored model selection visible.
// jsdom intentionally has no layout engine, so stable zero-sized geometry is
// sufficient for editor behavior tests.
Range.prototype.getBoundingClientRect ??= () => new DOMRect();
Range.prototype.getClientRects ??= () => [] as unknown as DOMRectList;

// @lexical/utils checks both DragEvent and ClipboardEvent constructors while
// routing rich-text commands. jsdom does not currently define DragEvent.
if (globalThis.DragEvent == null) {
  class DragEventMock extends MouseEvent {
    readonly dataTransfer: DataTransfer | null = null;
  }
  globalThis.DragEvent = DragEventMock as unknown as typeof DragEvent;
}
