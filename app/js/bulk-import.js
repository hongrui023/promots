/**
 * 批量导入界面：粘贴长文本 → 自动拆条 → 逐条确认 → 入库
 *
 * 交互设计上的几个取舍：
 *   1. 一屏看完。不搞分页向导，输入和分析结果在同一层里切换，随时能退回去改文本。
 *   2. 默认只勾选「判定为指令」的条目。说明、表格、碎片照样列出来但不勾，
 *      并且标明理由（scoreWhy），用户能一眼看出为什么某条没被选中。
 *   3. 每行可展开直接改标题/正文/备注/分类/标签，不必跳回主编辑器。
 *   4. AI 拆分是可选按钮，不是默认路径。规则能切干净就不该把文本发到外部服务。
 */

import { store } from './store.js';
import { CATEGORIES, CATEGORY_MAP, categoryMeta } from './classify.js';
import * as llm from './llm.js';
import {
  analyze, analyzeWithAI, diagnose, markInternalDuplicates, markDuplicates,
  toPromptPayload, kindLabel, fingerprint, extractVariables,
} from './importer.js';
import { el, clear, toast, modal, confirmDialog } from './ui.js';

/* ---------------------------------------------------------------- 小工具 */

function badge(text, cls = '') {
  return el('span.bi-badge' + (cls ? '.' + cls : ''), { text });
}

function statChip(label, value, cls = '') {
  return el('div.bi-stat' + (cls ? '.' + cls : ''), {}, [
    el('span.bi-stat-v', { text: String(value) }),
    el('span.bi-stat-l', { text: label }),
  ]);
}

function catSelect(current, onchange) {
  const sel = el('select.select.select-sm');
  for (const c of CATEGORIES) {
    sel.appendChild(el('option', { value: c.key, text: `${c.icon} ${c.name}`, selected: current === c.key }));
  }
  sel.addEventListener('change', () => onchange(sel.value));
  return sel;
}

/* ---------------------------------------------------------------- 主入口 */

