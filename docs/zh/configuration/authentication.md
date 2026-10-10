# 认证与凭证

[平台与模型](./providers.md) 讲的是供应商使用哪一套协议，本页讲的是另一半：CLI 如何向那个端点证明你的身份，这份凭证明文存在磁盘的哪里，以及如何在不手动改 TOML 的前提下查看或替换它。

有两个彼此独立的设置决定一次请求会带上什么。**凭证来源**说明密钥从哪里来——直接写在配置里、来自环境变量，还是通过 OAuth 登录获得；**认证方式**说明它以什么形式发出去——`Bearer` 请求头、你指定名称的请求头，或者干脆不发。同一个供应商可以单独改动其中一项，另一项不受影响。

## 凭证来源

供应商按下面的顺序解析凭证，取到值即停：

| 来源 | 配置方式 | 说明 |
| --- | --- | --- |
| 直接写值 | `api_key = "sk-…"` | 以明文形式存放在 `config.toml` 中 |
| 环境变量 | `api_key_env = "OPENAI_API_KEY"` | 只声明变量名，CLI 不会从配置文件里读取密钥本身 |
| 供应商 env 子表 | `[providers.<id>.env]` | 仅在上两项都没有设置时才读 |
| OAuth token | `[providers.<id>.oauth]` | 由 `/login` 写入并刷新 |

`api_key` 和 `api_key_env` 只能二选一。同时配上两者的供应商属于配置错误，而不是悄悄地对其中一个优先——正是这种歧义让密钥流到了不该去的地方。四个来源全都取不到值时，CLI 会在启动阶段直接失败，而不是发出一个不带认证的请求。

::: warning 注意
除 `api_key_env` 中显式声明的那个变量外，CLI 绝不会回退到 Shell 环境去找凭证。单独执行 `export OPENAI_API_KEY=…` 不会有任何效果，必须由供应商去引用它。
:::

