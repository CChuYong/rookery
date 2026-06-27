import "@testing-library/jest-dom/vitest";

// jsdom has no ResizeObserver, but @tanstack/react-virtual (FileTree virtualization) and useSegmentIndicator
// observe elements with it. A no-op mock is enough — tests assert data/DOM presence, not layout-driven windowing.
class ResizeObserverMock {
  observe(): void {}
  unobserve(): void {}
  disconnect(): void {}
}
globalThis.ResizeObserver ??= ResizeObserverMock as unknown as typeof ResizeObserver;
