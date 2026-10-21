import React from 'react';
import { AlertTriangle, RefreshCw } from 'lucide-react';

export class ErrorBoundary extends React.Component {
  constructor(props) {
    super(props);
    this.state = { hasError: false, error: null };
  }

  static getDerivedStateFromError(error) {
    return { hasError: true, error };
  }

  componentDidCatch(error, errorInfo) {
    console.error('Uncaught error caught by ErrorBoundary:', error, errorInfo);
  }

  handleReset = () => {
    this.setState({ hasError: false, error: null });
    window.location.href = '/';
  };

  render() {
    if (this.state.hasError) {
      return (
        <div className="crash-wrap">
          <div className="crash-card">
            <AlertTriangle size={28} />
            <h2>This screen hit a display error</h2>
            <p>The error was caught, so the page stays usable. Reload to continue.</p>
            {this.state.error && <pre className="crash-pre">{this.state.error.toString()}</pre>}
            <button className="btn btn-primary" onClick={this.handleReset}>
              <RefreshCw size={16} /> Reload
            </button>
          </div>
        </div>
      );
    }
    return this.props.children;
  }
}
