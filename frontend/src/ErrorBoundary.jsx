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
            <h2>Ứng dụng gặp lỗi hiển thị</h2>
            <p>Lỗi đã được chặn — trang không trắng. Tải lại để tiếp tục.</p>
            {this.state.error && <pre className="crash-pre">{this.state.error.toString()}</pre>}
            <button className="btn btn-primary" onClick={this.handleReset}>
              <RefreshCw size={16} /> Tải lại
            </button>
          </div>
        </div>
      );
    }
    return this.props.children;
  }
}
