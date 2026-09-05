import type { Instruction, InstructionType, Level, Program } from '../types';

const movement: InstructionType[] = ['forward', 'backward', 'left', 'right'];
const withLoops: InstructionType[] = [...movement, 'repeat'];
const allInstructions: InstructionType[] = [...withLoops, 'call'];

// Reference programs use the exact same nodes and interpreter as the child's program.
// IDs are deterministic here; new editor nodes get fresh IDs independently.
function program(prefix: string, build: (b: ReturnType<typeof blocks>) => Omit<Program, 'functions'> & { functions?: Partial<Program['functions']> }): Program {
  const result = build(blocks(prefix));
  return { main: result.main, functions: { A: result.functions?.A ?? [], B: result.functions?.B ?? [] } };
}

function blocks(prefix: string) {
  let sequence = 0;
  const id = () => `${prefix}-reference-${++sequence}`;
  return {
    forward: (steps = 1): Instruction => ({ id: id(), type: 'forward', steps }),
    backward: (steps = 1): Instruction => ({ id: id(), type: 'backward', steps }),
    left: (): Instruction => ({ id: id(), type: 'left' }),
    right: (): Instruction => ({ id: id(), type: 'right' }),
    repeat: (times: number, body: Instruction[]): Instruction => ({ id: id(), type: 'repeat', times, body }),
    call: (fn: 'A' | 'B'): Instruction => ({ id: id(), type: 'call', fn }),
  };
}

const stars = (prefix: string, points: [number, number][]) => points.map(([x, y], index) => ({ id: `${prefix}-star-${index + 1}`, x, y }));
const obstacles = (points: [number, number][]) => points.map(([x, y]) => ({ x, y }));

