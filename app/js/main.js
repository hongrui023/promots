/**
 * 主程序：界面渲染 + 事件编排
 */

import { store, bus, downloadJSON } from './store.js';
import {
  MODES, PLATFORMS, PLATFORM_MAP, search, findSpans, DEFAULT_FILTERS,
  expandOn, canExpand,
} from './search.js';
import { CATEGORIES, CATEGORY_MAP, categoryMeta, autoClassify, categoryName, reclassifyAll, classifyByRules, RULE_LEXICON_SIZE } from './classify.js';
import * as llm from './llm.js';
import * as syncMgr from './sync/manager.js';
import { ADAPTERS, ADAPTER_MAP, RECOMMENDED, badgeOf } from './sync/adapters.js';
import { SEED_PROMPTS } from './seed.js';
import {
  el, clear, toast, modal, confirmDialog, copyText, fmtTime, fmtFull,
  debounce, highlight, initialLetter, hueOf, escapeHtml,
} from './ui.js';

/* ================================================================== 状态 */

const $ = (sel) => document.querySelector(sel);

const state = {
  view: 'all',
  category: null,
  tag: null,
  mode: 'auto',
  query: '',
  sort: 'relevance',
  filters: { ...DEFAULT_FILTERS },
  results: [],
  meta: null,
  searching: false,
};

/* ================================================================== 启动 */

export async function boot() {
  if (globalThis.__aiph?.isDesktop) document.documentElement.classList.add('electron');

  await store.init();
  const settings = await store.getSettings();
  llm.configure(settings);

  await maybeSeed();

  renderModePills();
  renderNav();
  wireEvents();

  await runSearch();

  syncMgr.startAutoSync();
  renderSyncBadge();

  bus.on('change', () => {
    renderNav();
    scheduleSearch(120);
  });
  bus.on('settings', (s) => {
    llm.configure(s);
    renderSyncBadge();
  });
  bus.on('sync:done', renderSyncBadge);
  bus.on('sync:error', renderSyncBadge);
  bus.on('sync:start', renderSyncBadge);

  // 跨设备：窗口重新获得焦点时尝试拉一次
  document.addEventListener('visibilitychange', () => {
    if (!document.hidden && syncMgr.getConfig().provider && syncMgr.getConfig().auto) {
      const last = syncMgr.getConfig().lastSyncAt || 0;
      if (Date.now() - last > 60000) syncMgr.syncNow({ direction: 'both', silent: true });
    }
  });
}

/** 首次运行灌入示例指令，让用户立刻能感受到搜索效果 */
async function maybeSeed() {
  const settings = await store.getSettings();
  if (settings.seeded) return;
  if (store.all({ includeDeleted: true }).length > 0) {
    await store.saveSettings({ seeded: true });
    return;
  }
  for (const raw of SEED_PROMPTS) {
    const created = await store.create(raw);
    const r = await autoClassify({ ...created, categoryLocked: false });
    if (r.category && r.category !== 'other') {
      await store.update(created.id, { category: r.category }, { byUser: false });
    }
  }
  await store.saveSettings({ seeded: true });
  toast(`已导入 ${SEED_PROMPTS.length} 条示例指令，可直接试用搜索`, 'success', 3600);
}

/* ================================================================== 侧边栏 */

function renderModePills() {
  const box = $('#mode-pills');
  clear(box);
  for (const m of MODES) {
    box.appendChild(
      el('button.mode-pill' + (state.mode === m.key ? '.active' : ''), {
        text: m.name,
        title: m.hint,
        dataset: { mode: m.key },
        onclick: () => {
          state.mode = m.key;
          renderModePills();
          runSearch();
        },
      })
    );
  }
}

function renderNav() {
  const stats = store.stats();

  const main = $('#nav-main');
  clear(main);
  const items = [
    { key: 'all', icon: '◎', label: '全部指令', count: stats.total },
    { key: 'favorites', icon: '★', label: '收藏', count: stats.favorites },
    { key: 'trash', icon: '🗑', label: '回收站', count: stats.deleted },
  ];
  for (const it of items) {
    main.appendChild(
      el('button.nav-item' + (state.view === it.key && !state.category ? '.active' : ''), {
        onclick: () => {
          state.view = it.key;
          state.category = null;
          state.filters = { ...DEFAULT_FILTERS, includeDeleted: it.key === 'trash' };
          closeSidebar();
          renderNav();
          runSearch();
        },
      }, [
        el('span.ico', { text: it.icon }),
        el('span.label', { text: it.label }),
        el('span.count', { text: String(it.count) }),
      ])
    );
  }

  const cats = $('#nav-cats');
  clear(cats);
  cats.appendChild(
    el('button.nav-item' + (!state.category ? '.active' : ''), {
      onclick: () => {
        state.category = null;
        state.filters = { ...state.filters, category: null };
        closeSidebar();
        renderNav();
        runSearch();
      },
    }, [
      el('span.ico', { text: '◍' }),
      el('span.label', { text: '全部分类' }),
      el('span.count', { text: String(stats.total) }),
    ])
  );
  for (const c of CATEGORIES) {
    const n = stats.byCat[c.key] || 0;
    if (!n && c.key === 'other') continue;
    cats.appendChild(
      el('button.nav-item' + (state.category === c.key ? '.active' : ''), {
        onclick: () => {
          state.view = 'all';
          state.category = c.key;
          state.filters = { ...DEFAULT_FILTERS, category: c.key };
          closeSidebar();
          renderNav();
          runSearch();
        },
      }, [
        el('span.ico', { text: c.icon }),
        el('span.label', { text: c.name }),
        el('span.count', { text: String(n) }),
      ])
    );
  }

  const cloud = $('#tagcloud');
  clear(cloud);
  const tags = store.collectedTags().slice(0, 28);
  if (!tags.length) cloud.appendChild(el('span.dim', { text: '暂无标签' }));
  for (const t of tags) {
    cloud.appendChild(
      el('button.tagpill' + (state.tag === t.name ? '.active' : ''), {
        onclick: () => {
          state.tag = state.tag === t.name ? null : t.name;
          state.filters = { ...state.filters, tag: state.tag };
          closeSidebar();
          renderNav();
          runSearch();
        },
      }, [t.name, el('span.c', { text: String(t.count) })])
    );
  }
}

function renderSyncBadge() {
  const st = syncMgr.syncStatus();
  const box = $('#sync-badge');
  const dot = box.querySelector('.dot');
  const txt = box.querySelector('.txt');
  void dot;
  if (!st.provider) {
    box.dataset.state = 'idle';
    txt.textContent = '未配置同步';
    return;
  }
  if (st.lastStatus === 'running') {
    box.dataset.state = 'running';
    txt.textContent = `${st.providerName} · 同步中…`;
  } else if (st.lastStatus === 'error') {
    box.dataset.state = 'error';
    txt.textContent = `${st.providerName} · 失败`;
    box.title = st.lastError || '';
  } else {
    box.dataset.state = 'ok';
    txt.textContent = `${st.providerName} · ${st.lastSyncAt ? fmtTime(st.lastSyncAt) : '待同步'}`;
  }
}

