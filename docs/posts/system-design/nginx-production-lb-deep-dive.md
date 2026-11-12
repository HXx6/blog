---
title: 一次把生产环境 Nginx 摸个底朝天：实勘、负载均衡与调优实战
date: 2026-11-11
tags: [Nginx, 负载均衡, 前后端分离, 部署, 运维]
description: 不看文档不看教程，直接上生产服务器实勘：DNS→响应指纹→线上 JS 反查→nginx.conf 原文，再从 upstream 四策略讲到 Session 共享三方案、压缩/缓存/限流/SSL 四件套。含 10 帧可交互动画。
---

# 一次把生产环境 Nginx 摸个底朝天：实勘、负载均衡与调优实战

> 起因：看完一个 Nginx 负载均衡视频后冒出一个朴素的问题——"浏览器访问我们 MES 系统的时候，页面是怎么回来的？接口又是发给谁的？"于是我把自己维护的生产环境当教材，从外部一路探测到 nginx.conf 原文，全程只读。这篇是总账。（文中域名/IP 已脱敏，但每一字节的证据都是真的。）

## 先看动画：浏览器访问一个 MES 站点的全程

10 帧报文飞行动画，右下角黑框是每一步对应的真实抓包证据。**键盘 ← → 逐帧，空格自动播放**，最后有个"后端搬家"按钮实验，建议亲手点一遍：

<iframe src="/blog/animations/mes-nginx-lifecycle.html" width="100%" height="1230" style="border:none;border-radius:8px;" loading="lazy" title="浏览器访问 MES 站点全程动画"></iframe>

## 一、实勘是怎么做的（方法比结论值钱）

1. **DNS**：`nslookup mes.example.com` → `10.0.0.11`，解析方是公司域控 DNS，ping 1ms
2. **响应头指纹**：`curl -I http://mes.example.com/` → `Server: nginx/1.16.1`，`Content-Length: 1428`，`Last-Modified` + `ETag` + `Accept-Ranges`——这是"nginx 从磁盘吐静态文件"的标准指纹，动态渲染给不出这套
3. **1428 字节的首页壳**：全文就一个空 `<div id=app>` 加 `<script src=/js/app.c1e58aa0.js>`，所有资源路径**根相对、无域名无端口**——教科书级 Vue CLI 打包产物
4. **下载线上 JS 反查**：包里赫然写着 `window.VUE_APP_URL = "/api/"`——`.env.production` 在**打包那天**被编译进了产物
5. **三路指纹锁定后端真身**：`/api/`（走 nginx）、`:8080/`（直连）、`:8080/api/`（直连带前缀）返回**同一个 53 字节 JSON**——后端就是本机 8080 的 Java
6. **nginx.conf 原文**定案最后悬案

踩过的坑也值一条：办公机挂着本地代理，第一次 curl 拿到的是代理回的假 403——**探测内网服务先 `curl --noproxy '*'`**。

## 二、nginx.conf 定案的四个认知

1. **`proxy_pass http://10.0.0.11:8080/;` 结尾的斜杠会剥前缀**：浏览器发 `/api/mes/order/listPage`，Java 收到的是 `/mes/order/listPage`。这就是"三路指纹一致"的原因——后端路由压根没有 `/api` 前缀。去掉这个斜杠 = 全系统接口 404，一个字符引发血案
2. **一个 nginx 托管了三套前端**：`/` 是门户入口应用（那个 1428B 的壳）、`/mes` 是主 MES 前端（二级目录，对上 `vue.config.js` 的 `publicPath="/mes/"`）、`/sys` 是系统管理应用。动静分离 + 多应用同端口，全靠 `location` 按前缀分诊
3. **没有 upstream 块 = 没做负载均衡**：视频里讲的"分担"其实还没用上，单台 Java 直连，`worker_processes 1`（单保安）
4. **精确匹配优先于前缀**：`location = /api/sso/oauth2/callback` → 转给 9090 的认证服务，其余 `/api/` → 8080 的业务 Java。同一个前缀分流两台后端。优先级口诀：**`=` 精确 > `^~` 前缀 > 正则 > 普通前缀**

