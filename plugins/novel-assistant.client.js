// 小说阅览窗口（novel-reader）— 动态 Cordis 插件 Client 半部源码
// -----------------------------------------------------------------------------
// 安装方式：把本文件内容作为 code.client、novel-reader.host.js 作为 code.host，
// 通过 cordis_define(kind: new, idPrefix: nrdr) + cordis_run 安装（Client 需要浏览器授权）。
//
// UI 组成：
//   1) 浮动阅览窗口（shell.overlay，id: novel-reader-window）：
//      - 左侧：工作区文本文件/文件夹列表（可进子目录、面包屑、每 3 秒自动刷新）
//      - 右侧：编辑区（等宽中文阅读字体、自动换行无横向滚动）
//      - 工具栏：保存 / 复制 / 重载
//      - 标题栏可拖动移动；右边缘可拖拽拉伸宽度；可收起
//   2) 会话头部右上角开关按钮（conversation.session.header.utilities，id: novel-reader-toggle）
//
// 根目录来自当前会话工作区（useSessions.byId[current].cwd），随 RPC 传给 Host。
return {
  apply(ctx) {
    const slots = ctx.get('slots');
    if (slots === undefined) return;

    // 共享开关状态：窗口与开关按钮跨组件同步
    const store = { open: true, listeners: [] };
    function setOpen(v) {
      store.open = !!v;
      for (const l of store.listeners) l();
    }
    function useOpen() {
      const [v, setV] = React.useState(store.open);
      React.useEffect(() => {
        store.listeners.push(setV);
        return () => {
          const i = store.listeners.indexOf(setV);
          if (i >= 0) store.listeners.splice(i, 1);
        };
      }, []);
      return v;
    }

    styles.insert(`.nr-window{position:fixed;min-width:360px;max-width:calc(100vw - 32px);height:min(72vh,660px);min-height:320px;display:flex;flex-direction:column;background:var(--dsh-bg-2,#1e1f24);color:var(--dsh-fg-1,#e8e8ec);border:1px solid var(--dsh-border,#3a3b42);border-radius:10px;box-shadow:0 12px 44px rgba(0,0,0,.5);overflow:hidden;z-index:1200;pointer-events:auto;font-size:13px;font-family:inherit}\n.nr-resize{position:absolute;top:0;right:0;width:10px;height:100%;cursor:ew-resize;z-index:6}\n.nr-resize:hover{background:rgba(255,255,255,.08)}\n.nr-header{display:flex;align-items:center;gap:8px;padding:8px 10px;background:var(--dsh-bg-3,#26272d);border-bottom:1px solid var(--dsh-border,#3a3b42);cursor:move;user-select:none;flex-wrap:wrap}\n.nr-title{font-weight:600;white-space:nowrap}\n.nr-crumbs{display:flex;align-items:center;gap:2px;min-width:0;overflow:hidden;flex:1;flex-wrap:wrap}\n.nr-crumb{background:none;border:none;color:var(--dsh-fg-2,#b8b9c0);cursor:pointer;padding:2px 4px;border-radius:4px;font-size:12px}\n.nr-crumb:hover{background:rgba(255,255,255,.08);color:var(--dsh-fg-1,#e8e8ec)}\n.nr-sep{color:var(--dsh-fg-3,#76777f)}\n.nr-btn{background:var(--dsh-bg-3,#2c2d34);color:var(--dsh-fg-1,#e8e8ec);border:1px solid var(--dsh-border,#44454d);border-radius:6px;padding:4px 10px;cursor:pointer;white-space:nowrap;font-size:12px}\n.nr-btn:hover{background:rgba(255,255,255,.1)}\n.nr-primary{background:#2f6feb;border-color:#2f6feb;color:#fff}\n.nr-primary:hover{background:#3b7bf5}\n.nr-body{display:flex;flex:1;min-height:0}\n.nr-list{width:210px;min-width:140px;overflow-y:auto;overflow-x:hidden;border-right:1px solid var(--dsh-border,#3a3b42);padding:4px}\n.nr-row{display:flex;align-items:center;justify-content:space-between;gap:6px;padding:5px 8px;border-radius:6px;cursor:pointer}\n.nr-row:hover{background:rgba(255,255,255,.06)}\n.nr-dir{color:var(--dsh-fg-2,#c8c9d0)}\n.nr-active{background:rgba(47,111,235,.25)}\n.nr-rowname{overflow:hidden;text-overflow:ellipsis;white-space:nowrap}\n.nr-size{color:var(--dsh-fg-3,#76777f);font-size:11px;flex:none}\n.nr-editor{flex:1;display:flex;flex-direction:column;min-width:0}\n.nr-editor-inner{display:flex;flex-direction:column;flex:1;min-height:0}\n.nr-toolbar{display:flex;align-items:center;gap:6px;padding:6px 8px;border-bottom:1px solid var(--dsh-border,#3a3b42);flex-wrap:wrap}\n.nr-fname{font-weight:600;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;flex:1}\n.nr-fmeta{color:var(--dsh-fg-3,#76777f);font-weight:400;font-size:11px}\n.nr-textarea{flex:1;min-height:0;min-width:0;max-width:100%;resize:none;background:transparent;color:inherit;border:none;outline:none;padding:10px 14px;font-family:'PingFang SC','Hiragino Sans GB','Microsoft YaHei','Noto Sans CJK SC','Source Han Sans SC',system-ui,-apple-system,'Segoe UI',sans-serif;font-size:14.5px;line-height:1.9;letter-spacing:.02em;white-space:pre-wrap;overflow-wrap:break-word;word-break:break-word;overflow-x:hidden}\n.nr-hint{color:var(--dsh-fg-3,#76777f);padding:16px;text-align:center}\n.nr-error{color:#ff6b6b;padding:6px 10px;border-top:1px solid var(--dsh-border,#3a3b42);font-size:12px;max-height:80px;overflow:auto}\n.nr-status{color:#6bcb77;padding:4px 10px;font-size:12px}\n.nr-toggle{background:none;border:1px solid var(--dsh-border,#44454d);color:var(--dsh-fg-2,#c8c9d0);border-radius:6px;padding:4px 8px;cursor:pointer;font-size:12px;white-space:nowrap}\n.nr-toggle:hover{background:rgba(255,255,255,.08)}\n.nr-toggle-on{color:#2f6feb;border-color:#2f6feb}`);

    function fmtSize(n) {
      if (!n) return '';
      if (n < 1024) return n + ' B';
      if (n < 1024 * 1024) return (n / 1024).toFixed(1) + ' KB';
      return (n / (1024 * 1024)).toFixed(1) + ' MB';
    }

    function errText(err) {
      return err && err.message ? err.message : String(err);
    }

    function baseName(p) {
      if (!p) return '';
      const parts = String(p).split(/[\\/]/).filter(Boolean);
      return parts.length ? parts[parts.length - 1] : String(p);
    }

    // 复制到剪贴板：优先 Clipboard API，回退 execCommand
    async function copyText(text) {
      try {
        if (typeof navigator !== 'undefined' && navigator.clipboard && typeof navigator.clipboard.writeText === 'function') {
          await navigator.clipboard.writeText(text);
          return true;
        }
      } catch (e) { /* 继续尝试回退 */ }
      try {
        if (typeof document !== 'undefined' && document.execCommand) {
          const ta = document.createElement('textarea');
          ta.value = text;
          ta.style.position = 'fixed';
          ta.style.opacity = '0';
          document.body.appendChild(ta);
          ta.focus();
          ta.select();
          const ok = document.execCommand('copy');
          document.body.removeChild(ta);
          return ok;
        }
      } catch (e) { /* 忽略 */ }
      return false;
    }

    function ReaderWindow(props) {
      const open = useOpen();
      const useSessions = props && props.useSessions;
      const useWorkspaces = props && props.useWorkspaces;

      // 当前会话的 id 与其工作目录（会话 cwd 即工作区）；选择器返回标量，保持引用稳定
      const sessionId = useSessions ? useSessions((s) => (s ? s.current : undefined)) : undefined;
      const sessionCwd = useSessions ? useSessions((s) => {
        const c = s ? s.current : undefined;
        const sum = c && s.byId ? s.byId[c] : undefined;
        return sum && typeof sum.cwd === 'string' && sum.cwd ? sum.cwd : undefined;
      }) : undefined;
      const wsState = useWorkspaces ? useWorkspaces((s) => s) : undefined;

      // 根目录：当前会话工作区 > 最近/首个工作区 > Host 兜底
      let root = sessionCwd;
      if (!root && wsState && wsState.items && wsState.items.length) {
        const recent = wsState.recentWorkspaceId ? wsState.items.find((w) => w.workspaceId === wsState.recentWorkspaceId) : undefined;
        root = (recent || wsState.items[0]).path;
      }

      const [dir, setDir] = React.useState('');
      const [rows, setRows] = React.useState([]);
      const [selected, setSelected] = React.useState(null);
      const [draft, setDraft] = React.useState('');
      const [busy, setBusy] = React.useState(false);
      const [error, setError] = React.useState('');
      const [status, setStatus] = React.useState('');
      const [pos, setPos] = React.useState(null);
      const [w, setW] = React.useState(640);

      // 工作区切换时重置导航
      const [lastRoot, setLastRoot] = React.useState(root);
      React.useEffect(() => {
        if (root !== lastRoot) {
          setLastRoot(root);
          setDir('');
          setSelected(null);
          setDraft('');
          setStatus('');
        }
      }, [root, lastRoot]);

      // 初始加载 + 目录切换时加载
      React.useEffect(() => {
        if (!open) return;
        let dead = false;
        setBusy(true);
        setError('');
        host.call('nreader:list', { dir, root, sessionId }).then((res) => {
          if (dead) return;
          setRows(Array.isArray(res && res.rows) ? res.rows : []);
          setBusy(false);
        }).catch((err) => {
          if (!dead) { setError(errText(err)); setBusy(false); }
        });
        return () => { dead = true; };
      }, [open, dir, root, sessionId]);

      // 窗口打开时定时刷新文件列表（不触碰正在编辑的内容）
      const timer = ctx.get('timer');
      React.useEffect(() => {
        if (!open || timer === undefined) return;
        return timer.interval(() => {
          host.call('nreader:list', { dir, root, sessionId }).then((res) => {
            setRows(Array.isArray(res && res.rows) ? res.rows : []);
          }).catch(() => {});
        }, 3000);
      }, [open, dir, timer, root, sessionId]);

      function openEntry(row) {
        if (row.type === 'directory') { setDir(row.path); return; }
        setBusy(true); setError(''); setStatus('');
        host.call('nreader:read', { path: row.path, root, sessionId }).then((res) => {
          setSelected({ path: res.path, name: res.name, size: res.size });
          setDraft(res.content);
          setBusy(false);
        }).catch((err) => { setError(errText(err)); setBusy(false); });
      }

      function reloadSelected() {
        if (!selected) return;
        openEntry({ type: 'file', path: selected.path });
      }

      function save() {
        if (!selected) return;
        setStatus('保存中…'); setError('');
        host.call('nreader:write', { path: selected.path, content: draft, root, sessionId }).then(() => {
          setStatus('已保存 ✓');
          return host.call('nreader:list', { dir, root, sessionId });
        }).then((res) => {
          setRows(Array.isArray(res && res.rows) ? res.rows : []);
        }).catch((err) => { setError(errText(err)); setStatus(''); });
      }

      async function copyDraft() {
        const ok = await copyText(draft);
        setStatus(ok ? '已复制到剪贴板 ✓' : '复制失败：浏览器未授予剪贴板权限');
      }

      function onHeaderDown(e) {
        if (typeof document === 'undefined') return;
        const startX = e.clientX;
        const startY = e.clientY;
        const baseX = pos && typeof pos.x === 'number' ? pos.x : null;
        const baseY = pos && typeof pos.y === 'number' ? pos.y : null;
        function onMove(ev) {
          let nx;
          let ny;
          if (baseX !== null && baseY !== null) {
            nx = baseX + (ev.clientX - startX);
            ny = baseY + (ev.clientY - startY);
          } else {
            nx = ev.clientX;
            ny = ev.clientY;
          }
          setPos({ x: Math.max(0, nx), y: Math.max(0, ny) });
        }
        function onUp() {
          document.removeEventListener('mousemove', onMove);
          document.removeEventListener('mouseup', onUp);
        }
        document.addEventListener('mousemove', onMove);
        document.addEventListener('mouseup', onUp);
        e.preventDefault();
      }

      // 拖拽右边缘调整窗口宽度
      function onResizeDown(e) {
        if (typeof document === 'undefined') return;
        const startX = e.clientX;
        const startW = w;
        const maxW = (typeof window !== 'undefined' ? window.innerWidth : 1400) - 32;
        function onMove(ev) {
          setW(Math.max(360, Math.min(startW + (ev.clientX - startX), maxW)));
        }
        function onUp() {
          document.removeEventListener('mousemove', onMove);
          document.removeEventListener('mouseup', onUp);
        }
        document.addEventListener('mousemove', onMove);
        document.addEventListener('mouseup', onUp);
        e.preventDefault();
        e.stopPropagation();
      }

      if (!open) return React.createElement('div', null);

      const segs = dir ? dir.split('/') : [];
      const rootLabel = root ? baseName(root) : '工作目录';
      const crumbs = [React.createElement('button', { key: 'root', className: 'nr-crumb', title: root || '工作目录', onClick: () => setDir('') }, rootLabel)];
      let acc = '';
      for (let i = 0; i < segs.length; i++) {
        acc = acc ? acc + '/' + segs[i] : segs[i];
        const p = acc;
        crumbs.push(React.createElement('span', { key: 's' + i, className: 'nr-sep' }, '/'));
        crumbs.push(React.createElement('button', { key: 'c' + i, className: 'nr-crumb', onClick: () => setDir(p) }, segs[i]));
      }

      const style = { width: w, ...(pos ? { left: pos.x, top: pos.y } : { right: 16, top: 16 }) };

      const listEls = [];
      if (busy && rows.length === 0) listEls.push(React.createElement('div', { key: 'h', className: 'nr-hint' }, '加载中…'));
      if (!busy && rows.length === 0) listEls.push(React.createElement('div', { key: 'e', className: 'nr-hint' }, '（此目录没有文本文件）'));
      for (const row of rows) {
        listEls.push(React.createElement('div', {
          key: row.path,
          className: 'nr-row' + (row.type === 'directory' ? ' nr-dir' : '') + (selected && selected.path === row.path ? ' nr-active' : ''),
          onClick: () => openEntry(row),
          title: row.type === 'directory' ? '进入文件夹' : '打开文件',
        },
          React.createElement('span', { className: 'nr-rowname' }, row.type === 'directory' ? '📁 ' : '📄 ', row.name),
          row.type === 'file' ? React.createElement('span', { className: 'nr-size' }, fmtSize(row.size)) : null,
        ));
      }

      return React.createElement('div', { className: 'nr-window', style },
        React.createElement('div', { className: 'nr-header', onMouseDown: onHeaderDown, title: '拖动标题栏可移动窗口' },
          React.createElement('span', { className: 'nr-title' }, '📖 小说阅览窗口'),
          React.createElement('div', { className: 'nr-crumbs' }, crumbs),
          React.createElement('button', { className: 'nr-btn', onClick: () => { setError(''); setBusy(true); host.call('nreader:list', { dir, root, sessionId }).then((res) => { setRows(Array.isArray(res && res.rows) ? res.rows : []); setBusy(false); }).catch((err) => { setError(errText(err)); setBusy(false); }); } }, '↻ 刷新'),
          React.createElement('button', { className: 'nr-btn', onClick: () => setOpen(false) }, '收起'),
        ),
        React.createElement('div', { className: 'nr-body' },
          React.createElement('div', { className: 'nr-list' }, listEls),
          React.createElement('div', { className: 'nr-editor' },
            !selected
              ? React.createElement('div', { className: 'nr-hint' }, '← 选择左侧文件查看与编辑')
              : React.createElement('div', { className: 'nr-editor-inner' },
                  React.createElement('div', { className: 'nr-toolbar' },
                    React.createElement('span', { className: 'nr-fname' }, selected.name, ' ', React.createElement('span', { className: 'nr-fmeta' }, fmtSize(selected.size))),
                    React.createElement('button', { className: 'nr-btn nr-primary', onClick: save }, '💾 保存'),
                    React.createElement('button', { className: 'nr-btn', onClick: copyDraft }, '📋 复制'),
                    React.createElement('button', { className: 'nr-btn', onClick: reloadSelected }, '⟳ 重载'),
                  ),
                  React.createElement('textarea', {
                    className: 'nr-textarea',
                    value: draft,
                    spellCheck: false,
                    wrap: 'soft',
                    onChange: (e) => setDraft(e.target.value),
                  }),
                ),
            error ? React.createElement('div', { className: 'nr-error' }, error) : null,
            status ? React.createElement('div', { className: 'nr-status' }, status) : null,
          ),
        ),
        React.createElement('div', { className: 'nr-resize', title: '拖动调整宽度', onMouseDown: onResizeDown }),
      );
    }

    function ToggleButton() {
      const open = useOpen();
      return React.createElement('button', {
        className: 'nr-toggle' + (open ? ' nr-toggle-on' : ''),
        title: open ? '收起小说阅览窗口' : '打开小说阅览窗口（查看/编辑工作目录文本文件）',
        onClick: () => setOpen(!open),
      }, '📖 阅览');
    }

    // 浮动阅览窗口（框架级覆盖层，可拖动、可拉伸宽度、可收起）
    slots.inject('shell.overlay', () => slots.register(
      { name: 'shell.overlay', id: 'novel-reader-window', order: 100, label: '小说阅览窗口' },
      (props) => React.createElement(ReaderWindow, props),
    ));

    // 会话头部右上角的开关按钮（唯一的入口）
    slots.inject('conversation.session.header.utilities', () => slots.register(
      { name: 'conversation.session.header.utilities', id: 'novel-reader-toggle', order: 100, label: '小说阅览窗口' },
      () => React.createElement(ToggleButton, null),
    ));
  },
};
