---
title: "全家福综合测试文章 | Markdown | 渲染基准"
published: 2026-11-05
description: "覆盖嵌套列表、代码块、对齐表格、连续多图、参考式图片、外链转脚注、嵌套引用、视频嵌入与数学公式的黄金快照测试文章。"
image: "./cover.png"
tags: [Test, Benchmark]
draft: false
---

# 第一章：排版与行内语法

这是一段包含**粗体强调**、*斜体文字*、~~删除线~~、==重点高亮==以及行内代码 `$HF_ENDPOINT` 与 `$HOME_DIR` 的正文段落。

支持多种链接写法：[博客首页](https://blog.srprolin.com/)、[无协议头外链](decapcms.org/docs/intro/)、[站内相对链接](../45-immortalwrt-1/)、[页内锚点跳转](#第二章列表与引用)，以及保留可点击的[微信公众号内链](https://mp.weixin.qq.com/s/wechat_internal_article)。

# 第二章：列表与引用

## 多层嵌套列表

- 一级无序列表项 A
  - 二级无序列表项 A1
    - 三级无序列表项 A1a
    - 三级无序列表项 A1b
  - 二级有序列表嵌套：
    1. 第一步：执行环境检查
    2. 第二步：拉取仓库源码
- 一级无序列表项 B

## 任务列表

- [x] 已完成：初始化 TypeScript 工作区
- [ ] 待处理：验证 VPS 定时同步任务

## 嵌套引用块

> 外层引用：如无必要，勿增实体。
>
> > 内层嵌套引用：保持结构清晰与内联样式稳定。

# 第三章：表格与代码块

| 服务组件 | 监听协议 | 默认端口 |
| :--- | :---: | ---: |
| Nginx | HTTP | 80 |
| Caddy | HTTPS | 443 |
| WireGuard | UDP | 51820 |

```pwsh
# PowerShell 别名高亮验证
Get-Process | Where-Object { $_.CPU -gt 10 }
```

```cfg
[tunnel]
protocol = http2
port = 7890
```

```markdown
# 代码块内部的 HTML 不应被预处理器改写
<img style="width: 300px" src="https://obsidian.md/apple-touch-icon.png">
```

# 第四章：图片、视频与数学公式

![1](./generic-alt.png)

一段文字隔开独立图片，验证有意义图注保留、无意义图注清空：

![OpenWrt 固件编译流程与软件包架构示意图](./arch-diagram.png)

连续多张图片验证单列纵向堆叠（`stack` 模式）：

![連続截图一](./stack-1.png)

![連続截图二](./stack-2.png)

参考式图片与 HTML 图片转换：

![screen_ref][ref-id]

[ref-id]: ./ref-image.webp

<img width="480" alt="HTML 标签图片转换示例" src="./html-img.png">

跨行 Bilibili 视频嵌入卡片：

<iframe
  src="//player.bilibili.com/player.html?isOutside=true&bvid=BV136a9zqEk5"
  scrolling="no"
  border="0"
  frameborder="no"
  allowfullscreen="true">
</iframe>

行内数学公式 $x_1 + x_2 = y_1$ 与块级数学公式：

$$
f(x_1, x_2) = \sum_{i=1}^{n} w_i \cdot x_i + b_0
$$