回答最初那个问题——**前端请求后端的地址是打包时确定的吗？** 典型答案是"②③合体"：**前缀**（`/api/`）打包时烤进 JS 产物；**主机**（当前域名）运行时才定，由 nginx 的 `proxy_pass` 说了算。所以换后端机器/端口只改 nginx 一行、前端零改动；只有换前缀才需要重新打包。

## 三、负载均衡：三步上 upstream

```nginx
# ① http 块里、server 外面定义后端池
upstream mes_java {
    server 10.0.0.11:8080 max_fails=3 fail_timeout=30s;  # 30秒败3次自动拉黑30秒
    server 10.0.0.12:8080 backup;                         # 备胎：主力全倒才上
}
# ② location 里只改 proxy_pass 目标（IP 换池名，尾斜杠照旧）
location ^~ /api/ {
    proxy_pass http://mes_java/;
}
# ③ 验证 + 平滑生效（不断连接）
nginx -t && nginx -s reload
```

前端和 Java **零改动**——当初"前端只认相对路径"埋的红利在此兑现。

### 四种分发策略

| 策略 | 写法 | 一句话 |
|---|---|---|
| 轮询（默认） | 不写 | 一人一单 |
| 权重 | `server x weight=3;` | 好机器多干 |
| `ip_hash` | `ip_hash;` | 同一 IP 永远同一台（**会话粘性**） |
| `least_conn` | `least_conn;` | 谁手头活少给谁 |

## 四、上多台 Java 前的真正大坑：Session 在哪

**现象**：两台 Java 各自内存存 Session → 用户在 A 机登录，下个请求轮询到 B 机 → 不认识 → **随机被踢回登录页**，无规律、极难排查。

三条路：

1. **ip_hash**（nginx 层，治标）：同一 IP 粘死同一台。最省事，代价是流量分布可能不均（一个大车间一个出口 IP 全压一台）
2. **Spring Session + Redis**（治本，动配置不动代码）：Session 从"各存各的内存"搬到"共用 Redis"。Spring Session 偷梁换柱——代码照旧 `session.getAttribute()`（Servlet 标准接口不变），底层从查本机内存换成查 Redis。Spring Boot 三步：加 `spring-session-data-redis` 依赖、配 Redis 地址、`@EnableRedisHttpSession`
3. **JWT/token 无状态**：身份写在票上，服务端啥都不存；注销/踢人麻烦，老代码里的 HttpSession 需共存过渡

Redis 共享的流程一句话：A 机登录 → Session 写进 Redis → 浏览器 Cookie 只拿门票 `JSESSIONID=abc123` → 下个请求轮到 B 机 → 拿门票查同一个 Redis → 认得你。**存包柜从各窗口搬到大厅，凭票任何窗口可取。**

> 判断标准：**后端无状态随便轮询；有状态先 ip_hash 兜着，再 Redis 治本。**

## 五、调优四件套（大白话账）

| 件 | 是什么 | 作用 | 内网用不用 |
|---|---|---|---|
| gzip | 出门前把文本抽真空（40KB JS → 12KB） | 省路上时间，付一点 CPU | 白赚，值得上 |
| 缓存 | 浏览器抽屉存文件 30 天不发请求 | 免重复下载 | 带 hash 的静态敢长存；**index.html 必须 no-cache** |
| 限流 | nginx 数每个 IP 每秒几发，超了 503 | 防 while 循环脚本打爆 Java（最朴素 DoS） | 内网不需要；**外网版第一天必装** |
| SSL | 传输加密 + 服务器出示身份证 | 加密防偷看（密码/Cookie 明文裸奔），证书防冒充 | 内网暂不需要；外网必上 |

几个容易翻车的细节：

