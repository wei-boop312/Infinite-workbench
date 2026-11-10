import type { CanvasSnapshot } from "./model";

export type HistoryState = {
  past: CanvasSnapshot[];
  present: CanvasSnapshot;
  future: CanvasSnapshot[];
  gestureBase?: CanvasSnapshot;
};

export type HistoryAction =
  | { type: "commit"; next: CanvasSnapshot }
  | { type: "transient"; next: CanvasSnapshot }
  | { type: "gesture"; next: CanvasSnapshot }
  | { type: "gesture-commit"; next: CanvasSnapshot }
  | { type: "reset"; next: CanvasSnapshot }
  | { type: "undo" }
  | { type: "redo" };

const HISTORY_LIMIT = 80;

function append(past: CanvasSnapshot[], snapshot: CanvasSnapshot): CanvasSnapshot[] {
  return [...past, snapshot].slice(-HISTORY_LIMIT);
}

export function createHistoryState(snapshot: CanvasSnapshot): HistoryState {
  return { past: [], present: snapshot, future: [] };
}

export function historyReducer(state: HistoryState, action: HistoryAction): HistoryState {
  switch (action.type) {
    case "commit":
      return {
        past: append(state.past, state.gestureBase ?? state.present),
        present: action.next,
        future: [],
      };
    case "transient":
      return { ...state, present: action.next };
    case "gesture":
      return { ...state, gestureBase: state.gestureBase ?? state.present, present: action.next };
    case "gesture-commit":
      return {
        past: append(state.past, state.gestureBase ?? state.present),
        present: action.next,
        future: [],
      };
    case "undo": {
      const previous = state.past.at(-1);
      if (!previous) return state;
      return {
        past: state.past.slice(0, -1),
        present: previous,
        future: [state.present, ...state.future],
      };
    }
    case "redo": {
      const next = state.future[0];
      if (!next) return state;
      return {
        past: append(state.past, state.present),
        present: next,
        future: state.future.slice(1),
      };
    }
    case "reset":
      return createHistoryState(action.next);
  }
}

