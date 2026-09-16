/**
 * 近义词 / 同义表达词库（AI 指令领域定向）
 *
 * 用途：搜索时把用户输入的一个词扩展成一组等价说法，
 *       搜「摘要」也能命中只写了「总结」「提炼」的指令。
 *
 * 维护约定
 *  - 每组内的词视为互相等价，组内任意词命中即视为命中整组
 *  - 在组内可以混入英文，实现「中英互搜」
 *  - 分组要克制：把语义差别大的词放一组会显著拉低精度
 */

/** @type {string[][]} */
export const SYNONYM_GROUPS = [
  // ---------- 写作类 ----------
  ['写作', '撰写', '写', '创作', '起草', '拟', '原创', '行文'],
  ['文章', '文案', '文稿', '文本', '内容', '文字'],
  ['润色', '优化', '改写', '修饰', '打磨', 'polish', 'revise', 'refine'],
  ['扩写', '丰富', '展开', '扩充', '加长'],
  ['缩写', '精简', '简化', '缩短', 'concise'],
  ['风格', '语气', '口吻', '语调', 'tone', 'style'],
  ['标题', '题目', 'name', 'title', 'headline'],
  ['标题党', '吸睛', '爆款', '抓眼球', 'hook'],
  ['大纲', '框架', '提纲', '结构', 'outline'],
  ['素材', '资料', '材料', 'materials', 'raw'],
  ['段落', '章节', 'part', 'section'],
  ['小说', '故事', '剧情', '桥段', 'narrative', 'story'],
  ['剧本', '分镜', '脚本', 'screenplay', 'script'],
  ['诗歌', '诗词', '打油诗', 'poem', 'verse'],
  ['邮件', 'email', '信件', '函件', 'mail'],
  ['简历', '履历', 'CV', 'resume'],
  ['致辞', '演讲', '讲话', '发言', 'speech'],
  ['论文', '学术', '文献', 'paper', 'thesis', 'academic'],
  ['文献综述', '综述', 'review', 'research gap'],
  ['朋友圈', '社交文案', '动态', '微博', 'social post'],

  // ---------- 总结归纳 ----------
  ['总结', '摘要', '概括', '提炼', '归纳', '小结', 'summarize', 'summary', 'abstract'],
  ['要点', '关键点', '重点', '核心', 'key points', 'takeaway'],
  ['分析', '剖析', '解读', '拆解', 'analyze', 'analysis'],
  ['对比', '比较', '区别', '差异', '优劣', 'compare', 'vs', 'difference'],
  ['结论', '论断', '结果', 'conclusion'],
  ['改写为', '转述', '复述', 'paraphrase'],
  ['笔记', '纪要', '记录', 'notes', 'minutes'],

  // ---------- 编程类 ----------
  ['代码', '程序', '脚本', 'coding', 'code', 'program', 'programming'],
  ['编程', '开发', '写代码', 'implement', 'develop', '编写程序'],
  ['调试', 'debug', '排错', '修复', 'bug', 'fix', '排查'],
  ['重构', '优化代码', '整理代码', 'refactor', 'clean code'],
  ['报错', '异常', '错误', 'error', 'exception', 'traceback'],
  ['函数', '方法', '接口', 'function', 'method', 'api'],
  ['算法', '逻辑', 'algorithm', 'logic'],
  ['正则', 'regex', '正则表达式', 'regexp'],
  ['前端', '页面', 'UI', '界面', 'frontend', 'web'],
  ['后端', '服务端', 'backend', 'server'],
  ['数据库', 'SQL', '查询语句', 'database', 'query'],
  ['测试', '单测', 'test', 'unit test', '用例'],
  ['注释', '文档字符串', 'comment', 'docstring', '代码说明'],
  ['爬虫', '抓取', '采集', 'scrape', 'crawler'],
  ['部署', '上线', '发布', 'deploy', 'release'],
  ['Shell', '命令行', '终端', 'bash', 'command line', 'powershell'],
  ['Git', '版本控制', '提交', 'commit', 'branch', '分支'],

  // ---------- 翻译 / 语言 ----------
  ['翻译', '译', '转译', 'translate', 'translation'],
  ['英文', '英语', 'english', 'en'],
  ['中文', '汉语', 'chinese', 'zh'],
  ['日文', '日语', 'japanese', 'jp'],
  ['韩文', '韩语', 'korean', 'kr'],
  ['本地化', 'localization', 'i18n', '国际化'],
  ['语法', '拼写', '错别字', 'grammar', 'spelling'],
  ['术语', '名词', '专有名词', 'terminology', 'glossary'],

  // ---------- 办公效率 ----------
  ['Excel', '表格', '工作表', '电子表格', 'spreadsheet', 'xlsx'],
  ['公式', '函数式', 'formula', '单元格计算'],
  ['PPT', '幻灯片', '演示文稿', 'slides', 'presentation', '演示'],
  ['Word', '文档', 'word', 'docx'],
  ['会议', '例会', 'meeting', '研讨'],
  ['日程', '安排', '排期', 'schedule', '计划表'],
  ['待办', '任务', 'to-do', 'task', '清单'],
  ['周报', '日报', '月报', '汇报', 'report', 'reporting'],
  ['审批', '流程', 'workflow', '工单'],
  ['模板', '范式', 'template', '样板'],
  ['自动化', '批量处理', 'automation', '脚本化'],
  ['快捷键', '效率', 'efficiency', 'productivity'],

  // ---------- 数据 ----------
  ['数据', '数据表', 'dataset', 'data'],
  ['可视化', '图表', '图', 'chart', 'graph', 'plot', '可视化图表'],
  ['统计', '指标', '度量', 'metrics', 'KPI', 'statistics'],
  ['趋势', '走势', 'trend', '变化'],
  ['预测', '预估', '推算', 'forecast', 'predict'],
  ['清洗', '整理数据', '数据预处理', 'clean data', 'preprocess'],
  ['洞察', '看点', '发现', 'insight', 'finding'],

  // ---------- 营销 ----------
  ['营销', '推广', '获客', 'marketing', 'promotion'],
  ['广告', '投放', 'ad', 'ads', 'advertising'],
  ['种草', '推荐', '安利', 'recommend'],
  ['小红书', '笔记文案', 'rednote', 'xhs'],
  ['抖音', '短视频', 'Tiktok', 'douyin', 'short video'],
  ['公众号', '图文', 'wechat article'],
  ['SEO', '关键词', '搜索优化', 'ranking'],
  ['用户', '客户', '人群', 'user', 'customer', 'audience'],
  ['转化', '成交', '下单', 'conversion', 'conversion rate'],
  ['品牌', '定位', 'slogan', 'branding'],
  ['slogan', '口号', '标语', 'tagline'],
  ['竞品', '对手', '同行', 'competitor'],
  ['卖点', '优势', '亮点', 'selling point', 'USP'],

  // ---------- 学习 ----------
  ['学习', '讲解', '教学', 'study', 'learn', 'teach'],
  ['解释', '说明', '科普', 'explain', 'explanation'],
  ['入门', '基础', '初学', 'beginner', 'basic', '入门教程'],
  ['进阶', '高级', '深入', 'advanced', '进阶教程'],
  ['出题', '测验', '考试', 'quiz', 'exam', '题目'],
  ['背诵', '记忆', 'memorize', '巩固'],
  ['概念', '定义', '含义', 'definition', 'concept'],
  ['举例', '案例', 'example', 'case study'],

  // ---------- 图像 / 设计 ----------
  ['图片', '配图', '图像', 'image', 'picture', 'photo'],
  ['画图', '绘图', '生成图', '插画', 'illustration', 'drawing'],
  ['海报', 'banner', '宣传图', 'poster'],
  ['Logo', '标志', '图标', 'icon', 'logo design'],
  ['配色', '色彩', '调色', 'color', 'palette'],
  ['排版', '版式', 'layout', 'typography'],
  ['绘画提示词', '文生图提示词', 'image prompt', 'SD prompt', 'Midjourney'],
  ['修图', '抠图', '美颜', 'retouch', 'background removal'],
  ['3D', '三维', '建模', 'modeling'],

  // ---------- 音视频 ----------
  ['视频', '短片', 'video', 'clip'],
  ['音频', '语音', '声音', 'audio', 'voice'],
  ['配音', '旁白', 'voiceover', 'narration'],
  ['字幕', 'transcript', 'subtitle', '听写'],
  ['剪辑', '分镜脚本', 'editing', 'cutting'],
  ['音乐', '歌曲', '歌词', 'music', 'lyrics'],
  ['转文字', '语音转写', 'ASR', 'speech to text'],

  // ---------- 商业 / 生活 ----------
  ['商业', '创业', 'business', 'startup'],
  ['方案', '计划', '策划', 'proposal', 'plan'],
  ['合同', '协议', '条款', 'contract', 'agreement'],
  ['法律', '法规', '合规', 'legal', 'compliance'],
  ['财务', '会计', '账目', 'finance', 'accounting'],
  ['谈判', '沟通', '话术', 'negotiation'],
  ['面试', '招聘', '求职', 'interview', 'recruit', 'hiring'],
  ['头脑风暴', '创意', '点子', 'brainstorm', 'idea'],
  ['旅行', '旅游', '行程', 'travel', 'itinerary'],
  ['健身', '运动', '锻炼', 'fitness', 'workout'],
  ['菜谱', '食谱', '做饭', 'recipe', 'cooking'],
  ['健康', '养生', 'health', 'wellness'],
  ['心理咨询', '情绪', '焦虑', 'mental health'],
  ['装修', '家居', 'home decoration'],
  ['亲子', '育儿', '孩子', 'parenting', 'kids'],
  ['宠物', '猫', '狗', 'pet'],

  // ---------- 角色 / 交互 ----------
  ['扮演', '角色扮演', 'act as', 'role play', 'assume the role'],
  ['你是', '作为一名', '身份', 'you are', 'act as a'],
  ['专家', '专业人士', '顾问', 'expert', 'specialist'],
  ['语气温和', '礼貌', '友善', 'friendly', 'polite'],
  ['简洁', '简短', '精炼', 'concise', 'brief', 'short'],
  ['详细', '详尽', '具体', 'detailed', 'in detail'],
  ['分点', '列表', '条列', 'bullet', 'list', '分条'],
  ['步骤', '流程', 'step by step', '步骤化'],
  ['案例说明', '举例说明', 'with examples'],
  ['逐步思考', '思维链', 'step by step thinking', 'chain of thought', 'CoT'],
  ['不要', '禁止', '避免', '禁止使用', 'do not', 'avoid', 'without'],
  ['输出格式', '返回格式', 'JSON 格式', 'output format', '格式化输出'],
];

