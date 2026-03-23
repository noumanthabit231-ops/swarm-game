import React, { Component, ErrorInfo, ReactNode } from "react";

interface Props {
  children?: ReactNode;
}

interface State {
  hasError: boolean;
  error: Error | null;
}

class ErrorBoundary extends Component<Props, State> {
  public state: State = {
    hasError: false,
    error: null
  };

  public static getDerivedStateFromError(error: Error): State {
    // Update state so the next render will show the fallback UI.
    return { hasError: true, error };
  }

  public componentDidCatch(error: Error, errorInfo: ErrorInfo) {
    console.error("Uncaught error:", error, errorInfo);
  }

  public render() {
    if (this.state.hasError) {
      return (
        <div className="fixed inset-0 bg-slate-950 flex flex-col items-center justify-center p-6 text-center z-[500]">
          <div className="w-20 h-20 rounded-full bg-red-500/20 flex items-center justify-center mb-6 border-2 border-red-500/30">
            <span className="text-4xl">⚠️</span>
          </div>
          <h1 className="text-3xl font-black text-white mb-4 uppercase tracking-tighter">Something went wrong</h1>
          <p className="text-slate-400 max-w-md mb-8">
            The Imperial Engine encountered an unexpected error. Don't worry, Sultan, we are working on it.
          </p>
          <div className="bg-red-950/30 border border-red-500/20 rounded-2xl p-4 mb-8 w-full max-w-lg overflow-auto">
            <code className="text-red-400 text-xs text-left block whitespace-pre-wrap">
              {this.state.error?.toString()}
            </code>
          </div>
          <button
            onClick={() => window.location.reload()}
            className="px-8 py-4 bg-indigo-600 hover:bg-indigo-500 text-white font-black rounded-2xl transition-all uppercase tracking-widest"
          >
            Reload Game
          </button>
        </div>
      );
    }

    return this.props.children;
  }
}

export default ErrorBoundary;
