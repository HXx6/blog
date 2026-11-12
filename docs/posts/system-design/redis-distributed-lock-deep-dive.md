---
title: 一颗 Redis 养活一个微服务集群：从分布式锁的三段 Lua 到限流、缓存与发号器
date: 2026-11-12
tags: [Redis, 分布式锁, Redisson, 限流, 缓存, 分布式系统]
description: 看完《Redis 是什么》视频，对着自己维护的 MES 生产代码问了一句"定时任务部署两份怎么保证只跑一次"，从业务代码里唯一的一行 tryLock 出发，沿依赖链拆到 m2 仓库里 redisson-3.10.6.jar 的 class 常量池，把挂牌、续期、摘牌三段 Lua 原文抠了出来；顺手把这颗 Redis 在集群里的其他营业额——TTL 限流、字典/权限缓存、INCR 发号器——也盘了一遍。含 14 帧交互动画。
---

# 一颗 Redis 养活一个微服务集群：从分布式锁的三段 Lua 到限流、缓存与发号器

> 起因：看了个《Redis 是什么》的入门视频，回头对自己维护的 MES 系统（Java 微服务，基于开源框架 BudWk 改造）冒出一个问题——定时任务要是部署两份，怎么保证只跑一次？顺着这个问题，我从业务代码里**唯一的一行** `tryLock` 出发，一路拆到本地 m2 仓库里 redisson-3.10.6.jar 的字节码常量池，把三段 Lua 原文抠了出来；末尾把这颗 Redis 在集群里的其他营业额——限流、缓存、发号器——也盘了一遍。这篇是总账。（文中系统与 IP 已脱敏，但每一行代码证据都是真的。）

## 先看动画：两台实例抢一块牌子

14 帧报文飞行动画：单机事故 → Redis 公告板 → SET NX 挂牌 → 三个坑三个解 → 生产真码逐行翻译 → 广播全景。**键盘 ← → 逐帧，空格自动播放**，底部有个"亲手制造双跑事故"的双按钮实验，建议点一遍：

<iframe src="/blog/animations/redis-dist-lock.html" width="100%" height="1500" style="border:none;border-radius:8px;" loading="lazy" title="分布式锁动画：两台实例抢一块牌子"></iframe>

## 一、锁是什么：一块所有人都看得见的牌子

先忘掉 Redis，从车间讲起。一间共用办公室一台电脑，谁都能进——老张填报表，老李也进来敲同一张表，数据毁了。土办法：**门上挂一块牌子**，挂着"使用中"就别进，干完出来摘掉。锁的全部含义就这么多：**一块所有人都看得见的、只有一块的牌子**。

单机时代，`synchronized` 就是这块牌子——它贴在**自己 JVM 的堆**里，同进程的线程都看得见，够用。

坏就坏在"再加一台服务器"：两个进程就是**两栋隔音楼**，各挂各的牌子，各自觉得"我是主人"——月报表跑两遍、消息推两遍。**牌子各挂各的 = 没锁。**

判据一句话：**锁的标记必须放在所有参赛者都看得见的地方。** 进程的堆对外隔离，那就找第二个人人都连得着的公共区——Redis。于是"分布式锁"有了完整定义：**把"现在谁在干活"这个信息，从进程私有内存搬进共享存储。**

## 二、四件武器：挂牌、防失踪、防早衰、验名摘牌

| 机制 | 一句话 | 防什么事故 |
|---|---|---|
| **SET NX 挂牌** | 墙上没牌我才挂得上（NX = Not eXists） | 两人同时冲，只允许一个挂上 |
| **TTL 防失踪** | 牌子 30 秒自动蒸发 | 持牌进程死了没人摘 → 永久死锁 |
| **watchdog 防早衰** | 进程活着就每 10 秒续期 | 任务比 TTL 长 → 牌子提前蒸发 → 双跑 |
| **Lua 验名摘牌** | 摘之前对一下牌背的名字 | 卡死醒来摘错别人后来挂的牌 |

