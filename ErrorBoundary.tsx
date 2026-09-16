import { Component, type ErrorInfo, type ReactNode } from 'react';

interface Props {
  children: ReactNode;
}

interface State {
  hasError: boolean;
}

// L-16: guards a page section against an unhandled render/lifecycle error
// crashing the whole app to a blank white screen — catches it, logs it, and
// offers a retry instead. Only covers rendering errors in its subtree (React
// error boundary semantics); it doesn't catch errors from event handlers or
// async code, which this app already handles via its own try/catch + toast
// patterns elsewhere.
export class ErrorBoundary extends Component<Props, State> {
  state: State = { hasError: false };

  static getDerivedStateFromError(): State {
    return { hasError: true };
  }

  componentDidCatch(error: Error, info: ErrorInfo) {
    console.error('ErrorBoundary caught an error:', error, info);
  }

  handleRetry = () => {
    this.setState({ hasError: false });
  };

  render() {
    if (this.state.hasError) {
      return (
        <div className="min-h-screen flex items-center justify-center bg-gray-50">
          <div className="flex flex-col items-center gap-4 text-center px-6">
            <p className="text-gray-600 text-sm">Something went wrong loading this page.</p>
            <button
              type="button"
              onClick={this.handleRetry}
              className="px-4 py-2 text-sm font-medium text-white bg-orange-600 hover:bg-orange-700 rounded-lg transition-colors"
            >
              Try again
            </button>
          </div>
        </div>
      );
    }
    return this.props.children;
  }
}