完整的优先级规则（含项目级覆盖）见[配置覆盖：供应商凭证](./overrides.md#供应商凭证)。

## 凭证保存在哪里

直接写在 `api_key` 里的密钥会落到 `config.toml`——和模型、权限设置放在同一个文件里。CLI 创建该文件时使用只有属主可读写的权限（`0600`），并把它放在 `0700` 的目录中，所以在多人共用的机器上其他用户读不到它。但值本身仍然是明文，每次备份这个文件都会把它一起带走。

OAuth token 单独存放：数据根目录下的 `credentials/` 中，每个供应商一个 JSON 文件，权限同样是 `0600`。默认的数据根目录是 `~/.kimi-code`，或者 `KIMI_CODE_HOME` 指向的路径。完整的目录树见[数据路径](./data-locations.md#目录结构)。

如果你根本不想让密钥进配置文件，那就改用 `api_key_env`，把值放进 Shell 启动脚本或密钥管理工具。共享机器和 CI 环境都推荐这种写法。

::: warning 注意
`[providers.<id>.oauth]` 上的 `storage` 字段接受 `"file"` 和 `"keyring"`，但目前只实现了文件存储。写成 `"keyring"` 不会报错，token 照样会被写进凭据目录——不要指望它能把 token 挡在文件系统之外。
:::

## 凭证如何发送

`auth_scheme` 表决定用哪个请求头。`kind = "bearer"` 以 `Authorization: Bearer <key>` 发送，这是默认值，也是 OpenAI 兼容端点所期望的形式。`kind = "custom-header"` 把值放进你指定名称的请求头，完全不发送 `Authorization`——Anthropic 和大多数自建网关要的就是这种形式。`kind = "none"` 什么都不发，适合那些根本不校验凭证的本地服务器。

`auth_scheme` 改变的是值发到哪里，而不是值本身：密钥仍然由 `api_key` 或 `api_key_env` 提供。该字段适用于 `openai`、`openai_responses` 和 `anthropic` 类型，写在 `google-genai` 或 `vertexai` 上则是配置错误。完整对照表和示例见[自定义认证请求头与匿名访问](./providers.md#自定义认证请求头与匿名访问)。

## 查看凭证状态

`kimi auth` 回答的是"我现在到底能用哪些供应商"。两个子命令都严格离线：不联网联系供应商，不轮换 token，也不会卡在网络请求上。

```sh
kimi auth list
kimi auth status <providerId>
```

```text
AUTHENTICATED kimi        PRESENT (oauth token cached, refreshable)  expires 2026-01-31T09:12:44.000Z
AUTHENTICATED openrouter  PRESENT (api_key from config.toml)
EXPIRED      deepseek    EXPIRED (cached token lapsed; the runtime refreshes it on the next request)
MISSING      anthropic   MISSING (api_key_env "ANTHROPIC_API_KEY" is not set or is empty)
NONE         local       PRESENT (auth_scheme = "none", no credential sent)
```

一共有五种状态：

- `AUTHENTICATED`——凭证存在，请求时会带上它。
- `EXPIRED`——OAuth token 存在但已失效；运行时会在下次请求时刷新它，所以这还不算故障。
- `REVOKED`——服务端拒绝了已保存的 token，需要重新执行 `kimi auth login`。
- `MISSING`——没有任何凭证可发，在你补上之前请求一定会失败。详细信息里会指出上面四种来源中哪一种是空的。
- `NONE`——刻意与 `AUTHENTICATED` 区分开：供应商设置了 `auth_scheme = "none"`，它的凭证解析成功，但永远不会有密钥发出去。把它报告成"已登录"会误导人。

两个子命令都支持 `--json`，方便脚本处理。`kimi auth status <providerId>` 不输出表格，而是把单个供应商的结果按"键值对"逐行列出；供应商未配置时以非零退出码结束。

## 替换凭证

轮换密钥只需要一条命令：

```sh
kimi auth login <providerId>
```

它以隐藏输入的方式提示你输入，写入 `api_key`，并清空该供应商原有的 `api_key_env`——同时保留两者属于配置错误。因为值是从终端读取的，而不是从命令行参数传入的，所以它不会出现在 Shell 历史或进程列表里。同样的操作在 [`/provider` 管理器](./providers.md#provider-—-交互式供应商管理)里也能完成：选中某个供应商后按 <kbd>E</kbd>，打开的就是同一个隐藏输入对话框。删除供应商同理，按 <kbd>D</kbd>，会先要求确认。

脚本和无人值守的初始化可以用 [`kimi provider auth <providerId>`](../reference/kimi-command.md#kimi-provider-auth-providerid)，它把密钥作为参数接收。手动操作时优先用隐藏输入框：参数形式会在运行期间把密钥暴露在 Shell 历史和 `ps` 输出里。

通过 OAuth 认证的供应商会拒绝 `kimi auth login`，并指向 `kimi login`——它们的凭证属于登录会话，用前者写进去会被登录会话覆盖掉。

## 清除凭证

退出登录和删除供应商是两回事：

```sh
kimi auth logout <providerId>
```

它清除 `api_key`、`api_key_env` 或已缓存的 OAuth token，保留供应商条目、它的模型别名以及 `default_model`——配置结构还在，只有密钥没了。要连供应商本身一起移除，用 `kimi provider remove <providerId>`，这条命令会删掉条目以及所有指向它的引用。如果该供应商本来就没有存储任何内容，命令会如实说明并以成功状态退出。

## 刷新 OAuth token

`/login` 签发的 access token 会自动续期：运行时会在它失效前一点点刷新，你不会遇到 token 过期导致请求失败的情况。`kimi auth refresh <providerId>` 则立刻强制轮换一次，而不是等到下次请求。

该命令只适用于 OAuth 供应商。对静态 API 密钥，它会说明密钥不会过期、指向 `kimi auth login`，并以非零退出码结束——因为静态密钥是替换，不是刷新。

## 下一步

- [平台与模型](./providers.md)——协议类型、`/provider` 管理器和内置供应商目录
- [配置覆盖](./overrides.md)——完整的凭证优先级顺序，含项目级覆盖
- [数据路径](./data-locations.md)——CLI 会写出的每一个文件，以及如何迁移它们
- [kimi 命令参考](../reference/kimi-command.md)——完整的 `kimi auth` 与 `kimi provider`