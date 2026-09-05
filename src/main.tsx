import { StrictMode, Component, type ReactNode } from 'react';
import { createRoot } from 'react-dom/client';
import App from './App';
import './styles/app.css';
class ErrorBoundary extends Component<{ children: ReactNode }, { failed: boolean }> {
  state = { failed: false };
  static getDerivedStateFromError() { return { failed: true }; }
  render() {
    if (this.state.failed) return <main className="recovery"><h1>机器人需要休息一下</h1><p>页面遇到了问题。已保存的草稿仍留在当前浏览器中。</p><button onClick={() => location.reload()}>重新打开工作台</button></main>;
    return this.props.children;
  }
}
createRoot(document.getElementById('root')!).render(<StrictMode><ErrorBoundary><App /></ErrorBoundary></StrictMode>);
