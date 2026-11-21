/**
 * dsh-chat-search — browser half.
 *
 * 侧边栏挂一个「旧话篓子」入口，主区里用 iframe 装宿主半已经起好的
 * /chat-search 页面。页面本身是纯静态 HTML，和宿主同源，所以不需要
 * 再走一遍 React 渲染，省得两边各写一套搜索逻辑。
 */

window.__ModuleLoader__.load({
  id: 'dsh-chat-search',
  factory: (require) => {
    const React = require('react')
    const h = React.createElement

    const PANEL_ID = 'chat-search'
    const PAGE_PATH = '/chat-search'

    function BeanIcon() {
      return h('img', {
        src: '/chat-search/assets/dsniang1.png',
        alt: '旧话篓子',
        width: 20,
        height: 20,
        style: { borderRadius: 6, objectFit: 'cover', display: 'block' },
      })
    }

    function BeanPanel() {
      return h('div', {
        style: { width: '100%', height: '100%', minHeight: 0, overflow: 'hidden' },
      }, h('iframe', {
        src: PAGE_PATH,
        title: '旧话篓子',
        style: { width: '100%', height: '100%', border: 0, display: 'block', background: '#0e1520' },
      }))
    }

    function apply(ctx) {
      ctx.slots.inject('sidebar.panellist', () => ctx.slots.register({
        name: 'sidebar.panellist',
        id: PANEL_ID,
        order: 17,
        label: () => '旧话篓子',
      }, BeanIcon))
      ctx.slots.inject('main', () => ctx.slots.register({
        name: 'main',
        key: PANEL_ID,
      }, BeanPanel))
    }

    return { inject: ['slots'], apply }
  },
})