/* ================================================================== 搜索 */

const scheduleSearch = debounce(() => runSearch(), 190);

async function runSearch() {
  if (state.searching) return;

  // 回收站视图下按删除时间排，且不带搜索词
  const isTrash = state.view === 'trash';
  const filters = { ...state.filters };
  if (isTrash) filters.includeDeleted = true;

  let items = store.all({ includeDeleted: isTrash });
  if (isTrash) items = items.filter((p) => p.deleted);
  if (state.view === 'favorites') filters.favoriteOnly = true;

  // 没有搜索词时「按相关度」没有意义（所有条目得分相同），退化为按最近修改排序，
  // 否则用户看到的顺序会显得随机。
  let effSort = isTrash ? 'recent' : state.sort;
  if (!state.query.trim() && effSort === 'relevance') effSort = 'recent';

  state.searching = true;
  try {
    const { results, meta } = await search(state.query, {
      items,
      mode: state.mode,
      filters,
      sort: effSort,
      useLLM: true,
    });
    state.results = results;
    state.meta = meta;
    renderResults();
  } catch (e) {
    console.error(e);
    toast('搜索出错：' + e.message, 'error', 4000);
  } finally {
    state.searching = false;
  }
}

function renderResults() {
  const list = $('#list');
  const empty = $('#empty');
  const meta = state.meta;
  const terms = meta?.terms || [];

  $('#result-count').textContent = meta
    ? `${meta.matched} 条结果 · ${Math.round(meta.took)} ms`
    : '—';

  const exBox = $('#result-explain');
  clear(exBox);
  if (meta && meta.query) {
    exBox.appendChild(el('span.ex', { text: `模式：${MODES.find((m) => m.key === state.mode)?.name || state.mode}` }));
    if (meta.mode && meta.mode !== state.mode) exBox.appendChild(el('span.ex', { text: `实际：${meta.mode}` }));
    if (meta.terms?.length) exBox.appendChild(el('span.ex', { text: `检索词：${meta.terms.slice(0, 8).join(' / ')}` }));
    for (const s of meta.parsed?.explain || []) {
      exBox.appendChild(el('span.ex' + (/AI/.test(s) ? '.ai' : ''), { text: s }));
    }
    for (const err of meta.errors || []) {
      exBox.appendChild(el('span.ex', { text: '⚠ ' + err }));
    }
  }

  const chips = $('#active-filters');
  clear(chips);
  if (state.category) {
    chips.appendChild(el('span.chip.active', {
      title: '点击取消',
      text: `分类：${categoryName(state.category)} ✕`,
      onclick: () => { state.category = null; state.filters.category = null; renderNav(); runSearch(); },
    }));
  }
  if (state.tag) {
    chips.appendChild(el('span.chip.active', {
      title: '点击取消',
      text: `标签：${state.tag} ✕`,
      onclick: () => { state.tag = null; state.filters.tag = null; renderNav(); runSearch(); },
    }));
  }
  if (state.view === 'favorites') {
    chips.appendChild(el('span.chip.active', {
      text: '仅收藏 ✕',
      onclick: () => { state.view = 'all'; renderNav(); runSearch(); },
    }));
  }

  clear(list);
  if (!state.results.length) {
    empty.classList.remove('hidden');
    clear(empty);
    const isTrashEmpty = state.view === 'trash';
    empty.appendChild(el('div.big', { text: isTrashEmpty ? '🗑' : '⌕' }));
    empty.appendChild(el('h3', { text: isTrashEmpty ? '回收站是空的' : '没有找到匹配的指令' }));
    empty.appendChild(
      el('p', {
        text: isTrashEmpty
          ? '被删除的指令会先放到这里，可以随时恢复。'
          : state.query
            ? '换个说法试试：切到「近义词」模式，或用「自然语言」直接描述你要什么。也可以降低要求，只搜关键词。'
            : '点左上角「新建指令」开始积累你的指令库。',
      })
    );
    if (state.query) {
      empty.appendChild(
        el('button.btn', {
          text: '用近义词模式重试',
          onclick: () => { state.mode = 'synonym'; renderModePills(); runSearch(); },
        })
      );
    }
    return;
  }
  empty.classList.add('hidden');

  const frag = document.createDocumentFragment();
  for (const r of state.results) frag.appendChild(renderCard(r, terms));
  list.appendChild(frag);
}

function renderCard(result, terms) {
  const p = result.prompt;
  const cat = categoryMeta(p.category);
  const hue = hueOf(p.category + p.title);

  const titleHtml = highlight(p.title, findSpans(p.title, terms));
  const bodyText = p.content.slice(0, 260);
  const bodyHtml = highlight(bodyText, findSpans(bodyText, terms));

  const card = el('div.card' + (p.favorite ? '.fav' : ''), { dataset: { id: p.id } }, [
    el('div.card-head', {}, [
      el('div.card-avatar', {
        text: initialLetter(p.title),
        style: { background: `linear-gradient(135deg, hsl(${hue} 68% 58%), hsl(${(hue + 38) % 360} 68% 50%))` },
      }),
      el('div.card-title-wrap', {}, [
        el('div.card-title', { html: titleHtml }),
        el('div.card-meta', {}, [
          el('span', { text: fmtTime(p.updatedAt) }),
          p.useCount ? el('span', {}, [el('span.sep', { text: '·' }), `用过 ${p.useCount} 次`]) : null,
          (p.platforms || []).length ? el('span', {}, [el('span.sep', { text: '·' }), p.platforms.map((k) => PLATFORM_MAP.get(k)?.name || k).join('/')]) : null,
        ]),
      ]),
      el('div.card-actions', {}, [
        el('button.icon-btn' + (p.favorite ? '.on' : ''), {
          text: p.favorite ? '★' : '☆',
          title: p.favorite ? '取消收藏' : '收藏',
          onclick: async (e) => {
            e.stopPropagation();
            await store.toggleFavorite(p.id);
          },
        }),
        el('button.icon-btn', { text: '✎', title: '编辑', onclick: (e) => { e.stopPropagation(); openEditor(p); } }),
        el('button.icon-btn.danger', {
          text: '🗑', title: '删除',
          onclick: async (e) => {
            e.stopPropagation();
            await doDelete(p);
          },
        }),
      ]),
    ]),

    el('div.card-body' + (p.content.length > 260 ? '.fade' : ''), { html: bodyHtml }),

    el('div.card-tags', {}, [
      el('span.cat-badge', {
        style: { borderColor: cat.color + '55' },
        onclick: (e) => { e.stopPropagation(); openCategoryPicker(p); },
        title: '点击调整分类',
      }, [
        el('span', { text: cat.icon }),
        el('span', { text: cat.name }),
        p.categoryLocked ? el('span.lock', { text: '🔒', title: '已手动指定，自动分类不再覆盖' }) : null,
      ]),
      ...(p.tags || []).slice(0, 4).map((t) =>
        el('span.chip', { text: t, title: `按标签「${t}」筛选`, onclick: (e) => { e.stopPropagation(); state.tag = t; state.filters.tag = t; renderNav(); runSearch(); } })
      ),
    ]),

    (result.why || []).length
      ? el('div.card-why', {}, [el('span.dim', { text: '命中：' }), ...result.why.slice(0, 3).map((w) => el('span.w', { text: w }))])
      : null,

    el('div.card-foot', {}, [
      el('button.copy-btn', {
        text: '⧉ 复制指令',
        title: '复制内容到剪贴板',
        onclick: async (e) => {
          e.stopPropagation();
          const ok = await copyText(p.content);
          if (ok) {
            await store.markUsed(p.id);
            toast('已复制，去 AI 平台粘贴即可', 'success', 1900);
          } else {
            toast('复制失败，请手动选择内容', 'error');
          }
        },
      }),
      el('button.btn.btn-sm.btn-ghost', { text: '查看全文', onclick: (e) => { e.stopPropagation(); openPreview(p); } }),
      el('span.grow'),
      el('button.icon-btn', { text: '⤓', title: '导出这一条', onclick: (e) => { e.stopPropagation(); exportSingle(p); } }),
    ]),
  ]);

  return card;
}

