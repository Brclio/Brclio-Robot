import { Modal } from '../../components/Modal';
import { Icon } from '../../components/Icon';
import type { Level, CompletionRecord } from '../../types';
export function LevelPicker({ levels, current, completed, onSelect, onClose }: { levels: Level[]; current: string; completed: Record<string, CompletionRecord>; onSelect: (id: string) => void; onClose: () => void }) {
  const chapters = [...new Set(levels.filter(l => l.mode === 'challenge').map(l => l.chapter))];
  return <Modal title="选择一次新冒险" wide onClose={onClose}>
    <p className="dialog-intro">一步一步学，也可以自由选择。每关都会保留你的积木。</p>
    <div className="course-groups">{chapters.map((chapter, index) => <section className="course-group" key={chapter}>
      <h3><span>{String(index + 1).padStart(2, '0')}</span>{chapter}</h3>
      <div className="level-grid">{levels.filter(l => l.chapter === chapter && l.mode === 'challenge').map(level => <button key={level.id} className={`level-option ${level.id === current ? 'chosen' : ''}`} onClick={() => onSelect(level.id)} aria-current={level.id === current ? 'step' : undefined} data-testid={`level-${level.id}`}>
        <span className={`level-number ${completed[level.id] ? 'is-complete' : ''}`}>{completed[level.id] ? <Icon name="check" /> : String(level.number).padStart(2, '0')}</span>
        <span><strong>{level.title}</strong><small>{completed[level.id] ? '已完成 · 再试一种方法' : level.objective}</small></span>
      </button>)}</div>
    </section>)}</div>
    {levels.filter(l => l.mode === 'free').map(level => <button key={level.id} className="free-level" onClick={() => onSelect(level.id)} data-testid={`level-${level.id}`}><Icon name="blocks" size={28} /><span><strong>自由练习场</strong><small>所有积木都在这里，试试自己的想法。</small></span><Icon name="arrow" /></button>)}
  </Modal>;
}