三坑三解是这套东西的骨架，值得各用一条时间线过一遍：

**坑① 失踪**：A 挂牌后 1 秒断电，没人来 DEL，牌子永远挂着，B 每轮都被拒——任务永久死锁。解药就是挂牌时带 TTL：没人续期，30 秒后 Redis 亲自撕牌，系统自愈。**TTL 保的不是"别人进不来"，是"持牌人失踪后能恢复"。**

**坑② 早衰**：任务要跑 60 秒、TTL 只有 30 秒——第 30 秒牌子蒸发，B 大摇大摆挂上自己的牌开跑，月报表第 2 份诞生。坑①的解药成了坑②的毒药。解药是 watchdog：拿到锁后每 10 秒（30s÷3）把 TTL 重置回 30 秒。**进程活着就一直续，任务跑 600 秒都行；进程死了续期自然停，30 秒后放牌——坑①坑②一枪双雕。**

**坑③ 摘错牌**：A GC 卡了 35 秒（牌子 30 秒时蒸发）→ B 挂新牌开跑 → A 醒来干完活顺手 DEL——**摘的是 B 的牌**，下一秒第三者也能进场。解药：挂牌时值里写入持有者 UUID，摘牌前用 Lua 原子地"验名 + 摘"。名字对不上就不动。为什么必须 Lua 一条脚本？如果拆成"先 GET 看看是不是我的、再 DEL"两步，两条命令之间牌子可能易主——经典的 check-then-act 竞态。

## 三、拆轮子：从 pom 到 class 常量池

业务代码里只有一行 `rLock.tryLock(3, TimeUnit.SECONDS)`——四件武器一件都看不见。它们藏在哪？顺着依赖链挖：

```
业务 pom → nutzboot-starter-redisson
        → nutz-integration-redisson 1.r.70
        → org.redisson:redisson 3.10.6        ← 版本在此钉死
        → 本机 m2 仓库里的 redisson-3.10.6.jar
        → org/redisson/RedissonLock.class 常量池 → 三段 Lua 原文
```

**挂牌**（`tryLock` 触发，注意"NX"在真身里就是那个 `exists == 0` 前置条件）：

```lua
if (redis.call('exists', KEYS[1]) == 0) then        -- 墙上没这块牌（= NX）
    redis.call('hset', KEYS[1], ARGV[2], 1);        -- 挂牌：写入 "UUID:线程ID → 计数1"
    redis.call('pexpire', KEYS[1], ARGV[1]);        -- 同时上保险：TTL 30 秒
    return nil;                                      -- nil = 我抢到了
end
```

两个比教科书更真的细节：牌子不是普通字符串而是 **Hash**（field=持有者名，value=重入计数，所以同进程可以嵌套加锁）；`判断→写入→上TTL` 三步在**一条 Lua 里原子完成**——拆成三条命令的话，别人的 `exists` 检查恰好插进缝里。

**续期**（watchdog 每 10 秒执行，注意续期也验名——只续自己的牌）：

```lua
if (redis.call('hexists', KEYS[1], ARGV[2]) == 1) then
    redis.call('pexpire', KEYS[1], ARGV[1]);        -- 倒计时重置回 30 秒
    return 1;
end
```

**摘牌**（unlock 触发）：

```lua
if (redis.call('hexists', KEYS[1], ARGV[3]) == 0) then
    return nil;                                      -- 不是我的牌，一个手指头都不动
end
local counter = redis.call('hincrby', KEYS[1], ARGV[3], -1);   -- 正字擦一笔
if (counter > 0) then
    redis.call('pexpire', KEYS[1], ARGV[2]); return 0;         -- 没擦到零：牌还归我
else
    redis.call('del', KEYS[1]);                      -- 擦到零：真摘牌
    redis.call('publish', KEYS[2], ARGV[1]);         -- 📣 "牌放出来了！"
    return 1;
end
```