/* ================================================================== 复制 / 删除 */

async function doDelete(p) {
  if (state.view === 'trash') {
    const yes = await confirmDialog(`「${p.title}」将被彻底删除，无法恢复。确定吗？`, { title: '彻底删除', danger: true, okText: '彻底删除' });
    if (yes) { await store.purge(p.id); toast('已彻底删除', 'success'); }
    return;
  }
  const yes = await confirmDialog(`「${p.title}」将移入回收站，可以随时恢复。`, { title: '删除指令', okText: '移入回收站' });
  if (yes) { await store.remove(p.id); toast('已移入回收站', 'success'); }
}

function exportSingle(p) {
  downloadJSON({ schema: 1, app: 'ai-prompt-hub', exportedAt: Date.now(), items: [p] }, `${p.title.slice(0, 30)}.json`);
  toast('已导出该条指令', 'success');
}

/* ================================================================== 预览 */

function openPreview(p) {
  const cat = categoryMeta(p.category);
  const body = el('div', {}, [
    el('div.row', { style: { marginBottom: '10px' } }, [
      el('span.cat-badge', {}, [el('span', { text: cat.icon }), el('span', { text: cat.name })]),
      ...(p.tags || []).map((t) => el('span.chip', { text: t })),
      el('span.grow'),
      el('span.dim', { text: `${p.content.length} 字 · 用过 ${p.useCount} 次` }),
    ]),
    p.note ? el('p.dim', { text: p.note, style: { marginTop: 0 } }) : null,
    el('div.preview-box', { text: p.content }),
    el('dl.kv.mt12', {}, [
      el('dt', { text: '适用平台' }),
      el('dd', { text: (p.platforms || []).map((k) => PLATFORM_MAP.get(k)?.name || k).join('、') || '未指定' }),
      el('dt', { text: '创建时间' }),
      el('dd', { text: fmtFull(p.createdAt) }),
      el('dt', { text: '最后修改' }),
      el('dd', { text: fmtFull(p.updatedAt) }),
    ]),
  ]);

  const m = modal({
    title: p.title,
    width: '640px',
    body,
    footer: [
      el('button.btn', { text: '编辑', onclick: () => { m.close(); openEditor(p); } }),
      el('button.btn.btn-primary', {
        text: '⧉ 复制指令',
        onclick: async () => {
          const ok = await copyText(p.content);
          if (ok) { await store.markUsed(p.id); toast('已复制', 'success'); m.close(); }
        },
      }),
    ],
  });
}

/* ================================================================== 编辑器 */