- **gzip** 只压文本（js/css/json）；图片视频本身已压缩，再压纯属费 CPU；`gzip_comp_level 5` 是性价比点
- **缓存的命门**：带内容 hash 的文件名意味着"内容一变 URL 就变"，所以敢缓存 30 天；但 index.html 是"点名册"（写着当前该用哪个 hash 文件），**点名册被缓存 = 发版后用户拿旧点名册去找已删除的旧文件 = 白屏**。这就是"发版后总有人白屏、Ctrl+F5 才恢复"的病根
- **限流**类比 Java：Tomcat `maxThreads` 管同时接待几个（并发上限），`limit_req rate=10r/s burst=20` 管每秒放几个进门（速率上限）——而且闸机装在 nginx 层，坏流量到不了 Tomcat
- **SSL** 一对钥匙：私钥打死不给（泄露 = 别人可冒充你）；证书贴门口给浏览器验真伪。防"偷看"靠加密，防"演你"靠证书

## 六、高可用补遗：worker 崩了，旧连接谁来顶？

答案很残酷：**没人顶，旧连接跟着 worker 陪葬。** TCP 连接的本质是进程的文件描述符，worker 一崩，内核直接收走 fd、通知对端断开，在途请求全部失败。

那"多进程稳定"到底稳定在哪？——**爆炸半径 + 自愈速度**：

- listen socket 是 master 在 fork 前创建、所有 worker 共享的，一个 worker 死了端口依然有人监听，新连接照常被活着的 worker 接走
- master 毫秒级 fork 新 worker 补位，接的是**未来的新流量**
- 浏览器自动重连/用户刷新，秒级恢复

对比单进程多线程（如 Tomcat）：一个线程段错误 → 信号是进程级的 → **整个进程暴毙、端口短暂无人接、要靠 systemd 外力拉起**。多进程买的是"只死自己的连接"的故障隔离。而 `nginx -s reload` 的优雅换血是另一番景象——老 worker 把手头连接服务完才退，**正常轮换不丢连接，意外死亡才陪葬**。

> 引申成分布式通用结论：**进程/机器死了，手里的活没人能无缝接管；任何"高可用"兜的都是新流量，不是旧连接。** keepalived VIP 漂移如此，K8s Pod 重建如此，数据库主从切换更如此。连接级零丢失要靠客户端重试补最后一环。

nginx 自身的高可用阶梯：systemd `Restart=always`（防进程死）→ **keepalived 主备 + VIP 漂移**（防机器死，内网标准答案）→ DNS 多 A 记录/人工切换（分钟级）→ LVS/F5/云 SLB（更上游）。

## 七、渐进路线与优先级

给单机裸奔的生产系统一个不贪心的改法：

1. **第一步（保命）**：`10.0.0.11 主 + 10.0.0.12 backup`——平时单台跑，Java 崩了 nginx 自动切备胎，且完全不碰 Session 问题
2. **第二步（分摊）**：Session 方案想清楚后再双主力

四件套优先级：**gzip（1 分钟纯赚）> 保命 upstream（半小时）> 静态缓存（10 分钟）> ip_hash/Session 治理 > SSL + 限流（外网化那天再说）**。

## 金句

- 前端只需要知道自己的域名；后端在哪，Nginx 说了算
- proxy_pass 尾斜杠 = 剥前缀转发，一个字符引发全系统 404
- 任何"高可用"兜的都是新流量，不是旧连接——连接级零丢失谁也承诺不了，客户端重试是最后一环
- 后端无状态随便轮询；有状态先粘后治
- 带 hash 的长存，index.html 永远 no-cache
- 压缩管路上、缓存管重复、限流管坏人、SSL 管偷看

## 参考

- [Nginx 官方负载均衡文档（upstream 一手定义）](https://nginx.org/en/docs/http/load_balancing.html)
- [Nginx Beginner's Guide（静态/代理最小配置）](https://nginx.org/en/docs/beginners_guide.html)
- [万字多图，搞懂 Nginx 高性能网络工作原理（master-worker + epoll）](https://cloud.tencent.com/developer/article/1998071)
- [死磕 nginx 系列——nginx 入门（select vs epoll）](https://www.cnblogs.com/biglittleant/p/8979063.html)
- [探索惊群③——nginx 惊群现象](https://zhuanlan.zhihu.com/p/452979435)

系列上一篇：[同步/异步/并发/并行 + 进程/线程/协程](/posts/system-design/sync-async-concurrency-parallel)（本文"多进程 vs 多线程"的地基）