/** 反向索引：word -> groupIndex */
const INDEX = new Map();
SYNONYM_GROUPS.forEach((group, gi) => {
  for (const w of group) {
    const key = w.toLowerCase();
    if (!INDEX.has(key)) INDEX.set(key, []);
    if (!INDEX.get(key).includes(gi)) INDEX.get(key).push(gi);
  }
});

/**
 * 把一个查询词扩展成同义组。
 * @param {string} term
 * @returns {string[]} 包含原词在内的同义词列表（原词排第一）
 */
export function expand(term) {
  const key = String(term || '').toLowerCase();
  if (!key) return [];
  const groups = INDEX.get(key);
  if (!groups) return [term];
  const out = [term];
  for (const gi of groups) {
    for (const w of SYNONYM_GROUPS[gi]) {
      if (w.toLowerCase() !== key && !out.includes(w)) out.push(w);
    }
  }
  return out;
}

/**
 * 对整条查询做同义扩展。
 * @param {string[]} terms
 * @returns {{term:string, variants:string[], isSynonym:boolean}[]}
 */
export function expandAll(terms) {
  return terms.map((t) => {
    const variants = expand(t);
    return { term: t, variants, isSynonym: variants.length > 1 };
  });
}

/** 该词是否属于某个同义组 */
export function hasSynonym(term) {
  return INDEX.has(String(term || '').toLowerCase());
}

export const SYNONYM_COUNT = SYNONYM_GROUPS.length;
