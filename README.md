# dsh-chat-search

翻 DSH 会话里的旧话。索引 `~/.dsh/sessions` 下的 `session.v4.jsonl.zstd`，按词、按事搜你和鱼鱼聊过的内容。

## 为什么单独写

- `.dsh/sessions` 里的会话是 **一帧一段边聊边追加** 的 zstd，Node 的 `zstdDecompressSync` 只解第一帧（几十个字），直接解出来等于空。这里按帧头魔数 `28 B5 2F FD` 切开、逐帧解再拼回。
- 只读 `user/message` 和 `assistant/message` 的 text 块，工具调用和系统提示词不进索引，省内存也不吵。
- 解析结果按文件 mtime/size 缓存在内存，会话变长了下次查询自动重解那一个文件。

## 跑法

当 DSH 插件：

```
id: chat-search
name: dsh-chat-search
```

挂上后打开 `http://127.0.0.1:<GUI 端口>/chat-search`，接口是 `GET /api/chatsearch?q=关键词`（空格分词，全部命中才算）。

单独跑（不重启 DSH 也能用）：

```powershell
node lib/index.js --standalone
# 默认 http://127.0.0.1:50780/
```

环境变量：

- `DSH_SESSIONS_DIR` 换会话目录
- `CHAT_SEARCH_PORT` 换单独跑的端口

## 接口

- `GET /api/chatsearch?q=&limit=` — 返回命中条数、每条的角色/时间/摘要/前后两句
- `GET /api/chatsearch/stats` — 索引到几个会话、多少条消息

## 门面

界面上的小黄豆是照《Dumb Ways to Die》那种丑萌路数画的（黄身子、大眼、细胳膊），纯 SVG，没有外部素材，输入的时候眼珠会跟着鼠标动，搜到东西会咧嘴。

## 已知的坑

- 会话文件正在被 DSH 追加，读的时候可能少最后半帧，下次查询会补上。
- 解压是「撞上魔数就切一刀」，压缩数据里恰好出现魔数会切歪，那一刀跳过、由下一刀兜住；实测 4 个会话 4072 帧 0 失败。
- 只索引 DSH 的会话，QQ 那边（AstrBot）不在范围内。