最后那行 `publish` 是个彩蛋：摘牌瞬间往锁的频道广播一条消息——**蹲守在 `tryLock(3秒)` 里等其他实例，等的就是这个信号**，收到立刻醒来重试。四件武器在一条脚本里联动。

还有一个触发条件容易错过：**watchdog 只有在不指定 leaseTime 时才启动**。`tryLock(3, SECONDS)`（两参）→ 看门狗在岗；`tryLock(3, 10, SECONDS)`（三参，自己指定锁寿命）→ 看门狗直接不启动，10 秒必蒸发、任务跑久了就双跑。**一行 API 的参数个数，决定了背后有没有一支续期部队。**

## 四、业务侧那一行代码，以及它包住的一切

生产代码里的真身（开源 BudWk 框架 wk-starter-job 模块的 `SJobAopInterceptor`，业务开发者完全看不到这段——它是个 AOP 拦截器，业务只管写 `@SJob` 方法）：

```java
try {
    // 领一块命名牌：key = "wk:job:execute:" + bean名 + ":" + 任务名
    // （所有实例对同一任务拼出同一个 key——牌名一致才能抢同一把锁）
    RLock rLock = redissonClient.getLock(RedisConstant.JOB_EXECUTE + iocBean.name() + ":" + sJob.value());
    if (rLock.tryLock(3, TimeUnit.SECONDS)) {     // 第一枪 + 蹲守最多 3 秒
        chain.doChain();                          // 抢到了：放行，真跑业务方法
        tookTime = ...;                           // 计时
        doSendMessage(null, tookTime, ...);       // 汇报"成功" → 发往汇报频道
        log.info("... - Success");
    } else {
        log.info("... Locked");                   // 没抢到：一行日志走人
    }                                             // ——是 info 不是 error：没抢到是正常状态
} catch (Throwable e) {
    doSendMessage(e, tookTime, ...);              // 失败也汇报：带异常消息（截 250 字）
    log.error("... - Exception:{}", ...);
    throw e;                                      // 不吞：让反射调用方也能感知失败
}
```

三个值得品的细节：

- **成功失败都汇报**：`doSendMessage` 往汇报频道发一条 JSON（taskId、耗时、哪台实例跑的、成败、异常文本），管理后台的任务执行看板数据源就是它。无论抢没抢到、跑没跑成，调度中心都有账
- **`else` 分支的日志级别**是 info——没抢到锁不是错误，是设计内的正常状态。日志级别里藏着对系统的理解
- **catch 里没有 `finally { unlock(); }`**——这就引出了本文的悬案

## 五、四路命名空间：频道 ≠ key

把这套定时任务系统的 Redis 全景画出来，四个名字、两套体系：

| 名字 | 类型 | 谁发/写 | 谁听/读 | 用途 |
|---|---|---|---|---|
| `wk:job:publish:{任务名}` | 频道 | 调度中心 | 各实例（启动时订阅） | 到点广播"该跑了" |
| `wk:job:execute:{bean}:{任务名}` | **key**（Hash+TTL） | Redisson 三段 Lua | 抢锁的实例 | 牌子（互斥） |
| `wk:job:subscribe` | 频道 | 跑完任务的实例 | 任务历史收集器 | 汇报执行结果 |
| `redisson_lock__channel:{锁名}` | 频道（Redisson 内部） | unlock Lua 的 publish | 蹲守锁的实例 | "牌放出来了"信号 |

最容易混的一点：**频道不是 key**。频道是大喇叭——`PUBLISH` 不创建、不修改、不删除任何 key，喊完即逝、错过即丢；key 是存储格子，有内容、有 TTL、能 GET/DEL。所以"汇报执行结果"（发频道）和"摘牌子"（删 key）是完全不相干的两件事。

广播是放大器（人人听见），锁是收敛器（一人动手），缺一不可。

## 六、留下的悬案：全库没人还钥匙

拆完全部代码发现一个意外：**整个工程、连框架 starter 在内，没有任何一处调用 `unlock()`**。抢锁、跑任务、汇报、抛异常都有，唯独"还钥匙"这一步不存在——锁的释放完全靠 TTL/watchdog 的自然消亡。