export const levels: Level[] = [
  {
    id: '001', number: 1, title: '第一颗星星', chapter: '01 · 出发吧', mode: 'challenge',
    story: '小机器人布布醒来了！把路上的星星带到小旗子旁。',
    objective: '认识前进指令，按顺序执行程序。',
    width: 5, height: 5, start: { x: 1, y: 3, direction: 'E' }, goal: { x: 3, y: 3 },
    obstacles: obstacles([[1, 1], [3, 1]]), stars: stars('001', [[2, 3]]), allowed: ['forward'],
    hints: ['看看布布脸上的箭头，它正朝右。', '从起点到旗子，中间要走两格。', '摆两个「前进1格」，或者把一个前进积木改成2格。'],
    solution: program('001', b => ({ main: [b.forward(), b.forward()] })),
  },
  {
    id: '002', number: 2, title: '向北送星光', chapter: '01 · 出发吧', mode: 'challenge',
    story: '星光邮局在小路的尽头。布布这次面朝上方，沿路收集两颗星星。',
    objective: '调整数字参数，让一个前进积木走多格。',
    width: 6, height: 5, start: { x: 1, y: 4, direction: 'N' }, goal: { x: 1, y: 0 },
    obstacles: obstacles([[3, 1], [3, 2], [3, 3]]), stars: stars('002', [[1, 2], [1, 0]]), allowed: ['forward'], maxBlocks: 2,
    hints: ['向前是布布面对的方向，这一关是向上。', '先数一数起点与旗子相隔几格，起点不算一步。', '把「前进」的小数字改为4，就可以沿路收集全部星星。'],
    solution: program('002', b => ({ main: [b.forward(4)] })),
  },
  {
    id: '003', number: 3, title: '三站星光列车', chapter: '01 · 出发吧', mode: 'challenge',
    story: '三颗星星排成一列，每两格是一站。给布布安排好从左到右的行程。',
    objective: '理解积木的执行顺序与总步数。',
    width: 7, height: 5, start: { x: 0, y: 2, direction: 'E' }, goal: { x: 6, y: 2 },
    obstacles: obstacles([[2, 0], [4, 0], [2, 4], [4, 4]]), stars: stars('003', [[2, 2], [4, 2], [6, 2]]), allowed: ['forward'], maxBlocks: 3,
    hints: ['布布会按照积木上显示的编号依次行动。', '从起点到旗子共六格，程序最后要恰好停下。', '可以摆三个「前进2格」。运行时观察每个积木里的第几步。'],
    solution: program('003', b => ({ main: [b.forward(2), b.forward(2), b.forward(2)] })),
  },
  {
    id: '004', number: 4, title: '花园右转弯', chapter: '02 · 认认方向', mode: 'challenge',
    story: '花园里的石头挡住了近路。先往前走，再转个弯去找星星。',
    objective: '理解右转只改变朝向，转弯后再前进。',
    width: 6, height: 6, start: { x: 1, y: 4, direction: 'N' }, goal: { x: 4, y: 2 },
    obstacles: obstacles([[2, 4], [2, 3], [3, 4], [4, 4]]), stars: stars('004', [[1, 2], [3, 2]]), allowed: ['forward', 'right'],
    hints: ['先去正前方那颗星星，石头不能穿过去。', '到了第一颗星星后，旗子在布布右手边。', '试试「前进2格 → 右转 → 前进3格」。'],
    solution: program('004', b => ({ main: [b.forward(2), b.right(), b.forward(3)] })),
  },
  {
    id: '005', number: 5, title: '左手边的灯塔', chapter: '02 · 认认方向', mode: 'challenge',
    story: '布布想把星光送到左边的灯塔。记住，左边要从布布自己的方向来看。',
    objective: '分辨左右转，观察每次转向后的正前方。',
    width: 6, height: 6, start: { x: 4, y: 4, direction: 'N' }, goal: { x: 1, y: 1 },
    obstacles: obstacles([[3, 3], [3, 2], [2, 2]]), stars: stars('005', [[4, 2], [2, 1]]), allowed: ['forward', 'left', 'right'],
    hints: ['沿右侧的小路走到最上面的转弯处。', '面朝上时，左转会让布布面朝屏幕左边。', '「前进3格 → 左转 → 前进3格」可以绕开石头。'],
    solution: program('005', b => ({ main: [b.forward(3), b.left(), b.forward(3)] })),
  },
  {
    id: '006', number: 6, title: '退一步有新路', chapter: '02 · 认认方向', mode: 'challenge',
    story: '前面是一块大石头！退到岔路口，再从上面绕过去拜访朋友。',
    objective: '学会后退不转身，并组合转向绕开障碍物。',
    width: 7, height: 6, start: { x: 2, y: 4, direction: 'E' }, goal: { x: 5, y: 4 },
    obstacles: obstacles([[3, 4], [3, 3], [3, 2]]), stars: stars('006', [[1, 2], [3, 1], [5, 3]]), allowed: movement,
    hints: ['先后退一格。后退之后，布布仍然朝右。', '往上方绕路，经过三颗星星再走向旗子。', '后退1、左转、前进3、右转、前进4、右转、前进3。'],
    solution: program('006', b => ({ main: [b.backward(), b.left(), b.forward(3), b.right(), b.forward(4), b.right(), b.forward(3)] })),
  },
  {
    id: '007', number: 7, title: '重复的小节拍', chapter: '03 · 发现重复', mode: 'challenge',
    story: '星星每隔两格向布布招手。把一样的小动作放进重复盒子里。',
    objective: '把重复的指令放入循环体，理解重复次数。',
    width: 7, height: 5, start: { x: 0, y: 2, direction: 'E' }, goal: { x: 6, y: 2 },
    obstacles: obstacles([[1, 0], [3, 0], [5, 0], [1, 4], [3, 4], [5, 4]]), stars: stars('007', [[2, 2], [4, 2], [6, 2]]), allowed: withLoops, maxBlocks: 2,
    hints: ['相同的小动作是「向前走两格」。', '重复盒子本身不走路，要把前进积木放在它里面。', '用「重复3次［前进2格］」，两个积木就能装下整段路线。'],
    solution: program('007', b => ({ main: [b.repeat(3, [b.forward(2)])] })),
  },
  {
    id: '008', number: 8, title: '星星阶梯', chapter: '03 · 发现重复', mode: 'challenge',
    story: '两级大台阶通往山顶。找出每一级台阶相同的走法。',
    objective: '在循环体中组合移动与转向，重复一段路线。',
    width: 7, height: 7, start: { x: 1, y: 5, direction: 'E' }, goal: { x: 5, y: 1 },
    obstacles: obstacles([[2, 4], [4, 2], [1, 2], [5, 5]]), stars: stars('008', [[3, 5], [3, 3], [5, 3], [5, 1]]), allowed: withLoops, maxBlocks: 5,
    hints: ['一级台阶包含一段向右的小路和一段向上的小路。', '每轮结束时，让布布重新面朝右，下一轮才能用相同路线。', '重复2次［前进2 → 左转 → 前进2 → 右转］。'],
    solution: program('008', b => ({ main: [b.repeat(2, [b.forward(2), b.left(), b.forward(2), b.right()])] })),
  },
  {
    id: '009', number: 9, title: '大盒子和小盒子', chapter: '03 · 发现重复', mode: 'challenge',
    story: '布布发现重复盒子里还能放小盒子！先练两小步，再完成一个大台阶。',
    objective: '认识两层循环，观察内层次数和外层轮次。',
    width: 8, height: 8, start: { x: 1, y: 6, direction: 'N' }, goal: { x: 5, y: 2 },
    obstacles: obstacles([[2, 5], [4, 3], [5, 5], [6, 3]]), stars: stars('009', [[1, 5], [3, 4], [3, 3], [5, 2]]), allowed: withLoops, maxBlocks: 6,
    hints: ['一个大台阶是向上两格，再向右两格。', '小盒子放「重复2次［前进1格］」；大盒子包住完整台阶。', '重复2次［重复2次［前进1］→ 右转 → 前进2 → 左转］。'],
    solution: program('009', b => ({ main: [b.repeat(2, [b.repeat(2, [b.forward()]), b.right(), b.forward(2), b.left()])] })),
  },
  {
    id: '010', number: 10, title: '给动作起个名字', chapter: '04 · 动作组合', mode: 'challenge',
    story: '绕星光池走一圈，每到一个角都做一样的动作。把它取名为动作组合A。',
    objective: '定义动作组合，再通过调用来执行它。',
    width: 6, height: 6, start: { x: 1, y: 1, direction: 'E' }, goal: { x: 1, y: 1 },
    obstacles: obstacles([[2, 2], [4, 4]]), stars: stars('010', [[3, 1], [3, 3], [1, 3]]), allowed: allInstructions, maxBlocks: 6,
    hints: ['定义区里的积木不会自己运行，需要在主程序中放「执行A」。', '动作组合A可以负责走完一条边，然后右转。', 'A里放「前进2 → 右转」，主程序连续放四个「执行A」。'],
    solution: program('010', b => ({ main: [b.call('A'), b.call('A'), b.call('A'), b.call('A')], functions: { A: [b.forward(2), b.right()] } })),
  },
  {
    id: '011', number: 11, title: '星光缝纫机', chapter: '04 · 动作组合', mode: 'challenge',
    story: '一右一下，布布沿着星星缝出一条小路。让动作组合和重复盒子一起工作。',
    objective: '在循环中调用动作组合，复用同一段指令。',
    width: 6, height: 6, start: { x: 1, y: 1, direction: 'E' }, goal: { x: 4, y: 4 },
    obstacles: obstacles([[3, 1], [1, 3], [4, 2], [2, 4]]), stars: stars('011', [[2, 1], [2, 2], [3, 2], [3, 3], [4, 3], [4, 4]]), allowed: allInstructions, maxBlocks: 6,
    hints: ['每个小折线都包含向右一格，再向下一格。', '把小折线放入A，注意最后要左转，重新面朝右。', 'A为［前进1 → 右转 → 前进1 → 左转］，主程序重复3次［执行A］。'],
    solution: program('011', b => ({ main: [b.repeat(3, [b.call('A')])], functions: { A: [b.forward(), b.right(), b.forward(), b.left()] } })),
  },
  {
    id: '012', number: 12, title: '布布的星际任务', chapter: '04 · 动作组合', mode: 'challenge',
    story: '最后一段星路需要两位小帮手：A走小台阶，B组织两次A。一起把星光送回家！',
    objective: '组合A和B，理解函数之间的调用关系与调用位置。',
    width: 8, height: 8, start: { x: 1, y: 6, direction: 'N' }, goal: { x: 5, y: 2 },
    obstacles: obstacles([[1, 4], [2, 3], [4, 5], [5, 4], [6, 3]]), stars: stars('012', [[2, 5], [3, 4], [4, 3], [5, 2]]), allowed: allInstructions, maxBlocks: 8,
    hints: ['布布每次向上一格、向右一格，最后重新朝上。', '让A负责一个小台阶，让B重复执行两次A，主程序再执行两次B。', 'A：前进1、右转、前进1、左转。B：重复2次［执行A］。主程序：执行B、执行B。'],
    solution: program('012', b => ({ main: [b.call('B'), b.call('B')], functions: { A: [b.forward(), b.right(), b.forward(), b.left()], B: [b.repeat(2, [b.call('A')])] } })),
  },
  {
    id: 'free', number: 0, title: '自由探索', chapter: '自由练习', mode: 'free',
    story: '这里没有标准路线。试着画一个正方形，或者编一段属于你的星光舞步。',
    objective: '自由尝试全部指令；正常执行结束就会显示程序执行完成。',
    width: 8, height: 8, start: { x: 2, y: 5, direction: 'N' },
    obstacles: obstacles([[5, 2], [5, 3], [5, 4]]), stars: stars('free', [[2, 2], [4, 5], [6, 6]]), allowed: allInstructions,
    hints: ['先选择一个朝向，再预测布布的下一格在哪里。', '可以用重复4次［前进2格 → 右转］画正方形。', '遇到问题时点重置，再用单步观察每一格；这里不要求收集所有星星。'],
    solution: program('free', b => ({ main: [b.repeat(4, [b.forward(2), b.right()])] })),
  },
];

export function getLevel(id: string): Level {
  return levels.find(level => level.id === id) ?? levels[0];
}
