import { Component, type ErrorInfo, type ReactNode } from 'react';
import { Button } from '@/components/ui/button';

/**
 * Catches a crash in one part of the screen so the rest keeps working, and offers a retry.
 * `resetKey` clears the error when it changes (e.g. when you open another conversation).
 */
export class ErrorBoundary extends Component<
  { children: ReactNode; resetKey?: string; label?: string },
  { failed: boolean; key?: string | undefined }
> {
  override state: { failed: boolean; key?: string | undefined } = { failed: false };

  static getDerivedStateFromError() {
    return { failed: true };
  }

  static getDerivedStateFromProps(
    props: { resetKey?: string },
    state: { failed: boolean; key?: string | undefined },
  ) {
    return props.resetKey !== state.key ? { failed: false, key: props.resetKey } : null;
  }

  override componentDidCatch(error: Error, info: ErrorInfo) {
    console.error(error, info.componentStack);
  }

  override render() {
    if (!this.state.failed) return this.props.children;
    return (
      <div role="alert" className="grid flex-1 place-items-center px-6 text-center">
        <div>
          <p className="text-[15px] text-muted">{this.props.label ?? 'Something went wrong here.'}</p>
          <Button variant="ghost" className="mt-3" onClick={() => this.setState({ failed: false })}>
            Try again
          </Button>
        </div>
      </div>
    );
  }
}
