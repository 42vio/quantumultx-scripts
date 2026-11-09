# quantumultx-scripts

- [顺丰速运：签到、凭据获取与双手机 BoxJS 使用说明](scripts/sfexpress/README.md)

## 下班打卡提醒（Quantumult X）

`scripts/attendance-qx.js` 同时负责保存 App 的 `GetAttendData` 查询请求，以及在 17:20 从同一台手机重放该请求、计算下班时间并通知。提醒时间取“上班打卡后 9 小时”和当天 17:30 中较晚的时间。查询请求只保存在 QX 本地偏好设置中；仓库脚本不包含账号、会话或设备标识。`QuantumultX_Cookie.qxrewrite` 已包含该 App 的重写和 MitM 域名，`TaskGallery.json` 已加入 17:20 任务。推送后，在 iPhone QX 更新这两个现有订阅。

手机时区设为中国标准时间，开启 QX 隧道、MitM 和通知权限。首次使用时打开考勤 App 的当日考勤页，收到“考勤重写成功：已保存考勤查询请求”通知后，在 QX 任务列表手动运行该任务，确认时间与 App 一致。后续任务每天自动查询；若服务端使保存的会话失效，重新打开当日考勤页即可刷新。若开启该域名的 MitM 后 App 卡在连接中，先移除新规则，保持 App 可用。脚本不执行打卡。