export function openBulkImport({ onDone } = {}) {
  const state = {
    step: 'input',   // input | preview | working
    text: '',
    result: null,
    templateTag: '', // 统一附加的标签
    aiUsed: false,
  };

  const body = el('div.bi-body');
  const footer = el('div.bi-foot');

  const m = modal({
    title: '批量导入指令',
    width: '900px',
    body,
    footer: [],
    onClose: () => {},
  });

  // modal() 的 footer 是固定参数，这里手动把自定义底栏挂进 box
  m.box.appendChild(footer);

  const render = () => {
    clear(body);
    clear(footer);
    if (state.step === 'input') renderInput();
    else if (state.step === 'preview') renderPreview();
    else renderWorking();
  };

  /* ============================================================ 第一步：输入 */

  function renderInput() {
    const ta = el('textarea.bi-textarea', {
      placeholder:
        '在这里粘贴一大段文本。\n\n' +
        '工具会自动识别标题、编号、分隔线，把它拆成一条条可以入库的指令。\n' +
        '支持：Markdown 标题、【3.1】这类编号、【■ 章节】、------ 分隔线、\n' +
        '「技能：xxx」元数据行、@long-text: 之类的粘贴标记。',
      value: state.text,
    });

    const counter = el('div.bi-counter');
    const updateCount = () => {
      const v = ta.value;
      state.text = v;
      const lines = v ? v.split('\n').length : 0;
      const blocks = v ? v.split(/\n\s*\n/).filter((s) => s.trim()).length : 0;
      counter.textContent = `${v.length.toLocaleString()} 字符 · ${lines} 行 · 约 ${blocks} 段`;
      analyzeBtn.disabled = !v.trim();
    };
    ta.addEventListener('input', updateCount);
    setTimeout(updateCount, 0);

    // ---- 文件读取
    const fileInput = el('input', { type: 'file', accept: '.txt,.md,.markdown,.json,.csv,text/*', class: 'hidden' });
    fileInput.addEventListener('change', async (e) => {
      const f = e.target.files?.[0];
      e.target.value = '';
      if (!f) return;
      if (f.size > 8 * 1024 * 1024) {
        toast('文件超过 8 MB，请先拆分', 'warn', 3600);
        return;
      }
      const t = await f.text();
      ta.value = t;
      updateCount();
      toast(`已读入 ${f.name}（${(f.size / 1024).toFixed(1)} KB）`, 'success');
    });

    const aiReady = llm.llmAvailable();
    const aiCheck = el('input', { type: 'checkbox', disabled: !aiReady, checked: false });

    // ---- 剪贴板检测
    // 实际用法几乎都是「刚从别处复制完就点进来」，直接帮着载入省一步。
    // 读不到（没授权、浏览器不支持、或输入框已经有内容）就静默跳过，不弹任何提示。
    const clipBox = el('div.bi-clip.hidden');
    (async () => {
      try {
        if (!navigator.clipboard?.readText) return;
        const t = await navigator.clipboard.readText();
        if (!t || t.trim().length < 200 || ta.value.trim()) return;
        clear(clipBox);
        clipBox.classList.remove('hidden');
        clipBox.appendChild(
          el('button.mini-btn.mini-btn-accent', {
            text: `载入剪贴板里的 ${t.length.toLocaleString()} 字符`,
            onclick: () => {
              ta.value = t;
              updateCount();
              clipBox.classList.add('hidden');
              toast('已载入，点「分析」开始拆分', 'success');
            },
          })
        );
      } catch (_) {
        /* 未授权或浏览器不支持：什么都不做 */
      }
    })();

    const analyzeBtn = el('button.btn.btn-primary', {
      text: '分析 →',
      onclick: () => runAnalyze(Boolean(aiCheck.checked)),
    });

    body.appendChild(
      el('div.bi-step', {}, [
        el('div.bi-input-head', {}, [
          el('div.bi-input-title', { text: '① 粘贴文本' }),
          el('div.bi-input-acts', {}, [
            el('button.mini-btn', {
              text: '读取文件',
              onclick: () => fileInput.click(),
            }),
            el('button.mini-btn', {
              text: '清空',
              onclick: () => { ta.value = ''; updateCount(); },
            }),
          ]),
        ]),
        ta,
        counter,
        clipBox,
        fileInput,
      ])
    );

    body.appendChild(
      el('div.bi-opts', {}, [
        el('label.check' + (aiReady ? '' : '.disabled'), {}, [
          aiCheck,
          el('span', { text: '用 AI 辅助拆分' }),
        ]),
        el('div.hint', {
          text: aiReady
            ? '默认走本地规则引擎，文本不出本机。勾选后会先切块、再把块发送到你在「设置 → AI 增强」里配置的模型服务，由它判断哪些块是真指令并起标题。正文始终取自原文，模型改不到。'
            : 'AI 辅助需要先在「设置 → AI 增强」里配置模型服务。不配置也能用——规则引擎能处理绝大多数结构化文本。',
        }),
      ])
    );

    footer.appendChild(
      el('div.bi-foot-inner', {}, [
        el('div.bi-foot-hint', { text: '文本只在本地解析，不会被上传' }),
        el('div.bi-foot-btns', {}, [
          el('button.btn', { text: '取消', onclick: () => m.close() }),
          analyzeBtn,
        ]),
      ])
    );
  }

  /* ============================================================ 分析 */

  async function runAnalyze(useAI) {
    const text = state.text.trim();
    if (!text) { toast('请先粘贴文本', 'warn'); return; }

    state.step = 'working';
    render();

    try {
      if (useAI) {
        state.result = await analyzeWithAI(text, {
          chat: llm.chat,
          onProgress: (p) => setWorkingText(`AI 正在分析第 ${Math.min(p.done + 1, p.total)} / ${p.total} 批…`),
        });
        state.aiUsed = true;
        // AI 输出可能与库中已有内容重复，补一次跨库比对
        markDuplicates(state.result.items, store.all());
      } else {
        state.result = analyze(text, { existing: store.all() });
        state.aiUsed = false;
      }
      markInternalDuplicates(state.result.items);
      state.result.stats.duplicated = state.result.items.filter((i) => i.dup).length;
      state.result.stats.selected = state.result.items.filter((i) => i.selected).length;

      if (!state.result.items.length) {
        state.step = 'input';
        render();
        toast('没能从这段文本里解析出内容，换个方式再试试', 'warn', 4200);
        return;
      }
      state.step = 'preview';
      render();
    } catch (e) {
      state.step = 'input';
      render();
      toast('分析失败：' + e.message, 'error', 6000);
    }
  }

  function renderWorking() {
    body.appendChild(
      el('div.bi-working', {}, [
        el('div.bi-spinner'),
        el('div.bi-working-text', { text: '正在分析…' }),
      ])
    );
    footer.appendChild(el('div.bi-foot-inner', {}, [el('div.bi-foot-hint', { text: ' ' })]));
  }
  function setWorkingText(t) {
    const n = body.querySelector('.bi-working-text');
    if (n) n.textContent = t;
  }

  /* ============================================================ 第二步：预览 */

  function renderPreview() {
    const { items, stats } = state.result;
    const diag = diagnose(state.result);

    /* ---- 顶部统计 */
    const selNow = () => items.filter((i) => i.selected && !i.dup).length;

    const selLabel = el('span');
    const refreshSel = () => {
      const n = selNow();
      selLabel.textContent = `已选 ${n} 条`;
      importBtn.disabled = n === 0;
      importBtn.textContent = n ? `导入选中的 ${n} 条` : '请先勾选';
    };

    const importBtn = el('button.btn.btn-primary', { text: '导入', onclick: () => doImport() });

    const badgeRefs = [];
    const refreshBadges = () => {
      for (const b of badgeRefs) b();
      refreshSel();
    };

    body.appendChild(
      el('div.bi-stats', {}, [
        statChip('条候选', stats.total),
        statChip('条指令', stats.prompt, 'ok'),
        statChip('条说明', stats.note + stats.table + stats.fragment, 'dim'),
        statChip('条重复', stats.duplicated, stats.duplicated ? 'warn' : 'dim'),
      ])
    );

    /* ---- 诊断 */
    body.appendChild(
      el('div.bi-diag' + (diag.level === 'ok' ? '.ok' : '.warn'), {}, [
        el('div.bi-diag-title', { text: diag.level === 'ok' ? '✓ 解析正常' : '⚠ 需要留意' }),
        el('ul.bi-diag-list', {}, diag.notes.map((n) => el('li', { text: n }))),
      ])
    );

    /* ---- 快捷操作 */
    const setAll = (pred) => {
      for (const it of items) it.selected = it.dup ? false : pred(it);
      refreshBadges();
      for (const row of list.querySelectorAll('.bi-row')) row._sync?.();
    };

    body.appendChild(
      el('div.bi-toolbar', {}, [
        el('div.bi-toolbar-left', {}, [
          el('button.mini-btn', { text: '只选指令', onclick: () => setAll((i) => i.kind === 'prompt') }),
          el('button.mini-btn', { text: '全选可用', onclick: () => setAll(() => true) }),
          el('button.mini-btn', { text: '全不选', onclick: () => setAll(() => false) }),
          el('button.mini-btn', { text: '返回修改原文', onclick: () => { state.step = 'input'; render(); } }),
        ]),
        el('div.bi-toolbar-right', {}, [selLabel]),
      ])
    );

    /* ---- 统一标签 */
    const tagInput = el('input.input.input-sm', {
      placeholder: '给这批导入统一加个标签（可选），例如：手册模板',
      value: state.templateTag,
    });
    tagInput.addEventListener('input', () => { state.templateTag = tagInput.value; });
    body.appendChild(el('div.bi-tagbar', {}, [tagInput]));

    /* ---- 列表 */
    const list = el('div.bi-list');
    for (const it of items) list.appendChild(renderRow(it, refreshBadges));
    body.appendChild(list);

    refreshSel();

    footer.appendChild(
      el('div.bi-foot-inner', {}, [
        el('div.bi-foot-hint', {
          text: state.aiUsed
            ? 'AI 判断了哪些块是指令并起了标题；正文取自原文，未被改写'
            : '由本地规则引擎拆分，正文未做任何改写',
        }),
        el('div.bi-foot-btns', {}, [
          el('button.btn', { text: '取消', onclick: () => m.close() }),
          importBtn,
        ]),
      ])
    );
  }

  /* ---- 单行渲染 */
  function renderRow(it, onChange) {
    const row = el('div.bi-row' + (it.kind === 'prompt' ? '.is-prompt' : ''));

    const cb = el('input', { type: 'checkbox', checked: it.selected, disabled: Boolean(it.dup) });
    cb.addEventListener('change', () => { it.selected = cb.checked; onChange(); });

    const titleText = el('span.bi-row-title', { text: it.title });

    const head = el('div.bi-row-head', {}, [
      el('label.bi-row-check', {}, [cb]),
      el('div.bi-row-main', {}, [
        el('div.bi-row-line1', {}, [
          badge(kindLabel(it.kind), 'kind-' + it.kind),
          titleText,
          it.dup ? badge('重复', 'dup') : null,
          it.variables.length ? badge(`${it.variables.length} 个待填`, 'var') : null,
        ]),
        el('div.bi-row-line2', {}, [
          el('span.bi-cat', {
            text: `${categoryMeta(it.category).icon} ${categoryMeta(it.category).name}`,
            style: { color: categoryMeta(it.category).color },
          }),
          it.tags.length ? el('span.bi-tags', { text: it.tags.slice(0, 4).join(' · ') }) : null,
          el('span.bi-len', { text: `${it.content.length} 字` }),
          it.sourceRange ? el('span.bi-line', { text: `原文 ${it.sourceRange[0]}-${it.sourceRange[1]} 行` }) : null,
          it.dup ? el('span.bi-dup-why', { text: `与「${it.dup.title}」重复` }) : null,
        ]),
      ]),
      el('button.icon-btn.bi-expand', { text: '⌄', title: '展开编辑' }),
    ]);
    row.appendChild(head);

    // 判定理由：优先展示「为什么没被选中」，那才是用户要看的
    if (it.kind !== 'prompt' && it.scoreWhy?.length) {
      const neg = it.scoreWhy.filter((w) => /像说明性章节|过短|无动作词|对照式|只有约束/.test(w));
      const reason = (neg.length ? neg : it.scoreWhy).slice(0, 2).join('；');
      row.appendChild(el('div.bi-why', { text: '未选中：' + reason }));
    }
    if (it.warnings.length) {
      row.appendChild(el('div.bi-warn', { text: '⚠ ' + it.warnings.join('；') }));
    }

    // 展开编辑区
    const detail = el('div.bi-detail.hidden');
    let built = false;
    function buildDetail() {
      if (built) return;
      built = true;

      const titleIn = el('input.input.input-sm', { value: it.title });
      titleIn.addEventListener('input', () => {
        it.title = titleIn.value;
        titleText.textContent = it.title || '（无标题）';
      });

      const contentTa = el('textarea.bi-ta-sm', { value: it.content });
      contentTa.addEventListener('input', () => {
        it.content = contentTa.value;
        it.variables = extractVariables(it.content);
        it.fingerprint = fingerprint(it.content);
      });

      const noteIn = el('input.input.input-sm', { value: it.note, placeholder: '备注（可选）' });
      noteIn.addEventListener('input', () => { it.note = noteIn.value; });

      const catSel = catSelect(it.category, (v) => {
        it.category = v;
        it.categoryChanged = true;
        const meta = categoryMeta(v);
        const catEl = head.querySelector('.bi-cat');
        if (catEl) { catEl.textContent = `${meta.icon} ${meta.name}`; catEl.style.color = meta.color; }
      });

      const tagIn = el('input.input.input-sm', { value: it.tags.join('、'), placeholder: '标签，用、分隔' });
      tagIn.addEventListener('input', () => {
        it.tags = tagIn.value.split(/[、,，\s]+/).map((s) => s.trim()).filter(Boolean);
      });

      detail.appendChild(
        el('div.bi-detail-grid', {}, [
          el('div.field', {}, [el('label', { text: '标题' }), titleIn]),
          el('div.field', {}, [el('label', { text: '分类' }), catSel]),
          el('div.field', {}, [el('label', { text: '标签' }), tagIn]),
          el('div.field', {}, [el('label', { text: '备注' }), noteIn]),
        ])
      );
      detail.appendChild(el('div.field', {}, [el('label', { text: '正文（入库后即复制内容）' }), contentTa]));

      if (it.original && it.original.trim() !== it.content.trim()) {
        const srcBox = el('details.bi-src', {}, [
          el('summary', { text: '查看原文片段' }),
          el('pre.bi-src-pre', { text: it.original }),
        ]);
        detail.appendChild(srcBox);
      }
      row.appendChild(detail);
    }

    head.querySelector('.bi-expand').addEventListener('click', () => {
      buildDetail();
      detail.classList.toggle('hidden');
      head.querySelector('.bi-expand').textContent = detail.classList.contains('hidden') ? '⌄' : '⌃';
    });

    // 供外部批量操作时同步 checkbox
    row._sync = () => {
      cb.checked = Boolean(it.selected);
      cb.disabled = Boolean(it.dup);
    };

    return row;
  }

  /* ============================================================ 导入 */

  async function doImport() {
    const picked = state.result.items.filter((i) => i.selected && !i.dup);
    if (!picked.length) { toast('没有勾选任何条目', 'warn'); return; }

    if (picked.some((i) => !i.title.trim())) {
      toast('有条目没有标题，请先补齐', 'warn', 3600);
      return;
    }
    const blurry = picked.filter((i) => i.content.length < 30).length;
    if (blurry) {
      const yes = await confirmDialog(
        `有 ${blurry} 条正文不到 30 字，导入后可能不好用。仍要继续吗？`,
        { title: '确认导入', okText: '继续导入' }
      );
      if (!yes) return;
    }

    const extraTags = state.templateTag
      .split(/[、,，\s]+/)
      .map((s) => s.trim())
      .filter(Boolean);

    const payloads = picked.map((it) =>
      toPromptPayload(it, {
        tags: extraTags,
        category: it.category,
        lockCategory: Boolean(it.categoryChanged),
      })
    );

    try {
      const { count } = await store.createMany(payloads);
      m.close();
      if (onDone) onDone({ count });
      toast(`已导入 ${count} 条指令`, 'success', 3600);
    } catch (e) {
      toast('导入失败：' + e.message, 'error', 5200);
    }
  }

  render();
  return m;
}
