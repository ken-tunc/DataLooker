import { Component, type ErrorInfo, type ReactNode } from "react";
import { IpcError } from "./invoke";

type Props = { children: ReactNode };
type State = { error: Error | null };

export class ErrorBoundary extends Component<Props, State> {
  state: State = { error: null };

  static getDerivedStateFromError(error: Error): State {
    return { error };
  }

  componentDidCatch(error: Error, info: ErrorInfo) {
    console.error("ErrorBoundary caught:", error, info);
  }

  handleReset = () => {
    this.setState({ error: null });
  };

  render() {
    const { error } = this.state;
    if (!error) return this.props.children;
    const kind = error instanceof IpcError ? error.kind : error.name;
    return (
      <div className="flex min-h-screen items-center justify-center p-8">
        <div role="alert" className="alert alert-error max-w-xl flex-col items-start gap-3">
          <span>
            <strong>{kind}:</strong> {error.message}
          </span>
          <button type="button" className="btn btn-sm" onClick={this.handleReset}>
            Retry
          </button>
        </div>
      </div>
    );
  }
}
