import { useEffect, useRef, useState, type FormEvent, type MouseEvent } from 'react';
import { Modal } from '../../components/Modal';
import { Icon } from '../../components/Icon';
import { RobotMark } from '../../components/RobotMark';
import { ApiError, request, type AuthCapabilities, type AuthUser } from './api';
import './auth.css';

export type { AuthCapabilities, AuthUser } from './api';

interface AuthDialogProps {
  user: AuthUser | null;
  capabilities: AuthCapabilities;
  onClose: () => void;
  onAuthenticated: (user: AuthUser) => void;
  onLogout: () => Promise<void>;
  syncStatus: string;
  onRetrySync: () => void;
}

export function AccountIcon({ size = 21 }: { size?: number }) {
  return <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" aria-hidden="true"><circle cx="12" cy="8" r="3.5" /><path d="M4.5 20v-2a7.5 7.5 0 0 1 15 0v2" /></svg>;
}

function CloudIcon() {
  return <svg width="21" height="21" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="M7 18H6a4 4 0 0 1-1-7.9A7 7 0 0 1 18.4 8 5 5 0 0 1 19 18h-2" /><path d="m9 14 3-3 3 3m-3-3v10" /></svg>;
}

function GoogleIcon() {
  return <svg width="20" height="20" viewBox="0 0 48 48" aria-hidden="true"><path fill="#EA4335" d="M24 9.5c3.5 0 6.6 1.2 9 3.5l6.8-6.8A22.8 22.8 0 0 0 24 0C14.6 0 6.5 5.4 2.6 13.2l7.9 6.1A14.4 14.4 0 0 1 24 9.5Z" /><path fill="#4285F4" d="M47 24.5c0-1.6-.1-3.3-.4-4.9H24v9.2h12.9a11.1 11.1 0 0 1-4.8 7.3l7.7 6C44.4 37.9 47 31.8 47 24.5Z" /><path fill="#FBBC05" d="M10.5 28.7a14.4 14.4 0 0 1 0-9.4l-7.9-6.1a24 24 0 0 0 0 21.6l7.9-6.1Z" /><path fill="#34A853" d="M24 48c6.5 0 12-2.1 15.9-5.9l-7.7-6a14.7 14.7 0 0 1-21.7-7.4l-7.9 6.1C6.5 42.6 14.6 48 24 48Z" /></svg>;
}

