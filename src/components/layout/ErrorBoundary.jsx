import { Component } from 'react';

export default class ErrorBoundary extends Component {
  constructor(props) {
    super(props);
    this.state = {
      error: null,
      errorInfo: null,
    };
  }

  static getDerivedStateFromError(error) {
    return { error };
  }

  componentDidCatch(error, errorInfo) {
    this.setState({ errorInfo });

    if (typeof console !== 'undefined') {
      console.error('[CertSim] Render fallback caught an error.', error, errorInfo);
    }
  }

  componentDidUpdate(previousProps) {
    if (
      this.state.error &&
      previousProps.resetKey !== this.props.resetKey
    ) {
      this.resetErrorBoundary();
    }
  }

  resetErrorBoundary = () => {
    this.setState({
      error: null,
      errorInfo: null,
    });
  };

  render() {
    if (this.state.error) {
      if (this.props.fallback) {
        return this.props.fallback({
          error: this.state.error,
          errorInfo: this.state.errorInfo,
          resetErrorBoundary: this.resetErrorBoundary,
        });
      }

      return null;
    }

    return this.props.children;
  }
}
