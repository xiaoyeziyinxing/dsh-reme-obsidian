/**
 * dsh-reme-obsidian — 浏览器半（客户端插件）
 *
 * 「设置」弹窗左侧导航底部新增「导入知识库」页（settings.section，order 610）：
 *   点击按钮 → Connection RPC 调用宿主半的导入逻辑：
 *     rpc.call("/api", "reme-obsidian/import", { dryRun }, signal)
 * v0.2.0：入口由聊天输入框（conversation.input.left）迁到设置页。
 *
 * 免构建：与 dsh-skill-market 同范式 —— 用 window.__ModuleLoader__.load 包装、
 * 由 require("react") 取 React 实例，不经过任何打包步骤。
 */

window.__ModuleLoader__.load({
  id: "dsh-reme-obsidian",
  factory: (require) => {
    var module = { exports: {} };
    var exports = module.exports;
    Object.defineProperty(exports, Symbol.toStringTag, { value: "Module" });

    var React = require("react");
    var h = React.createElement;
    var useState = React.useState;
    var useEffect = React.useEffect;

    // ── 常量 ──────────────────────────────────────────────────────────

    /** 设置弹窗的「一页设置」槽位：DSH shell 声明，注册即出现在左侧导航 */
    var SLOT = "settings.section";
    var ENDPOINT = "reme-obsidian/import";

    // ── 样式（只注入一次）：灰阶描边/底色随设置弹窗明暗主题，按钮用主色蓝 ──

    var CSS = `
.dsh-reme-import-card {
  display: flex; flex-direction: column; gap: 10px;
  padding: 14px 16px;
  border: 1px solid rgba(128,128,128,0.22);
  border-radius: 10px;
  background: rgba(128,128,128,0.06);
}
.dsh-reme-import-title { display: flex; align-items: center; gap: 6px; font-size: 13px; font-weight: 600; }
.dsh-reme-import-desc { font-size: 12px; line-height: 1.65; opacity: .72; }
.dsh-reme-import-row { display: flex; align-items: center; gap: 10px; flex-wrap: wrap; }
.dsh-reme-import-btn {
  display: inline-flex; align-items: center; gap: 6px;
  height: 30px; padding: 0 14px;
  border: none; border-radius: 8px;
  background: #0A84FF; color: #fff;
  font: inherit; font-size: 12px; line-height: 1; white-space: nowrap;
  cursor: pointer; user-select: none;
  transition: background .15s, opacity .15s;
}
.dsh-reme-import-btn:hover { background: #0a76e6; }
.dsh-reme-import-btn:disabled { opacity: .55; cursor: default; }
.dsh-reme-import-btn.is-ok { background: #3fb950; }
.dsh-reme-import-btn.is-error { background: #f85149; }
.dsh-reme-import-note { font-size: 12px; opacity: .72; }
.dsh-reme-import-note.is-error { color: #f85149; opacity: 1; }
`;

    var cssInjected = false;
    function injectCSS() {
      if (cssInjected) return;
      cssInjected = true;
      var style = document.createElement("style");
      style.id = "dsh-reme-obsidian-css";
      style.textContent = CSS;
      document.head.appendChild(style);
    }

    // ── 设置页内容：导入知识库（当前唯一入口，原输入框按钮已迁走） ──────────

    function ImportSection(props) {
      var rpc = props.rpc;
      var pair = useState({ phase: "idle", text: "", detail: "" });
      var status = pair[0];
      var setStatus = pair[1];

      // 成功/失败提示显示 4 秒后自动回到常态
      useEffect(function () {
        if (status.phase !== "ok" && status.phase !== "error") return;
        var timer = setTimeout(function () {
          setStatus({ phase: "idle", text: "", detail: "" });
        }, 4000);
        return function () { clearTimeout(timer); };
      }, [status]);

      var onClick = function () {
        if (status.phase === "busy") return;
        setStatus({ phase: "busy", text: "", detail: "" });
        var controller = new AbortController();
        rpc
          .call("/api", ENDPOINT, { dryRun: false }, controller.signal)
          .then(function (result) {
            if (!result || !result.ok) {
              throw new Error(result && result.error ? result.error.message : "RPC 调用失败");
            }
            setStatus({ phase: "ok", text: String(result.value || ""), detail: "" });
          })
          .catch(function (error) {
            setStatus({
              phase: "error",
              text: "",
              detail: error && error.message ? error.message : String(error),
            });
          });
      };

      var label =
        status.phase === "busy" ? "导入中…"
        : status.phase === "ok" ? "✓ " + (status.text || "完成")
        : status.phase === "error" ? "✗ 导入失败"
        : "开始导入";

      var className =
        "dsh-reme-import-btn" +
        (status.phase === "ok" ? " is-ok" : "") +
        (status.phase === "error" ? " is-error" : "");

      return h(
        "div",
        { className: "dsh-reme-import-card" },
        h(
          "div",
          { className: "dsh-reme-import-title" },
          h("span", { "aria-hidden": true }, "📥"),
          h("span", null, "导入知识库"),
        ),
        h(
          "div",
          { className: "dsh-reme-import-desc" },
          "把 ReMe 知识库（digest）导入 Obsidian 库的 ReMe/ 文件夹，方便在 Obsidian 里直接检索与双链。",
        ),
        h(
          "div",
          { className: "dsh-reme-import-row" },
          h(
            "button",
            {
              type: "button",
              className: className,
              disabled: status.phase === "busy",
              title: "把 ReMe 知识库（digest）导入 Obsidian 库的 ReMe/ 文件夹",
              onClick: onClick,
            },
            label,
          ),
          status.phase === "error" && status.detail
            ? h("span", { className: "dsh-reme-import-note is-error" }, status.detail)
            : null,
        ),
      );
    }

    // ── 插件入口 ───────────────────────────────────────────────────────

    var inject = ["slots", "connection"];

    function apply(ctx) {
      injectCSS();
      var rpc = ctx.get("connection").rpc;

      ctx.effect(function () {
        return ctx.slots.inject(SLOT, function () {
          return ctx.slots.register(
            {
              name: SLOT,
              id: "reme-obsidian",
              order: 610,
              label: function () { return "导入知识库"; },
              inject: function () { return { rpc: rpc }; },
            },
            ImportSection,
          );
        });
      }, "dsh-reme-obsidian: 设置页导入入口");
    }

    exports.apply = apply;
    exports.inject = inject;
    return module.exports;
  },
});