export function AuthDialog({ user, capabilities, onClose, onAuthenticated, onLogout, syncStatus, onRetrySync }: AuthDialogProps) {
  const [mode, setMode] = useState<'login' | 'register'>('login');
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [code, setCode] = useState('');
  const [showPassword, setShowPassword] = useState(false);
  const [pending, setPending] = useState<'code' | 'submit' | 'logout' | 'google' | null>(null);
  const [error, setError] = useState('');
  const [message, setMessage] = useState('');
  const [resendAt, setResendAt] = useState(0);
  const [now, setNow] = useState(Date.now());
  const emailRef = useRef<HTMLInputElement>(null);
  const codeRef = useRef<HTMLInputElement>(null);
  const busy = useRef(false);
  const googleRedirecting = useRef(false);
  const navigationFrame = useRef<number | null>(null);
  const googlePending = pending === 'google';
  const remaining = Math.max(0, Math.ceil((resendAt - now) / 1000));

  useEffect(() => {
    // A back navigation can restore this exact component from the browser cache.
    const restore = () => {
      if (!googleRedirecting.current) return;
      if (navigationFrame.current !== null) window.cancelAnimationFrame(navigationFrame.current);
      navigationFrame.current = null;
      googleRedirecting.current = false; busy.current = false; setPending(null);
    };
    window.addEventListener('pageshow', restore);
    return () => {
      window.removeEventListener('pageshow', restore);
      if (navigationFrame.current !== null) window.cancelAnimationFrame(navigationFrame.current);
    };
  }, []);

  useEffect(() => {
    if (resendAt <= Date.now()) return;
    const timer = window.setInterval(() => {
      const time = Date.now();
      setNow(time);
      if (time >= resendAt) window.clearInterval(timer);
    }, 1000);
    return () => window.clearInterval(timer);
  }, [resendAt]);

  const setCooldown = (seconds: number) => {
    const time = Date.now();
    setNow(time);
    setResendAt(time + Math.min(Math.max(Math.ceil(seconds), 1), 3600) * 1000);
  };

  const sendCode = async () => {
    if (busy.current || remaining > 0 || !capabilities.email || !emailRef.current?.reportValidity()) return;
    busy.current = true;
    setPending('code'); setError(''); setMessage('');
    try {
      const result = await request<{ retryAfter: number }>('/auth/code', { email: email.trim() });
      setCooldown(result.retryAfter || 60);
      setMessage('验证码已发送，请检查收件箱和垃圾邮件。10 分钟内有效。');
      window.requestAnimationFrame(() => codeRef.current?.focus());
    } catch (reason) {
      if (reason instanceof ApiError && reason.retryAfter > 0) setCooldown(reason.retryAfter);
      setError(reason instanceof Error ? reason.message : '验证码没有发送成功，请稍后再试。');
    } finally { busy.current = false; setPending(null); }
  };

  const submit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (busy.current || (mode === 'register' && !capabilities.email)) return;
    busy.current = true;
    setPending('submit'); setError(''); setMessage('');
    try {
      const result = await request<{ user: AuthUser }>(`/auth/${mode}`, {
        email: email.trim(), password, ...(mode === 'register' ? { code } : {}),
      });
      onAuthenticated(result.user);
      onClose();
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : '暂时无法登录，请稍后再试。');
    } finally { busy.current = false; setPending(null); }
  };

  const logout = async () => {
    if (busy.current) return;
    busy.current = true;
    setPending('logout'); setError('');
    try { await onLogout(); onClose(); }
    catch (reason) { setError(reason instanceof Error ? reason.message : '退出没有完成，请稍后再试。'); }
    finally { busy.current = false; setPending(null); }
  };

  const beginGoogleLogin = (event: MouseEvent<HTMLAnchorElement>) => {
    if (busy.current) { event.preventDefault(); return; }
    // Keep native new-tab/new-window behavior; only this tab needs a waiting state.
    if (event.defaultPrevented || event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
    event.preventDefault();
    const target = event.currentTarget.href;
    googleRedirecting.current = true; busy.current = true;
    setPending('google'); setError(''); setMessage('');
    // Paint the transition before the browser starts a document navigation.
    navigationFrame.current = window.requestAnimationFrame(() => {
      navigationFrame.current = window.requestAnimationFrame(() => {
        navigationFrame.current = null;
        if (googleRedirecting.current) window.location.assign(target);
      });
    });
  };

  return <Modal title={user ? '我的账号与进度' : '记录每一次探索'} onClose={onClose}>
    <div className="auth-dialog">
      {user ? <>
        <div className="account-identity"><span className="account-avatar"><AccountIcon size={30} /></span><div><span className="auth-eyebrow">欢迎回来，小小创造家</span><strong className="account-email">{user.email}</strong><span className="account-provider">{user.provider === 'google' ? '使用 Google 账号登录' : '使用邮箱账号登录'}</span></div></div>
        <section className="account-sync" aria-label="同步状态"><div className="account-sync-heading"><CloudIcon /><strong>通关记录，随账号同行</strong></div><p className="account-sync-status" role="status">{syncStatus}</p><p>登录时合并浏览器与账号中的历史记录。积木或记录有变化时，再稍后一起同步。</p><button type="button" className="auth-sync-button" onClick={onRetrySync} disabled={pending !== null}><Icon name="reset" size={17} />重新同步</button></section>
        <p className="auth-footnote">退出后仍可继续编程。未登录的新记录会保存在这台浏览器，之后登录时再合并。</p>
        {error && <p className="auth-feedback auth-error" role="alert">{error}</p>}
        <button type="button" className="auth-logout" disabled={pending !== null} onClick={() => void logout()}>{pending === 'logout' ? '正在保存并退出…' : '退出登录'}</button>
      </> : <>
        <div className="auth-intro"><span className="auth-robot"><RobotMark /></span><p>把今天摆好的积木和通关记录，<br /><strong>带到下一次冒险。</strong></p></div>
        <div className="auth-mode" role="group" aria-label="登录或注册"><button type="button" aria-pressed={mode === 'login'} disabled={pending !== null} onClick={() => { setMode('login'); setError(''); setMessage(''); }}>邮箱登录</button><button type="button" aria-pressed={mode === 'register'} disabled={pending !== null} onClick={() => { setMode('register'); setError(''); setMessage(''); }}>注册新账号</button></div>
        <form className="auth-form" onSubmit={event => void submit(event)}>
          <label className="auth-field"><span>邮箱地址</span><input ref={emailRef} type="email" name="email" autoComplete="email" placeholder="you@example.com" value={email} required maxLength={254} disabled={pending !== null} onChange={event => { setEmail(event.target.value); setCode(''); setMessage(''); setError(''); }} /></label>
          <div className="auth-field"><label htmlFor="auth-password">{mode === 'register' ? '设置密码' : '密码'}</label><span className="auth-password"><input id="auth-password" type={showPassword ? 'text' : 'password'} name="password" autoComplete={mode === 'register' ? 'new-password' : 'current-password'} placeholder={mode === 'register' ? '至少 8 位，建议混合字母和数字' : '输入你的密码'} value={password} required minLength={mode === 'register' ? 8 : undefined} maxLength={128} aria-describedby={mode === 'register' ? 'auth-password-hint' : undefined} disabled={pending !== null} onChange={event => setPassword(event.target.value)} /><button type="button" className="auth-password-toggle" aria-label={showPassword ? '隐藏密码' : '显示密码'} aria-pressed={showPassword} onClick={() => setShowPassword(value => !value)}>{showPassword ? '隐藏' : '显示'}</button></span>{mode === 'register' && <small id="auth-password-hint">8–128 位；请使用这个账号专属的密码。</small>}</div>
          {mode === 'register' && <div className="auth-field"><label htmlFor="auth-code">邮箱验证码</label><span className="auth-code-row"><input id="auth-code" ref={codeRef} type="text" name="code" autoComplete="one-time-code" inputMode="numeric" pattern="[0-9]{6}" placeholder="6 位数字" value={code} required maxLength={6} disabled={pending !== null} onChange={event => setCode(event.target.value.replace(/\D/g, '').slice(0, 6))} /><button type="button" className="auth-code-button" disabled={pending !== null || remaining > 0 || !capabilities.email} onClick={() => void sendCode()}>{pending === 'code' ? '发送中…' : remaining > 0 ? `${remaining} 秒后重发` : '获取验证码'}</button></span></div>}
          {mode === 'register' && !capabilities.email && <p className="auth-service-note" role="status">注册邮件服务正在准备中。你可以先继续编程，浏览器会保存记录。</p>}
          {error && <p className="auth-feedback auth-error" role="alert">{error}</p>}
          {message && <p className="auth-feedback auth-success" role="status">{message}</p>}
          <button type="submit" className="auth-submit" disabled={pending !== null || (mode === 'register' && !capabilities.email)}>{pending === 'submit' ? (mode === 'register' ? '正在创建账号…' : '正在登录…') : mode === 'register' ? '注册并同步进度' : '登录并同步进度'}<Icon name="arrow" size={19} /></button>
        </form>
        <div className="auth-divider"><span>也可以</span></div>
        {capabilities.google ? <a className={`auth-google ${pending !== null ? 'auth-google-disabled' : ''}`} aria-disabled={pending !== null} aria-busy={googlePending} href={`/api/auth/google?returnTo=${encodeURIComponent(window.location.pathname)}`} onClick={beginGoogleLogin}>{googlePending ? <span className="auth-redirect-spinner" aria-hidden="true" /> : <GoogleIcon />}<span>{googlePending ? '正在跳转至 Google…' : '使用 Google 继续'}</span></a> : <><button type="button" className="auth-google" disabled><GoogleIcon />使用 Google 继续</button><p className="auth-google-note">Google 登录正在准备中</p></>}
        {googlePending && <p className="auth-google-transition" role="status">正在打开 Google 登录页，请稍候。选择账号后会自动返回。</p>}
        <p className="auth-local-note"><Icon name="check" size={17} /><span>不登录也能玩。历史记录先留在浏览器，登录后自动合并；有新变化时再批量同步。</span></p>
      </>}
    </div>
  </Modal>;
}