async function openEditor(existing) {
  const draft = existing
    ? { ...existing, tags: [...(existing.tags || [])], platforms: [...(existing.platforms || [])] }
    : { title: '', content: '', note: '', tags: [], category: 'other', categoryLocked: false, favorite: false, platforms: [] };

  let autoResult = null;
  let autoTimer = null;

  /* --- 字段：标题 */
  const titleInput = el('input.input', {
    value: draft.title,
    placeholder: '给这条指令起个一眼能认出的名字，例如「周报生成器」',
    oninput: () => { draft.title = titleInput.value; scheduleClassify(); },
  });

  /* --- 字段：正文 */
  const contentInput = el('textarea.textarea.tall', {
    value: draft.content,
    placeholder: '粘贴指令正文。用 {{变量}} 标记需要替换的部分，例如：\n\n你是一位资深{{行业}}编辑，请把下面这段文字改写成{{风格}}风格，控制在{{字数}}字以内：\n\n{{原文}}',
    oninput: () => {
      draft.content = contentInput.value;
      charCount.textContent = `${contentInput.value.length} 字`;
      scheduleClassify();
    },
  });
  const charCount = el('div.char-count', { text: `${draft.content.length} 字` });

  /* --- 字段：备注 */
  const noteInput = el('input.input', {
    value: draft.note,
    placeholder: '什么时候用它、有什么注意事项（可选）',
    oninput: () => { draft.note = noteInput.value; scheduleClassify(); },
  });

  /* --- 字段：标签 */
  const tagInput = el('input.input', {
    placeholder: '输入后按回车添加，例如：周报、职场、中文',
    onkeydown: (e) => {
      if (e.key === 'Enter' || e.key === ',') {
        e.preventDefault();
        addTag(tagInput.value.trim().replace(/[,，]$/, ''));
        tagInput.value = '';
      } else if (e.key === 'Backspace' && !tagInput.value && draft.tags.length) {
        draft.tags.pop();
        renderTags();
        scheduleClassify();
      }
    },
  });
  const tagBox = el('div.autocomplete');

  function renderTags() {
    clear(tagBox);
    const all = store.collectedTags().map((t) => t.name).filter((t) => !draft.tags.includes(t));
    for (const t of draft.tags) {
      tagBox.appendChild(
        el('span.chip.active', {
          text: t + ' ✕',
          style: { cursor: 'pointer' },
          onclick: () => { draft.tags = draft.tags.filter((x) => x !== t); renderTags(); scheduleClassify(); },
        })
      );
    }
    const suggestions = all.filter((t) => !draft.tags.includes(t)).slice(0, 6);
    for (const t of suggestions) {
      tagBox.appendChild(el('button.sug', { text: '+ ' + t, onclick: () => addTag(t) }));
    }
  }
  function addTag(t) {
    if (!t || draft.tags.includes(t)) return;
    draft.tags.push(t);
    renderTags();
    scheduleClassify();
  }

  /* --- 字段：分类 */
  const catSelect = el('select.select', {
    onchange: () => { draft.category = catSelect.value; draft.categoryLocked = true; renderClassifyHint(); },
  });
  for (const c of CATEGORIES) {
    catSelect.appendChild(el('option', { value: c.key, text: `${c.icon} ${c.name}`, selected: c.key === draft.category }));
  }
  const classifyHint = el('div.classify-hint');
  const lockCheck = el('input', {
    type: 'checkbox', checked: draft.categoryLocked,
    onchange: () => { draft.categoryLocked = lockCheck.checked; renderClassifyHint(); },
  });

  function renderClassifyHint() {
    clear(classifyHint);
    const meta = categoryMeta(draft.category);
    classifyHint.appendChild(el('span', { text: `当前分类：${meta.icon} ${meta.name}` }));
    if (draft.categoryLocked) {
      classifyHint.appendChild(el('span.src', { text: '已锁定，自动分类不会再改它' }));
    } else if (autoResult) {
      const srcName = { rule: '规则引擎', llm: '大模型', fallback: '规则引擎', locked: '锁定' }[autoResult.source] || autoResult.source;
      classifyHint.appendChild(
        el('span.src', { text: `自动判定 ${Math.round(autoResult.confidence * 100)}% · ${srcName}` })
      );
      if (autoResult.reason) classifyHint.appendChild(el('span.dim', { text: autoResult.reason }));
      if (autoResult.category !== draft.category) {
        classifyHint.appendChild(
          el('button.btn.btn-sm', {
            text: `采纳 → ${categoryName(autoResult.category)}`,
            onclick: () => {
              draft.category = autoResult.category;
              catSelect.value = autoResult.category;
              draft.categoryLocked = false;
              lockCheck.checked = false;
              renderClassifyHint();
            },
          })
        );
      }
    } else {
      classifyHint.appendChild(el('span.dim', { text: '填写标题或正文后自动判定' }));
    }
  }

  const scheduleClassify = debounce(async () => {
    if (!draft.title && !draft.content) return;
    autoResult = await autoClassify({ ...draft, categoryLocked: false });
    if (!draft.categoryLocked && autoResult && autoResult.category !== draft.category) {
      draft.category = autoResult.category;
      catSelect.value = autoResult.category;
    }
    renderClassifyHint();
  }, 420);

  /* --- 字段：平台 */
  const platformBox = el('div.platform-picker');
  function renderPlatforms() {
    clear(platformBox);
    for (const pf of PLATFORMS) {
      const on = draft.platforms.includes(pf.key);
      platformBox.appendChild(
        el('span.chip' + (on ? '.active' : ''), {
          style: { '--c': pf.color },
          text: pf.name,
          onclick: () => {
            draft.platforms = on ? draft.platforms.filter((x) => x !== pf.key) : [...draft.platforms, pf.key];
            renderPlatforms();
          },
        })
      );
    }
  }

  const favCheck = el('input', { type: 'checkbox', checked: draft.favorite });

  const body = el('div', {}, [
    el('div.field', {}, [el('label', { text: '标题' }), titleInput]),
    el('div.field', {}, [
      el('label', { text: '指令内容' }),
      contentInput,
      charCount,
      el('div.hint', { text: '提示：用 {{变量}} 占位，复制后只需替换花括号里的内容，避免每次重新编辑整段。' }),
    ]),
    el('div.field', {}, [el('label', { text: '备注' }), noteInput]),
    el('div.field', {}, [el('label', { text: '标签' }), tagInput, tagBox]),
    el('div.field', {}, [
      el('label', { text: '分类' }),
      catSelect,
      classifyHint,
      el('label.check', { style: { marginTop: '7px' } }, [
        lockCheck,
        el('span', { text: '锁定分类（勾选后自动分类不再覆盖，手动调整会自动勾选）' }),
      ]),
    ]),
    el('div.field', {}, [el('label', { text: '常用平台（可多选，用于筛选）' }), platformBox]),
    el('div.field', {}, [
      el('label.check', {}, [favCheck, el('span', { text: '加入收藏' })]),
    ]),
  ]);

  const doSave = async () => {
    if (!draft.title && !draft.content) { toast('至少填写标题或内容', 'warn'); return; }
    if (!draft.title) draft.title = draft.content.slice(0, 24).replace(/\s+/g, ' ').trim() || '未命名指令';
    draft.favorite = favCheck.checked;
    draft.categoryLocked = lockCheck.checked;

    if (existing) {
      await store.update(existing.id, draft);
      toast('已保存', 'success');
    } else {
      const created = await store.create(draft);
      if (!created.categoryLocked && (!created.category || created.category === 'other')) {
        const r = await autoClassify(created);
        if (r.category && r.category !== 'other') await store.update(created.id, { category: r.category });
      }
      toast('已新建指令', 'success');
    }
    m.close();
  };

  renderTags();
  renderPlatforms();
  renderClassifyHint();

  const m = modal({
    title: existing ? '编辑指令' : '新建指令',
    width: '700px',
    body,
    footer: [
      el('span.grow', { text: existing ? `创建于 ${fmtFull(existing.createdAt)}` : 'Ctrl + Enter 快速保存' }),
      el('button.btn', { text: '取消', onclick: () => m.close() }),
      el('button.btn.btn-primary', { text: '保存', onclick: doSave }),
    ],
    onClose: () => clearTimeout(autoTimer),
  });

  setTimeout(() => (existing ? contentInput : titleInput).focus(), 60);
  if (!existing) scheduleClassify();
}

/* ================================================================== 分类调整 */

function openCategoryPicker(p) {
  const body = el('div.checks');
  for (const c of CATEGORIES) {
    const n = store.stats().byCat[c.key] || 0;
    body.appendChild(
      el('label.check', { style: { cursor: 'pointer' } }, [
        el('input', {
          type: 'radio',
          name: 'cat',
          checked: c.key === p.category,
          onchange: async () => {
            await store.update(p.id, { category: c.key }, { byUser: true });
            toast(`已归入「${c.name}」，并锁定该分类`, 'success');
            m.close();
          },
        }),
        el('span', { text: `${c.icon} ${c.name}` }),
        el('span.dim', { text: `（${n} 条）`, style: { marginLeft: 'auto' } }),
      ])
    );
  }
  const m = modal({
    title: `调整「${p.title}」的分类`,
    width: '420px',
    body,
    footer: [
      el('button.btn', {
        text: '解除锁定，交给自动分类',
        onclick: async () => {
          await store.update(p.id, { categoryLocked: false });
          const r = await autoClassify({ ...p, categoryLocked: false });
          if (r.category) await store.update(p.id, { category: r.category });
          toast(`已重新判定为「${categoryName(r.category)}」`, 'success');
          m.close();
        },
      }),
      el('button.btn.btn-primary', { text: '完成', onclick: () => m.close() }),
    ],
  });
}

/* ================================================================== 设置 */

const SETTINGS_TABS = [
  { key: 'sync', name: '同步' },
  { key: 'ai', name: 'AI 增强' },
  { key: 'data', name: '数据' },
  { key: 'about', name: '关于' },
];

