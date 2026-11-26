/**
 * 插件自有命名常量。
 *
 * 飞书开放平台要求权限与事件使用固定标识，业务代码不直接散写这些字符串，
 * 统一通过这里的 FSMCP_* 常量引用；文档也只展示自有常量名。
 */

/** 接收私聊消息的飞书权限标识。 */
export const FSMCP_SCOPE_P2P_READ = 'im:message.p2p_msg:readonly'

/** 以应用身份发送消息的飞书权限标识。 */
export const FSMCP_SCOPE_MESSAGE_SEND = 'im:message'

/** 读取机器人所在群列表的飞书权限标识。 */
export const FSMCP_SCOPE_CHAT_READ = 'im:chat:readonly'

/** 下载消息中图片等资源的飞书权限标识。 */
export const FSMCP_SCOPE_RESOURCE_READ = 'im:resource'

/** 飞书私聊消息接收事件标识。 */
export const FSMCP_EVENT_MESSAGE_RECEIVE = 'im.message.receive_v1'

/** 飞书卡片按钮回传事件标识。 */
export const FSMCP_EVENT_CARD_ACTION = 'card.action.trigger'