按教科书语义推，watchdog 会在进程活着时一直续期，那下一轮任务岂不该被上一轮的锁挡住？但生产上一轮轮跑得好好的。为什么没人发现？因为**当前是单实例部署，锁根本没有竞争者**——锁多活 30 秒没人等着用。

定案方法很朴素（只读操作）：任务触发后在 Redis 上 `TTL wk:job:execute:{bean}:{job}` 连续观察一分钟——**TTL 在 30 秒内归零 = 靠过期释放；TTL 一直在 30 上下徘徊 = watchdog 在续期**。一眼分辨。留个坑，后续补结论。

## 七、锁之外：这颗 Redis 还为集群干了什么

锁只是这颗 Redis 的一小块营业额。镜头拉远——同一个实例、同一批连接池（每个微服务进程启动时各揣一个，池大小 100，借出前先 PING 防死连接）上，还跑着三类最基础的用法，每一类都值得认识一遍。

### ① 防爆破限流：把 TTL 当"刑期"用

业务故事：凌晨有人拿字典爆破登录接口。防线是每个 IP 一个计数器，计满判刑——判刑的"刑期"就是 key 的 TTL（开源框架 wk-ucenter 模块 `AuthServiceImpl` 真码）：

```java
int count = Integer.parseInt(Strings.sNull(
    redisService.get("wk:checkLoginname:" + ip), "0"));      // ① 读计数，没见过=0
if (count > nameRetryNum - 1) {                               // ② 超阈值 → 直接拒绝
    long ttl = redisService.ttl("wk:checkLoginname:" + ip);   //    剩余刑期还能现场读出来
    throw new BaseException("您的IP已被锁定，请" + ttl/60 + "分" + ttl%60 + "秒后重试");
}
// ……密码校验失败之后：
redisService.setex("wk:checkLoginname:" + ip, nameTimeout,   // ③ 计数+1，带 TTL 写回
    String.valueOf(++count));
```

细品三个设计：**Redis 里的真实样子**是 `wk:checkLoginname:10.0.0.23 → "5"，TTL 437s`——第 6 次请求连 SQL 都不会执行，判刑期间数据库零负担；**TTL 到点 key 自动蒸发**，"解禁"不需要任何清理代码；**为什么不用 MySQL**——每次失败都要读写一次的高频计数、刑期天然等于 TTL、丢了还能重建的数据，三样都不配进真相库。

挑刺一处：每次失败 `setex` 都会整体覆盖重置 TTL，这是**滑动窗口**——攻击者只要不停手，锁就永远续期，歪打正着比教科书的固定窗口（`INCR` + `EXPIRE key ttl NX`）更狠。面试题"固定窗口 vs 滑动窗口限流"的活例子。

### ② 基础数据缓存：字典与权限，"参数即身份"

系统里 20+ 个 Service 在用同一套注解缓存，几乎全是基础/配置类数据（数据字典、行政区划、计量单位、用户权限、菜单）。用法两注解：

```java
// 类级默认：缓存命名空间 + 统一 TTL（秒）
@CacheDefaults(cacheName = "wk:wkcache:sys_user", cacheLiveTime = 7200)
public class SysUserServiceImpl ... {

    @CacheResult(cacheKey = "${userId}_getPermissionList")      // 单参数做身份
    public List<String> getPermissionList(String userId) { ... }

    @CacheResult(cacheKey = "${userId}_${appId}_getMenuList")   // 多参数组合做身份
    public List<Sys_menu> getMenuList(String userId, String appId) { ... }
}
```

最终 Redis key = `cacheName + ":" + cacheKey`，例如 `wk:wkcache:sys_user:zhangsan_getPermissionList`（TTL 7200）——**模板里的 `${形参名}` 被替换成实参值，不同用户天然落进不同的 K**，这就是"参数即身份"。

