# 顺丰速运

顺丰签到脚本、凭据获取脚本、BoxJS 配置及使用说明统一放在此目录。

| 文件 | 用途 |
| --- | --- |
| [sfexpress.js](sfexpress.js) | 定时签到、领取每日任务，并尝试更新 Web 会话 |
| [sfexpress.cookie.js](sfexpress.cookie.js) | 打开积分签到页时保存当前账号的 Web 会话 |
| [sfexpress.native-cookie.js](sfexpress.native-cookie.js) | 捕获 App 换票请求，供后续刷新 Web 会话 |
| [sfexpress.boxjs.json](sfexpress.boxjs.json) | BoxJS 凭据复制、粘贴页面 |

仓库根目录的 [TaskGallery.json](../../TaskGallery.json) 提供签到任务入口，[QuantumultX_Cookie.qxrewrite](../../QuantumultX_Cookie.qxrewrite) 提供凭据获取规则；两者均引用此目录。测试仍集中在 [tests/sfexpress.test.cjs](../../tests/sfexpress.test.cjs)，在仓库根目录运行 `node tests/sfexpress.test.cjs`。

## 双手机使用方式

两台 iPhone 各保持一个顺丰账号登录，主手机运行两个账号的签到任务。副手机只在获取或更新凭据时开机，不需要每天开机。登录态仍可能自然过期；跨手机换票是否可用，以首次运行结果为准。

## 准备

主手机需已保存两个账号的 Web 会话（例如已有通知同时显示两个账号）；此功能只为已保存的账号补充 App 换票凭据，不自动新增账号。

两台手机安装 BoxJS，并在 QX 添加本仓库的 Cookie 重写，开启 QX 连接、重写和 MitM。在各自手机安装 QX 证书后，还需在 iPhone“设置 → 通用 → 关于本机 → 证书信任设置”中开启该证书的完全信任，并允许 QX 通知。主手机更新顺丰签到脚本，副手机无需添加定时签到任务。

- [Cookie 重写订阅](https://raw.githubusercontent.com/42vio/quantumultx-scripts/main/QuantumultX_Cookie.qxrewrite)
- [主手机签到脚本](https://raw.githubusercontent.com/42vio/quantumultx-scripts/main/scripts/sfexpress/sfexpress.js)
- [BoxJS 订阅](https://raw.githubusercontent.com/42vio/quantumultx-scripts/main/scripts/sfexpress/sfexpress.boxjs.json)

两台手机在 BoxJS 的“订阅”中添加上述 BoxJS 订阅，进入“顺丰速运（双手机凭据）”。本仓库订阅与其他作者的顺丰订阅使用不同的存储字段，不要混用。

## 副手机：获取并复制

1. 登录准备由副手机保持的账号，打开顺丰积分签到页。
2. 确认 QX 通知“App 换票请求已保存”。不要主动退出该账号。
3. 重新进入或刷新 BoxJS 应用页面，避免复制旧内容。
4. 在“本机 App 换票凭据（复制用）”里全选、复制全部内容，包括最外层的 `[` 和 `]`。不要只复制 token，也不要复制手机整个 BoxJS 备份。
5. 可粘贴到临时文本文件，通过隔空投送传给主手机；传完删除临时文件。凭据等同登录信息，不要发到公开聊天、仓库或订阅文件中。

## 主手机：粘贴并验证

1. 打开 BoxJS 的“顺丰速运（双手机凭据）”。
2. 将上述完整内容粘贴到“副手机 App 换票凭据（粘贴到这里）”，保存应用设置。不要粘贴到“本机”输入框，也无需还原整份 BoxJS 备份。
3. 主手机保持自己的顺丰账号登录，打开积分签到页，确认本机 App 凭据已保存。捕获后刷新 BoxJS 页面，避免将旧页面中的内容保存回去。
4. 在 QX 手动运行顺丰签到，检查两个账号是否均显示“App 换票已更新”。只有签到成功但仍提示“使用原 Web 会话”，不能证明跨手机换票成功。
5. 确认副手机账号成功换票后，副手机可关机，主手机继续执行原有定时任务。

两份 App 凭据分别保存，脚本按换票后返回的账号标识匹配原有 Web 账号，验证登录有效后才更新该账号；不会用副手机凭据覆盖另一账号。原有签到、每日任务流程不变。

## 更新与故障

- 副手机重新登录或凭据失效：重复获取、复制、粘贴步骤，替换“副手机”输入框的完整内容。
- “副手机凭据格式错误，已忽略”：重新复制完整 JSON 数组。脚本继续尝试其他已保存凭据及 Web 会话，不输出粘贴内容。
- 仍然换票失败：先在副手机重新打开积分签到页并复制最新内容，再测试。若持续失败，可能涉及登录失效或跨设备限制，不能靠复制凭据保证解决。
- 清空“副手机”输入框并保存，会停止读取该输入框。此前已验证并绑定到账号的换票请求仍会保留，原有 Web 会话也不删除；这不是注销登录操作。

BoxJS 在这里用于手动转移数据，没有自动跨设备同步。请勿将真实凭据写入公开的 BoxJS 订阅 JSON。
