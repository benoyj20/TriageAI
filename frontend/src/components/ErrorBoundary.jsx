import { Component } from 'react';
import { TriangleAlert } from 'lucide-react';

// Keeps one broken view (e.g. an unexpected gateway field) from unmounting the whole console.
// Pass a resetKey (the route) so navigating away clears the error.
export default class ErrorBoundary extends Component {
  state = { error: null, key: this.props.resetKey };

  static getDerivedStateFromError(error) {
    return { error };
  }

  static getDerivedStateFromProps(props, state) {
    return props.resetKey !== state.key ? { error: null, key: props.resetKey } : null;
  }

  componentDidCatch(error, info) {
    console.error('View crashed:', error, info.componentStack);
  }

  render() {
    if (!this.state.error) return this.props.children;
    return (
      <div role="alert" className="m-6 rounded border border-red-200 bg-red-50 px-5 py-4 text-[13px] text-red-900">
        <div className="flex items-center gap-2 font-semibold"><TriangleAlert size={16} /> This view could not be shown.</div>
        <p className="mt-1 text-red-800">{String(this.state.error?.message ?? this.state.error)}</p>
        <a href="#/console" className="mt-2 inline-block text-brand-700 hover:underline">Back to the dashboard</a>
      </div>
    );
  }
}