比用法更重要的是**什么数据配缓存**，这家里有一张干净的分层表：读极多 + 写极少 + 全局共享 + 容忍秒级旧的基础数据才挂缓存；全库**零处**库存/单据/余额等交易数据挂缓存——强一致数据永远直读 DB。一句话：**交易数据直读，基础数据才缓存**。

再送一个挑刺彩蛋（实勘发现）：**private 方法上的缓存注解是死的**。注解框架注册拦截器的入口用的是 Java 反射的 `clazz.getMethods()`——它只返回 public 方法，private 方法进不了注册循环，拦截器从未挂上，每次调用直通数据库。注解不是法术，背后是 AOP 拦截器在干活，而拦截器有一张只收 public 的名单。

### ③ 发号器：INCR 原子自增，日期进 key

业务单号 `SO20261112-0001` 这种"每天从 1 开始"的号，用 `INCR` 发：key 里带日期（如 `daily:count:20261112`），单线程自增保证多服务并发取号不重不漏，日期一变 key 换新、计数自然归零——又是"零清理代码"的设计。比 MySQL 自增列的好处：跨服务共享一个号段来源、不占数据库自增锁。

### 收尾：同一颗 Redis 的五种角色

| 角色 | 核心命令 | 一句话 |
|---|---|---|
| 限流计数器 | GET + SETEX | 计数带刑期，到点自动赦免 |
| 基础数据缓存 | GET + SETEX(7200) | 读多写少的数据快照，参数即身份 |
| 发号器 | INCR | 原子自增，日期进 key 每天归零 |
| 分布式锁 | EVAL（三段 Lua） | key 当牌子用 |
| 广播/汇报频道 | PUBLISH / SUBSCRIBE | 声波不是存储，喊完即逝 |

前三样都是 Jedis 客户端直连干的粗活，只有锁那一档请了 Redisson——两套客户端吃两段配置（`redis:` 段管数据，`redisson:` 段管协调），**key 当数据用，也当牌子用**，一颗 Redis 两种活法。

## 尾声：方法比结论值钱

回顾这次挖掘的路径：入门视频 → 生产业务代码 → AOP 拦截器 → pom 依赖链 → m2 仓库的 jar → class 常量池的 Lua 原文。每往下一层，"注解/API 是魔法"的感觉就少一分，"这是人写的、有道理的代码"的实感就多一分。

几个顺手沉淀的工程技巧：取 GitHub 源码被墙时走 `api.github.com` + `Accept: application/vnd.github.raw`；判断一个注解/框架特性是否真的生效，去找它的注册入口（比如 AOP 拦截器注册时用 `clazz.getMethods()` 只收 public——private 方法上的注解缓存是死的）；同一条 `rg -rn "X"` 命令里 `-rn` 会被解析成 `-r n`（替换显示），差点让我把常量名看错——工具的坑和代码的坑一样真。

<details>
<summary><b>自测五题（先答再展开）</b></summary>

1. 两个实例同一毫秒各发一条 `SET 牌子 ON NX`，结果？
2. 锁的 TTL 最先救的是哪种事故？
3. `tryLock(3, TimeUnit.SECONDS)` 里的 3 秒是什么的时长？
4. watchdog 自动续期的生效前提？
5. A 卡顿 35 秒后恢复、B 已持新牌，A 顺手 unlock 为什么没摘掉 B 的锁？

<details>
<summary>答案</summary>

1. 恰好一条成功——Redis 单线程排队执行，第二条进来时 key 已存在被 NX 拒绝
2. 持牌进程宕机、牌子永远没人摘的死锁（不是"别人抢不走"——那是 NX 的事）
3. 最多**等**牌 3 秒（等待时长）；持有时长归 watchdog 管，两套时间互不掺和
4. 获取锁时不指定 leaseTime（两参版 tryLock；指定了就是"到点必过期，自己负责"）
5. unlock 前先验锁值里的 UUID，不是自己的牌不摘（Lua 原子完成，防 check-then-act 竞态）

</details>
</details>
