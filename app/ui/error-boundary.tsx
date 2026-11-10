import { Component, Fragment, type ReactNode } from "react";

/** Keep a failed panel recoverable instead of unmounting the entire workspace. */
export class ErrorBoundary extends Component<
  { children: ReactNode; close?: () => void },
  { error: Error | null; attempt: number }
> {
  state = { error: null as Error | null, attempt: 0 };
  static getDerivedStateFromError(error: Error) {
    return { error };
  }
  render() {
    if (this.state.error)
      return (
        <section className="panel form-error" role="alert">
          <h2>This panel could not be displayed</h2>
          <p>
            Your saved research is still available. No model request was
            restarted.
          </p>
          <details>
            <summary>Error details</summary>
            <pre>{this.state.error.message}</pre>
          </details>
          <div className="actions">
            <button
              type="button"
              className="button secondary"
              onClick={() =>
                this.setState((s) => ({ error: null, attempt: s.attempt + 1 }))
              }
            >
              Reopen panel
            </button>
            {this.props.close ? (
              <button
                type="button"
                className="button secondary"
                onClick={this.props.close}
              >
                Close panel
              </button>
            ) : (
              <button
                type="button"
                className="button secondary"
                onClick={() => window.location.reload()}
              >
                Reload app
              </button>
            )}
          </div>
        </section>
      );
    return <Fragment key={this.state.attempt}>{this.props.children}</Fragment>;
  }
}
