# Redesign

这里是 insπre 的 redesign 参考材料。只保留一条 Trace 方向、Renault 参考和一份历史草图。

```text
docs/redesign/
├── README.md
├── trace.md       # 方向 prompt
├── renault.md     # Renault 设计分析原文
└── prototype/     # Trace 静态草图
    ├── index.html
    ├── styles.css
    ├── app.js
    └── screenshots/
```

## 材料

- [Trace 方向](trace.md)：当前的高层设计 prompt；它不是具体实现规范。
- [Renault 参考](renault.md)：从 [getdesign.md](https://getdesign.md/renault/design-md) 保存的未修改设计分析原文；它是参考，不是 insπre 的规格。
- [Trace 草图](prototype/index.html)：可直接在浏览器打开的静态 HTML 草图。`prototype/screenshots/` 保存浅色、深色、搜索、设置和移动端截图。

## 使用方式

草图只用于观察和提取想法，不是目标屏幕。未来设计必须从真实产品和当前反馈重新推导，而不是复制任何一个参考。

## 已知反馈

- composer 必须保持为一个完整输入区域；模型、思考、附件、上下文和发送控件应属于这个区域。
- workspace explorer 必须保留真实功能和足够的展开空间。
- 不能为了技术感而堆叠分割线、规则或顶栏按钮。
- 背景网格属于工作台底材，不得出现在长文、代码、数学和其他持续阅读内容之后。
- 草图仍有大量空白和其他未解决问题，不能被当作当前界面或后续实施的模板。
