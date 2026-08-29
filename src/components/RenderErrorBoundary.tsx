import { Component, type ReactNode } from "react";

interface RenderErrorBoundaryProps {
  children: ReactNode;
  fallback: ReactNode;
  onError?: (error: unknown) => void;
}

class Boundary extends Component<
  RenderErrorBoundaryProps,
  { failed: boolean }
> {
  state = { failed: false };

  static getDerivedStateFromError() {
    return { failed: true };
  }

  componentDidCatch(error: unknown) {
    this.props.onError?.(error);
  }

  render() {
    return this.state.failed ? this.props.fallback : this.props.children;
  }
}

/** Catch a render failure at the nearest surface and show its owned fallback. */
export function RenderErrorBoundary(props: RenderErrorBoundaryProps) {
  return <Boundary {...props} />;
}
