import { defineConfig } from 'vitepress'

export default defineConfig({
  lang: 'zh-CN',
  base: '/blog/',
  title: 'links 的技术博客',
  description: 'MES 开发者的技术学习笔记：系统设计 / LangChain / LangGraph / Agent 工程 / 并发与异步',
  cleanUrls: true,
  lastUpdated: true,

  themeConfig: {
    nav: [
      { text: '首页', link: '/' },
      { text: '文章', link: '/posts/nginx-production-lb-deep-dive' },
    ],

    sidebar: [
      {
        text: '系统设计学习',
        items: [
          { text: '分布式锁拆解：从一行 tryLock 到 Redisson 的三段 Lua（含交互动画）', link: '/posts/system-design/redis-distributed-lock-deep-dive' },
        ],
      },
      {
        text: '学习笔记',
        items: [
          { text: 'Nginx 实勘、负载均衡与调优实战（含交互动画）', link: '/posts/nginx-production-lb-deep-dive' },
          { text: '同步/异步/并发/并行 + 进程/线程/协程', link: '/posts/sync-async-concurrency-parallel' },
        ],
      },
    ],

    socialLinks: [
      { icon: 'github', link: 'https://github.com/HXx6' },
    ],

    search: {
      provider: 'local',
      options: {
        translations: {
          button: { buttonText: '搜索文章', buttonAriaLabel: '搜索文章' },
          modal: {
            noResultsText: '没有找到相关结果',
            resetButtonTitle: '清除查询',
            footer: { selectText: '选择', navigateText: '切换', closeText: '关闭' },
          },
        },
      },
    },

    outline: { level: [2, 3], label: '本页目录' },
    docFooter: { prev: '上一篇', next: '下一篇' },
    lastUpdatedText: '最后更新',
    returnToTopLabel: '回到顶部',
    darkModeSwitchLabel: '深色模式',
  },
})