function openSettings(tabKey = 'sync') {
  const bodyHost = el('div');
  const tabsRow = el('div.tabs');
  let current = tabKey;

  const renderTab = async () => {
    clear(tabsRow);
    for (const t of SETTINGS_TABS) {
      tabsRow.appendChild(
        el('button.tab' + (current === t.key ? '.active' : ''), {
          text: t.name,
          onclick: () => { current = t.key; renderTab(); },
        })
      );
    }
    clear(bodyHost);
    if (current === 'sync') bodyHost.appendChild(await renderSyncTab());
    else if (current === 'ai') bodyHost.appendChild(await renderAiTab());
    else if (current === 'data') bodyHost.appendChild(await renderDataTab());
    else bodyHost.appendChild(renderAboutTab());
  };

  const m = modal({ title: '设置', width: '680px', body: el('div', {}, [tabsRow, bodyHost]) });
  renderTabReload = renderTab;
  renderTab();
  return m;
}

/* ---------------------------------------------------------------- 同步页 */

async function renderSyncTab() {
  const cfg = syncMgr.getConfig();
  const wrap = el('div');

  wrap.appendChild(el('p.hint', {
    text: '选择一种通道把数据同步到你的网盘。数据文件里是明文 JSON，含你保存的所有指令，请放在私有位置。',
    style: { marginTop: 0, marginBottom: '12px' },
  }));

  for (const a of ADAPTERS) {
    const on = cfg.provider === a.key;
    const disabled = !a.available();
    const reason = a.unavailableReason ? a.unavailableReason() : '';
    const card = el('div.provider-card' + (on ? '.active' : ''), {
      style: disabled ? { opacity: '.58' } : {},
      onclick: async () => {
        if (disabled) { toast(reason, 'warn', 4200); return; }
        await syncMgr.saveConfig({ provider: a.key });
        renderTabReload();
      },
    }, [
      el('div.pc-head', {}, [
        el('span.pc-name', { text: a.name }),
        badgeOf(a.key) ? el('span.pc-rec', { text: badgeOf(a.key) }) : null,
        on ? el('span.dim', { text: '● 已启用' }) : null,
      ]),
      el('div.pc-desc', { text: a.desc }),
      reason ? el('div.pc-desc', { text: '⚠ ' + reason, style: { color: 'var(--warn)' } }) : null,
    ]);
    wrap.appendChild(card);
  }

  const active = syncMgr.activeAdapter();
  if (active && active.fields.length) {
    wrap.appendChild(el('hr', { style: { border: 'none', borderTop: '1px solid var(--border)', margin: '6px 0 16px' } }));
    wrap.appendChild(await renderProviderForm(active));
  } else if (active) {
    wrap.appendChild(el('div.status-line.info', { text: '本通道无需配置。请在「数据」页使用导入/导出。' }));
  }

  // 同步控制
  wrap.appendChild(el('hr', { style: { border: 'none', borderTop: '1px solid var(--border)', margin: '16px 0' } }));
  const autoCheck = el('input', {
    type: 'checkbox', checked: cfg.auto,
    onchange: async () => { await syncMgr.saveConfig({ auto: autoCheck.checked }); syncMgr.startAutoSync(); },
  });
  wrap.appendChild(el('label.check', {}, [autoCheck, el('span', { text: '自动同步（改动后自动上传，切换设备时自动拉取）' })]));

  const statusLine = el('div.status-line.info', { text: '尚未同步' });
  const steps = el('div.sync-steps');

  const syncBtn = el('button.btn.btn-primary', {
    text: '⟳ 立即双向同步',
    onclick: async () => {
      syncBtn.disabled = true;
      clear(steps);
      statusLine.className = 'status-line info';
      statusLine.textContent = '同步中…';
      const off = bus.on('sync:stage', (label) => {
        steps.appendChild(el('div.step', {}, [el('span.n', { text: String(steps.childElementCount + 1) }), label]));
      });
      try {
        const r = await syncMgr.syncNow({ direction: 'both' });
        off();
        statusLine.className = 'status-line ok';
        statusLine.textContent = r.report
          ? `同步完成：共 ${r.report.total} 条（新增 ${r.report.added}，本地胜出 ${r.report.localWin}，云端胜出 ${r.report.remoteWin}）`
          : `同步完成：${r.push?.message || '已上传 ' + (r.localCount || 0) + ' 条'}`;
        toast('同步完成', 'success');
      } catch (e) {
        off();
        statusLine.className = 'status-line err';
        statusLine.textContent = '同步失败：' + e.message;
      } finally {
        syncBtn.disabled = false;
        renderSyncBadge();
      }
    },
  });

  const state = await store.getSettings();
  const syncState = state.sync || {};
  if (syncState.lastStatus === 'success' && syncState.lastSyncAt) {
    statusLine.className = 'status-line ok';
    statusLine.textContent = `上次同步成功：${fmtFull(syncState.lastSyncAt)}`;
  } else if (syncState.lastStatus === 'error') {
    statusLine.className = 'status-line err';
    statusLine.textContent = '上次同步失败：' + (syncState.lastError || '未知原因');
  }

  wrap.appendChild(
    el('div.row.mt12', {}, [
      syncBtn,
      el('button.btn', {
        text: '↑ 仅上传',
        title: '以本机数据为准覆盖云端',
        onclick: async () => {
          try { const r = await syncMgr.pushOnly(); toast(r.push?.message || '已上传', 'success'); }
          catch (e) { toast('上传失败：' + e.message, 'error', 4000); }
        },
      }),
      el('button.btn', {
        text: '↓ 仅拉取',
        title: '从云端合并到本机',
        onclick: async () => {
          try {
            const r = await syncMgr.pullOnly();
            toast(r.remoteEmpty ? '云端暂无数据' : '已拉取并合并', 'success');
            await runSearch();
          } catch (e) { toast('拉取失败：' + e.message, 'error', 4000); }
        },
      }),
    ])
  );
  wrap.appendChild(statusLine);
  wrap.appendChild(steps);
  return wrap;
}

let renderTabReload = () => {};

