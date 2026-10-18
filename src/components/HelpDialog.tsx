import { Modal } from './Modal';
import type { Settings } from '../types';
export function HelpDialog({ settings, onSettings, onClose }: { settings: Settings; onSettings: (patch: Partial<Settings>) => void; onClose: () => void }) {
  return <Modal title="让小机器人听懂你的想法" onClose={onClose}>
    <div className="help-steps"><p><b>1</b><span><strong>看看地图</strong>找到起点、星星和旗子。小机器人头顶的蓝箭头，就是它的前方。</span></p><p><b>2</b><span><strong>摆一摆积木</strong>点击或拖入指令。按从左到右、从上到下的编号执行；前进的数字代表格数。</span></p><p><b>3</b><span><strong>运行，再试一次</strong>程序结束时停在旗子上，并收集所有星星。遇到问题，重置后改一改。</span></p></div>
    <details className="help-detail"><summary>积木怎么编辑？</summary><p>点击积木选中，再用「前移」「后移」「复制」「删除」或位置菜单操作。选中后按 Alt + ← / → 移动，Delete 删除。先选中插入位置，再点积木库，就能把积木放进循环或动作组合。</p><p>触屏请从积木的拖动手柄开始拖动，其他区域可以正常滚动。循环最多嵌套两层；动作组合只会在被调用时执行。</p></details>
    <details className="help-detail"><summary>运行、暂停、单步有什么不同？</summary><p>「运行」每次都从起点开始。「暂停」完成当前一步后停下，「继续」沿着原进度走。「单步」一次只前进/后退一格，或转向90度。「重置」立即回到起点，保留程序。运行和暂停时需要先重置才能修改积木。</p></details>
    <details className="help-detail"><summary>老师小贴士与坐标规则</summary><p>地图左上角是 (0, 0)，x 向右增加、y 向下增加。朝向只有北、东、南、西四种。后退不会转身，转向不会移动。每关有分级提示和可供试验的参考解。自由练习没有强制通关目标。</p></details>
    <section className="settings-section"><h3>让操作更适合你</h3>
      <label className="toggle-row"><span><strong>减少动画</strong><small>立即显示新位置，执行速度保持不变</small></span><input type="checkbox" checked={settings.reducedMotion} onChange={e => onSettings({ reducedMotion: e.target.checked })} /></label>
      <label className="toggle-row"><span><strong>声音反馈</strong><small>移动、收集星星与完成时的轻提示</small></span><input type="checkbox" checked={settings.sound} onChange={e => onSettings({ sound: e.target.checked })} /></label>
    </section>
    <div className="data-note"><strong>你的想法，保存在这台浏览器里。</strong><p>草稿、进度和设置保存在当前浏览器，不会自动跨设备同步。清除浏览器数据可能丢失进度，请用「导出」备份每关程序。本应用不要求姓名或手机号，不添加追踪脚本。</p></div>
    <p className="design-credit">原创机器人与课程：Brclio Robot<br />界面基于 <a href="https://github.com/Brclio/brclio-design-system" target="_blank" rel="noreferrer">Brclio · brclio-design-system</a> 改编，设计改编遵循 CC BY-NC-SA 4.0。</p>
  </Modal>;
}
