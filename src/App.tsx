import { useEffect, useRef, useState } from 'react';
import { Icon } from './components/Icon';
import { RobotMark } from './components/RobotMark';
import { HelpDialog } from './components/HelpDialog';
import { LevelPicker } from './features/levels/LevelPicker';
import { ProgramEditor } from './features/editor/ProgramEditor';
import { RobotMap } from './features/simulator/RobotMap';
import { usePlayer } from './features/simulator/usePlayer';
import { ExecutionBreadcrumb } from './features/simulator/ExecutionBreadcrumb';
import { AuthDialog, AccountIcon } from './features/auth/AuthDialog';
import { ApiError, request, type AuthUser, type AuthCapabilities } from './features/auth/api';
import { useProgressSync } from './features/sync/useProgressSync';
import { enableSound } from './features/simulator/sound';
import { levels, getLevel } from './data/levels';
import { loadSave, importProgram, exportProgram } from './storage';
import { countBlocks } from './engine';
import { emptyProgram, type Settings, type Program } from './types';

export default function App() {
  const [initial] = useState(() => loadSave(levels));
  const [save, setSave] = useState(initial.data);
  const [notice, setNotice] = useState(initial.warning ?? '');
  const [storageWarningDismissed, setStorageWarningDismissed] = useState(false);
  const [dialog, setDialog] = useState<'levels' | 'help' | 'auth' | null>(null);
  const [user, setUser] = useState<AuthUser | null | undefined>(undefined);
  const [capabilities, setCapabilities] = useState<AuthCapabilities>({ email: false, google: false });
  const [mobilePanel, setMobilePanel] = useState<'map' | 'editor'>('map');
  const [hintCount, setHintCount] = useState(0);
  const inputRef = useRef<HTMLInputElement>(null);
  const importVersion = useRef(0);
  const sessionVersion = useRef(0);
  const level = getLevel(save.currentLevel);
  const program = save.drafts[level.id] ?? emptyProgram();
  const player = usePlayer(level, save.settings, snapshot => {
    setSave(current => ({ ...current, completed: { ...current.completed, [level.id]: {
      completedAt: new Date().toISOString(), blocks: countBlocks(program), actions: snapshot.runtime.actions, program: structuredClone(program),
    } } }));
  });
  const { snapshot, resetKey } = player;
  const { runtime } = snapshot;
  const locked = ['running', 'pausing', 'paused'].includes(snapshot.status);
  const performing = snapshot.status === 'running' || snapshot.status === 'pausing';
  const sync = useProgressSync({ save, setSave, userId: user?.id ?? (user === undefined ? undefined : null), canApply: !locked,
    onBeforeApply: () => { importVersion.current++; player.reset(); },
  });
  const { storageError } = sync;
  const statusNames = { idle: '准备好出发', running: '正在执行', pausing: '正在暂停…', paused: '已暂停', finished: runtime.outcome === 'success' ? '挑战完成！' : runtime.status === 'error' ? '一起找找问题' : '执行结束' };
  const completedCount = levels.filter(l => l.mode === 'challenge' && save.completed[l.id]).length;
  useEffect(() => { setStorageWarningDismissed(false); }, [save, storageError]);
  useEffect(() => {
    let active = true;
    const version = ++sessionVersion.current;
    void request<{ user: AuthUser | null; capabilities: AuthCapabilities }>('/auth/session').then(result => {
      if (active && version === sessionVersion.current) { setUser(result.user); setCapabilities(result.capabilities); }
    }).catch(() => { if (active && version === sessionVersion.current) setUser(null); });
    const url = new URL(window.location.href);
    const error = url.searchParams.get('auth_error');
    if (error) {
      const messages: Record<string, string> = {
        google_state: 'Google 登录已过期，请重新点击登录。',
        google_cancelled: '已取消 Google 登录，你可以继续编程。',
        google_failed: 'Google 登录暂时没有完成，请稍后重试。',
        google_link_required: '这个邮箱已有账号，请先使用邮箱和密码登录。',
      };
      setNotice(messages[error] ?? 'Google 登录没有完成，请重试。');
      url.searchParams.delete('auth_error');
      window.history.replaceState(null, '', url);
    }
    return () => { active = false; };
  }, []);
  useEffect(() => () => { importVersion.current++; }, []);
  const changeSettings = (patch: Partial<Settings>) => { if (patch.sound) enableSound(); setSave(s => ({ ...s, settings: { ...s.settings, ...patch } })); };
  const changeProgram = (next: Program) => {
    if (locked) return;
    importVersion.current++;
    if (snapshot.status === 'finished') player.reset();
    setSave(s => ({ ...s, drafts: { ...s.drafts, [level.id]: next } }));
  };
  const chooseLevel = (id: string) => {
    importVersion.current++; player.reset();
    setSave(s => ({ ...s, currentLevel: id }));
    setDialog(null); setHintCount(0); setNotice(''); setMobilePanel('map');
  };
  const reset = () => { importVersion.current++; player.reset(); setNotice(''); };
  const authenticated = (account: AuthUser) => { sessionVersion.current++; reset(); setUser(account); };
  const logout = async () => {
    await sync.prepareLogout();
    try { await request('/auth/logout', {}, 'POST', { 'X-Brclio-User-Id': user?.id ?? '' }); }
    catch (error) {
      if (error instanceof ApiError && error.status === 409) {
        const session = await request<{ user: AuthUser | null; capabilities: AuthCapabilities }>('/auth/session');
        sessionVersion.current++; reset(); setUser(session.user); setCapabilities(session.capabilities);
      }
      throw error;
    }
    sessionVersion.current++; reset(); setUser(null);
  };
  const openAccount = () => {
    setDialog('auth');
    const version = ++sessionVersion.current;
    void request<{ user: AuthUser | null; capabilities: AuthCapabilities }>('/auth/session').then(result => {
      if (version !== sessionVersion.current) return;
      setCapabilities(result.capabilities);
      if (result.user?.id !== user?.id || user === undefined) { reset(); setUser(result.user); }
    }).catch(() => { if (version === sessionVersion.current && user === undefined) setUser(null); });
  };
  const run = () => { importVersion.current++; setNotice(''); player.run(program); setMobilePanel('map'); };
  const exportFile = () => {
    const blob = new Blob([exportProgram(program, level.id)], { type: 'application/json' });
    const url = URL.createObjectURL(blob), anchor = document.createElement('a');
    anchor.href = url; anchor.download = `Brclio-Robot-${level.id}-${new Date().toISOString().slice(0, 10)}.json`;
    anchor.click(); setTimeout(() => URL.revokeObjectURL(url), 0);
    setNotice('程序已导出。把这个文件留好，就有一份备份啦。');
  };
  const readFile = async (file?: File) => {
    if (!file || locked) return;
    const token = ++importVersion.current;
    if (file.size > 100_000) { setNotice('文件太大啦，请选择小于 100 KB 的机器人程序。'); return; }
    try {
      const result = importProgram(await file.text(), level);
      if (token !== importVersion.current) return;
      if (result.error || !result.program) { setNotice(result.error ?? '这个文件暂时无法读取。'); return; }
      if (countBlocks(program) > 0 && !window.confirm('导入会替换当前关卡的程序。已经导出备份或确定替换了吗？')) return;
      changeProgram(result.program); setNotice('导入成功！可以继续摆积木或运行。'); setMobilePanel('editor');
    } catch { setNotice('文件没有读成功，请重新选择一个 JSON 程序文件。'); }
  };
  const nextLevel = levels.find(l => l.number === level.number + 1 && l.mode === 'challenge');
  return <div className={`app-shell ${save.settings.reducedMotion ? 'reduce-motion' : ''}`}>
    <header className="app-header">
      <div className="brand" aria-label="Brclio 编程机器人工作台"><RobotMark /><span><strong>Brclio <em>Robot</em></strong><small>Brclio 编程机器人</small></span><span className="brand-divider" /></div>
      <button className="level-selector" onClick={() => setDialog('levels')} data-testid="open-levels"><span className="level-selector-icon"><Icon name="map" /></span><span>{level.mode === 'free' ? '自由练习场' : `第 ${String(level.number).padStart(2, '0')} 关`}<strong>{level.mode === 'free' ? '让想法自由走走' : level.title}</strong></span><Icon name="chevron" size={18} /></button>
      <div className="header-actions"><button className="account-button" onClick={openAccount} aria-label={user ? "我的账号与进度" : "登录或注册"}><AccountIcon /><span className="account-button-label">{user ? "我的账号" : "登录 / 注册"}</span></button><span className="course-progress"><Icon name="flag" size={18} />{completedCount}<span>/ 12</span></span><button className="icon-button" onClick={() => changeSettings({ sound: !save.settings.sound })} aria-label={save.settings.sound ? '关闭声音' : '开启声音'} aria-pressed={save.settings.sound}><Icon name={save.settings.sound ? 'sound' : 'mute'} /></button><button className="help-button" aria-label="帮助与设置" onClick={() => setDialog('help')}><Icon name="help" /><span>帮助与设置</span></button></div>
    </header>
    <div className="mobile-tabs" role="tablist" aria-label="工作台视图"><button role="tab" aria-selected={mobilePanel === 'map'} onClick={() => setMobilePanel('map')}><Icon name="map" />机器人地图</button><button role="tab" aria-selected={mobilePanel === 'editor'} onClick={() => setMobilePanel('editor')}><Icon name="blocks" />我的编程板 <span>{countBlocks(program)}</span></button></div>
    {(notice || (storageError && !storageWarningDismissed)) && <div className="notice" role="status"><Icon name="bulb" /><span>{storageError && !storageWarningDismissed ? storageError : notice}</span><button className="icon-button" aria-label="关闭提示" onClick={() => { setNotice(''); setStorageWarningDismissed(true); }}><Icon name="close" size={18} /></button></div>}
    <main className="workspace">
      <section className={`map-panel ${mobilePanel === 'map' ? 'mobile-visible' : ''}`} aria-label="地图与任务">
        <div className="section-heading"><div><p className="eyebrow"><span className="tiny-dot" />{level.mode === 'free' ? '自由探索 · 没有标准答案' : `${level.chapter} · 第 ${level.number} 关`}</p><h1>{level.title}</h1></div><span className="lesson-stamp">{level.mode === 'free' ? '∞' : String(level.number).padStart(2, '0')}</span></div>
        <p className="level-story">{level.story}</p>
        <div className="map-board">
          <div className="map-toolbar"><span className="collection-count"><Icon name="star" size={20} /><strong data-testid="stars-count">{runtime.collected.length}<span> / {level.stars.length}</span></strong><span>颗星星</span></span><label className="trail-toggle"><input type="checkbox" checked={save.settings.trail} onChange={e => changeSettings({ trail: e.target.checked })} />显示轨迹</label></div>
          <RobotMap level={level} runtime={runtime} settings={save.settings} resetKey={resetKey} />
          <div className="map-legend"><span><i className="legend-start" />起点</span><span><Icon name="star" size={16} />收集星星</span>{level.goal && <span><Icon name="flag" size={16} />终点</span>}<span><i className="legend-rock" />障碍物</span></div>
        </div>
        <div className="mobile-player">
          <div className="player-controls"><button className="run-button" disabled={locked} onClick={run} data-testid="mobile-run"><Icon name="play" />运行</button><button disabled={!locked || snapshot.status === 'pausing'} onClick={() => snapshot.status === 'paused' ? player.resume() : player.pause()} data-testid="mobile-pause"><Icon name={snapshot.status === 'paused' ? 'play' : 'pause'} />{snapshot.status === 'paused' ? '继续' : '暂停'}</button><button disabled={performing} onClick={() => { importVersion.current++; player.step(program); }} data-testid="mobile-step"><Icon name="step" />单步</button><button onClick={reset} data-testid="mobile-reset"><Icon name="reset" />重置</button></div>
          <div className="mobile-runtime" role="status"><span>{statusNames[snapshot.status]} · 已执行 {runtime.actions} 个动作</span><p>{runtime.status === 'ready' ? '先去编程板摆一摆，再让布布出发。' : runtime.message}</p>{runtime.active?.step && <p>第 {runtime.active.step.current}/{runtime.active.step.total} 步</p>}{runtime.active?.loops.length ? <p>{runtime.active.loops.map(l => `第 ${l.current}/${l.total} 轮`).join(' · ')}</p> : null}<ExecutionBreadcrumb program={program} active={runtime.active} />{runtime.outcome === 'success' && <p>学会了「{level.objective}」，用了 {countBlocks(program)} 块积木！</p>}</div>
          {runtime.outcome === 'success' && nextLevel && <button className="next-level" onClick={() => chooseLevel(nextLevel.id)}>下一关 <Icon name="arrow" size={20} /></button>}
        </div>
        <div className="mission"><span className="mission-icon"><Icon name={level.mode === 'free' ? 'blocks' : 'flag'} /></span><div><strong>这次的小任务</strong><p>{level.mode === 'free' ? '大胆试试你的想法，正常执行结束就完成练习。' : '程序结束时停在旗子上，并收集所有星星。'}</p></div></div>
        <div className="hints-area"><button className="hint-button" onClick={() => setHintCount(n => Math.min(n + 1, level.hints.length))} disabled={hintCount >= level.hints.length}><Icon name="bulb" size={20} />{hintCount ? '再给我一点提示' : '给我一点提示'}<small>{hintCount}/{level.hints.length}</small></button><span className="learning-tag">本关学习：{level.objective}</span></div>
        {hintCount > 0 && <div className="hint-content">{level.hints.slice(0, hintCount).map((hint, i) => <p key={hint}><b>{i + 1}</b>{hint}</p>)}{hintCount === level.hints.length && <button className="text-button" disabled={locked} onClick={() => { if (countBlocks(program) === 0 || window.confirm('使用参考解会替换当前程序。要试试这份参考解吗？')) { changeProgram(structuredClone(level.solution)); setMobilePanel('editor'); } }}>把参考解放到编程板 <Icon name="arrow" size={16} /></button>}</div>}
      </section>
      <section className={`program-panel ${mobilePanel === 'editor' ? 'mobile-visible' : ''}`} aria-label="编程工作台">
        <div className="program-panel-heading"><div><p className="eyebrow">想一想，摆一摆</p><h2>我的编程板 <span className="pencil-line" /></h2></div><span className={`save-status ${storageError ? 'save-error' : ''}`}><span className="tiny-dot" />{storageError ? '保存遇到问题' : user ? sync.status : '已保存在此浏览器'}</span></div>
        <ProgramEditor key={level.id} level={level} program={program} onChange={changeProgram} locked={locked} active={runtime.active} errorBlockId={runtime.status === 'error' ? runtime.active?.blockId : undefined} onNotice={setNotice} />
        <div className="player-console">
          <div className="player-topline"><span className={`runtime-indicator ${snapshot.status}`}><span className="tiny-dot" />{statusNames[snapshot.status]}</span><label className="speed-control">速度<select aria-label="播放速度" value={save.settings.speed} onChange={e => changeSettings({ speed: Number(e.target.value) as Settings['speed'] })}><option value="0.5">0.5 ×</option><option value="1">1 ×</option><option value="2">2 ×</option></select></label></div>
          <div className="player-controls"><button className="run-button" disabled={locked} onClick={run} data-testid="run"><Icon name="play" />运行</button><button onClick={() => snapshot.status === 'paused' ? player.resume() : player.pause()} disabled={!locked || snapshot.status === 'pausing'} data-testid="pause"><Icon name={snapshot.status === 'paused' ? 'play' : 'pause'} />{snapshot.status === 'paused' ? '继续' : snapshot.status === 'pausing' ? '正在暂停' : '暂停'}</button><button disabled={performing} onClick={() => { importVersion.current++; player.step(program); }} data-testid="step"><Icon name="step" />单步</button><button onClick={reset} data-testid="reset"><Icon name="reset" />重置</button></div>
          <div className="execution-details"><span>已执行 <strong data-testid="action-count">{runtime.actions}</strong> 个动作</span><span>{runtime.active?.step ? `第 ${runtime.active.step.current}/${runtime.active.step.total} 步` : '一次单步 = 一个动作'}{runtime.active?.loops.map(l => <b className="loop-progress" key={l.blockId}>第 {l.current}/{l.total} 轮</b>)}</span></div>
          <ExecutionBreadcrumb program={program} active={runtime.active} />
          <div className={`execution-message ${runtime.outcome === 'success' ? 'message-success' : runtime.status === 'error' ? 'message-error' : ''}`} aria-live="polite" aria-atomic="true" data-testid="execution-message"><Icon name={runtime.outcome === 'success' ? 'check' : runtime.status === 'error' ? 'bulb' : 'arrow'} size={21} /><div><strong>{runtime.status === 'ready' ? '准备好了，就让机器人出发吧！' : runtime.message}</strong>{runtime.outcome === 'success' && <p>你学会了「{level.objective}」！这次用了 {countBlocks(program)} 块积木，完成 {runtime.actions} 个动作。</p>}{locked && <p>想修改积木？先点「重置」，你的程序会保留。</p>}</div></div>
          {runtime.outcome === 'success' && nextLevel && <button className="next-level" onClick={() => chooseLevel(nextLevel.id)}>准备好下一关啦 <Icon name="arrow" size={20} /></button>}
        </div>
        <div className="file-tools"><p><Icon name="check" size={16} />每个想法都值得试一试</p><div><button onClick={exportFile}><Icon name="download" size={18} />导出</button><button disabled={locked} onClick={() => inputRef.current?.click()}><Icon name="upload" size={18} />导入</button><input ref={inputRef} type="file" accept="application/json,.json" aria-label="导入程序文件" className="sr-only" tabIndex={-1} onChange={e => { const file = e.target.files?.[0]; e.target.value = ''; void readFile(file); }} /></div></div>
      </section>
    </main>
    <footer className="app-footer"><span>Brclio Robot <i>·</i> 小小积木，大大想法。</span><button onClick={() => setDialog('help')}>本地保存与使用说明 <Icon name="arrow" size={14} /></button></footer>
    {dialog === 'levels' && <LevelPicker levels={levels} current={level.id} completed={save.completed} onSelect={chooseLevel} onClose={() => setDialog(null)} />}
    {dialog === 'auth' && <AuthDialog user={user ?? null} capabilities={capabilities} onClose={() => setDialog(null)} onAuthenticated={authenticated} onLogout={logout} syncStatus={sync.status} onRetrySync={sync.retry} />}
    {dialog === 'help' && <HelpDialog settings={save.settings} onSettings={changeSettings} onClose={() => setDialog(null)} />}
  </div>;
}