async function renderProviderForm(adapter) {
  const cfg = syncMgr.providerConfig(adapter.key);
  const wrap = el('div');
  wrap.appendChild(el('h4', { text: `${adapter.name} 配置`, style: { margin: '0 0 12px', fontSize: '14px' } }));

  const inputs = {};

  for (const f of adapter.fields) {
    const value = cfg[f.key] ?? f.default ?? (f.type === 'checkbox' ? false : '');
    let input;
    if (f.type === 'checkbox') {
      input = el('input', { type: 'checkbox', checked: Boolean(value) });
    } else if (f.type === 'select') {
      input = el('select.select');
      for (const o of f.options) input.appendChild(el('option', { value: o.value, text: o.label, selected: o.value === value }));
    } else {
      input = el('input.input', { type: f.type === 'password' ? 'password' : 'text', value, placeholder: f.placeholder || '' });
    }
    inputs[f.key] = input;

    const hintChildren = [];
    if (f.hint) hintChildren.push(el('span', { text: f.hint }));
    if (f.link) hintChildren.push(el('a', { href: f.link, target: '_blank', rel: 'noreferrer', text: '→ 去申请' }));

    wrap.appendChild(
      el('div.field', {}, [
        el('label', { text: f.label + (f.required ? ' *' : '') }),
        input,
        hintChildren.length ? el('div.hint', {}, hintChildren) : null,
      ])
    );
  }

  const statusEl = el('div');

  const collect = () => {
    const out = {};
    for (const f of adapter.fields) {
      const node = inputs[f.key];
      out[f.key] = f.type === 'checkbox' ? node.checked : node.value.trim();
    }
    return out;
  };

  const saveBtn = el('button.btn.btn-primary', {
    text: '保存配置',
    onclick: async () => {
      const vals = collect();
      const missing = adapter.fields.filter((f) => f.required && !vals[f.key]);
      if (missing.length) { toast('请填写：' + missing.map((f) => f.label).join('、'), 'warn'); return; }
      await syncMgr.saveProviderConfig(adapter.key, vals);
      toast('配置已保存（仅存放在本机）', 'success');
    },
  });

  const testBtn = el('button.btn', {
    text: '测试连接',
    onclick: async () => {
      clear(statusEl);
      statusEl.appendChild(el('div.status-line.info', { text: '正在测试…' }));
      testBtn.disabled = true;
      try {
        const vals = collect();
        await syncMgr.saveProviderConfig(adapter.key, vals);
        const r = await adapter.test(vals);
        clear(statusEl);
        statusEl.appendChild(el('div.status-line.ok', { text: '✓ ' + r.message }));
        if (r.data?.gistId && !vals.gistId) {
          await syncMgr.saveProviderConfig(adapter.key, { gistId: r.data.gistId });
          toast('已自动识别到已有的数据 Gist', 'success');
        }
      } catch (e) {
        clear(statusEl);
        statusEl.appendChild(el('div.status-line.err', { text: '✕ ' + e.message }));
      } finally {
        testBtn.disabled = false;
      }
    },
  });

  const row = el('div.row', {}, [saveBtn, testBtn]);

  // 通道特有的辅助按钮
  if (adapter.key === 'localfolder') {
    const chooser = el('button.btn', {
      text: '📁 选择同步目录',
      onclick: async () => {
        try {
          const r = await adapter.chooseDirectory();
          if (r.dirPath) {
            inputs.dirPath && (inputs.dirPath.value = r.dirPath);
            await syncMgr.saveProviderConfig(adapter.key, { mode: 'manual', dirPath: r.dirPath });
            toast('已选择：' + r.dirPath, 'success');
          } else {
            await syncMgr.saveProviderConfig(adapter.key, { mode: 'picker' });
            toast('目录已授权', 'success');
          }
        } catch (e) {
          if (e.name !== 'AbortError') toast(e.message, 'error', 4200);
        }
      },
    });
    row.appendChild(chooser);
    row.appendChild(el('span.dim', { text: '把目录指向「微云同步助手 / 百度网盘同步空间 / OneDrive」里的文件夹' }));
  }

  if (adapter.key === 'baidupan') {
    row.appendChild(
      el('button.btn', {
        text: '🔑 获取授权',
        onclick: async () => {
          const vals = collect();
          if (!vals.appKey) { toast('请先填写 AppKey', 'warn'); return; }
          if (!vals.redirectUri) { toast('请先填写回调地址', 'warn'); return; }
          await syncMgr.saveProviderConfig(adapter.key, vals);
          const url = adapter.getAuthUrl(vals);
          window.open(url, '_blank', 'noopener,width=760,height=720');
          toast('已打开百度授权页，登录并同意后会自动把 Token 回填到本页', 'info', 6000);
        },
      })
    );
    const refreshBtn = el('button.btn', {
      text: '刷新 Token',
      onclick: async () => {
        try {
          const vals = collect();
          const r = await adapter.refresh(vals);
          await syncMgr.saveProviderConfig(adapter.key, r);
          inputs.accessToken && (inputs.accessToken.value = r.accessToken);
          toast('Token 已刷新', 'success');
        } catch (e) { toast('刷新失败：' + e.message, 'error', 4200); }
      },
    });
    row.appendChild(refreshBtn);
  }

  wrap.appendChild(row);
  wrap.appendChild(statusEl);
  return wrap;
}

/* ---------------------------------------------------------------- AI 页 */

async function renderAiTab() {
  const settings = await store.getSettings();
  const wrap = el('div');

  wrap.appendChild(el('p.hint', {
    text: 'AI 增强是可选功能，不配置也能正常使用全部搜索模式和自动分类（走本地规则引擎）。配置后可以解锁：真正的语义搜索、复杂自然语言查询解析、低置信度分类兜底。',
    style: { marginTop: 0 },
  }));

  const enabled = el('input', { type: 'checkbox', checked: Boolean(settings.llmEnabled) });
  const providerSel = el('select.select');
  const presets = llm.llmPresets();
  for (const [k, v] of Object.entries(presets)) {
    providerSel.appendChild(el('option', { value: k, text: v.label, selected: settings.llmProvider === k }));
  }
  const baseInput = el('input.input', { value: settings.llmBaseUrl || '', placeholder: 'https://api.deepseek.com/v1' });
  const keyInput = el('input.input', { type: 'password', value: settings.llmApiKey || '', placeholder: 'sk-...' });
  const modelInput = el('input.input', { value: settings.llmModel || '', placeholder: 'deepseek-chat' });
  const docLink = el('a', { href: presets[settings.llmProvider]?.doc || '#', target: '_blank', rel: 'noreferrer', text: '→ 获取 API Key' });

  providerSel.addEventListener('change', () => {
    const p = presets[providerSel.value];
    if (p) {
      baseInput.value = p.baseUrl;
      modelInput.value = p.model;
      docLink.href = p.doc || '#';
    }
  });

  const testOut = el('div');

  const collect = () => ({
    llmEnabled: enabled.checked,
    llmProvider: providerSel.value,
    llmBaseUrl: baseInput.value.trim(),
    llmApiKey: keyInput.value.trim(),
    llmModel: modelInput.value.trim(),
  });

  const saveBtn = el('button.btn.btn-primary', {
    text: '保存并启用',
    onclick: async () => {
      const s = await store.saveSettings(collect());
      llm.configure(s);
      store.settings = s;
      toast('已保存（Key 仅存本机，不会同步到云端）', 'success');
    },
  });

  const testBtn = el('button.btn', {
    text: '测试连通性',
    onclick: async () => {
      const s = await store.saveSettings(collect());
      llm.configure(s);
      clear(testOut);
      testOut.appendChild(el('div.status-line.info', { text: '正在请求…' }));
      try {
        const r = await llm.llmTest();
        clear(testOut);
        testOut.appendChild(el('div.status-line.ok', { text: `✓ 连通正常，耗时 ${r.ms} ms，模型回复：${r.reply}` }));
      } catch (e) {
        clear(testOut);
        testOut.appendChild(el('div.status-line.err', { text: '✕ ' + e.message }));
      }
    },
  });

  wrap.appendChild(el('div.field', {}, [el('label.check', {}, [enabled, el('span', { text: '启用 AI 增强' })] )]));
  wrap.appendChild(el('div.field', {}, [el('label', { text: '服务商' }), providerSel]));
  wrap.appendChild(el('div.field-row', {}, [
    el('div.field', {}, [el('label', { text: '接口地址 (Base URL)' }), baseInput]),
    el('div.field', {}, [el('label', { text: '模型名' }), modelInput]),
  ]));
  wrap.appendChild(el('div.field', {}, [el('label', { text: 'API Key' }), keyInput, el('div.hint', {}, [docLink])]));
  wrap.appendChild(el('div.row', {}, [saveBtn, testBtn]));
  wrap.appendChild(testOut);

  wrap.appendChild(el('div.status-line.warn.mt12', {
    text: '浏览器 / PWA 直接调用大模型接口通常会遇到跨域（CORS）限制。桌面端已内置转发可正常使用；网页端如报「请求被跨域拦截」，属于已知限制。',
  }));

  return wrap;
}

/* ---------------------------------------------------------------- 数据页 */

async function renderDataTab() {
  const wrap = el('div');
  const stats = store.stats();
  const snap = store.snapshot();
  const size = new Blob([JSON.stringify(snap)]).size;

  wrap.appendChild(
    el('dl.kv', {}, [
      el('dt', { text: '指令总数' }), el('dd', { text: `${stats.total} 条` }),
      el('dt', { text: '收藏' }), el('dd', { text: `${stats.favorites} 条` }),
      el('dt', { text: '回收站' }), el('dd', { text: `${stats.deleted} 条` }),
      el('dt', { text: '数据体积' }), el('dd', { text: `${(size / 1024).toFixed(1)} KB` }),
      el('dt', { text: '设备标识' }), el('dd', { text: store.deviceName + ' · ' + store.deviceId.slice(0, 8) }),
      el('dt', { text: '规则词库' }), el('dd', { text: `${RULE_LEXICON_SIZE} 个词条` }),
    ])
  );

  wrap.appendChild(el('hr', { style: { border: 'none', borderTop: '1px solid var(--border)', margin: '16px 0' } }));

  wrap.appendChild(
    el('div.row', {}, [
      el('button.btn.btn-primary', {
        text: '⤓ 导出全部为 JSON',
        onclick: () => {
          downloadJSON(store.snapshot(), `ai-prompt-hub-${new Date().toISOString().slice(0, 10)}.json`);
          toast('已导出，可直接丢进微云 / 百度网盘', 'success', 3200);
        },
      }),
      el('button.btn', { text: '⤒ 从 JSON 导入', onclick: () => $('#file-import').click() }),
      el('button.btn', {
        text: '📋 复制为 Markdown',
        onclick: async () => {
          const md = toMarkdown(store.all());
          const ok = await copyText(md);
          toast(ok ? '已复制 Markdown 到剪贴板' : '复制失败', ok ? 'success' : 'error');
        },
      }),
    ])
  );

  wrap.appendChild(el('hr', { style: { border: 'none', borderTop: '1px solid var(--border)', margin: '16px 0' } }));

  // 批量重分类
  const reOut = el('div');
  wrap.appendChild(
    el('div.row', {}, [
      el('button.btn', {
        text: '🔁 重新智能分类',
        title: '对所有未锁定的指令重跑分类算法',
        onclick: async (ev) => {
          ev.target.disabled = true;
          reOut.textContent = '正在分类…';
          const changed = await reclassifyAll(store.all(), { skipLocked: true });
          for (const c of changed) await store.update(c.id, { category: c.to });
          reOut.textContent = changed.length ? `已调整 ${changed.length} 条的分类` : '所有指令分类都已是最优';
          ev.target.disabled = false;
          toast(changed.length ? `已调整 ${changed.length} 条` : '无需调整', 'success');
        },
      }),
      el('button.btn', {
        text: '🔓 全部解除分类锁定',
        onclick: async () => {
          const locked = store.all().filter((p) => p.categoryLocked);
          const yes = await confirmDialog(`将解除 ${locked.length} 条指令的分类锁定，之后自动分类可以再次调整它们。`, { title: '解除锁定' });
          if (!yes) return;
          for (const p of locked) await store.update(p.id, { categoryLocked: false });
          toast(`已解除 ${locked.length} 条`, 'success');
        },
      }),
      el('button.btn.btn-danger', {
        text: '清空回收站',
        onclick: async () => {
          const yes = await confirmDialog('回收站内所有指令将被彻底删除，无法恢复。', { title: '清空回收站', danger: true, okText: '彻底清空' });
          if (!yes) return;
          await store.emptyTrash();
          toast('回收站已清空', 'success');
        },
      }),
    ])
  );
  wrap.appendChild(reOut);

  wrap.appendChild(el('hr', { style: { border: 'none', borderTop: '1px solid var(--border)', margin: '16px 0' } }));

  const dangerCheck = el('input', { type: 'checkbox' });
  wrap.appendChild(
    el('div.checks', {}, [
      el('label.check', {}, [dangerCheck, el('span', { text: '我明白这会删除本机全部数据（云端保留，可再次拉取）' })]),
    ])
  );
  wrap.appendChild(
    el('button.btn.btn-danger.mt8', {
      text: '清空本机全部数据',
      onclick: async () => {
        if (!dangerCheck.checked) { toast('请先勾选确认项', 'warn'); return; }
        await store.reset();
        toast('本机数据已清空', 'success');
      },
    })
  );

  return wrap;
}

function toMarkdown(items) {
  const byCat = new Map();
  for (const p of items) {
    if (!byCat.has(p.category)) byCat.set(p.category, []);
    byCat.get(p.category).push(p);
  }
  let out = `# AI 指令库\n\n> 导出时间：${new Date().toLocaleString('zh-CN')}　共 ${items.length} 条\n`;
  for (const c of CATEGORIES) {
    const list = byCat.get(c.key);
    if (!list || !list.length) continue;
    out += `\n## ${c.icon} ${c.name}\n`;
    for (const p of list) {
      out += `\n### ${p.title}\n`;
      if (p.note) out += `\n${p.note}\n`;
      if (p.tags?.length) out += `\n标签：${p.tags.join('、')}\n`;
      out += `\n\`\`\`text\n${p.content}\n\`\`\`\n`;
    }
  }
  return out;
}

/* ---------------------------------------------------------------- 关于页 */

function renderAboutTab() {
  const wrap = el('div');
  wrap.appendChild(el('p', { text: 'Prompt Hub —— 本地优先的 AI 指令管理中心。', style: { marginTop: 0, fontWeight: 600 } }));
  wrap.appendChild(
    el('dl.kv', {}, [
      el('dt', { text: '搜索模式' }), el('dd', { text: MODES.map((m) => m.name).join(' / ') }),
      el('dt', { text: '分类体系' }), el('dd', { text: `${CATEGORIES.length} 类（规则 + LLM 双层判定）` }),
      el('dt', { text: '数据存储' }), el('dd', { text: '本机 IndexedDB，明文 JSON，可随时导出' }),
      el('dt', { text: '同步通道' }), el('dd', { text: ADAPTERS.map((a) => a.name).join('　') }),
      el('dt', { text: '运行环境' }), el('dd', { text: globalThis.__aiph?.isDesktop ? `桌面端 ${globalThis.__aiph.platform}` : '浏览器 / PWA' }),
    ])
  );
  wrap.appendChild(
    el('div.status-line.info.mt12', {
      text: '隐私说明：所有指令保存在本机。启用同步后才会写入你指定的网盘/Gist。API Key 只在本地保存，且不包含在同步数据中。',
    })
  );
  wrap.appendChild(
    el('div.row.mt12', {}, [
      el('button.btn', {
        text: '快捷键说明',
        onclick: () => modal({
          title: '快捷键',
          width: '420px',
          body: el('dl.kv', {}, [
            el('dt', { text: 'Ctrl / ⌘ + K' }), el('dd', { text: '聚焦搜索框' }),
            el('dt', { text: 'Ctrl / ⌘ + N' }), el('dd', { text: '新建指令' }),
            el('dt', { text: 'Ctrl / ⌘ + Enter' }), el('dd', { text: '在编辑器中保存' }),
            el('dt', { text: 'Ctrl / ⌘ + 1~5' }), el('dd', { text: '切换搜索模式' }),
            el('dt', { text: 'Esc' }), el('dd', { text: '关闭弹窗 / 清空搜索' }),
          ]),
        }),
      }),
    ])
  );
  return wrap;
}

/* ================================================================== 事件 */

function wireEvents() {
  const input = $('#search-input');

  input.addEventListener('input', () => {
    state.query = input.value;
    $('#btn-clear-search').classList.toggle('hidden', !input.value);
    scheduleSearch();
  });

  input.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') { input.value = ''; state.query = ''; $('#btn-clear-search').classList.add('hidden'); runSearch(); }
  });

  $('#btn-clear-search').addEventListener('click', () => {
    input.value = '';
    state.query = '';
    $('#btn-clear-search').classList.add('hidden');
    input.focus();
    runSearch();
  });

  $('#sort-select').addEventListener('change', (e) => {
    state.sort = e.target.value;
    runSearch();
  });

  $('#btn-new').addEventListener('click', () => openEditor(null));
  $('#btn-settings').addEventListener('click', () => openSettings('sync'));
  $('#btn-sync').addEventListener('click', async () => {
    if (!syncMgr.getConfig().provider) {
      toast('尚未配置同步通道，先到设置里选一个', 'warn', 3600);
      openSettings('sync');
      return;
    }
    try {
      const r = await syncMgr.syncNow({ direction: 'both' });
      toast(r.report ? `同步完成，共 ${r.report.total} 条` : '同步完成', 'success');
      await runSearch();
    } catch (e) {
      toast('同步失败：' + e.message, 'error', 4600);
    }
    renderSyncBadge();
  });

  $('#btn-reclassify').addEventListener('click', async () => {
    const changed = await reclassifyAll(store.all(), { skipLocked: true });
    for (const c of changed) await store.update(c.id, { category: c.to });
    toast(changed.length ? `已调整 ${changed.length} 条分类` : '分类已是最优', 'success');
  });

  $('#btn-open-sidebar').addEventListener('click', () => {
    $('#sidebar').classList.add('open');
    $('#sidebar-backdrop').classList.add('in');
  });
  $('#btn-close-sidebar').addEventListener('click', closeSidebar);
  $('#sidebar-backdrop').addEventListener('click', closeSidebar);

  // 导入
  $('#file-import').addEventListener('change', async (e) => {
    const file = e.target.files?.[0];
    e.target.value = '';
    if (!file) return;
    try {
      const text = await file.text();
      const payload = JSON.parse(text);
      const count = Array.isArray(payload?.items) ? payload.items.length : Array.isArray(payload) ? payload.length : 0;
      const yes = await confirmDialog(
        `文件包含 ${count} 条指令。合并模式会按「最后修改时间」逐条比对，不会覆盖你更新的内容。`,
        { title: '导入数据', okText: '合并导入' }
      );
      if (!yes) return;
      const r = await store.importSnapshot(payload, 'merge');
      toast(`导入完成：新增 ${r.added} 条，共 ${r.total} 条`, 'success', 3600);
      await runSearch();
    } catch (err) {
      toast('导入失败：' + err.message, 'error', 4600);
    }
  });

  // 全局快捷键
  document.addEventListener('keydown', (e) => {
    const meta = e.ctrlKey || e.metaKey;
    if (meta && e.key.toLowerCase() === 'k') {
      e.preventDefault();
      input.focus();
      input.select();
    } else if (meta && e.key.toLowerCase() === 'n') {
      e.preventDefault();
      openEditor(null);
    } else if (meta && /^[1-5]$/.test(e.key)) {
      e.preventDefault();
      const m = MODES[Number(e.key) - 1];
      if (m) { state.mode = m.key; renderModePills(); runSearch(); }
    }
  });

  // OAuth 回填：授权页把 token 写进 localStorage，这里读回来
  window.addEventListener('storage', (e) => {
    if (e.key === 'aiph-oauth') maybeApplyOAuth();
  });
  maybeApplyOAuth();

  // 桌面端原生菜单
  if (globalThis.__aiph?.onMenu) {
    globalThis.__aiph.onMenu((action) => {
      if (action === 'new') openEditor(null);
      else if (action === 'import') $('#file-import').click();
      else if (action === 'export') {
        downloadJSON(store.snapshot(), `ai-prompt-hub-${new Date().toISOString().slice(0, 10)}.json`);
        toast('已导出全部指令', 'success');
      }
    });
  }

  // PWA
  if ('serviceWorker' in navigator && location.protocol.startsWith('http')) {
    navigator.serviceWorker.register('sw.js').catch(() => {});
  }
}

function closeSidebar() {
  $('#sidebar').classList.remove('open');
  $('#sidebar-backdrop').classList.remove('in');
}

async function maybeApplyOAuth() {
  try {
    const raw = localStorage.getItem('aiph-oauth');
    if (!raw) return;
    const data = JSON.parse(raw);
    if (!data.access_token) return;
    localStorage.removeItem('aiph-oauth');
    await syncMgr.saveProviderConfig('baidupan', {
      accessToken: data.access_token,
      refreshToken: data.refresh_token || '',
      expiresAt: Date.now() + (Number(data.expires_in) || 2592000) * 1000,
    });
    toast('百度网盘授权成功，Token 已保存', 'success', 4200);
  } catch (_) {
    /* 忽略 */
  }
}

/* ================================================================== 引导 */

boot().catch((e) => {
  console.error(e);
  document.body.innerHTML =
    `<div style="padding:40px;font-family:system-ui">
       <h2>启动失败</h2>
       <p style="color:#666">${escapeHtml(e.message)}</p>
       <p style="color:#999;font-size:13px">请确认通过 http(s) 环境访问（不要用 file:// 直接打开），例如运行 <code>npm run serve</code>。</p>
     </div>`;
});
